import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createApplication } from '../server/app.js';
import { createLiveApplication } from './helpers/create-live-application.js';
import { readConfig } from '../server/config.js';
import { digest, seal } from '../server/auth/crypto.js';
import { createStartupRepository, type StartupProgress } from '../server/startup.js';
import type { Session, TerminalConnection } from '../server/contracts.js';

const stubs = vi.hoisted(() => ({ authorize: vi.fn(), connect: vi.fn() }));
vi.mock('../server/auth/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/auth/index.js')>();
  return { ...actual, createAuth: async (...args: Parameters<typeof actual.createAuth>) => ({ ...await actual.createAuth(...args), authorizeSession: stubs.authorize }) };
});
vi.mock('../server/github/index.js', async () => {
  const { Router } = await import('express'); const { previewCredentials } = await import('../server/preview.js');
  return { createGitHubServices: async () => ({ router: Router(), credentials: previewCredentials, close: async () => {} }) };
});
vi.mock('../server/infra/e2b.js', async () => {
  const { PreviewProvider } = await import('../server/preview.js');
  return { E2BProvider: class extends PreviewProvider { connectTerminal = stubs.connect; async exists() { return true; } } };
});

const headers = { 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1', Cookie: 'ephemeral=owner-browser' };
const testKey = Buffer.alloc(32, 1).toString('base64');
const connection = (): TerminalConnection => ({ write: vi.fn(async () => {}), resize: vi.fn(async () => {}), disconnect: vi.fn(async () => {}) });

describe('startup HTTP and terminal boundary', () => {
  let live: Awaited<ReturnType<typeof createApplication>>, preview: Awaited<ReturnType<typeof createApplication>>;
  let directory: string, liveOrigin: string, previewOrigin: string;
  const publicUrl = 'http://localhost:4327';
  async function listen(application: typeof live) {
    await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve));
    const address = application.server.address(); if (!address || typeof address === 'string') throw new Error('No server address');
    return `http://127.0.0.1:${address.port}`;
  }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ep-startup-http-'));
    const config = readConfig({ EPHEMERAL_MODE: 'preview', DATA_DIR: directory, PUBLIC_URL: publicUrl, ENCRYPTION_KEY: testKey, ALLOWED_GITHUB_IDS: '42,99' });
    live = await createLiveApplication({ ...config, mode: 'live' }); liveOrigin = await listen(live);
    preview = await createApplication(config); previewOrigin = await listen(preview);
    await live.db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
      [digest('owner-browser'), '42', 'owner', '', seal('test-credential', testKey), new Date(Date.now() + 3600_000).toISOString()]);
  }, 30_000);
  afterAll(async () => { await live?.close(); await preview?.close(); await rm(directory, { recursive: true, force: true }); }, 30_000);
  beforeEach(() => { stubs.authorize.mockReset().mockResolvedValue(undefined); stubs.connect.mockReset().mockResolvedValue(connection()); });
  afterEach(() => vi.restoreAllMocks());

  async function insert(id: string, changes: Partial<Session> = {}, application = live) {
    const s: Session = { id, userId: '42', repository: 'owner/repo', repositoryId: 1, installationId: 2,
      baseBranch: 'main', branch: `ephemeral/${id}`, state: 'running', createdAt: new Date(Date.now() - 2000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), maxExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      sandboxId: `preview-${id}`, endedAt: null, error: null,
      cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified', ...changes };
    // Fixtures must not create multiple active sessions for the same owner.
    await application.db.query("UPDATE ephemeral_sessions SET state='ended',data=jsonb_set(data,'{state}','\"ended\"'::jsonb) WHERE user_id=$1", [s.userId]);
    await application.repo.insert(s); return s;
  }
  const get = (id: string) => fetch(`${liveOrigin}/api/sessions/${id}/startup`, { headers }).then(r => r.json() as Promise<StartupProgress>);
  const mark = (id: string, body = '{}', overrides: Record<string, string> = {}) => fetch(`${liveOrigin}/api/sessions/${id}/first-useful-response`, { method: 'POST', headers: { ...headers, ...overrides }, body });
  function terminal(id: string) {
    const ws = new WebSocket(`${liveOrigin.replace('http:', 'ws:')}/api/sessions/${id}/terminal`, { origin: publicUrl, headers: { Cookie: headers.Cookie } });
    const ready = new Promise<void>((resolve, reject) => {
      ws.on('message', raw => { if (JSON.parse(raw.toString()).type === 'ready') resolve(); });
      ws.on('error', reject); ws.on('close', () => reject(new Error('Closed before ready')));
    });
    return { ws, ready };
  }
  async function close(ws: WebSocket) { if (ws.readyState === WebSocket.CLOSED) return; await new Promise<void>(resolve => { ws.once('close', resolve); ws.close(); }); }
  async function waitAttached(id: string) { await vi.waitFor(async () => expect((await get(id)).firstTerminalAttachedAt).toBeTruthy()); }

  it('requires actual browser authentication and owner access for reads and marks', async () => {
    const s = await insert('foreign', { userId: '99' });
    expect((await fetch(`${liveOrigin}/api/sessions/${s.id}/startup`)).status).toBe(401);
    expect((await fetch(`${liveOrigin}/api/sessions/${s.id}/first-useful-response`, { method: 'POST', headers: { ...headers, Cookie: '' }, body: '{}' })).status).toBe(401);
    expect((await fetch(`${liveOrigin}/api/sessions/${s.id}/startup`, { headers })).status).toBe(404);
    expect((await mark(s.id)).status).toBe(404); expect(stubs.authorize).not.toHaveBeenCalled();
  });

  it('enforces same origin, verification header, and a strict empty object body', async () => {
    const s = await insert('body');
    expect((await mark(s.id, '{}', { Origin: 'https://evil.test' })).status).toBe(403);
    expect((await mark(s.id, '{}', { 'X-Ephemeral-Request': '' })).status).toBe(403);
    for (const body of ['{"timestamp":"2020-01-01"}', '{"response":"content"}', '[]', 'null', '"response"', '']) expect((await mark(s.id, body)).status).toBe(400);
    expect(stubs.authorize).not.toHaveBeenCalled();
  });

  it('rejects reporting before a terminal attaches and rejects lost repository access', async () => {
    const s = await insert('before-attach'); expect((await mark(s.id)).status).toBe(409);
    expect((await get(s.id)).firstUsefulResponseAt).toBeNull();
    stubs.authorize.mockRejectedValueOnce(new Error('Repository access denied'));
    expect((await mark(s.id)).status).toBe(409); expect((await get(s.id)).firstUsefulResponseAt).toBeNull();
  });

  it('records only after provider attachment, ignores output, and preserves first useful response on repeat and reconnect', async () => {
    const s = await insert('terminal-success'), attachedConnection = connection();
    let resolveConnection!: (value: TerminalConnection) => void;
    stubs.connect.mockImplementationOnce(async (_id, onData) => { onData(Buffer.from('secret-output-cannot-mark-useful')); return new Promise<TerminalConnection>(resolve => { resolveConnection = resolve; }); });
    const first = terminal(s.id);
    try {
      await vi.waitFor(() => expect(stubs.connect).toHaveBeenCalled());
      expect(await get(s.id)).toMatchObject({ firstTerminalAttachedAt: null, firstUsefulResponseAt: null });
      resolveConnection(attachedConnection); await first.ready; await waitAttached(s.id);
      expect((await get(s.id)).firstUsefulResponseAt).toBeNull();
      const response = await mark(s.id); expect(response.status).toBe(200); const marked = await response.json();
      expect(marked).toMatchObject({ mode: 'live', measurement: 'user_reported', startedAt: s.createdAt });
      expect(marked.timeToFirstUsefulResponseMs).toBeGreaterThanOrEqual(2000);
      expect(await mark(s.id).then(r => r.json())).toEqual(marked);
      await close(first.ws);
      const second = terminal(s.id); try { await second.ready; expect(await get(s.id)).toEqual(marked); } finally { await close(second.ws); }
      expect(stubs.authorize).toHaveBeenCalled();
    } finally { await close(first.ws); }
  });

  it('rejects reporting after expiry or session end but permits retained startup reads', async () => {
    const s = await insert('ended'); const startup = await createStartupRepository(live.db);
    await startup.recordTerminalAttached(s.id); await startup.recordFirstUsefulResponse(s.id);
    const before = await get(s.id);
    await live.repo.update({ ...s, state: 'ended', endedAt: new Date().toISOString() });
    expect((await mark(s.id)).status).toBe(409); expect(await get(s.id)).toEqual(before);
    const expired = await insert('expired', { expiresAt: new Date(Date.now() - 1).toISOString() });
    expect((await mark(expired.id)).status).toBe(409);
  });

  it('declines a report if the session ends while repository authorization is in flight', async () => {
    const s = await insert('authorize-ended'), startup = await createStartupRepository(live.db);
    await startup.recordTerminalAttached(s.id);
    stubs.authorize.mockImplementationOnce(async () => { await live.repo.update({ ...s, state: 'ended' }); });
    expect((await mark(s.id)).status).toBe(409);
    expect((await get(s.id)).firstUsefulResponseAt).toBeNull();
  });

  it('refuses preview measurements and returns honest empty preview progress', async () => {
    const s = await insert('preview-honesty', { userId: 'preview-user' }, preview);
    const response = await fetch(`${previewOrigin}/api/sessions/${s.id}/first-useful-response`, { method: 'POST', headers, body: '{}' });
    expect(response.status).toBe(409);
    expect(await fetch(`${previewOrigin}/api/sessions/${s.id}/startup`).then(r => r.json())).toEqual({ startedAt: s.createdAt, firstTerminalAttachedAt: null, firstUsefulResponseAt: null, timeToFirstUsefulResponseMs: null, measurement: 'user_reported', mode: 'preview' });
  });

  it('disconnects an attachment that resolves after the session ended without recording it', async () => {
    const s = await insert('attach-ended'), attachedConnection = connection();
    let resolveConnection!: (value: TerminalConnection) => void;
    stubs.connect.mockImplementationOnce(() => new Promise<TerminalConnection>(resolve => { resolveConnection = resolve; }));
    const t = terminal(s.id); const failedReady = t.ready.catch(() => {});
    await vi.waitFor(() => expect(stubs.connect).toHaveBeenCalled());
    await live.repo.update({ ...s, state: 'ended' }); resolveConnection(attachedConnection);
    await failedReady;
    // Socket close can precede the provider's asynchronous cleanup continuation.
    await vi.waitFor(() => expect(attachedConnection.disconnect).toHaveBeenCalled());
    expect((await get(s.id)).firstTerminalAttachedAt).toBeNull();
  });

  it('keeps a successful terminal usable when timestamp persistence fails', async () => {
    const s = await insert('metric-failed'), attachedConnection = connection(); stubs.connect.mockResolvedValueOnce(attachedConnection);
    const query = live.db.query.bind(live.db);
    vi.spyOn(live.db, 'query').mockImplementation((sql, params) => sql.includes('INSERT INTO session_startup_metrics') ? Promise.reject(new Error('private storage failure')) : query(sql, params));
    const t = terminal(s.id);
    try {
      await t.ready; t.ws.send(JSON.stringify({ type: 'input', data: 'safe input' }));
      await vi.waitFor(() => expect(attachedConnection.write).toHaveBeenCalledWith('safe input'));
      expect(attachedConnection.disconnect).not.toHaveBeenCalled(); expect((await get(s.id)).firstTerminalAttachedAt).toBeNull();
    } finally { await close(t.ws); }
  });

  it('sends ready and accepts input while timestamp persistence is delayed', async () => {
    const s = await insert('metric-delayed'), attachedConnection = connection(); stubs.connect.mockResolvedValueOnce(attachedConnection);
    const query = live.db.query.bind(live.db); let resolveMetric!: (value: { rows: [] }) => void;
    vi.spyOn(live.db, 'query').mockImplementation((sql, params) => sql.includes('INSERT INTO session_startup_metrics') ? new Promise(resolve => { resolveMetric = resolve; }) : query(sql, params));
    const t = terminal(s.id);
    try {
      await t.ready; t.ws.send(JSON.stringify({ type: 'input', data: 'still works' }));
      await vi.waitFor(() => expect(attachedConnection.write).toHaveBeenCalledWith('still works'));
      expect(attachedConnection.disconnect).not.toHaveBeenCalled();
    } finally { resolveMetric({ rows: [] }); await close(t.ws); }
  });

  it('disconnects safely when the browser closes during validation and discards early input', async () => {
    const s = await insert('close-validation'), attachedConnection = connection();
    let resolveConnection!: (value: TerminalConnection) => void;
    stubs.connect.mockImplementationOnce(() => new Promise<TerminalConnection>(resolve => { resolveConnection = resolve; }));
    const t = terminal(s.id); const failedReady = t.ready.catch(() => {});
    await vi.waitFor(() => expect(stubs.connect).toHaveBeenCalled());
    let resolveLookup!: (value: Session) => void;
    vi.spyOn(live.repo, 'get').mockImplementationOnce(() => new Promise(resolve => { resolveLookup = resolve; }));
    resolveConnection(attachedConnection); await vi.waitFor(() => expect(resolveLookup).toBeTypeOf('function'));
    t.ws.send(JSON.stringify({ type: 'input', data: 'must be discarded' })); await close(t.ws);
    resolveLookup(s); await failedReady;
    await vi.waitFor(() => expect(attachedConnection.disconnect).toHaveBeenCalled());
    expect(attachedConnection.write).not.toHaveBeenCalled();
    expect((await get(s.id)).firstTerminalAttachedAt).toBeNull();
  });
});
