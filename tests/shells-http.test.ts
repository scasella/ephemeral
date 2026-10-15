import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createApplication } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { digest, seal } from '../server/auth/crypto.js';
import type { Session, TerminalConnection } from '../server/contracts.js';
import type { ShellList } from '../server/shells.js';

const stubs = vi.hoisted(() => ({ authorize: vi.fn(), ensure: vi.fn(), inspect: vi.fn(), close: vi.fn(), attach: vi.fn() }));
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
  return { E2BProvider: class extends PreviewProvider {
    ensureShell = stubs.ensure; inspectShell = stubs.inspect; closeShell = stubs.close; connectTerminal = stubs.attach; async exists() { return true; }
  } };
});
const headers = { 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1', Cookie: 'ephemeral=shell-owner' };
const publicUrl = 'http://localhost:4351';
describe('shell HTTP and websocket boundaries', () => {
  let application: Awaited<ReturnType<typeof createApplication>>, directory: string, origin: string;
  const sockets: WebSocket[] = [];
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ep-shell-http-')); const key = Buffer.alloc(32, 1).toString('base64');
    const config = readConfig({ EPHEMERAL_MODE: 'preview', DATA_DIR: directory, PUBLIC_URL: publicUrl, ENCRYPTION_KEY: key, ALLOWED_GITHUB_IDS: '42,99' });
    application = await createApplication({ ...config, mode: 'live' });
    await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve));
    const address = application.server.address(); if (!address || typeof address === 'string') throw new Error('No server address'); origin = `http://127.0.0.1:${address.port}`;
    for (const [cookie, expires] of [['shell-owner', Date.now()+3600_000], ['expired-shell-owner', Date.now()-100]] as const) await application.db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [digest(cookie), '42', 'owner', '', seal('credential', key), new Date(expires).toISOString()]);
  }, 30_000);
  afterAll(async () => { for (const ws of sockets) ws.terminate(); await application?.close(); await rm(directory, { recursive: true, force: true }); }, 30_000);
  beforeEach(() => {
    vi.clearAllMocks(); stubs.authorize.mockResolvedValue(undefined); stubs.ensure.mockResolvedValue('open'); stubs.inspect.mockResolvedValue('open'); stubs.close.mockResolvedValue('closed');
    stubs.attach.mockReset().mockImplementation(async () => ({ write: vi.fn(async () => {}), resize: vi.fn(async () => {}), disconnect: vi.fn(async () => {}) } satisfies TerminalConnection));
  });
  async function saved(changes: Partial<Session> = {}) {
    const id = randomUUID(), now = new Date().toISOString();
    const s: Session = { id, userId: '42', repository: 'owner/repo', repositoryId: 1, installationId: 2, baseBranch: 'main', branch: `ephemeral/${id}`, state: 'running', createdAt: now,
      expiresAt: new Date(Date.now()+3600_000).toISOString(), maxExpiresAt: new Date(Date.now()+7200_000).toISOString(), sandboxId: 'fake-vm', endedAt: null, error: null,
      cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified', ...changes };
    await application.db.query("UPDATE ephemeral_sessions SET state='ended',data=jsonb_set(data,'{state}','\"ended\"'::jsonb) WHERE user_id=$1", [s.userId]);
    await application.repo.insert(s); return s;
  }
  const request = (id: string, method = 'GET', body?: unknown, extra = {}, suffix = '') => fetch(`${origin}/api/sessions/${id}/shells${suffix}`, { method, headers: { ...headers, ...extra }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  async function created(s: Session) { const response = await request(s.id, 'POST', { requestId: randomUUID(), name: 'Build' }); expect(response.status).toBe(200); const state = await response.json() as ShellList; return state.shells.find(shell => shell.kind === 'supplemental' && shell.state !== 'closed')!; }
  async function ready(s: Session, query = '') {
    const ws = new WebSocket(`${origin.replace('http', 'ws')}/api/sessions/${s.id}/terminal${query}`, { headers: { Origin: publicUrl, Cookie: headers.Cookie } }); sockets.push(ws);
    await new Promise<void>((resolve, reject) => { ws.on('message', raw => { if (JSON.parse(raw.toString()).type === 'ready') resolve(); }); ws.once('error', reject); }); return ws;
  }
  async function rejected(s: Session, query = '', extra = {}) {
    const ws = new WebSocket(`${origin.replace('http', 'ws')}/api/sessions/${s.id}/terminal${query}`, { headers: { Origin: publicUrl, Cookie: headers.Cookie, ...extra } }); sockets.push(ws);
    return new Promise<number>(resolve => { ws.on('error', () => {}); ws.on('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode!); }); });
  }
  it('requires current identity and ownership, same origin and verified strict mutation bodies', async () => {
    const foreign = await saved({ userId: '99' }); expect((await request(foreign.id)).status).toBe(404); expect((await request(foreign.id, 'POST', { requestId: randomUUID(), name: 'Build' })).status).toBe(404);
    const s = await saved(); for (const Cookie of ['', 'ephemeral=expired-shell-owner']) expect((await request(s.id, 'GET', undefined, { Cookie })).status).toBe(401);
    const input = { requestId: randomUUID(), name: 'Build' };
    expect((await request(s.id, 'POST', input, { Origin: 'https://evil.test' })).status).toBe(403); expect((await request(s.id, 'POST', input, { 'X-Ephemeral-Request': '' })).status).toBe(403);
    for (const body of [{ ...input, extra: true }, { ...input, name: '\nBuild' }, { ...input, name: '' }, { ...input, name: 'x'.repeat(81) }, { ...input, requestId: 'bad' }, {}]) expect((await request(s.id, 'POST', body)).status).toBe(400);
    expect(stubs.ensure).not.toHaveBeenCalled();
    const shell = await created(s);
    for (const body of [{}, { confirm: false }, { confirm: true, requestId: randomUUID() }, [], null]) expect((await request(s.id, 'POST', body, {}, `/${shell.id}/close`)).status).toBe(400);
    expect(stubs.close).not.toHaveBeenCalled(); expect((await request(s.id, 'POST', { confirm: true }, {}, '/codex/close')).status).toBe(409);
  });
  it('rejects ended/expired actions and access revoked while authorizing', async () => {
    const s = await saved(); stubs.authorize.mockRejectedValueOnce(new Error('Repository access denied'));
    expect((await request(s.id, 'POST', { requestId: randomUUID(), name: 'Build' })).status).toBe(409); expect(stubs.ensure).not.toHaveBeenCalled();
    await application.repo.update({ ...s, expiresAt: new Date(Date.now()-100).toISOString() }); expect((await request(s.id, 'POST', { requestId: randomUUID(), name: 'Expired' })).status).toBe(409);
    expect((await request(s.id).then(r => r.json())).canCreate).toBe(false);
  });
  it('validates socket shell queries, blocks unknown IDs, and closes only supplemental sockets before provider close', async () => {
    const s = await saved(), shell = await created(s);
    for (const query of ['?unknown=true', '?shell=codex&shell=codex', '?shell=', `?shell=${randomUUID()}`]) expect(await rejected(s, query)).toBe(query.includes('unknown') || query.includes('&') || query === '?shell=' ? 400 : 403);
    expect(await rejected(s, '', { Origin: 'https://evil.test' })).toBe(403);
    const secondary = await ready(s, `?shell=${shell.id.toUpperCase()}`);
    expect((await application.db.query('SELECT session_id FROM session_startup_metrics WHERE session_id=$1', [s.id])).rows).toHaveLength(0);
    const primary = await ready(s);
    expect(stubs.attach.mock.calls.map(call => call[4])).toEqual([shell.id, 'codex']);
    const primaryConnection = await stubs.attach.mock.results[1].value as TerminalConnection;
    const secondaryConnection = await stubs.attach.mock.results[0].value as TerminalConnection;
    const closed = new Promise<void>(resolve => secondary.once('close', () => resolve()));
    stubs.close.mockImplementationOnce(async () => { expect(await application.shells.attachable(s, shell.id)).toBe(false); return 'closed'; });
    expect((await request(s.id, 'POST', { confirm: true }, {}, `/${shell.id}/close`)).status).toBe(200); await closed;
    expect(primary.readyState).toBe(WebSocket.OPEN);
    await vi.waitFor(() => expect(secondaryConnection.disconnect).toHaveBeenCalledTimes(1));
    primary.send(JSON.stringify({ type: 'input', data: 'still alive' })); await vi.waitFor(() => expect(primaryConnection.write).toHaveBeenCalledWith('still alive'));
    expect(await rejected(s, `?shell=${shell.id}`)).toBe(403); primary.close();
    await vi.waitFor(async () => expect((await application.db.query('SELECT session_id FROM session_startup_metrics WHERE session_id=$1', [s.id])).rows).toHaveLength(1));
  });
  it('rejects queued input and resize after closure while disconnecting a late provider attachment', async () => {
    const s = await saved(), shell = await created(s), secondary = await ready(s, `?shell=${shell.id}`);
    const connection = await stubs.attach.mock.results[0].value as TerminalConnection;
    const original = application.shells.attachable.bind(application.shells);
    let finishCheck!: (value: boolean) => void;
    const check = vi.spyOn(application.shells, 'attachable').mockImplementationOnce(() => new Promise(resolve => { finishCheck = resolve; })).mockImplementation(original);
    secondary.send(JSON.stringify({ type: 'input', data: 'must not run' })); secondary.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
    await vi.waitFor(() => expect(finishCheck).toBeTypeOf('function'));
    const closed = new Promise<void>(resolve => secondary.once('close', () => resolve()));
    await request(s.id, 'POST', { confirm: true }, {}, `/${shell.id}/close`); await closed; finishCheck(true);
    await vi.waitFor(() => expect(connection.disconnect).toHaveBeenCalledTimes(1));
    expect(connection.write).not.toHaveBeenCalled(); expect(connection.resize).not.toHaveBeenCalled(); check.mockRestore();
    const next = await created(s); let completeAttach!: (value: TerminalConnection) => void;
    stubs.attach.mockImplementationOnce(() => new Promise(resolve => { completeAttach = resolve; }));
    const ws = new WebSocket(`${origin.replace('http', 'ws')}/api/sessions/${s.id}/terminal?shell=${next.id}`, { headers: { Origin: publicUrl, Cookie: headers.Cookie } }); sockets.push(ws); ws.on('error', () => {});
    await vi.waitFor(() => expect(completeAttach).toBeTypeOf('function'));
    const disconnected = { write: vi.fn(async () => {}), resize: vi.fn(async () => {}), disconnect: vi.fn(async () => {}) };
    const ended = new Promise<void>(resolve => ws.once('close', () => resolve())); await request(s.id, 'POST', { confirm: true }, {}, `/${next.id}/close`); await ended;
    completeAttach(disconnected); await vi.waitFor(() => expect(disconnected.disconnect).toHaveBeenCalledTimes(1)); expect(disconnected.write).not.toHaveBeenCalled();
  });
  it('allows two tabs per shell and four total connections while preserving primary default', async () => {
    const s = await saved(), shell = await created(s); const connections = await Promise.all([ready(s), ready(s), ready(s, `?shell=${shell.id}`), ready(s, `?shell=${shell.id}`)]);
    expect(await rejected(s)).toBe(429); expect(await rejected(s, `?shell=${shell.id}`)).toBe(429);
    for (const ws of connections) ws.close();
  });
});
