import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sandbox } from 'e2b';
import type { Session } from '../server/contracts.js';
import { E2BProvider } from '../server/infra/e2b.js';
import { PreviewProvider } from '../server/preview.js';
import { shellCommand, shellTarget, SHELL_FRAME } from '../server/infra/terminal-shell.js';

const stubs = vi.hoisted(() => ({ get: vi.fn(), run: vi.fn(), create: vi.fn(), sendInput: vi.fn(), kill: vi.fn(), disconnect: vi.fn(), wait: vi.fn() }));
vi.mock('e2b', async importOriginal => {
  const actual = await importOriginal<typeof import('e2b')>();
  return { ...actual, ApiClient: class { api = { GET: stubs.get }; }, Sandbox: class extends actual.Sandbox {
    constructor(...args: ConstructorParameters<typeof actual.Sandbox>) {
      super(...args);
      Object.defineProperty(this, 'commands', { value: { run: stubs.run } });
      Object.defineProperty(this, 'pty', { value: { create: stubs.create, sendInput: stubs.sendInput, kill: stubs.kill } });
    }
  } };
});
const id = '681d9186-c197-4d05-aa52-1bbdca4404d7';
const session = (): Session => ({ id: 'session', userId: 'owner', sandboxId: 'sandbox-a', repository: 'org/repo', repositoryId: 12,
  installationId: 1, baseBranch: 'main', branch: 'work', state: 'running', createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(), maxExpiresAt: new Date(Date.now() + 120_000).toISOString(),
  endedAt: null, error: null, codexRemoteRevocation: 'unverified', cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' } });
const info = () => ({ sandboxID: 'sandbox-a', state: 'running', envdVersion: '0.4.0', envdAccessToken: 'private-provider-token', lifecycle: { autoResume: false },
  metadata: { ephemeral_session_id: 'session', ephemeral_user_id: 'owner', ephemeral_repository: 'org/repo', ephemeral_repository_id: '12', ephemeral_branch: 'work' } });
const result = (state: string) => ({ exitCode: 0, stdout: JSON.stringify({ state }) + SHELL_FRAME });
const provider = () => new E2BProvider({ apiKey: 'test-only-key', templateId: 'test-template', gatewayUrl: 'https://gateway.example.test' });
beforeEach(() => {
  stubs.get.mockReset().mockResolvedValue({ data: info() }); stubs.run.mockReset().mockResolvedValue(result('open'));
  stubs.wait.mockReset().mockImplementation(() => new Promise(() => {}));
  stubs.disconnect.mockReset().mockResolvedValue(undefined); stubs.create.mockReset().mockResolvedValue({ pid: 123, disconnect: stubs.disconnect, wait: stubs.wait });
  stubs.sendInput.mockReset().mockResolvedValue(undefined); stubs.kill.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('supplemental shell provider boundaries', () => {
  it('rejects target expressions, command fragments and attempts to mutate Codex before provider calls', async () => {
    for (const invalid of ['ephemeral', '=ephemeral', 'codex;whoami', `${id}'`, `$(echo ${id})`, '../codex', '']) {
      expect(() => shellTarget(invalid)).toThrow();
      await expect(provider().ensureShell(session(), invalid)).rejects.toThrow();
      await expect(provider().connectTerminal('sandbox-a', () => {}, 80, 24, invalid)).rejects.toThrow();
    }
    await expect(provider().ensureShell(session(), 'codex')).rejects.toThrow('protected');
    await expect(provider().closeShell(session(), 'codex')).rejects.toThrow('protected');
    expect(stubs.get).not.toHaveBeenCalled(); expect(stubs.run).not.toHaveBeenCalled();
  });

  it('explicit creation is idempotent and identity verified with no resume or deadline mutation', async () => {
    const connect = vi.spyOn(Sandbox, 'connect'), timeout = vi.spyOn(Sandbox, 'setTimeout'), create = vi.spyOn(Sandbox, 'create');
    const p = provider(), s = session(), original = structuredClone(s);
    expect(await p.ensureShell(s, id)).toBe('open'); expect(await p.ensureShell(s, id)).toBe('open');
    expect(stubs.run).toHaveBeenCalledWith(shellCommand(id, 'ensure'), expect.objectContaining({ user: 'user', cwd: '/home/user/workspace', timeoutMs: 10_000 }));
    expect(s).toEqual(original); expect(connect).not.toHaveBeenCalled(); expect(timeout).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    stubs.get.mockResolvedValueOnce({ data: { ...info(), metadata: { ...info().metadata, ephemeral_user_id: 'foreign' } } });
    await expect(p.ensureShell(s, id)).rejects.toThrow('Unable to open workspace shell.');
    expect(stubs.run).toHaveBeenCalledTimes(2);
  });

  it('attachment and inspection never create shells and reject a missing session before allocating a PTY', async () => {
    const p = provider(), connect = vi.spyOn(Sandbox, 'connect'), timeout = vi.spyOn(Sandbox, 'setTimeout');
    stubs.run.mockResolvedValueOnce(result('closed'));
    await expect(p.connectTerminal('sandbox-a', () => {}, 80, 24, id)).rejects.toThrow('Unable to attach sandbox terminal.');
    expect(stubs.create).not.toHaveBeenCalled();
    stubs.run.mockResolvedValueOnce(result('closed'));
    expect(await p.inspectShell(session(), id)).toBe('closed');
    await p.connectTerminal('sandbox-a', () => {}, 80, 24, id);
    expect(new TextDecoder().decode(stubs.sendInput.mock.calls[0][1])).toBe(`exec tmux attach-session -t '=ephemeral-shell-${id}'\r`);
    for (const [command] of stubs.run.mock.calls) expect(command).toBe(shellCommand(id, 'inspect'));
    expect(connect).not.toHaveBeenCalled(); expect(timeout).not.toHaveBeenCalled();
  });

  it('declines paused and expired workspaces and masks SDK errors and incomplete close frames', async () => {
    const p = provider();
    stubs.get.mockResolvedValueOnce({ data: { ...info(), state: 'paused' } });
    expect(await p.inspectShell(session(), id)).toBe('unknown'); expect(stubs.run).not.toHaveBeenCalled();
    await expect(p.ensureShell({ ...session(), maxExpiresAt: new Date(0).toISOString() }, id)).rejects.toThrow('Unable to open workspace shell.');
    stubs.get.mockRejectedValueOnce(new Error('private-provider-token'));
    await expect(p.connectTerminal('sandbox-a', () => {}, 80, 24, id)).rejects.toThrow('Unable to attach sandbox terminal.');
    stubs.run.mockResolvedValueOnce({ exitCode: 0, stdout: '{"state":"closed"}' });
    await expect(p.closeShell(session(), id)).rejects.toThrow('Workspace shell termination could not be confirmed.');
    stubs.run.mockResolvedValue(result('closed'));
    expect(await p.closeShell(session(), id)).toBe('closed'); expect(await p.closeShell(session(), id)).toBe('closed');
    expect(stubs.kill).not.toHaveBeenCalled();
  });

  it('recovers only a verified running primary and never connects, extends, or destroys the VM', async () => {
    const p = provider(), connect = vi.spyOn(Sandbox, 'connect'), timeout = vi.spyOn(Sandbox, 'setTimeout'), kill = vi.spyOn(Sandbox, 'kill');
    expect(await p.recoverPrimaryShell(session())).toBe('open');
    expect(stubs.run.mock.calls[0][0]).toContain('recover');
    expect(connect).not.toHaveBeenCalled(); expect(timeout).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled(); expect(stubs.kill).not.toHaveBeenCalled();
    for (const change of [{ state: 'paused' }, { endAt: new Date(0).toISOString() }, { metadata: { ...info().metadata, ephemeral_user_id: 'foreign' } }]) {
      stubs.get.mockResolvedValueOnce({ data: { ...info(), ...change } });
      await expect(p.recoverPrimaryShell(session())).rejects.toThrow('Primary shell recovery could not be confirmed.');
    }
    await expect(p.recoverPrimaryShell({ ...session(), state: 'ended' })).rejects.toThrow('Primary shell recovery could not be confirmed.');
    expect(stubs.run).toHaveBeenCalledTimes(1);
  });

  it.each(['before', 'during', 'after'] as const)('reports PTY wait completion %s listener registration and replays to late listeners', async when => {
    let finish!: () => void;
    if (when === 'before') stubs.wait.mockResolvedValueOnce({ exitCode: 0 });
    else stubs.wait.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const connection = await provider().connectTerminal('sandbox-a', () => {}, 80, 24);
    if (when === 'during') finish(); // Settled wait whose completion callback has not run yet.
    const listener = vi.fn(); const unsubscribe = connection.onExit!(listener);
    if (when === 'after') finish();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    const late = vi.fn(); connection.onExit!(late); expect(late).toHaveBeenCalledOnce(); unsubscribe();
    await expect(connection.write('late')).rejects.toThrow('disconnected');
    await connection.disconnect(); expect(stubs.kill).toHaveBeenCalledWith(123, expect.anything());
    const detached = vi.fn(); connection.onExit!(detached); expect(detached).not.toHaveBeenCalled();
  });

  it('isolates exit observer failures while notifying every observer once', async () => {
    let finish!: () => void; stubs.wait.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const connection = await provider().connectTerminal('sandbox-a', () => {}, 80, 24), next = vi.fn();
    connection.onExit!(() => { throw new Error('observer failed'); }); connection.onExit!(next); finish();
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    expect(() => connection.onExit!(() => { throw new Error('late observer failed'); })).not.toThrow();
    await connection.disconnect();
  });

  it('masks wait transport failures and suppresses intentional disconnect exit notifications', async () => {
    let reject!: (error: Error) => void; stubs.wait.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const connection = await provider().connectTerminal('sandbox-a', () => {}, 80, 24), listener = vi.fn(); connection.onExit!(listener);
    await connection.disconnect(); reject(new Error('private-provider-token')); await Promise.resolve(); expect(listener).not.toHaveBeenCalled();
    stubs.wait.mockRejectedValueOnce(new Error('private-provider-token'));
    const failed = await provider().connectTerminal('sandbox-a', () => {}, 80, 24), ended = vi.fn(); failed.onExit!(ended);
    await vi.waitFor(() => expect(ended).toHaveBeenCalledOnce()); await failed.disconnect();
  });

  it('preview labels the shell as simulation, echoes without executing, and only attaches explicitly opened shells', async () => {
    vi.useFakeTimers();
    const p = new PreviewProvider(), s = session(), output: string[] = [];
    expect(await p.inspectShell(s, id)).toBe('closed');
    await expect(p.connectTerminal('sandbox-a', () => {}, 80, 24, id)).rejects.toThrow('closed');
    expect(await p.ensureShell(s, id)).toBe('open'); expect(await p.ensureShell(s, id)).toBe('open');
    const terminal = await p.connectTerminal('sandbox-a', data => output.push(Buffer.from(data).toString()), 80, 24, id);
    await vi.advanceTimersByTimeAsync(50); await terminal.write('touch /tmp/should-never-exist\r');
    expect(output.join('')).toContain('SHELL SIMULATION'); expect(output.join('')).toContain('commands are not executed');
    expect(await p.closeShell(s, id)).toBe('closed'); expect(await p.closeShell(s, id)).toBe('closed');
    await expect(p.ensureShell(s, id)).rejects.toThrow('generation is closed');
    await expect(p.connectTerminal('sandbox-a', () => {}, 80, 24, id)).rejects.toThrow('closed');
    expect(await p.inspectShell(s, 'codex')).toBe('open'); await terminal.disconnect();
  });
});
