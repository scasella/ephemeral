import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthenticationError, InvalidArgumentError, RateLimitError, Sandbox, SandboxError, TemplateError, TimeoutError } from 'e2b';
import type { Session } from '../server/contracts.js';
import { SandboxCreationError } from '../server/core/provisioning.js';
import { E2BProvider } from '../server/infra/e2b.js';
import type { PreviewTokenStore } from '../server/infra/application-preview.js';

const stubs = vi.hoisted(() => ({ get: vi.fn(), run: vi.fn(), options: vi.fn(), config: vi.fn() }));
vi.mock('e2b', async importOriginal => {
  const actual = await importOriginal<typeof import('e2b')>();
  return { ...actual, ApiClient: class { api = { GET: stubs.get }; },
    ConnectionConfig: class extends actual.ConnectionConfig {
      constructor(...args: ConstructorParameters<typeof actual.ConnectionConfig>) { super(...args); stubs.config(args[0]); }
    }, Sandbox: class extends actual.Sandbox {
      constructor(...args: ConstructorParameters<typeof actual.Sandbox>) { super(...args); stubs.options(args[0]); Object.defineProperty(this, 'commands', { value: { run: stubs.run } }); }
    } };
});
const s = (): Session => ({ id: 'session', userId: 'owner', sandboxId: 'sandbox-a', repository: 'org/repo', repositoryId: 12,
  installationId: 1, baseBranch: 'main', branch: 'work', state: 'running', createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(), maxExpiresAt: new Date(Date.now() + 120_000).toISOString(),
  endedAt: null, error: null, codexRemoteRevocation: 'unverified', cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' } });
const info = () => ({ sandboxID: 'sandbox-a', state: 'running', envdVersion: '0.4.0', envdAccessToken: 'synthetic-envd-token',
  endAt: new Date(Date.now() + 60_000).toISOString(), lifecycle: { autoResume: false },
  metadata: { ephemeral_session_id: 'session', ephemeral_user_id: 'owner', ephemeral_repository: 'org/repo', ephemeral_repository_id: '12', ephemeral_branch: 'work' } });
const provider = (previewTokens?: PreviewTokenStore) => new E2BProvider({ apiKey: 'synthetic-api-key', templateId: 'test-template', gatewayUrl: 'https://gateway.example.test', previewTokens });
beforeEach(() => {
  stubs.get.mockReset().mockResolvedValue({ data: info(), response: new Response('{}', { status: 200 }) });
  stubs.run.mockReset().mockResolvedValue({ exitCode: 0 }); stubs.options.mockReset(); stubs.config.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('conservative E2B creation outcomes', () => {
  it('asserts no creation only for local expired/invalid deadline preflight', async () => {
    const create = vi.spyOn(Sandbox, 'create');
    for (const deadline of ['invalid', new Date(Date.now() - 1).toISOString()]) {
      await expect(provider().create({ ...s(), expiresAt: deadline }, 'gateway-token')).rejects.toMatchObject({ outcome: 'not_created', reason: 'request_not_sent' });
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('never infers noncreation from arbitrary or SDK errors, status-like text, or network failures', async () => {
    const status408 = Object.assign(new SandboxError('synthetic-secret'), { statusCode: 408 });
    const status500 = Object.assign(new SandboxError('synthetic-secret'), { statusCode: 500 });
    const create = vi.spyOn(Sandbox, 'create');
    for (const error of [new Error('400 synthetic-secret'), new AuthenticationError('synthetic-secret'), new RateLimitError('synthetic-secret'),
      new InvalidArgumentError('synthetic-secret'), new TemplateError('synthetic-secret'), new TimeoutError('synthetic-secret'), status408, status500]) {
      create.mockRejectedValueOnce(error);
      let result: unknown; try { await provider().create(s(), 'gateway-token'); } catch (caught) { result = caught; }
      expect(result).toBeInstanceOf(SandboxCreationError); expect(result).toMatchObject({ outcome: 'unknown', reason: 'request_uncertain' });
      expect((result as Error).message).not.toContain('synthetic-secret');
    }
    expect(create).toHaveBeenCalledTimes(8);
    for (const call of create.mock.calls) expect(call[1]).toMatchObject({ retries: 0, requestTimeoutMs: 60_000, lifecycle: { onTimeout: 'kill', autoResume: false } });
  });

  it('carries the returned VM handle on preview-vault failure even after a kill attempt', async () => {
    vi.spyOn(Sandbox, 'create').mockResolvedValue({ sandboxId: 'known-vm', trafficAccessToken: 'synthetic-traffic-token' } as Sandbox);
    const kill = vi.spyOn(Sandbox, 'kill');
    for (const compensationFails of [false, true]) {
      if (compensationFails) kill.mockRejectedValueOnce(new Error('offline')); else kill.mockResolvedValueOnce(true);
      const vault: PreviewTokenStore = { save: vi.fn().mockRejectedValue(new Error('vault offline')), read: vi.fn(), remove: vi.fn() };
      await expect(provider(vault).create(s(), 'gateway-token')).rejects.toMatchObject({ outcome: 'created', reason: 'resource_record_failed', knownSandboxId: 'known-vm' });
    }
    expect(kill).toHaveBeenCalledTimes(2);
  });
});

describe('read-only Codex cleanup lookup', () => {
  it('uses bounded detail and local construction without connect/resume/timeout mutation', async () => {
    const connect = vi.spyOn(Sandbox, 'connect'), timeout = vi.spyOn(Sandbox, 'setTimeout'), create = vi.spyOn(Sandbox, 'create');
    expect(await provider().cleanupCodex('sandbox-a', s())).toBe(true);
    expect(stubs.get).toHaveBeenCalledWith('/sandboxes/{sandboxID}', { params: { path: { sandboxID: 'sandbox-a' } }, signal: expect.any(AbortSignal) });
    expect(stubs.config).toHaveBeenCalledWith(expect.objectContaining({ requestTimeoutMs: 10_000, retries: 0 }));
    expect(stubs.options).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: 'sandbox-a', envdAccessToken: 'synthetic-envd-token' }));
    expect(stubs.run.mock.calls[0][1]).toMatchObject({ user: 'root', timeoutMs: 10_000, signal: expect.any(AbortSignal) });
    expect(stubs.run.mock.calls[0][0]).toContain('pkill'); expect(stubs.run.mock.calls[1][0]).toContain('codex logout');
    expect(connect).not.toHaveBeenCalled(); expect(timeout).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });

  it('starts no process for paused, expired, mismatched, or unsafe lifecycle state', async () => {
    const original = info();
    for (const override of [{ state: 'paused' }, { lifecycle: { autoResume: true } }, { endAt: 'invalid' }, { endAt: new Date(Date.now() - 1).toISOString() },
      { sandboxID: 'wrong-id' }, { metadata: { ...original.metadata, ephemeral_session_id: 'another' } },
      { metadata: { ...original.metadata, ephemeral_user_id: 'another' } }, { metadata: { ...original.metadata, ephemeral_repository_id: '999' } }]) {
      stubs.get.mockResolvedValueOnce({ data: { ...original, ...override }, response: new Response('{}') });
      expect(await provider().cleanupCodex('sandbox-a', s())).toBe(false);
    }
    expect(await provider().cleanupCodex('sandbox-a', { ...s(), expiresAt: new Date(Date.now() - 1).toISOString() })).toBe(false);
    expect(stubs.run).not.toHaveBeenCalled();
  });

  it('distinguishes trusted absence from failed/ambiguous detail lookup', async () => {
    stubs.get.mockResolvedValueOnce({ error: { code: 404 }, response: new Response('{}', { status: 404 }) });
    expect(await provider().cleanupCodex('sandbox-a', s())).toBe(true);
    stubs.get.mockResolvedValueOnce({ error: { code: 404 }, response: new Response('{}', { status: 503 }) });
    expect(await provider().cleanupCodex('sandbox-a', s())).toBe(false);
    stubs.get.mockRejectedValueOnce(new Error('offline')); expect(await provider().cleanupCodex('sandbox-a', s())).toBe(false);
    expect(stubs.run).not.toHaveBeenCalled();
  });

  it('does not start logout after the sandbox deadline passes during process cleanup', async () => {
    vi.useFakeTimers(); const now = Date.now();
    stubs.get.mockResolvedValueOnce({ data: { ...info(), endAt: new Date(now + 100).toISOString() } });
    stubs.run.mockImplementationOnce(async () => { vi.setSystemTime(now + 101); return { exitCode: 0 }; });
    expect(await provider().cleanupCodex('sandbox-a', s())).toBe(false); expect(stubs.run).toHaveBeenCalledTimes(1);
  });
});
