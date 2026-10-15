import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sandbox } from 'e2b';
import type { Session } from '../server/contracts.js';
import { E2BProvider } from '../server/infra/e2b.js';
import { SandboxCreationError } from '../server/core/provisioning.js';
import { APPLICATION_PREVIEW_UNAVAILABLE, isApplicationPreviewPort, privateApplicationPreviewTarget,
  type PreviewTokenStore } from '../server/infra/application-preview.js';
import { PreviewProvider } from '../server/preview.js';

const stubs = vi.hoisted(() => ({ get: vi.fn(), options: vi.fn(), configuration: vi.fn(), host: vi.fn() }));
vi.mock('e2b', async importOriginal => {
  const actual = await importOriginal<typeof import('e2b')>();
  return { ...actual, ApiClient: class { api = { GET: stubs.get }; }, ConnectionConfig: class extends actual.ConnectionConfig {
    constructor(...args: ConstructorParameters<typeof actual.ConnectionConfig>) { super(...args); stubs.configuration(args[0]); }
  }, Sandbox: class extends actual.Sandbox {
    constructor(...args: ConstructorParameters<typeof actual.Sandbox>) { super(...args); stubs.options(args[0]); }
    getHost(port: number) { return stubs.host(port) ?? super.getHost(port); }
  } };
});
const session = (): Session => ({ id: 'session', userId: 'owner', sandboxId: 'sandbox-a', repository: 'org/repo', repositoryId: 12,
  installationId: 1, baseBranch: 'main', branch: 'work', state: 'running', createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(), maxExpiresAt: new Date(Date.now() + 120_000).toISOString(),
  endedAt: null, error: null, codexRemoteRevocation: 'unverified', cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' } });
const info = () => ({ sandboxID: 'sandbox-a', state: 'running', envdVersion: '0.4.0', envdAccessToken: 'CONTROL-SECRET',
  endAt: new Date(Date.now() + 60_000).toISOString(), lifecycle: { autoResume: false }, network: { allowPublicTraffic: false },
  metadata: { ephemeral_session_id: 'session', ephemeral_user_id: 'owner', ephemeral_repository: 'org/repo', ephemeral_repository_id: '12', ephemeral_branch: 'work', ephemeral_preview_gateway: '1' } });
const token = 'NATIVE-TRAFFIC-SECRET';
const vault = (): PreviewTokenStore => ({ save: vi.fn().mockResolvedValue(undefined), read: vi.fn().mockResolvedValue(token), remove: vi.fn().mockResolvedValue(undefined) });
const provider = (previewTokens?: PreviewTokenStore) => new E2BProvider({ apiKey: 'API-SECRET', templateId: 'template', gatewayUrl: 'https://gateway.example.test', previewTokens });
beforeEach(() => {
  stubs.get.mockReset().mockResolvedValue({ data: info() }); stubs.host.mockReset(); stubs.options.mockReset(); stubs.configuration.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('private application preview transport', () => {
  it('resolves only the exact session and selected port with native server-only traffic auth', async () => {
    const store = vault(), p = provider(store), s = session(), original = structuredClone(s);
    const connect = vi.spyOn(Sandbox, 'connect'), timeout = vi.spyOn(Sandbox, 'setTimeout'), create = vi.spyOn(Sandbox, 'create');
    expect(await p.previewTarget(s, 5173)).toEqual({ origin: 'https://49152-sandbox-a.e2b.app', headers: { 'e2b-traffic-access-token': token, 'x-ephemeral-preview-port': '5173', origin: 'http://localhost:5173' } });
    expect(store.read).toHaveBeenCalledWith(s, 'sandbox-a');
    expect(stubs.get).toHaveBeenCalledWith('/sandboxes/{sandboxID}', { params: { path: { sandboxID: 'sandbox-a' } }, signal: expect.any(AbortSignal) });
    expect(stubs.configuration).toHaveBeenCalledWith(expect.objectContaining({ requestTimeoutMs: 10_000, retries: 0 }));
    expect(stubs.options).toHaveBeenCalledWith(expect.objectContaining({ trafficAccessToken: token, sandboxId: 'sandbox-a', sandboxDomain: 'e2b.app' }));
    expect(stubs.options.mock.calls[0][0]).not.toHaveProperty('envdAccessToken');
    expect(s).toEqual(original); expect(connect).not.toHaveBeenCalled(); expect(timeout).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });

  it.each([0, 22, 80, 443, 1023, 49152, 49983, 49999, 50005, 65535, 1.5, NaN, Infinity, '5173', null])('rejects reserved or malformed port %s before credential lookup', async port => {
    const store = vault();
    expect(isApplicationPreviewPort(port)).toBe(false);
    await expect(provider(store).previewTarget(session(), port as number)).rejects.toThrow(APPLICATION_PREVIEW_UNAVAILABLE);
    expect(store.read).not.toHaveBeenCalled(); expect(stubs.get).not.toHaveBeenCalled();
  });

  it('permits the application port boundaries', async () => {
    for (const port of [1024, 49151]) expect((await provider(vault()).previewTarget(session(), port)).origin).toBe('https://49152-sandbox-a.e2b.app');
  });

  it('rejects ended, expired, invalid-date and unsafe sandbox identities before provider lookup', async () => {
    const s = session();
    for (const changes of [{ state: 'ended' as const }, { endedAt: new Date().toISOString() }, { sandboxId: null }, { sandboxId: '../other' },
      { sandboxId: 'user@evil.test' }, { expiresAt: 'invalid' }, { maxExpiresAt: 'invalid' }, { expiresAt: new Date(0).toISOString() }, { maxExpiresAt: new Date(0).toISOString() }]) {
      await expect(provider(vault()).previewTarget({ ...s, ...changes }, 3000)).rejects.toThrow(APPLICATION_PREVIEW_UNAVAILABLE);
    }
    expect(stubs.get).not.toHaveBeenCalled();
  });

  it('rejects paused, expired, public and unverified metadata', async () => {
    const p = provider(vault()), original = info();
    const variants = [{ state: 'paused' }, { sandboxID: 'other' }, { endAt: 'invalid' }, { endAt: new Date(0).toISOString() },
      { lifecycle: undefined }, { lifecycle: { autoResume: true } }, { network: undefined }, { network: { allowPublicTraffic: true } }, { network: {} },
      ...Object.keys(original.metadata).map(key => ({ metadata: { ...original.metadata, [key]: 'other' } }))];
    for (const changes of variants) {
      stubs.get.mockResolvedValueOnce({ data: { ...original, ...changes } });
      await expect(p.previewTarget(session(), 3000)).rejects.toThrow(APPLICATION_PREVIEW_UNAVAILABLE);
    }
    expect(stubs.options).not.toHaveBeenCalled();
  });

  it('checks persisted deadline again after lookup', async () => {
    vi.useFakeTimers();
    stubs.get.mockImplementationOnce(async () => { vi.advanceTimersByTime(61_000); return { data: info() }; });
    await expect(provider(vault()).previewTarget(session(), 3000)).rejects.toThrow(APPLICATION_PREVIEW_UNAVAILABLE);
    expect(stubs.options).not.toHaveBeenCalled();
  });

  it.each(['evil.test', 'e2b.app.evil.test', 'localhost', '127.0.0.1', 'E2B.APP', 'https://e2b.app', 'e2b.app/'])('rejects unsafe provider domain %s', async domain => {
    stubs.get.mockResolvedValueOnce({ data: { ...info(), domain } });
    await expect(provider(vault()).previewTarget(session(), 3000)).rejects.toThrow(APPLICATION_PREVIEW_UNAVAILABLE);
    expect(stubs.options).not.toHaveBeenCalled();
  });

  it.each(['localhost:3000', '127.0.0.1', '3001-sandbox-a.e2b.app', '49152-other.e2b.app', 'user@49152-sandbox-a.e2b.app',
    '3000-sandbox-a.e2b.app.evil.test', '3000-sandbox-a.e2b.app:443', '3000-sandbox-a.e2b.app/path', '3000-sandbox-a.e2b.app?token=secret',
    '3000-sandbox-a.e2b.app#fragment', 'https://3000-sandbox-a.e2b.app'])('rejects unsafe SDK host %s', async host => {
    stubs.host.mockReturnValueOnce(host);
    await expect(provider(vault()).previewTarget(session(), 3000)).rejects.toThrow(APPLICATION_PREVIEW_UNAVAILABLE);
  });

  it('declines missing native traffic auth and masks SDK or store errors without envd fallback', async () => {
    const store = vault(), p = provider(store);
    vi.mocked(store.read).mockResolvedValueOnce(null);
    await expect(p.previewTarget(session(), 3000)).rejects.toThrow(APPLICATION_PREVIEW_UNAVAILABLE);
    expect(stubs.get).not.toHaveBeenCalled();
    vi.mocked(store.read).mockRejectedValueOnce(new Error(`API-SECRET ${token} CONTROL-SECRET`));
    await expect(p.previewTarget(session(), 3000)).rejects.toThrow(APPLICATION_PREVIEW_UNAVAILABLE);
    stubs.get.mockRejectedValueOnce(new Error(`API-SECRET ${token} CONTROL-SECRET`));
    await expect(p.previewTarget(session(), 3000)).rejects.toThrow(APPLICATION_PREVIEW_UNAVAILABLE);
    stubs.get.mockResolvedValueOnce({ error: { message: token }, data: info() });
    await expect(p.previewTarget(session(), 3000)).rejects.toThrow(APPLICATION_PREVIEW_UNAVAILABLE);
    for (const badToken of ['bad\r\nHeader: x', '', 'x'.repeat(4097)]) expect(() => privateApplicationPreviewTarget(session(), 3000, info(), badToken,
      () => '3000-sandbox-a.e2b.app')).toThrow(APPLICATION_PREVIEW_UNAVAILABLE);
  });

  it('declines older VMs without a provisioned trusted gateway', async () => {
    const old = info(); delete (old.metadata as Partial<typeof old.metadata>).ephemeral_preview_gateway;
    stubs.get.mockResolvedValueOnce({ data: old });
    await expect(provider(vault()).previewTarget(session(), 3000)).rejects.toThrow(APPLICATION_PREVIEW_UNAVAILABLE);
    expect(stubs.options).not.toHaveBeenCalled();
  });

  it('persists only native create token and uses private localhost host masking', async () => {
    const store = vault(), p = provider(store), s = session();
    const create = vi.spyOn(Sandbox, 'create').mockResolvedValue({ sandboxId: 'sandbox-a', trafficAccessToken: token } as Sandbox);
    expect(await p.create(s, 'GATEWAY-SECRET')).toBe('sandbox-a');
    expect(store.save).toHaveBeenCalledWith(s, 'sandbox-a', token);
    expect(create).toHaveBeenCalledWith('template', expect.objectContaining({ secure: true,
      network: { allowPublicTraffic: false, maskRequestHost: 'localhost:${PORT}' }, lifecycle: { onTimeout: 'kill', autoResume: false } }));
  });

  it('destroys newly created VM if native token persistence fails and redacts failure', async () => {
    const store = vault(); vi.mocked(store.save).mockRejectedValue(new Error(token));
    vi.spyOn(Sandbox, 'create').mockResolvedValue({ sandboxId: 'sandbox-a', trafficAccessToken: token } as Sandbox);
    const kill = vi.spyOn(Sandbox, 'kill').mockResolvedValue(true);
    const failure = await provider(store).create(session(), 'gateway').catch(error => error);
    expect(failure).toBeInstanceOf(SandboxCreationError);
    expect(failure).toMatchObject({ outcome: 'created', reason: 'resource_record_failed', knownSandboxId: 'sandbox-a' });
    expect(failure.message).not.toContain(token);
    expect(JSON.stringify(failure)).not.toContain(token);
    expect(kill).toHaveBeenCalledWith('sandbox-a', expect.anything());
  });

  it('declines missing native create tokens without using envd credentials', async () => {
    vi.spyOn(Sandbox, 'create').mockResolvedValue({ sandboxId: 'sandbox-a', envdAccessToken: 'CONTROL-SECRET' } as unknown as Sandbox);
    const kill = vi.spyOn(Sandbox, 'kill').mockResolvedValue(true), store = vault();
    const failure = await provider(store).create(session(), 'gateway').catch(error => error);
    expect(failure).toBeInstanceOf(SandboxCreationError);
    expect(failure).toMatchObject({ outcome: 'created', reason: 'resource_record_failed', knownSandboxId: 'sandbox-a' });
    expect(failure.message).not.toContain('CONTROL-SECRET');
    expect(JSON.stringify(failure)).not.toContain('CONTROL-SECRET');
    expect(store.save).not.toHaveBeenCalled(); expect(kill).toHaveBeenCalled();
  });

  it('removes durable tokens after confirmed VM kill only', async () => {
    const store = vault(), p = provider(store), kill = vi.spyOn(Sandbox, 'kill').mockRejectedValueOnce(new Error('provider failure')).mockResolvedValue(true);
    await expect(p.kill('sandbox-a')).rejects.toThrow(); expect(store.remove).not.toHaveBeenCalled();
    await p.kill('sandbox-a'); expect(store.remove).toHaveBeenCalledWith('sandbox-a'); expect(kill).toHaveBeenCalledTimes(2);
  });

  it('supports bounded memory token retention for an uninjected provider', async () => {
    vi.useFakeTimers();
    vi.spyOn(Sandbox, 'create').mockResolvedValue({ sandboxId: 'sandbox-a', trafficAccessToken: token } as Sandbox);
    vi.spyOn(Sandbox, 'kill').mockResolvedValue(true);
    const p = provider(), s = session(); await p.create(s, 'gateway');
    expect((await p.previewTarget(s, 3000)).headers).toEqual({ 'e2b-traffic-access-token': token, 'x-ephemeral-preview-port': '3000', origin: 'http://localhost:3000' });
    await expect(p.previewTarget({ ...s, id: 'other' }, 3000)).rejects.toThrow(APPLICATION_PREVIEW_UNAVAILABLE);
    await p.kill('sandbox-a'); await expect(p.previewTarget(s, 3000)).rejects.toThrow(APPLICATION_PREVIEW_UNAVAILABLE);
    const p2 = provider(); await p2.create(s, 'gateway'); vi.advanceTimersByTime(61_000);
    await expect(p2.previewTarget({ ...s, expiresAt: new Date(Date.now() + 60_000).toISOString() }, 3000)).rejects.toThrow(APPLICATION_PREVIEW_UNAVAILABLE);
  });

  it('local simulation never claims to provide an application target', async () => {
    await expect(new PreviewProvider().previewTarget(session(), 3000)).rejects.toThrow('Local preview has no application server.');
  });
});
