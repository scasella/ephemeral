import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { shellCommandSource, shellTarget, SHELL_FRAME } from '../server/infra/terminal-shell.js';

const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 2500;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  expect(predicate()).toBe(true);
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe.skipIf(!hasTmux)('actual tmux shell process containment on an isolated socket', () => {
  it('keeps Codex, primary background work, Git and other tmux sessions alive while terminating supplemental foreground and background jobs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ephemeral-shell-test-'));
    const socket = join(directory, 'tmux.sock'), id = randomUUID(), target = shellTarget(id);
    const tmux = (...args: string[]) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', timeout: 2500 });
    const command = (action: 'ensure' | 'inspect' | 'close') => {
      const source = shellCommandSource(target, action).replace('const tmuxArgs = [];', `const tmuxArgs = ${JSON.stringify(['-S', socket])};`)
        .replace("'-c', '/home/user/workspace'", `'-c', ${JSON.stringify(directory)}`)
        .replace("const controlDirectory = '/tmp/ephemeral-terminal-shells';", `const controlDirectory = ${JSON.stringify(join(directory, 'control'))};`);
      return execFileSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 12_000 });
    };
    try {
      execFileSync('git', ['init', '-q', directory]);
      tmux('new-session', '-d', '-s', 'ephemeral', '-c', directory, 'bash --noprofile --norc');
      tmux('new-session', '-d', '-s', 'unrelated', '-c', directory, 'bash --noprofile --norc');
      const primaryPid = Number(tmux('list-panes', '-t', '=ephemeral', '-F', '#{pane_pid}').trim());
      const unrelatedPid = Number(tmux('list-panes', '-t', '=unrelated', '-F', '#{pane_pid}').trim());
      const primaryJobFile = join(directory, 'primary-job');
      tmux('send-keys', '-t', '=ephemeral:', `sleep 60 & jobs -p > '${primaryJobFile}'`, 'Enter');
      try { await waitFor(() => existsSync(primaryJobFile)); } catch (error) { throw new Error(tmux('capture-pane', '-p', '-t', '=ephemeral:'), { cause: error }); }
      const primaryJob = Number(readFileSync(primaryJobFile, 'utf8').trim());
      const beforeGit = execFileSync('git', ['-C', directory, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
      expect(command('inspect')).toBe('{"state":"closed"}' + SHELL_FRAME);
      expect(command('ensure')).toBe('{"state":"open"}' + SHELL_FRAME);
      const supplementalPid = Number(tmux('list-panes', '-t', `=${target}`, '-F', '#{pane_pid}').trim());
      expect(command('ensure')).toBe('{"state":"open"}' + SHELL_FRAME);
      expect(Number(tmux('list-panes', '-t', `=${target}`, '-F', '#{pane_pid}').trim())).toBe(supplementalPid);
      const supplementalJobFile = join(directory, 'supplemental-job'), foregroundFile = join(directory, 'foreground-job');
      tmux('send-keys', '-t', `=${target}:`, `sleep 60 & jobs -p > '${supplementalJobFile}'; bash -c 'echo $$ > "${foregroundFile}"; exec sleep 60'`, 'Enter');
      await waitFor(() => existsSync(supplementalJobFile) && existsSync(foregroundFile));
      const supplementalJob = Number(readFileSync(supplementalJobFile, 'utf8').trim()), foregroundJob = Number(readFileSync(foregroundFile, 'utf8').trim());
      expect(alive(supplementalJob)).toBe(true); expect(alive(foregroundJob)).toBe(true);
      expect(command('close')).toBe('{"state":"closed"}' + SHELL_FRAME);
      await waitFor(() => !alive(supplementalPid) && !alive(supplementalJob) && !alive(foregroundJob));
      expect(command('close')).toBe('{"state":"closed"}' + SHELL_FRAME);
      expect(command('inspect')).toBe('{"state":"closed"}' + SHELL_FRAME);
      expect(() => command('ensure')).toThrow();
      expect(Number(tmux('list-panes', '-t', '=ephemeral', '-F', '#{pane_pid}').trim())).toBe(primaryPid);
      expect(alive(primaryPid)).toBe(true); expect(alive(primaryJob)).toBe(true); expect(alive(unrelatedPid)).toBe(true);
      // The existing repo remains usable after the unrelated process cleanup.
      expect(execFileSync('git', ['-C', directory, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim()).toBe('true');
      const primaryGitFile = join(directory, 'primary-git-ok');
      tmux('send-keys', '-t', '=ephemeral:', `git status --porcelain --untracked-files=no > '${primaryGitFile}'`, 'Enter');
      await waitFor(() => existsSync(primaryGitFile));
      expect(readFileSync(primaryGitFile, 'utf8')).toBe(beforeGit);
      expect(tmux('list-sessions', '-F', '#{session_name}').trim().split('\n').sort()).toEqual(['ephemeral', 'unrelated']);
    } finally {
      // Test cleanup owns this private socket only, never a user's shared tmux server.
      spawnSync('tmux', ['-S', socket, 'kill-server'], { timeout: 2000 });
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it('fences delayed creation after close, serializes overlapping creation, and recovers a dead lock owner', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ephemeral-shell-fence-')), socket = join(directory, 'tmux.sock');
    const control = join(directory, 'control');
    const tmux = (...args: string[]) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', timeout: 2500 });
    const sourceFor = (target: string, action: 'ensure' | 'inspect' | 'close') => shellCommandSource(target, action)
      .replace('const tmuxArgs = [];', `const tmuxArgs = ${JSON.stringify(['-S', socket])};`)
      .replace("'-c', '/home/user/workspace'", `'-c', ${JSON.stringify(directory)}`)
      .replace("const controlDirectory = '/tmp/ephemeral-terminal-shells';", `const controlDirectory = ${JSON.stringify(control)};`);
    const execute = (target: string, action: 'ensure' | 'inspect' | 'close') => execFileSync(process.execPath, ['-e', sourceFor(target, action)], { encoding: 'utf8', timeout: 12_000 });
    const deferred = (source: string) => {
      const child = spawn(process.execPath, ['-e', source]);
      let stdout = ''; child.stdout.on('data', data => { stdout += data; });
      return new Promise<{code: number | null; stdout: string}>((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ code, stdout })); });
    };
    try {
      tmux('new-session', '-d', '-s', 'ephemeral', '-c', directory, 'bash --noprofile --norc');
      const primaryPid = Number(tmux('list-panes', '-t', '=ephemeral', '-F', '#{pane_pid}').trim());
      const delayedTarget = shellTarget(randomUUID()), lateMarker = join(directory, 'late-started');
      const delay = `if (action === 'ensure') { fs.writeFileSync(${JSON.stringify(lateMarker)}, 'started'); await new Promise(resolve => setTimeout(resolve, 300)); }`;
      const late = deferred(sourceFor(delayedTarget, 'ensure').replace("if (action !== 'inspect') await acquire();", `${delay}\nif (action !== 'inspect') await acquire();`));
      await waitFor(() => existsSync(lateMarker));
      expect(execute(delayedTarget, 'close')).toBe('{"state":"closed"}' + SHELL_FRAME);
      expect((await late).code).toBe(1); expect(execute(delayedTarget, 'inspect')).toBe('{"state":"closed"}' + SHELL_FRAME);

      const overlapTarget = shellTarget(randomUUID()), overlapMarker = join(directory, 'overlap-started');
      const hold = `if (action === 'ensure') { fs.writeFileSync(${JSON.stringify(overlapMarker)}, 'started'); await new Promise(resolve => setTimeout(resolve, 300)); }`;
      const opening = deferred(sourceFor(overlapTarget, 'ensure').replace("if (action !== 'inspect') await acquire();", `if (action !== 'inspect') await acquire();\n${hold}`));
      await waitFor(() => existsSync(overlapMarker));
      expect(execute(overlapTarget, 'close')).toBe('{"state":"closed"}' + SHELL_FRAME);
      expect(await opening).toEqual({ code: 0, stdout: '{"state":"open"}' + SHELL_FRAME });
      expect(execute(overlapTarget, 'inspect')).toBe('{"state":"closed"}' + SHELL_FRAME);
      expect(() => execute(overlapTarget, 'ensure')).toThrow();

      const recoveredTarget = shellTarget(randomUUID()), deadPid = spawnSync(process.execPath, ['-e', '']).pid;
      mkdirSync(join(control, recoveredTarget + '.lock')); writeFileSync(join(control, recoveredTarget + '.lock', 'owner'), String(deadPid));
      expect(execute(recoveredTarget, 'ensure')).toBe('{"state":"open"}' + SHELL_FRAME);
      const filesBefore = readdirSync(control).sort();
      expect(execute(recoveredTarget, 'inspect')).toBe('{"state":"open"}' + SHELL_FRAME); expect(readdirSync(control).sort()).toEqual(filesBefore);
      expect(execute(recoveredTarget, 'close')).toBe('{"state":"closed"}' + SHELL_FRAME);
      expect(alive(primaryPid)).toBe(true); expect(tmux('list-sessions', '-F', '#{session_name}').trim()).toBe('ephemeral');
    } finally { spawnSync('tmux', ['-S', socket, 'kill-server'], { timeout: 2000 }); rmSync(directory, { recursive: true, force: true }); }
  }, 20_000);
});
