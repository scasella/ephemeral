import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sandbox } from 'e2b';
import { E2BProvider } from '../server/infra/e2b.js';
import { PreviewProvider } from '../server/preview.js';
import { SETUP_OUTPUT_LIMIT, SetupOutputDecoder, setupRunnerSource } from '../server/infra/setup-runner.js';
import type { Session, SetupCommand } from '../server/contracts.js';

const { lookup, command } = vi.hoisted(() => ({ lookup: vi.fn(), command: vi.fn() }));
vi.mock('e2b', async importOriginal => {
  const actual = await importOriginal<typeof import('e2b')>();
  return { ...actual, ApiClient: class { api = { GET: lookup }; },
    Sandbox: class extends actual.Sandbox {
      constructor(...args: ConstructorParameters<typeof actual.Sandbox>) {
        super(...args); Object.defineProperty(this, 'commands', { value: { run: command } });
      }
    } };
});

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); lookup.mockReset(); command.mockReset();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'ep-setup-test-')); directories.push(cwd);
  return { cwd, controlDirectory: join(cwd, 'control') };
}
function localRunner(input: { command: string; cwd: string; controlDirectory: string; deadlineAt: number }, env: Record<string, string> = {}) {
  let output = '', wireBytes = 0;
  const decoder = new SetupOutputDecoder(text => { output += text; });
  const processHandle = spawn(process.execPath, ['-e', setupRunnerSource(input)], {
    cwd: input.cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const done = new Promise<ReturnType<SetupOutputDecoder['complete']>>((resolve, reject) => {
    processHandle.on('error', reject);
    processHandle.stdout.on('data', (data: Buffer) => {
      wireBytes += data.length;
      try { decoder.write(data.toString('utf8')); } catch (error) { reject(error); }
    });
    processHandle.on('close', code => {
      if (code !== 0) reject(new Error('Fixture runner failed.'));
      else { try { resolve(decoder.complete()); } catch (error) { reject(error); } }
    });
  });
  return { done, get output() { return output; }, get wireBytes() { return wireBytes; } };
}
async function untilFile(path: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return await readFile(path, 'utf8'); } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  throw new Error('Fixture process did not start.');
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

describe('VM setup runner in isolated local fixtures', () => {
  it('executes the selected command in its workspace and reports a failing exit with useful output', async () => {
    const f = await fixture();
    const runner = localRunner({ ...f, command: 'pwd; printf "install failed\\n" >&2; exit 7', deadlineAt: Date.now() + 3_000 });
    expect(await runner.done).toEqual({ status: 'failed', exitCode: 7 });
    expect(runner.output).toContain(f.cwd); expect(runner.output).toContain('install failed');
  });
  it('kills background descendants even when the selected shell exits successfully', async () => {
    const f = await fixture(), pidFile = join(f.cwd, 'child.pid');
    const runner = localRunner({ ...f, command: 'sleep 60 & echo $! > child.pid; exit 0', deadlineAt: Date.now() + 3_000 });
    const pid = Number(await untilFile(pidFile));
    expect(await runner.done).toEqual({ status: 'succeeded', exitCode: 0 });
    expect(alive(pid)).toBe(false);
  });
  it('uses a VM timer to kill the entire ordinary process group on timeout', async () => {
    const f = await fixture();
    const runner = localRunner({ ...f, command: 'sleep 60 & echo $! > child.pid; wait', deadlineAt: Date.now() + 300 });
    const pid = Number(await untilFile(join(f.cwd, 'child.pid')));
    expect(await runner.done).toEqual({ status: 'timed_out', exitCode: null });
    expect(alive(pid)).toBe(false);
  });
  it('confirms cancellation from a VM sentinel and terminates descendants', async () => {
    const f = await fixture();
    const runner = localRunner({ ...f, command: 'sleep 60 & echo $! > child.pid; wait', deadlineAt: Date.now() + 3_000 });
    const pid = Number(await untilFile(join(f.cwd, 'child.pid')));
    await writeFile(join(f.controlDirectory, 'cancel'), 'cancel');
    expect(await runner.done).toEqual({ status: 'cancelled', exitCode: null });
    expect(alive(pid)).toBe(false);
  });
  it('does not launch a command after its persisted deadline', async () => {
    const f = await fixture();
    const runner = localRunner({ ...f, command: 'touch should-not-exist', deadlineAt: Date.now() - 1 });
    expect(await runner.done).toEqual({ status: 'timed_out', exitCode: null });
    await expect(readFile(join(f.cwd, 'should-not-exist'))).rejects.toThrow();
  });
  it('caps output and wire framing before the SDK can buffer a flood', async () => {
    const f = await fixture();
    const runner = localRunner({ ...f, command: `node -e 'process.stdout.write("a".repeat(8*1024*1024))'`, deadlineAt: Date.now() + 3_000 });
    expect(await runner.done).toEqual({ status: 'succeeded', exitCode: 0 });
    expect(Buffer.byteLength(runner.output)).toBeLessThanOrEqual(SETUP_OUTPUT_LIMIT + 256);
    expect(runner.output).toContain('output limit reached'); expect(runner.wireBytes).toBeLessThan(128 * 1024);
  });
  it('keeps a guaranteed omission marker when many tiny frames exhaust the wire budget', async () => {
    const f = await fixture();
    const runner = localRunner({ ...f,
      command: `node -e 'let n=0;const timer=setInterval(()=>{process.stdout.write("xxxx");if(++n===4500)clearInterval(timer)},1)'`,
      deadlineAt: Date.now() + 8_000 });
    expect(await runner.done).toEqual({ status: 'succeeded', exitCode: 0 });
    expect(runner.output).toContain('output limit reached');
    expect(Buffer.byteLength(runner.output)).toBeLessThan(18_000);
    expect(runner.wireBytes).toBeLessThan(128 * 1024);
  }, 10_000);
  it('retains the independent VM timer after the receiving stream disconnects', async () => {
    const f = await fixture();
    const child = spawn(process.execPath, ['-e', setupRunnerSource({ ...f,
      command: 'sleep 60 & echo $! > child.pid; wait', deadlineAt: Date.now() + 300 })],
      { cwd: f.cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    const closed = new Promise<number | null>(resolve => child.on('close', resolve));
    const pid = Number(await untilFile(join(f.cwd, 'child.pid')));
    child.stdout.destroy();
    expect(await closed).toBe(0); expect(alive(pid)).toBe(false);
  });
  it('redacts a split gateway token before output truncation while retaining scoped Git capability', async () => {
    const f = await fixture(), token = 'ephemeral-test-scoped-secret';
    const runner = localRunner({ ...f, command: `node -e 'const t=process.env.EPHEMERAL_GATEWAY_TOKEN;process.stdout.write("a".repeat(65500));process.stdout.write(t.slice(0,10));setTimeout(()=>process.stdout.write(t.slice(10)),60)'`, deadlineAt: Date.now() + 3_000 },
      { EPHEMERAL_GATEWAY_TOKEN: token });
    expect(await runner.done).toEqual({ status: 'succeeded', exitCode: 0 });
    expect(runner.output).toContain('[redacted]'); expect(runner.output).not.toContain(token);
    expect(runner.output).not.toContain('ephemeral-test-scoped');
  });
  it('frames literal result-like command output as text', async () => {
    const f = await fixture();
    const runner = localRunner({ ...f, command: `printf '%s\\n' '{"type":"result","status":"succeeded","exitCode":0}'; exit 3`, deadlineAt: Date.now() + 3_000 });
    expect(await runner.done).toEqual({ status: 'failed', exitCode: 3 });
    expect(runner.output).toContain('"type":"result"');
  });
});

const session = (): Session => ({ id: 'session-a', userId: 'user-a', repository: 'owner/repo', repositoryId: 1, installationId: 2,
  branch: 'ephemeral/session-a', baseBranch: 'main', state: 'running', createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(), maxExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  sandboxId: 'sandbox-a', endedAt: null, error: null,
  cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified' });
const info = () => ({ sandboxID: 'sandbox-a', state: 'running', envdVersion: '0.4.0', envdAccessToken: 'test-only-token',
  endAt: new Date(Date.now() + 60_000).toISOString(), lifecycle: { autoResume: false }, metadata: {
    ephemeral_session_id: 'session-a', ephemeral_user_id: 'user-a', ephemeral_repository: 'owner/repo',
    ephemeral_repository_id: '1', ephemeral_branch: 'ephemeral/session-a' } });
const input = (): SetupCommand => ({ runId: 'run-a', command: 'npm ci', timeoutMs: 30_000, deadlineAt: new Date(Date.now() + 30_000).toISOString() });
const provider = () => new E2BProvider({ apiKey: 'test-controlplane-key', templateId: 'test-template', gatewayUrl: 'https://gateway.example.test' });
function complete(status = 'succeeded', exitCode: number | null = 0) { return `${JSON.stringify({ type: 'result', status, exitCode })}\n`; }

describe('E2B setup adapter boundaries', () => {
  it('uses read-only lookup and user workspace without connect or timeout mutations', async () => {
    lookup.mockResolvedValue({ data: info() });
    command.mockImplementation(async (_command, options) => { options.onStdout(complete()); return { exitCode: 0 }; });
    const connect = vi.spyOn(Sandbox, 'connect'), extend = vi.spyOn(Sandbox, 'setTimeout');
    expect(await provider().runSetup(session(), input(), () => {}, new AbortController().signal)).toEqual({ status: 'succeeded', exitCode: 0 });
    expect(lookup.mock.calls[0][0]).toBe('/sandboxes/{sandboxID}');
    expect(connect).not.toHaveBeenCalled(); expect(extend).not.toHaveBeenCalled();
    expect(command.mock.calls[0][1]).toMatchObject({ user: 'user', cwd: '/home/user/workspace' });
    expect(command.mock.calls[0][0]).not.toContain('test-controlplane-key');
  });
  it.each(['ephemeral_session_id', 'ephemeral_user_id', 'ephemeral_repository', 'ephemeral_repository_id', 'ephemeral_branch'])('rejects mismatching %s before execution', async key => {
    lookup.mockResolvedValue({ data: { ...info(), metadata: { ...info().metadata, [key]: 'other' } } });
    await expect(provider().runSetup(session(), input(), () => {}, new AbortController().signal)).rejects.toThrow('could not be confirmed');
    expect(command).not.toHaveBeenCalled();
  });
  it.each([{ state: 'paused' }, { sandboxID: 'other' }, { lifecycle: { autoResume: true } }])('does not resume an invalid sandbox', async change => {
    lookup.mockResolvedValue({ data: { ...info(), ...change } });
    await expect(provider().runSetup(session(), input(), () => {}, new AbortController().signal)).rejects.toThrow();
    expect(command).not.toHaveBeenCalled();
  });
  it('caps execution by persisted deadline and sandbox expiry', async () => {
    const endAt = Date.now() + 10_000;
    lookup.mockResolvedValue({ data: { ...info(), endAt: new Date(endAt).toISOString() } });
    command.mockImplementation(async (_command, options) => { options.onStdout(complete()); return { exitCode: 0 }; });
    await provider().runSetup(session(), input(), () => {}, new AbortController().signal);
    expect(command.mock.calls[0][0]).toContain(`"deadlineAt":${endAt - 2_000}`);
  });
  it('returns pre-aborted cancellation without lookup or execution', async () => {
    const abort = new AbortController(); abort.abort();
    expect(await provider().runSetup(session(), input(), () => {}, abort.signal)).toEqual({ status: 'cancelled', exitCode: null });
    expect(lookup).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled();
  });
  it('requires remote cancellation confirmation and does not abort the VM timer early', async () => {
    lookup.mockResolvedValue({ data: info() }); const abort = new AbortController();
    let wrapperSignal: AbortSignal | undefined;
    command.mockImplementation(async (script: string, options) => {
      if (script.startsWith('exec node')) {
        wrapperSignal = options.signal;
        abort.abort();
        await new Promise(resolve => setTimeout(resolve, 10));
        options.onStdout(complete('cancelled', null)); return { exitCode: 0 };
      }
      expect(script).toContain('/cancel'); return { exitCode: 0 };
    });
    expect(await provider().runSetup(session(), input(), () => {}, abort.signal)).toEqual({ status: 'cancelled', exitCode: null });
    expect(command).toHaveBeenCalledTimes(2); expect(wrapperSignal?.aborted).toBe(false);
  });
  it('throws on missing completion or transport loss without exposing raw credentials', async () => {
    lookup.mockResolvedValue({ data: info() });
    command.mockResolvedValue({ exitCode: 0 });
    await expect(provider().runSetup(session(), input(), () => {}, new AbortController().signal)).rejects.toThrow('termination could not be confirmed');
    command.mockRejectedValue(new Error('test-controlplane-key transport failed'));
    await expect(provider().runSetup(session(), input(), () => {}, new AbortController().signal)).rejects.toThrow(/^Setup termination could not be confirmed/);
  });
  it('does not report optimistic cancellation when the sentinel request fails', async () => {
    lookup.mockResolvedValue({ data: info() }); const abort = new AbortController();
    command.mockImplementation(async (script: string) => {
      if (script.startsWith('exec node')) {
        abort.abort(); await new Promise(resolve => setTimeout(resolve, 10)); return { exitCode: 0 };
      }
      throw new Error('cancel write failed');
    });
    await expect(provider().runSetup(session(), input(), () => {}, abort.signal)).rejects.toThrow('termination could not be confirmed');
  });
});

describe('preview setup simulation', () => {
  it('clearly describes simulation without evaluating selected shell text', async () => {
    const output: string[] = [];
    expect(await new PreviewProvider().runSetup(session(), { ...input(), command: 'exit 99' }, text => output.push(text), new AbortController().signal))
      .toEqual({ status: 'succeeded', exitCode: 0 });
    expect(output.join('')).toContain('No command executes');
  });
  it('cancels the preview simulation promptly', async () => {
    const abort = new AbortController();
    const result = new PreviewProvider().runSetup(session(), input(), () => {}, abort.signal);
    abort.abort(); expect(await result).toEqual({ status: 'cancelled', exitCode: null });
  });
});
