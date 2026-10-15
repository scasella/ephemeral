import { shellQuote } from './git-prepare.js';

const SHELL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const SHELL_FRAME = '\nEPHEMERAL_SHELL_COMPLETE\n';

/** Browser IDs are never accepted as tmux target expressions or shell code. */
export function shellTarget(shellId: string): string {
  if (shellId === 'codex') return 'ephemeral';
  if (!SHELL_UUID.test(shellId)) throw new Error('Invalid terminal shell ID.');
  return `ephemeral-shell-${shellId}`;
}

/** Bounded VM-side lifecycle operation; ordinary jobs remain inside their pane OS session. */
export function shellCommand(shellId: string, action: 'ensure' | 'inspect' | 'close'): string {
  const target = shellTarget(shellId);
  if (shellId === 'codex' && action !== 'inspect') throw new Error('The Codex terminal is protected.');
  return `node -e ${shellQuote(shellCommandSource(target, action))}`;
}

export function shellCommandSource(target: string, action: 'ensure' | 'inspect' | 'close'): string {
  // Also validate this internal entry point so callers cannot bypass shell ID validation.
  if (target !== 'ephemeral') {
    if (!target.startsWith('ephemeral-shell-') || shellTarget(target.slice('ephemeral-shell-'.length)) !== target) throw new Error('Invalid terminal target.');
  }
  if (target === 'ephemeral' && action !== 'inspect') throw new Error('The Codex terminal is protected.');
  return `
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const target = ${JSON.stringify(target)}, action = ${JSON.stringify(action)};
const tmuxArgs = [];
const controlDirectory = '/tmp/ephemeral-terminal-shells';
const lock = controlDirectory + '/' + target + '.lock', tombstone = controlDirectory + '/' + target + '.closed';
const candidate = lock + '.candidate-' + process.pid + '-' + require('node:crypto').randomUUID();
let locked = false;
const acquire = async () => {
  fs.mkdirSync(controlDirectory, {recursive:true, mode:0o700});
  // Publish owner and lock together. A process killed before rename never owns the lock.
  fs.mkdirSync(candidate, {mode:0o700});
  fs.writeFileSync(candidate + '/owner', String(process.pid), {mode:0o600});
  const deadline = Date.now() + 2500;
  while (!locked) {
    try { fs.renameSync(candidate, lock); locked = true; }
    catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
      // Serialize dead-owner recovery so two waiters cannot delete a newly acquired lock.
      const recovery = lock + '.recovery';
      let recovering = false;
      try {
        fs.mkdirSync(recovery, {mode:0o700}); recovering = true;
        let owner;
        try { owner = Number(fs.readFileSync(lock + '/owner', 'utf8')); } catch {}
        if (Number.isSafeInteger(owner) && owner > 1) {
          try { process.kill(owner, 0); } catch (error) {
            if (error.code === 'ESRCH') fs.rmSync(lock, {recursive:true, force:true});
            else if (error.code !== 'EPERM') throw error;
          }
        }
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      finally { if (recovering) fs.rmdirSync(recovery); }
      if (Date.now() >= deadline) throw new Error('Terminal lifecycle is busy');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
};
const run = args => {
  const result = spawnSync('tmux', [...tmuxArgs, ...args], {encoding:'utf8', timeout:1500, maxBuffer:65536});
  if (result.error || result.signal || !Number.isInteger(result.status)) throw new Error('Terminal command failed');
  return result;
};
const names = () => {
  const result = run(['list-sessions', '-F', '#{session_name}']);
  if (result.status !== 0) throw new Error('Terminal server unavailable');
  return result.stdout.trim().split('\\n');
};
const exists = () => names().includes(target);
const complete = state => process.stdout.write(JSON.stringify({state}) + ${JSON.stringify(SHELL_FRAME)});
const panes = name => {
  const result = run(['list-panes', '-s', '-t', '=' + name, '-F', '#{pane_pid}']);
  if (result.status !== 0) throw new Error('Terminal panes unavailable');
  const pids = result.stdout.trim().split('\\n').map(Number);
  if (!pids.length || pids.some(pid => !Number.isSafeInteger(pid) || pid <= 1)) throw new Error('Invalid terminal panes');
  return pids;
};
const processes = () => {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,sess=,tty=,stat='], {encoding:'utf8', timeout:1000, maxBuffer:1048576});
  if (result.error || result.signal || result.status !== 0) throw new Error('Process inspection failed');
  return result.stdout.trim().split('\\n').map(line => {
    const [pid, parent, group, sid, tty, state] = line.trim().split(/\\s+/);
    // macOS hides sess addresses as 0; its controlling tty still contains ordinary pane jobs.
    const session = process.platform === 'linux' ? sid : tty !== '??' && tty !== '?' ? 'tty:' + tty : 'pid:' + pid;
    return {pid:Number(pid), parent:Number(parent), group:Number(group), session, state};
  }).filter(row => Number.isSafeInteger(row.pid) && row.pid > 1 && Number.isSafeInteger(row.group) && row.group > 1 && row.session && !/^[ZX]/.test(row.state));
};
(async () => {
  if (action !== 'inspect') await acquire();
  if (action === 'close') fs.writeFileSync(tombstone, 'closed', {mode:0o600});
  if (action === 'ensure') {
    if (fs.existsSync(tombstone)) throw new Error('Terminal generation is closed');
    if (!exists()) {
      // A separate tmux session keeps window selection independent of Codex.
      const created = run(['new-session', '-d', '-s', target, '-c', '/home/user/workspace', 'bash -l']);
      if (created.status !== 0 && !exists()) throw new Error('Terminal creation failed');
    }
    complete('open'); return;
  }
  if (!exists()) { complete('closed'); return; }
  if (action === 'inspect') { complete('open'); return; }
  const roots = new Set(panes(target));
  const initial = processes();
  const own = initial.find(row => row.pid === process.pid);
  if (!own) throw new Error('Cleanup identity unavailable');
  const server = run(['display-message', '-p', '#{pid}']);
  const serverPid = Number(server.stdout.trim());
  if (server.status !== 0 || !Number.isSafeInteger(serverPid) || serverPid <= 1) throw new Error('Terminal server identity unavailable');
  const primaryPanes = names().includes('ephemeral') ? panes('ephemeral') : [];
  const protectedPids = new Set([process.pid, serverPid, ...primaryPanes]);
  const protectedSessions = new Set(initial.filter(row => protectedPids.has(row.pid)).map(row => row.session));
  const protectedGroups = new Set(initial.filter(row => protectedPids.has(row.pid)).map(row => row.group));
  const rootRows = initial.filter(row => roots.has(row.pid));
  if (rootRows.length !== roots.size || rootRows.some(row => protectedSessions.has(row.session) || protectedGroups.has(row.group))) throw new Error('Terminal containment unavailable');
  const sessions = new Set(rootRows.map(row => row.session));
  const descendants = new Set(roots);
  let changed = true;
  while (changed) { changed = false; for (const row of initial) if (descendants.has(row.parent) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; } }
  const groups = new Set(initial.filter(row => descendants.has(row.pid)).map(row => row.group));
  const contained = rows => rows.filter(row => (sessions.has(row.session) || groups.has(row.group)) && !protectedPids.has(row.pid) && !protectedSessions.has(row.session) && !protectedGroups.has(row.group));
  const signal = name => {
    for (const group of new Set(contained(processes()).map(row => row.group))) {
      try { process.kill(-group, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  signal('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 200));
  signal('SIGKILL');
  // Killing a pane leader can remove the session before this exact-target operation.
  if (exists() && run(['kill-session', '-t', '=' + target]).status !== 0 && exists()) throw new Error('Terminal close failed');
  const deadline = Date.now() + 1500;
  while (contained(processes()).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  if (contained(processes()).length || exists()) throw new Error('Terminal termination unconfirmed');
  complete('closed');
})().catch(() => { process.exitCode = 1; }).finally(() => {
  if (locked) { try { fs.rmSync(lock, {recursive:true}); } catch { process.exitCode = 1; } }
  else { try { fs.rmSync(candidate, {recursive:true, force:true}); } catch {} }
});
`;
}
