import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/app.js';
import { createLiveApplication } from './helpers/create-live-application.js';
import { createResourceObservationController } from '../server/resource-observation.js';
import { readConfig } from '../server/config.js';
import { digest, seal } from '../server/auth/crypto.js';
import type { Session } from '../server/contracts.js';
import type { SessionResourceSnapshot } from '../shared/resource-visibility.js';

const stubs = vi.hoisted(() => ({ authorize: vi.fn(), inspect: vi.fn() }));
vi.mock('../server/github/index.js', async () => {
  const { Router } = await import('express'); const { previewCredentials } = await import('../server/preview.js');
  return { createGitHubServices: async () => ({ router: Router(), credentials: previewCredentials, authorizeContinuation: stubs.authorize, close: async () => {} }) };
});
vi.mock('../server/infra/e2b.js', async () => {
  const { PreviewProvider } = await import('../server/preview.js');
  return { E2BProvider: class extends PreviewProvider { inspectResources = stubs.inspect; async exists() { return true; } } };
});
const key = Buffer.alloc(32, 1).toString('base64');
const headers = { Cookie: 'ephemeral=resources-owner' };
const known = (): SessionResourceSnapshot => ({ state: 'known', checkedAt: new Date(Date.now()).toISOString(), reason: null,
  allocation: { cpuCount: 2, memoryMiB: 512, diskMiB: null }, startedAt: new Date(Date.now() - 60_000).toISOString(), providerEndAt: new Date(Date.now() + 3600_000).toISOString(),
  metrics: { sampledAt: new Date(Date.now()).toISOString(), cpuUsedPercent: 12.5, memoryUsedBytes: 128, memoryTotalBytes: 512, diskUsedBytes: null, diskTotalBytes: null } });

