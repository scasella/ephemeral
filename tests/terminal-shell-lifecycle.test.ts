import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { recoverPrimaryShellCommandSource, shellCommandSource, shellTarget, SHELL_FRAME } from '../server/infra/terminal-shell.js';

const complete = (state: string) => JSON.stringify({ state }) + SHELL_FRAME;
const execute = (source: string) => spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 12_000 });
const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 3500;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  expect(predicate()).toBe(true);
};

describe('terminal server diagnostics', () => {
  it('reports absence only for explicit missing-server diagnostics', () => {
    for (const stderr of ['no server running on /tmp/test.sock\n', 'error connecting to /tmp/test.sock (No such file or directory)\n', 'no sessions\n']) {
      const source = shellCommandSource('ephemeral', 'inspect').replace("const {spawnSync} = require('node:child_process');", `const spawnSync = () => ({status:1,stdout:'',stderr:${JSON.stringify(stderr)}});`);
      expect(execute(source)).toMatchObject({ status: 0, stdout: complete('closed') });
    }
  });
  it('keeps socket permission, connection, timeout and unrecognized failures unknown without attempting recovery', () => {
    for (const result of [
      { status: 1, stderr: 'error connecting to /tmp/test.sock (Permission denied)\n' },
      { status: 1, stderr: 'error connecting to /tmp/test.sock (Connection refused)\n' },
      { status: 1, stderr: 'server exited unexpectedly\n' },
      { status: null, signal: 'SIGTERM', stderr: '' },
    ]) {
      for (const source of [shellCommandSource('ephemeral', 'inspect'), recoverPrimaryShellCommandSource()]) {
        const directory = mkdtempSync(join(tmpdir(), 'ephemeral-diagnostic-')), calls = join(directory, 'calls');
        try {
          const fixture = source.replace("const {spawnSync} = require('node:child_process');", `const spawnSync = (_command, args) => { require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n'); return {...${JSON.stringify(result)},stdout:''}; };`)
            .replace("const controlDirectory = '/tmp/ephemeral-terminal-shells';", `const controlDirectory = ${JSON.stringify(join(directory, 'control'))};`);
          expect(execute(fixture)).toMatchObject({ status: 1, stdout: '' });
          expect(readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual([['list-sessions', '-F', '#{session_name}']]);
        } finally { rmSync(directory, { recursive: true, force: true }); }
      }
    }
  });
});

describe.skipIf(spawnSync('tmux', ['-V']).status !== 0)('primary recovery on private tmux sockets', () => {
  it('survives exit and Ctrl-D, recovers once concurrently, preserves workspace/auth/env and never restarts a living primary', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ephemeral-primary-')), socket = join(directory, 'tmux.sock');
    const env = { ...process.env, HOME: directory };
    const tmux = (...args: string[]) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', timeout: 2500, env });
    const fixture = (source: string) => source.replace('const tmuxArgs = [];', `const tmuxArgs = ${JSON.stringify(['-S', socket])};`)
      .replaceAll("'-c', '/home/user/workspace'", `'-c', ${JSON.stringify(directory)}`)
      .replace("const controlDirectory = '/tmp/ephemeral-terminal-shells';", `const controlDirectory = ${JSON.stringify(join(directory, 'control'))};`);
    const inspect = () => execute(fixture(shellCommandSource('ephemeral', 'inspect')));
    const recover = () => execute(fixture(recoverPrimaryShellCommandSource()));
    const pid = () => Number(tmux('list-panes', '-t', '=ephemeral', '-F', '#{pane_pid}').trim());
    const deferredRecover = () => {
      const child = spawn(process.execPath, ['-e', fixture(recoverPrimaryShellCommandSource())], { env });
      let stdout = ''; child.stdout.on('data', data => { stdout += data; });
      return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ code, stdout })); });
    };
    try {
      mkdirSync(join(directory, '.codex')); writeFileSync(join(directory, '.codex', 'auth.json'), '{"fixture":"unchanged"}');
      writeFileSync(join(directory, 'workspace.txt'), 'work in progress');
      expect(inspect()).toMatchObject({ status: 0, stdout: complete('closed') });
      // Supplemental creation works even when the entire tmux server is absent.
      const supplemental = shellTarget(randomUUID());
      expect(execute(fixture(shellCommandSource(supplemental, 'ensure')))).toMatchObject({ status: 0, stdout: complete('open') });
      expect(recover()).toMatchObject({ status: 0, stdout: complete('open') });
      tmux('set-environment', '-t', '=ephemeral', 'EPHEMERAL_RECOVERY_FIXTURE', 'preserved');
      const initial = pid(); expect(recover()).toMatchObject({ status: 0, stdout: complete('open') }); expect(pid()).toBe(initial);
      tmux('send-keys', '-t', '=ephemeral:', 'exit', 'Enter'); await waitFor(() => inspect().stdout === complete('closed'));
      expect(tmux('list-sessions', '-F', '#{session_name}')).toContain('ephemeral');
      const outcomes = await Promise.all([deferredRecover(), deferredRecover()]);
      expect(outcomes).toEqual([{ code: 0, stdout: complete('open') }, { code: 0, stdout: complete('open') }]);
      const recovered = pid(); expect(recovered).not.toBe(initial);
      const marker = join(directory, 'recovered-environment');
      tmux('send-keys', '-t', '=ephemeral:', `printf '%s' "$EPHEMERAL_RECOVERY_FIXTURE" > '${marker}'`, 'Enter');
      await waitFor(() => existsSync(marker)); expect(readFileSync(marker, 'utf8')).toBe('preserved');
      expect(readFileSync(join(directory, '.codex', 'auth.json'), 'utf8')).toBe('{"fixture":"unchanged"}');
      expect(readFileSync(join(directory, 'workspace.txt'), 'utf8')).toBe('work in progress');
      tmux('send-keys', '-t', '=ephemeral:', 'C-d'); await waitFor(() => inspect().stdout === complete('closed'));
      expect(recover()).toMatchObject({ status: 0, stdout: complete('open') }); expect(pid()).not.toBe(recovered);
      expect(execute(fixture(shellCommandSource(supplemental, 'close')))).toMatchObject({ status: 0, stdout: complete('closed') });
      expect(inspect()).toMatchObject({ status: 0, stdout: complete('open') });
      expect(() => shellCommandSource('ephemeral', 'close')).toThrow('protected');
    } finally { spawnSync('tmux', ['-S', socket, 'kill-server'], { timeout: 2000 }); rmSync(directory, { recursive: true, force: true }); }
  }, 25_000);
});
