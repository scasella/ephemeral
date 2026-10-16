import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Sandbox } from 'e2b';
import type { Session } from '../server/contracts.js';
import { E2BProvider } from '../server/infra/e2b.js';
import { PreviewProvider } from '../server/preview.js';
import { WORKSPACE_FILES_FRAME } from '../server/infra/workspace-files.js';

const stubs = vi.hoisted(() => ({ get: vi.fn(), run: vi.fn(), send: vi.fn(), close: vi.fn(), wait: vi.fn() }));
vi.mock('e2b', async importOriginal => {
  const actual = await importOriginal<typeof import('e2b')>();
  return { ...actual, ApiClient: class { api = { GET: stubs.get }; }, Sandbox: class extends actual.Sandbox {
    constructor(...args: ConstructorParameters<typeof actual.Sandbox>) { super(...args); Object.defineProperty(this, 'commands', { value: { run: stubs.run } }); }
  } };
});
const session = (): Session => ({ id: 'session', userId: 'owner', sandboxId: 'sandbox-a', repository: 'org/repo', repositoryId: 12,
  installationId: 1, baseBranch: 'main', branch: 'work', state: 'running', createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(), maxExpiresAt: new Date(Date.now() + 120_000).toISOString(),
  endedAt: null, error: null, codexRemoteRevocation: 'unverified', cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' } });
const info = () => ({ sandboxID: 'sandbox-a', state: 'running', envdVersion: '0.4.0', envdAccessToken: 'private-provider-token', lifecycle: { autoResume: false },
  endAt: new Date(Date.now() + 60_000).toISOString(),
  metadata: { ephemeral_session_id: 'session', ephemeral_user_id: 'owner', ephemeral_repository: 'org/repo', ephemeral_repository_id: '12', ephemeral_branch: 'work' } });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const file = () => ({ path: 'src/app.ts', content: 'original\n', version: hash('original\n'), simulation: false });
const result = (body: unknown) => ({ exitCode: 0, stdout: JSON.stringify(body) + WORKSPACE_FILES_FRAME });
const provider = () => new E2BProvider({ apiKey: 'private-api-key', templateId: 'test-template', gatewayUrl: 'https://gateway.example.test' });
type OutputOptions = { signal: AbortSignal; onStdout: (chunk: string) => void; onStderr: (chunk: string) => void };
const pending = () => new Promise<never>(() => {});
beforeEach(() => {
  stubs.get.mockReset().mockResolvedValue({ data: info() }); stubs.send.mockReset().mockResolvedValue(undefined); stubs.close.mockReset().mockResolvedValue(undefined);
  stubs.wait.mockReset().mockResolvedValue(result({ ok: true, value: file() }));
  stubs.run.mockReset().mockResolvedValue({ sendStdin: stubs.send, closeStdin: stubs.close, wait: stubs.wait });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('E2B file editor provider identity and transport', () => {
  it('uses a read-only identity lookup, bounded user helper and stdin without connecting or extending VM', async () => {
    const connect = vi.spyOn(Sandbox, 'connect'), timeout = vi.spyOn(Sandbox, 'setTimeout'), create = vi.spyOn(Sandbox, 'create');
    const p = provider(), s = session(), original = structuredClone(s);
    expect(await p.readFile(s, 'src/app.ts')).toEqual(file());
    expect(stubs.get).toHaveBeenCalledWith('/sandboxes/{sandboxID}', { params: { path: { sandboxID: 'sandbox-a' } }, signal: expect.any(AbortSignal) });
    expect(stubs.run).toHaveBeenCalledWith(expect.stringContaining('exec python3 -I -c '), expect.objectContaining({
      user: 'user', cwd: '/home/user/workspace', background: true, stdin: true, timeoutMs: 10_000, requestTimeoutMs: 12_000, signal: expect.any(AbortSignal),
    }));
    expect(stubs.send).toHaveBeenCalledWith(JSON.stringify({ operation: 'read', path: 'src/app.ts' }) + '\n', expect.objectContaining({ requestTimeoutMs: 5_000 }));
    expect(stubs.close).not.toHaveBeenCalled(); expect(stubs.wait).toHaveBeenCalled();
    expect(s).toEqual(original); expect(connect).not.toHaveBeenCalled(); expect(timeout).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });
  it('lists directories and sends optimistic writes as bounded stdin data', async () => {
    const p = provider(), directory = { path: '', entries: [{ path: 'src', name: 'src', kind: 'directory' }], truncated: false, simulation: false };
    stubs.wait.mockResolvedValueOnce(result({ ok: true, value: directory }));
    expect(await p.listFiles(session(), '')).toEqual(directory);
    const content = '\t\n\r"\\'.repeat(26214) + 'ab', value = { path: 'src/app.ts', content, expectedVersion: hash('original\n') };
    stubs.wait.mockResolvedValueOnce(result({ ok: true, value: { ...value, version: hash(content), simulation: false } }));
    expect((await p.writeFile(session(), value)).content).toBe(content);
    expect(stubs.send).toHaveBeenLastCalledWith(JSON.stringify({ operation: 'write', ...value }) + '\n', expect.anything());
    expect(Buffer.byteLength(stubs.run.mock.calls[1][0])).toBeLessThan(16_000);
    expect(stubs.run.mock.calls[1][0]).not.toContain(content);
  });
  it.each(['run', 'stdin', 'wait'] as const)('stops accumulating stdout or stderr floods during %s before a command result exists', async phase => {
    for (const stream of ['stdout', 'stderr'] as const) {
      let options!: OutputOptions, bytes = 0, chunks = 0, callbackError: unknown;
      const budget = stream === 'stdout' ? 1_000_000 : 64 * 1024;
      const chunk = 'private-guest-token '.repeat(128);
      const flood = () => {
        try {
          // Emulate the SDK: it retains a chunk, then awaits the callback and
          // stops consuming the iterator when that callback throws.
          for (let i = 0; i < 10_000; i++) {
            bytes += Buffer.byteLength(chunk); chunks++;
            (stream === 'stdout' ? options.onStdout : options.onStderr)(chunk);
          }
        } catch (error) { callbackError = error; }
        return pending(); // A compromised guest never sends its final result.
      };
      stubs.run.mockImplementationOnce((_command, supplied: OutputOptions) => {
        options = supplied;
        return phase === 'run' ? flood() : Promise.resolve({ sendStdin: stubs.send, wait: stubs.wait });
      });
      if (phase === 'stdin') stubs.send.mockImplementationOnce(flood);
      if (phase === 'wait') stubs.wait.mockImplementationOnce(flood);
      const error = await provider().readFile(session(), 'src/app.ts').catch(error => error);
      expect(error).toMatchObject({ status: 503, code: 'unavailable', message: 'The running workspace is unavailable. Refresh and try again.' });
      expect(error.message).not.toContain('private-guest-token');
      expect(callbackError).toBeInstanceOf(Error);
      expect((callbackError as Error).message).toBe('Workspace file operation unavailable.');
      expect(options.signal.aborted).toBe(true);
      expect(chunks).toBeGreaterThan(1);
      expect(bytes).toBeGreaterThan(budget);
      expect(bytes).toBeLessThanOrEqual(budget + Buffer.byteLength(chunk));
    }
    expect(stubs.send).toHaveBeenCalledTimes(phase === 'run' ? 0 : 2);
    expect(stubs.wait).toHaveBeenCalledTimes(phase === 'wait' ? 2 : 0);
  });
  it.each(['stdout', 'stderr'] as const)('counts UTF-8 bytes across many %s chunks and rejects the first byte over budget', async stream => {
    let options!: OutputOptions, atBudgetAborted = true, callbackError: unknown;
    const budget = stream === 'stdout' ? 1_000_000 : 64 * 1024;
    stubs.run.mockImplementationOnce((_command, supplied: OutputOptions) => {
      options = supplied;
      const output = stream === 'stdout' ? options.onStdout : options.onStderr;
      for (let i = 0; i < Math.floor(budget / 1_000); i++) output('é'.repeat(500));
      output('é'.repeat((budget % 1_000) / 2));
      atBudgetAborted = options.signal.aborted;
      try { output('x'); } catch (error) { callbackError = error; }
      return pending();
    });
    await expect(provider().readFile(session(), 'src/app.ts')).rejects.toMatchObject({ status: 503, code: 'unavailable' });
    expect(atBudgetAborted).toBe(false);
    expect(callbackError).toEqual(new Error('Workspace file operation unavailable.'));
    expect(options.signal.aborted).toBe(true);
  });
  it('accepts exact stream budgets and a maximum-sized file escaped as JSON', async () => {
    const content = '\u00a0'.repeat(65_536), value = { ...file(), content, version: hash(content) };
    expect(Buffer.byteLength(content)).toBe(128 * 1024);
    // The Python helper uses ensure_ascii=True, including for multibyte text.
    const escaped = result({ ok: true, value }).stdout.replace(/[^\x00-\x7f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
    stubs.run.mockImplementationOnce((_command, options: OutputOptions) => {
      for (let offset = 0; offset < escaped.length; offset += 4_096) options.onStdout(escaped.slice(offset, offset + 4_096));
      return Promise.resolve({ sendStdin: stubs.send, wait: stubs.wait });
    });
    stubs.wait.mockResolvedValueOnce({ exitCode: 0, stdout: escaped, stderr: '' });
    expect(await provider().readFile(session(), value.path)).toEqual(value);

    const body = { ok: true, value: file(), padding: '' };
    body.padding = 'x'.repeat(1_000_000 - Buffer.byteLength(result(body).stdout));
    const stdout = result(body).stdout, stderr = 'é'.repeat(32_768);
    expect(Buffer.byteLength(stdout)).toBe(1_000_000);
    stubs.run.mockImplementationOnce((_command, options: OutputOptions) => {
      options.onStdout(stdout); options.onStderr(stderr);
      expect(options.signal.aborted).toBe(false);
      return Promise.resolve({ sendStdin: stubs.send, wait: stubs.wait });
    });
    stubs.wait.mockResolvedValueOnce({ exitCode: 0, stdout, stderr });
    expect(await provider().readFile(session(), 'src/app.ts')).toEqual(file());
  });
  it.each(['run', 'stdin', 'wait'] as const)('honors the operation abort signal while %s has no response', async phase => {
    const deadline = new AbortController(), timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => ms === 12_000 ? deadline.signal : timeout(ms));
    const add = vi.spyOn(AbortSignal.prototype, 'addEventListener'), remove = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
    let entered!: () => void, options!: OutputOptions;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const idle = () => { entered(); return pending(); };
    stubs.run.mockImplementationOnce((_command, supplied: OutputOptions) => {
      options = supplied;
      return phase === 'run' ? idle() : Promise.resolve({ sendStdin: stubs.send, wait: stubs.wait });
    });
    if (phase === 'stdin') stubs.send.mockImplementationOnce(idle);
    if (phase === 'wait') stubs.wait.mockImplementationOnce(idle);
    const operation = provider().readFile(session(), 'src/app.ts').catch(error => error);
    await started; deadline.abort();
    expect(await operation).toMatchObject({ status: 503, code: 'unavailable' });
    expect(options.signal.aborted).toBe(true);
    expect(stubs.get).toHaveBeenCalledTimes(1); expect(stubs.run).toHaveBeenCalledTimes(1);
    const added = add.mock.calls.filter((_call, index) => add.mock.contexts[index] === options.signal);
    const removed = remove.mock.calls.filter((_call, index) => remove.mock.contexts[index] === options.signal);
    expect(added).toHaveLength(phase === 'run' ? 1 : phase === 'stdin' ? 2 : 3);
    expect(removed.map(([type, listener]) => [type, listener])).toEqual(added.map(([type, listener]) => [type, listener]));
  });
  it('rejects invalid inputs and ended, expired or unsafe sessions before provider lookup', async () => {
    const p = provider(), s = session();
    for (const changes of [{ state: 'ended' as const }, { sandboxId: null }, { sandboxId: '../other' }, { endedAt: new Date().toISOString() },
      { expiresAt: 'invalid' }, { maxExpiresAt: 'invalid' }, { expiresAt: new Date(0).toISOString() }, { maxExpiresAt: new Date(0).toISOString() }]) {
      await expect(p.readFile({ ...s, ...changes }, 'src/app.ts')).rejects.toMatchObject({ status: 503, code: 'unavailable' });
    }
    await expect(p.listFiles(s, '.git')).rejects.toMatchObject({ status: 400 });
    await expect(p.writeFile(s, { path: '../private', content: 'x', expectedVersion: null })).rejects.toMatchObject({ status: 400 });
    expect(stubs.get).not.toHaveBeenCalled(); expect(stubs.run).not.toHaveBeenCalled();
  });
  it('refuses mismatched identities, paused/resumable sandboxes and expired provider resources', async () => {
    const p = provider(), original = info();
    for (const changes of [{ sandboxID: 'foreign' }, { state: 'paused' }, { lifecycle: { autoResume: true } }, { lifecycle: undefined },
      { endAt: 'invalid' }, { endAt: new Date(0).toISOString() },
      ...Object.keys(original.metadata).map(key => ({ metadata: { ...original.metadata, [key]: 'foreign' } }))]) {
      stubs.get.mockResolvedValueOnce({ data: { ...original, ...changes } });
      await expect(p.readFile(session(), 'src/app.ts')).rejects.toMatchObject({ status: 503, code: 'unavailable' });
    }
    expect(stubs.run).not.toHaveBeenCalled();
  });
  it('rechecks session expiry after a slow identity lookup', async () => {
    vi.useFakeTimers(); const s = session(), original = info();
    stubs.get.mockImplementationOnce(async () => { vi.advanceTimersByTime(61_000); return { data: original }; });
    await expect(provider().readFile(s, 'src/app.ts')).rejects.toMatchObject({ status: 503 });
    expect(stubs.run).not.toHaveBeenCalled();
  });
  it.each([[400, 'invalid_path'], [404, 'not_found'], [409, 'conflict'], [413, 'too_large'], [415, 'unsupported'], [503, 'unavailable']])('returns safe structured helper failure %s', async (status, code) => {
    stubs.wait.mockResolvedValueOnce(result({ ok: false, status, code, message: 'private-provider-token /home/user/.codex/auth.json' }));
    const error = await provider().readFile(session(), 'src/app.ts').catch(error => error);
    expect(error).toMatchObject({ status, code }); expect(error.message).not.toContain('private-provider-token'); expect(error.message).not.toContain('/home/');
  });
  it('masks SDK failures and rejects unframed, oversized, wrong-path, wrong-hash or simulated snapshots', async () => {
    const p = provider();
    stubs.get.mockRejectedValueOnce(new Error('private-api-key'));
    await expect(p.readFile(session(), 'src/app.ts')).rejects.toMatchObject({ status: 503, message: 'The running workspace is unavailable. Refresh and try again.' });
    const variants = [ { exitCode: 0, stdout: JSON.stringify(file()) }, { exitCode: 0, stdout: 'x'.repeat(1_000_001) + WORKSPACE_FILES_FRAME },
      result({ ok: true, value: file(), padding: 'é'.repeat(500_000) }),
      { ...result({ ok: true, value: file() }), stderr: 'é'.repeat(32_769) },
      result({ ok: false, status: 200, code: 'conflict' }), result({ ok: true, value: { ...file(), path: 'other' } }),
      result({ ok: true, value: { ...file(), simulation: true } }), result({ ok: true, value: { ...file(), version: hash('different') } }) ];
    for (const value of variants) {
      stubs.wait.mockResolvedValueOnce(value);
      await expect(p.readFile(session(), 'src/app.ts')).rejects.toMatchObject({ status: 503, code: 'unavailable' });
    }
  });
});

describe('local file editor simulation', () => {
  it('browses and edits isolated in-memory fixtures, detects conflicts, and clears on kill', async () => {
    const p = new PreviewProvider(), s = session(), other = { ...s, id: 'other', sandboxId: 'sandbox-b' };
    const list = await p.listFiles(s, ''); expect(list.simulation).toBe(true); expect(list.entries.map(entry => entry.name)).toEqual(['src', 'package.json', 'README.md']);
    const original = await p.readFile(s, 'src/app.ts'); expect(original.simulation).toBe(true);
    expect(await p.writeFile(s, { path: original.path, content: 'edited', expectedVersion: original.version })).toMatchObject({ content: 'edited', simulation: true });
    expect((await p.readFile(other, original.path)).content).toBe(original.content);
    await expect(p.writeFile(s, { path: original.path, content: 'stale', expectedVersion: original.version })).rejects.toMatchObject({ status: 409 });
    await expect(p.writeFile(s, { path: original.path, content: 'clobber', expectedVersion: null })).rejects.toMatchObject({ status: 409 });
    await expect(p.writeFile(s, { path: 'missing/new', content: '', expectedVersion: null })).rejects.toMatchObject({ status: 404 });
    expect(await p.writeFile(s, { path: 'src/new.ts', content: 'new', expectedVersion: null })).toMatchObject({ content: 'new', simulation: true });
    await p.kill(s.sandboxId!);
    await expect(p.readFile(s, original.path)).rejects.toMatchObject({ status: 503 });
    expect((p as unknown as { files: Map<string, unknown> }).files.has(s.sandboxId!)).toBe(false);
    expect((await p.readFile(other, original.path)).content).toBe(original.content);
    expect(stubs.run).not.toHaveBeenCalled(); expect(stubs.get).not.toHaveBeenCalled();
  });
  it('applies path, byte-size, text and lifecycle restrictions to simulation', async () => {
    const p = new PreviewProvider(), s = session();
    await expect(p.readFile(s, '.git/config')).rejects.toMatchObject({ status: 400 });
    await expect(p.readFile(s, 'src')).rejects.toMatchObject({ status: 415 });
    await expect(p.readFile(s, 'missing')).rejects.toMatchObject({ status: 404 });
    await expect(p.listFiles(s, 'src/app.ts')).rejects.toMatchObject({ status: 415 });
    await expect(p.writeFile(s, { path: 'file', content: 'x'.repeat(131073), expectedVersion: null })).rejects.toMatchObject({ status: 413 });
    await expect(p.writeFile(s, { path: 'file', content: '\0', expectedVersion: null })).rejects.toMatchObject({ status: 415 });
    await expect(p.readFile({ ...s, state: 'ended' }, 'README.md')).rejects.toMatchObject({ status: 503 });
  });
});