describe('resource visibility HTTP boundaries', () => {
  let application: Awaited<ReturnType<typeof createApplication>>, preview: Awaited<ReturnType<typeof createApplication>>;
  let directory: string, origin: string, previewOrigin: string, clock: ReturnType<typeof vi.spyOn>, allowedIds: Set<string>, tick = 0;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ep-resources-http-'));
    const config = readConfig({ EPHEMERAL_MODE: 'preview', DATA_DIR: directory, PUBLIC_URL: 'http://localhost:4355', ENCRYPTION_KEY: key, ALLOWED_GITHUB_IDS: '42,99' });
    allowedIds = config.allowedIds;
    application = await createLiveApplication({ ...config, mode: 'live' }, { resourceObservationTimeoutMs: 200 });
    preview = await createApplication(config);
    for (const app of [application, preview]) await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const url = (app: typeof application) => { const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('No address'); return `http://127.0.0.1:${address.port}`; };
    origin = url(application); previewOrigin = url(preview);
    for (const [cookie, id, expires] of [['resources-owner', '42', Date.now() + 86_400_000], ['expired-resources-owner', '42', Date.now() - 100], ['resources-other', '99', Date.now() + 86_400_000], ['resources-uninvited', '100', Date.now() + 86_400_000]] as const) {
      await application.db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
        [digest(cookie), id, 'owner', '', seal('credential', key), new Date(expires).toISOString()]);
    }
    clock = vi.spyOn(Date, 'now');
  }, 30_000);
  afterAll(async () => { clock?.mockRestore(); await application?.close(); await preview?.close(); if (directory) await rm(directory, { recursive: true, force: true }); }, 30_000);
  beforeEach(async () => {
    clock.mockReturnValue(new Date().getTime() + ++tick * 60_000);
    stubs.authorize.mockReset().mockResolvedValue(undefined); stubs.inspect.mockReset().mockImplementation(async () => known());
    await application.db.query('UPDATE browser_sessions SET expires_at=$2,credential=$3 WHERE hash=$1', [digest('resources-owner'), new Date(Date.now() + 86_400_000).toISOString(), seal('credential', key)]);
  });
  async function saved(changes: Partial<Session> = {}, app = application) {
    const id = randomUUID(), now = new Date(Date.now()).toISOString();
    const session: Session = { id, userId: '42', repository: 'owner/repo', repositoryId: 1, installationId: 2, baseBranch: 'main', branch: `ephemeral/${id}`,
      state: 'running', createdAt: now, expiresAt: new Date(Date.now() + 3600_000).toISOString(), maxExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
      sandboxId: 'fake-vm', endedAt: null, error: null, cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified', ...changes };
    await app.db.query("UPDATE ephemeral_sessions SET state='ended',data=jsonb_set(data,'{state}','\"ended\"'::jsonb) WHERE user_id=$1", [session.userId]);
    await app.repo.insert(session); return session;
  }
  const request = (id: string, query = '', extra = {}, base = origin) => fetch(`${base}/api/sessions/${id}/resources${query}`, { headers: { ...headers, ...extra } });
  it('requires current identity, ownership, allowlist and same origin before external inspection', async () => {
    const s = await saved();
    for (const Cookie of ['', 'ephemeral=expired-resources-owner', 'ephemeral=resources-uninvited']) expect((await request(s.id, '', { Cookie })).status).toBe(401);
    expect((await request(s.id, '', { Cookie: 'ephemeral=resources-other' })).status).toBe(404);
    expect((await request(randomUUID())).status).toBe(404);
    for (const extra of [{ Origin: 'https://evil.test' }, { 'Sec-Fetch-Site': 'cross-site' }]) expect((await request(s.id, '', extra)).status).toBe(403);
    expect(stubs.authorize).not.toHaveBeenCalled(); expect(stubs.inspect).not.toHaveBeenCalled();
  });
  it('rejects every query key and GET bodies before authorization', async () => {
    const s = await saved();
    for (const query of ['?vm=one', '?x=one&x=two', '?x[]=one', '?token=SECRET', '?=']) expect((await request(s.id, query)).status).toBe(400);
    const status = await new Promise<number>(resolve => {
      const req = httpRequest(`${origin}/api/sessions/${s.id}/resources`, { method: 'GET', headers: { ...headers, 'Content-Type': 'text/plain', 'Content-Length': '2' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); }); req.end('{}');
    });
    expect(status).toBe(400); expect(stubs.authorize).not.toHaveBeenCalled(); expect(stubs.inspect).not.toHaveBeenCalled();
  });
  it('returns historical unavailable without external calls for sessions outside their valid running lifetime', async () => {
    for (const changes of [{ state: 'ended' as const }, { state: 'failed' as const }, { state: 'provisioning' as const }, { state: 'cleanup_pending' as const },
      { expiresAt: new Date(Date.now() - 1).toISOString() }, { maxExpiresAt: new Date(Date.now() - 1).toISOString() }, { expiresAt: 'invalid' }, { maxExpiresAt: 'invalid' }, { sandboxId: null }, { endedAt: new Date().toISOString() }]) {
      const s = await saved(changes), response = await request(s.id);
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ state: 'unavailable', allocation: null, metrics: null, startedAt: null, providerEndAt: null });
    }
    expect(stubs.authorize).not.toHaveBeenCalled(); expect(stubs.inspect).not.toHaveBeenCalled();
  });
  it('projects a validated observation and binds both checks to the current browser credential and abort signal', async () => {
    const s = await saved(), snapshot = known(); stubs.inspect.mockResolvedValueOnce({ ...snapshot, apiKey: 'SECRET', metrics: { ...snapshot.metrics, secret: 'SECRET' } });
    const response = await request(s.id); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store'); expect(await response.json()).toEqual(snapshot);
    expect(stubs.authorize).toHaveBeenCalledTimes(2); expect(stubs.authorize.mock.calls[0]).toEqual([s, 'credential', expect.any(AbortSignal)]);
    expect(stubs.inspect.mock.calls[0]).toEqual([s, expect.any(AbortSignal)]); expect(await application.repo.get(s.id)).toEqual(s);
  });
  it('sanitizes authorization denial before and after provider inspection', async () => {
    const s = await saved(); stubs.authorize.mockRejectedValueOnce(new Error('Bearer SECRET'));
    let response = await request(s.id); expect(response.status).toBe(403); expect(await response.text()).not.toContain('SECRET'); expect(stubs.inspect).not.toHaveBeenCalled();
    stubs.authorize.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked SECRET'));
    response = await request(s.id); expect(response.status).toBe(403); expect(await response.text()).not.toContain('SECRET'); expect(stubs.inspect).toHaveBeenCalledTimes(1);
  });
  it('discards provider observations if browser identity expires or credentials rotate', async () => {
    for (const rotate of [false, true]) {
      const s = await saved(); stubs.inspect.mockImplementationOnce(async () => {
        await application.db.query(rotate ? 'UPDATE browser_sessions SET credential=$2 WHERE hash=$1' : 'UPDATE browser_sessions SET expires_at=$2 WHERE hash=$1', [digest('resources-owner'), rotate ? seal('replacement', key) : new Date(new Date().getTime() - 100).toISOString()]); return known();
      });
      expect((await request(s.id)).status).toBe(401);
      await application.db.query('UPDATE browser_sessions SET expires_at=$2,credential=$3 WHERE hash=$1', [digest('resources-owner'), new Date(Date.now() + 86_400_000).toISOString(), seal('credential', key)]);
    }
  });
  it('rechecks the invite allowlist before exposing an observation', async () => {
    const s = await saved(); stubs.inspect.mockImplementationOnce(async () => { allowedIds.delete('42'); return known(); });
    try { expect((await request(s.id)).status).toBe(401); }
    finally { allowedIds.add('42'); }
  });
  it('invalidates observations on session, VM, repository or expiry metadata changes during any check', async () => {
    const changes: Partial<Session>[] = [{ state: 'ended' }, { sandboxId: 'replacement' }, { repository: 'owner/other' }, { repositoryId: 99 }, { installationId: 99 }, { branch: 'other' }, { baseBranch: 'other' }, { createdAt: new Date(Date.now() - 1).toISOString() }, { expiresAt: new Date(Date.now() + 1800_000).toISOString() }, { maxExpiresAt: new Date(Date.now() + 5400_000).toISOString() }];
    for (const change of changes) {
      const s = await saved(); stubs.inspect.mockImplementationOnce(async () => { await application.repo.update({ ...s, ...change }); return known(); });
      expect(await request(s.id).then(r => r.json())).toMatchObject({ state: 'unavailable', allocation: null, metrics: null });
    }
    const s = await saved(); stubs.authorize.mockImplementationOnce(async () => { await application.repo.update({ ...s, sandboxId: 'replacement' }); });
    const before = stubs.inspect.mock.calls.length; expect(await request(s.id).then(r => r.json())).toMatchObject({ state: 'unavailable' }); expect(stubs.inspect).toHaveBeenCalledTimes(before);
    const next = await saved(); stubs.authorize.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { await application.repo.update({ ...next, state: 'ended' }); });
    expect(await request(next.id).then(r => r.json())).toMatchObject({ state: 'unavailable', metrics: null });
  });
  it('sanitizes provider failure, malformed or stale observations without inventing zero usage', async () => {
    const s = await saved(); stubs.inspect.mockRejectedValueOnce(new Error('SDK SECRET'));
    let response = await request(s.id); expect(await response.json()).toMatchObject({ state: 'unknown', metrics: null, allocation: null });
    for (const value of [{ ...known(), metrics: { ...known().metrics, cpuUsedPercent: -1 } }, { ...known(), checkedAt: 'invalid' }, { ...known(), metrics: { ...known().metrics, sampledAt: new Date(Date.now() - 300_000).toISOString() } }, { ...known(), state: 'simulation' }]) {
      stubs.inspect.mockResolvedValueOnce(value); response = await request(s.id); const body = await response.json(); expect(body.state).toBe('unknown'); expect(body.metrics).toBeNull(); expect(JSON.stringify(body)).not.toContain('SECRET');
    }
  });
  it('revalidates sample freshness after the final remote authorization', async () => {
    const s = await saved(), snapshot = known(); stubs.inspect.mockResolvedValueOnce(snapshot);
    stubs.authorize.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { clock.mockReturnValue(Date.now() + 60_001); });
    expect(await request(s.id).then(r => r.json())).toMatchObject({ state: 'unknown', allocation: null, metrics: null });
  });
  it('returns explicitly simulated preview information without live provider or authorization calls', async () => {
    clock.mockImplementation(() => new Date().getTime());
    const s = await saved({ userId: 'preview-user' }, preview), response = await request(s.id, '', {}, previewOrigin);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ state: 'simulation' }); expect(stubs.authorize).not.toHaveBeenCalled(); expect(stubs.inspect).not.toHaveBeenCalled();
  });
  it('retains a timed out raw inspection slot until settlement and signals cancellation', async () => {
    const s = await saved(); let complete!: (value: SessionResourceSnapshot) => void, signal!: AbortSignal;
    stubs.inspect.mockImplementationOnce((_s, received) => { signal = received; return new Promise(resolve => { complete = resolve; }); });
    const pending = request(s.id); await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    const busy = await request(s.id); expect(busy.status).toBe(429); expect(busy.headers.get('retry-after')).toBe('1');
    expect(await pending.then(r => r.json())).toMatchObject({ state: 'unknown', metrics: null }); expect(signal.aborted).toBe(true);
    expect((await request(s.id)).status).toBe(429); complete(known());
    await vi.waitFor(async () => expect((await request(s.id)).status).toBe(200));
  });
  it('applies the inspection deadline to authorization and never dispatches provider work after it', async () => {
    const s = await saved(); let complete!: () => void, signal!: AbortSignal;
    stubs.authorize.mockImplementationOnce((_s, _credential, received) => { signal = received; return new Promise<void>(resolve => { complete = resolve; }); });
    const response = await request(s.id); expect(await response.json()).toMatchObject({ state: 'unknown', metrics: null });
    expect(signal.aborted).toBe(true); expect(stubs.inspect).not.toHaveBeenCalled(); expect((await request(s.id)).status).toBe(429);
    complete(); await vi.waitFor(async () => expect((await request(s.id)).status).toBe(200));
  });
  it('aborts disconnected HTTP requests while retaining the raw provider slot', async () => {
    const s = await saved(); let complete!: (value: SessionResourceSnapshot) => void, signal!: AbortSignal;
    stubs.inspect.mockImplementationOnce((_s, received) => { signal = received; return new Promise(resolve => { complete = resolve; }); });
    const client = new AbortController(), pending = fetch(`${origin}/api/sessions/${s.id}/resources`, { headers, signal: client.signal }).catch(() => null);
    await vi.waitFor(() => expect(complete).toBeTypeOf('function')); client.abort(); await pending;
    await vi.waitFor(() => expect(signal.aborted).toBe(true)); expect((await request(s.id)).status).toBe(429);
    complete(known()); await vi.waitFor(async () => expect((await request(s.id)).status).toBe(200));
  });
  it('bounds repeated refresh pressure with Retry-After', async () => {
    const s = await saved({ userId: '99' });
    for (let i = 0; i < 16; i++) expect((await request(s.id, '', { Cookie: 'ephemeral=resources-other' })).status).toBe(200);
    const response = await request(s.id, '', { Cookie: 'ephemeral=resources-other' }); expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('1');
  });
});

it('bounds global resource admission and aborts/drains raw operations during shutdown', async () => {
  const observations = createResourceObservationController(50), finish: (() => void)[] = [], signals: AbortSignal[] = [];
  const requests = Array.from({ length: 4 }, (_, i) => observations.observe(`user-${i}`, `session-${i}`, signal => { signals.push(signal); return new Promise<void>(resolve => finish.push(resolve)); }).catch(error => error));
  await vi.waitFor(() => expect(finish).toHaveLength(4));
  await expect(observations.observe('fifth', 'fifth', async () => {})).rejects.toMatchObject({ status: 429 });
  await expect(observations.observe('user-0', 'session-0', async () => {})).rejects.toMatchObject({ status: 429 });
  let drained = false; const close = observations.close().then(() => { drained = true; });
  expect(signals.every(signal => signal.aborted)).toBe(true); await Promise.all(requests); expect(drained).toBe(false);
  await expect(observations.observe('closed', 'closed', async () => {})).rejects.toMatchObject({ status: 503 });
  finish.forEach(complete => complete()); await close; expect(drained).toBe(true);
});
