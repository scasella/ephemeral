import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sandbox } from 'e2b';
import type { Session } from '../server/contracts.js';
import { E2BProvider } from '../server/infra/e2b.js';
import { PreviewProvider } from '../server/preview.js';

const stubs = vi.hoisted(() => ({ get: vi.fn(), constructed: vi.fn(), configuration: vi.fn() }));
vi.mock('e2b', async importOriginal => {
  const actual = await importOriginal<typeof import('e2b')>();
  return { ...actual, ApiClient: class { api = { GET: stubs.get }; }, ConnectionConfig: class extends actual.ConnectionConfig {
    constructor(...args: ConstructorParameters<typeof actual.ConnectionConfig>) { super(...args); stubs.configuration(args[0]); }
  }, Sandbox: class extends actual.Sandbox {
    constructor(...args: ConstructorParameters<typeof actual.Sandbox>) { super(...args); stubs.constructed(args[0]); }
  } };
});
const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const stamp = (offset = 0) => new Date(NOW + offset).toISOString();
const session = (): Session => ({ id: 'session', userId: 'owner', sandboxId: 'sandbox-a', repository: 'org/repo', repositoryId: 12,
  installationId: 1, baseBranch: 'main', branch: 'work', state: 'running', createdAt: stamp(-120_000),
  expiresAt: stamp(60_000), maxExpiresAt: stamp(120_000), endedAt: null, error: null, codexRemoteRevocation: 'unverified',
  cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' } });
const info = () => ({ sandboxID: 'sandbox-a', state: 'running', cpuCount: 2, memoryMB: 4096, diskSizeMB: 10240,
  startedAt: stamp(-120_000), endAt: stamp(60_000), envdVersion: '0.4.0', envdAccessToken: 'ENVD-SECRET',
  lifecycle: { autoResume: false }, metadata: { ephemeral_session_id: 'session', ephemeral_user_id: 'owner',
    ephemeral_repository: 'org/repo', ephemeral_repository_id: '12', ephemeral_branch: 'work', secret: 'METADATA-SECRET' } });
const metrics = () => [{ timestamp: stamp(-5000), timestampUnix: (NOW - 5000) / 1000, cpuCount: 2, cpuUsedPct: 25,
  memUsed: 1024 ** 3, memTotal: 4 * 1024 ** 3 - 100_000_000, memCache: 1234, diskUsed: 2 * 1024 ** 3, diskTotal: 10 * 1024 ** 3,
  token: 'METRIC-SECRET' }];
const provider = () => new E2BProvider({ apiKey: 'API-SECRET', templateId: 'test-template', gatewayUrl: 'https://gateway.example.test' });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  stubs.get.mockReset().mockImplementation(async (path: string) => ({ data: path.endsWith('/metrics') ? metrics() : info() }));
  stubs.constructed.mockReset(); stubs.configuration.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('read-only E2B resource observations', () => {
  it('reads details and bounded latest metrics with one deadline and no VM connection or mutations', async () => {
    const connect = vi.spyOn(Sandbox, 'connect'), timeout = vi.spyOn(Sandbox, 'setTimeout'), create = vi.spyOn(Sandbox, 'create'), kill = vi.spyOn(Sandbox, 'kill');
    const s = session(), original = structuredClone(s);
    const snapshot = await provider().inspectResources(s);
    expect(snapshot).toEqual({ state: 'known', checkedAt: stamp(), reason: null,
      allocation: { cpuCount: 2, memoryMiB: 4096, diskMiB: 10240 }, startedAt: stamp(-120_000), providerEndAt: stamp(60_000),
      metrics: { sampledAt: stamp(-5000), cpuUsedPercent: 25, memoryUsedBytes: 1024 ** 3, memoryTotalBytes: 4 * 1024 ** 3 - 100_000_000,
        diskUsedBytes: 2 * 1024 ** 3, diskTotalBytes: 10 * 1024 ** 3 } });
    expect(stubs.get.mock.calls.map(call => call[0])).toEqual(['/sandboxes/{sandboxID}', '/sandboxes/{sandboxID}/metrics', '/sandboxes/{sandboxID}']);
    const signal = stubs.get.mock.calls[0][1].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(stubs.get).toHaveBeenNthCalledWith(2, '/sandboxes/{sandboxID}/metrics', {
      params: { path: { sandboxID: 'sandbox-a' }, query: { start: NOW / 1000 - 60, end: NOW / 1000 } }, signal,
    });
    expect(stubs.get.mock.calls.every(call => call[1].signal === signal)).toBe(true);
    expect(stubs.configuration).toHaveBeenCalledWith(expect.objectContaining({ requestTimeoutMs: 10_000, retries: 0 }));
    expect(s).toEqual(original); expect(JSON.stringify(snapshot)).not.toContain('SECRET');
    expect(connect).not.toHaveBeenCalled(); expect(timeout).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled();
    expect(stubs.constructed).not.toHaveBeenCalled();
  });
  it('declines ended, expired and malformed sessions before any provider request', async () => {
    for (const patch of [{ state: 'ended' as const }, { state: 'cleanup_pending' as const }, { endedAt: stamp() }, { sandboxId: null },
      { sandboxId: '../other' }, { sandboxId: 'x'.repeat(129) }, { expiresAt: 'invalid' }, { maxExpiresAt: 'invalid' },
      { expiresAt: stamp(-1) }, { maxExpiresAt: stamp(-1) }, { createdAt: 'invalid' }, { createdAt: stamp(1) },
      { maxExpiresAt: stamp(5 * 3600_000) }, { expiresAt: stamp(180_000) }]) {
      expect(await provider().inspectResources({ ...session(), ...patch })).toMatchObject({ state: 'unavailable', allocation: null, metrics: null, startedAt: null, providerEndAt: null });
    }
    expect(stubs.get).not.toHaveBeenCalled();
  });
  it('requires exact VM metadata, running lifecycle, valid allocation and live provider deadlines', async () => {
    const original = info();
    for (const patch of [{ sandboxID: 'other' }, { state: 'paused' }, { lifecycle: { autoResume: true } }, { lifecycle: undefined },
      { metadata: undefined }, { startedAt: stamp(1) }, { startedAt: stamp(-126_000) }, { startedAt: 'invalid' },
      { endAt: 'invalid' }, { endAt: stamp() }, { endAt: stamp(5 * 3600_000) }, { endAt: stamp(240_001) },
      { cpuCount: Infinity }, { cpuCount: 0 }, { memoryMB: NaN }, { diskSizeMB: -1 },
      ...Object.keys(original.metadata).filter(key => key !== 'secret').map(key => ({ metadata: { ...original.metadata, [key]: 'foreign' } }))]) {
      stubs.get.mockResolvedValueOnce({ data: { ...original, ...patch } });
      const result = await provider().inspectResources(session());
      expect(result).toMatchObject({ state: 'unknown', allocation: null, metrics: null, startedAt: null, providerEndAt: null });
    }
    expect(stubs.get.mock.calls.every(call => call[0] === '/sandboxes/{sandboxID}')).toBe(true);
  });
  it('rechecks metadata, lifecycle, generation and deadlines after metrics read', async () => {
    for (const patch of [{ sandboxID: 'other' }, { state: 'paused' }, { lifecycle: { autoResume: true } },
      { metadata: { ...info().metadata, ephemeral_user_id: 'other' } }, { endAt: stamp(-1) },
      { startedAt: stamp(-60_000) }, { cpuCount: 4 }, { memoryMB: 8192 }]) {
      stubs.get.mockResolvedValueOnce({ data: info() }).mockResolvedValueOnce({ data: metrics() }).mockResolvedValueOnce({ data: { ...info(), ...patch } });
      const result = await provider().inspectResources(session());
      expect(result).toMatchObject({ state: 'unknown', allocation: null, metrics: null, startedAt: null, providerEndAt: null });
    }
  });
  it('allows bounded provider create-request latency beyond the persisted stop time', async () => {
    stubs.get.mockImplementation(async (path: string) => ({ data: path.endsWith('/metrics') ? metrics() : { ...info(), endAt: stamp(180_000) } }));
    expect(await provider().inspectResources(session())).toMatchObject({ state: 'known', providerEndAt: stamp(180_000) });
  });
  it('invalidates results when the persisted session expires or stops during provider reads', async () => {
    const s = session();
    stubs.get.mockImplementationOnce(async () => { vi.setSystemTime(NOW + 61_000); return { data: info() }; });
    expect((await provider().inspectResources(s)).state).toBe('unknown'); expect(stubs.get).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW); stubs.get.mockClear();
    stubs.get.mockResolvedValueOnce({ data: info() }).mockImplementationOnce(async () => { s.state = 'cleanup_pending'; return { data: metrics() }; });
    expect(await provider().inspectResources(s)).toMatchObject({ state: 'unknown', allocation: null, metrics: null });
    expect(stubs.get).toHaveBeenCalledTimes(2);
  });
  it('returns known allocation with optional missing, malformed, old, future or failed metrics', async () => {
    const sample = metrics()[0];
    for (const data of [[], null, {}, [null], Array(121).fill(sample), [{ ...sample, cpuUsedPct: NaN }],
      [{ ...sample, timestamp: stamp(-61_000), timestampUnix: (NOW - 61_000) / 1000 }],
      [{ ...sample, timestamp: stamp(1_000), timestampUnix: (NOW + 1000) / 1000 }]]) {
      stubs.get.mockResolvedValueOnce({ data: info() }).mockResolvedValueOnce({ data }).mockResolvedValueOnce({ data: info() });
      expect(await provider().inspectResources(session())).toMatchObject({ state: 'known', allocation: { cpuCount: 2, memoryMiB: 4096 }, metrics: null });
    }
    stubs.get.mockResolvedValueOnce({ data: info() }).mockRejectedValueOnce(new Error('METRIC-SECRET')).mockResolvedValueOnce({ data: info() });
    expect(await provider().inspectResources(session())).toMatchObject({ state: 'known', metrics: null });
    stubs.get.mockResolvedValueOnce({ data: info() }).mockResolvedValueOnce({ error: { message: 'API-SECRET' } }).mockResolvedValueOnce({ data: info() });
    expect(await provider().inspectResources(session())).toMatchObject({ state: 'known', metrics: null });
  });
  it('sanitizes initial or final SDK errors and API failures', async () => {
    const p = provider();
    stubs.get.mockRejectedValueOnce(new Error('API-SECRET ENVD-SECRET'));
    const first = await p.inspectResources(session()); expect(first.state).toBe('unknown'); expect(JSON.stringify(first)).not.toContain('SECRET');
    stubs.get.mockResolvedValueOnce({ error: { message: 'API-SECRET' }, data: info() });
    expect((await p.inspectResources(session())).state).toBe('unknown');
    stubs.get.mockResolvedValueOnce({ data: info() }).mockResolvedValueOnce({ data: metrics() }).mockRejectedValueOnce(new Error('ENVD-SECRET'));
    const last = await p.inspectResources(session()); expect(last).toMatchObject({ state: 'unknown', allocation: null, metrics: null });
    expect(JSON.stringify(last)).not.toContain('SECRET');
  });
  it('bounds the inspection result to one ten-second deadline and passes cancellation to transport', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal;
    });
    stubs.get.mockImplementationOnce(async () => { await new Promise(resolve => setTimeout(resolve, 6_000)); return { data: info() }; })
      .mockImplementationOnce(() => new Promise(() => {}));
    const pending = provider().inspectResources(session());
    await vi.advanceTimersByTimeAsync(6_000); expect(stubs.get).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await pending).toMatchObject({ state: 'unknown', allocation: null, metrics: null });
    expect(stubs.get).toHaveBeenCalledTimes(2);
    expect(stubs.get.mock.calls[0][1].signal.aborted).toBe(true);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
  });
  it('honors an external aborted signal before reading and cancels a pending transport', async () => {
    const controller = new AbortController(); controller.abort('PRIVATE-REASON');
    expect((await provider().inspectResources(session(), controller.signal)).state).toBe('unknown'); expect(stubs.get).not.toHaveBeenCalled();
    const active = new AbortController(); stubs.get.mockImplementationOnce(() => new Promise(() => {}));
    const pending = provider().inspectResources(session(), active.signal);
    await vi.advanceTimersByTimeAsync(1); expect(stubs.get).toHaveBeenCalledTimes(1); active.abort('PRIVATE-REASON');
    const result = await pending; expect(result).toMatchObject({ state: 'unknown', allocation: null, metrics: null });
    expect(JSON.stringify(result)).not.toContain('PRIVATE-REASON');
  });
});

describe('local resource simulation', () => {
  it('explicitly marks synthetic allocation and no real usage', async () => {
    const result = await new PreviewProvider().inspectResources(session());
    expect(result).toMatchObject({ state: 'simulation', allocation: { cpuCount: 2, memoryMiB: 4096, diskMiB: 10240 }, metrics: null });
    expect(result.reason).toContain('No VM or real resource usage'); expect(stubs.get).not.toHaveBeenCalled();
  });
  it('declines stopped, expired, destroyed and cancelled simulations', async () => {
    const p = new PreviewProvider(), s = session();
    for (const patch of [{ state: 'ended' as const }, { endedAt: stamp() }, { expiresAt: stamp(-1) }]) {
      expect((await p.inspectResources({ ...s, ...patch })).state).toBe('unavailable');
    }
    const controller = new AbortController(); controller.abort();
    expect((await p.inspectResources(s, controller.signal)).state).toBe('unavailable');
    await p.kill(s.sandboxId!); expect((await p.inspectResources(s)).state).toBe('unavailable');
  });
});
