import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { digest, seal } from '../server/auth/crypto.js';
import { createTerminalAuthorization } from '../server/auth/terminal-authorization.js';
import type { Session } from '../server/contracts.js';
import { createLiveApplication } from './helpers/create-live-application.js';

const provider = vi.hoisted(() => ({ connect: vi.fn(), write: vi.fn(), resize: vi.fn(), disconnect: vi.fn(), timeout: vi.fn(), inspect: vi.fn() }));
vi.mock('../server/github/index.js', async () => {
  const { Router } = await import('express'); const { previewCredentials } = await import('../server/preview.js');
  return { createGitHubServices: async () => ({ router: Router(), credentials: previewCredentials, close: async () => {} }) };
});
vi.mock('../server/infra/e2b.js', async () => {
  const { PreviewProvider } = await import('../server/preview.js');
  return { E2BProvider: class extends PreviewProvider {
    async exists() { return true; }
    connectTerminal = provider.connect;
    setTimeout = provider.timeout;
    inspectShell = provider.inspect;
  } };
});
const realFetch = globalThis.fetch, realNow = Date.now;
const key = Buffer.alloc(32, 9).toString('base64'), publicUrl = 'https://control.example.test';
const session = (id: string): Session => ({ id, userId: '42', repository: 'owner/repo', repositoryId: 1, installationId: 2, baseBranch: 'main', branch: `ephemeral/${id}`, state: 'running',
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(), maxExpiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(), sandboxId: `vm-${id}`, endedAt: null, error: null,
  cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified' });

it('bounds and coalesces permission checks, scopes success to browser and repository identity, and invalidates failures', async () => {
  let now = 0, finish!: () => void;
  const authorize = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
  const cache = createTerminalAuthorization(authorize, 60_000, () => now), s = session('cache');
  const first = cache.authorize(s, 'browser'), second = cache.authorize(s, 'browser'); await Promise.resolve();
  expect(authorize).toHaveBeenCalledTimes(1); finish(); await Promise.all([first, second]);
  now = 4999; await cache.authorize(s, 'browser'); expect(authorize).toHaveBeenCalledTimes(1);
  now = 5000; await cache.authorize(s, 'browser'); expect(authorize).toHaveBeenCalledTimes(2);
  await cache.authorize(s, 'new-browser'); await cache.authorize({ ...s, repositoryId: 9 }, 'browser'); expect(authorize).toHaveBeenCalledTimes(4);
  cache.revoke(s.id); authorize.mockRejectedValueOnce(new Error('private failure'));
  await expect(cache.authorize(s, 'browser')).rejects.toThrow('Repository access could not be verified.');
  await cache.authorize(s, 'browser'); expect(authorize).toHaveBeenCalledTimes(6); cache.close();
});

for (const action of ['revoke', 'close'] as const) it(`rejects late pending permission success after cache ${action}`, async () => {
  let finish!: () => void;
  const authorize = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const cache = createTerminalAuthorization(authorize), s = session(`late-${action}`);
  const pending = cache.authorize(s, 'browser'); await Promise.resolve();
  if (action === 'revoke') cache.revoke(s.id); else cache.close();
  finish(); await expect(pending).rejects.toThrow('Repository access could not be verified.');
  if (action === 'close') { await expect(cache.authorize(s, 'browser')).rejects.toThrow('Repository access could not be verified.'); expect(authorize).toHaveBeenCalledOnce(); }
});

describe('actual terminal upgrade and extension authorization boundary', () => {
  let application: Awaited<ReturnType<typeof createApplication>>, directory: string, origin: string;
  let upstream = vi.fn<typeof fetch>();
  const sockets = new Set<WebSocket>();
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ep-terminal-auth-'));
    const config = { ...readConfig({ EPHEMERAL_MODE: 'preview', DATA_DIR: directory, ENCRYPTION_KEY: key, ALLOWED_GITHUB_IDS: '42,99', SESSION_MAX_HOURS: '4' }), publicUrl, secure: true, mode: 'live' as const };
    application = await createLiveApplication(config, { terminalCheckMs: 25 });
    await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve));
    const address = application.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener'); origin = `http://127.0.0.1:${address.port}`;
  }, 30_000);
  beforeEach(async () => {
    vi.restoreAllMocks();
    await application.db.query("UPDATE ephemeral_sessions SET state='ended',data=jsonb_set(data,'{state}','\"ended\"'::jsonb)");
    await application.db.query('DELETE FROM browser_sessions');
    for (const [value, id] of [['owner', '42'], ['other', '99']]) await application.db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [digest(value), id, 'fixture', '', seal('synthetic-access', key), new Date(Date.now() + 3600_000).toISOString()]);
    provider.write.mockReset().mockResolvedValue(undefined); provider.resize.mockReset().mockResolvedValue(undefined); provider.disconnect.mockReset().mockResolvedValue(undefined);
    provider.connect.mockReset().mockImplementation(async () => ({ write: provider.write, resize: provider.resize, disconnect: provider.disconnect }));
    provider.timeout.mockReset().mockResolvedValue(undefined); provider.inspect.mockReset().mockResolvedValue('open');
    upstream = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ id: 1, permissions: { push: true } }));
    vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => String(input).startsWith('https://api.github.com/') ? upstream(input, init) : realFetch(input, init));
  });
  afterEach(async () => {
    for (const socket of sockets) socket.terminate(); sockets.clear();
    await vi.waitFor(() => expect(provider.disconnect.mock.calls.length).toBeGreaterThanOrEqual(provider.connect.mock.calls.length));
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  afterAll(async () => { await application?.close(); await rm(directory, { recursive: true, force: true }); }, 30_000);
  async function insert(id: string) { const s = session(id); await application.repo.insert(s); return s; }
  function client(id: string, cookie = 'owner', originHeader: string | null = publicUrl) {
    const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/api/sessions/${id}/terminal`, { ...(originHeader === null ? {} : { origin: originHeader }), headers: { Cookie: cookie ? `__Host-ephemeral=${cookie}` : '' } });
    ws.on('error', () => {}); sockets.add(ws); return ws;
  }
  async function denied(id: string, cookie = 'owner', originHeader: string | null = publicUrl) {
    const ws = client(id, cookie, originHeader);
    const status = await new Promise<number>((resolve, reject) => {
      ws.once('unexpected-response', (_request, response) => { const status = response.statusCode!; response.resume(); ws.terminate(); resolve(status); });
      ws.once('open', () => resolve(101));
      ws.once('error', error => { if (!String(error).includes('closed before')) reject(error); });
    });
    expect(status).toBe(403);
  }
  async function attached(id: string, cookie = 'owner') {
    const ws = client(id, cookie), messages: Record<string, unknown>[] = [];
    ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
    await vi.waitFor(() => expect(messages.some(message => message.type === 'ready')).toBe(true));
    return { ws, messages };
  }
  const expireCache = () => vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 10_000);
  const extend = (id: string) => realFetch(`${origin}/api/sessions/${id}/extend`, { method: 'POST', headers: { Cookie: '__Host-ephemeral=owner', Origin: publicUrl, 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1' }, body: JSON.stringify({ minutes: 30 }) });

  it('rejects wrong owner, absent identity/session, missing Origin and cross-origin through the real upgrade handler', async () => {
    const s = await insert('upgrade-denial');
    await denied(s.id, 'other'); await denied(s.id, ''); await denied('missing');
    await denied(s.id, 'owner', null);
    await denied(s.id, 'owner', 'https://evil.example.test');
    expect(provider.connect).not.toHaveBeenCalled(); expect(upstream).not.toHaveBeenCalled();
  });
  it('denies repository permission on initial attach with an explicit 403 and no provider action', async () => {
    const s = await insert('initial-permission'); upstream.mockImplementation(async () => Response.json({ id: 1, permissions: { push: false } }));
    await denied(s.id); expect(provider.connect).not.toHaveBeenCalled(); expect(provider.timeout).not.toHaveBeenCalled();
  });
  it('coalesces healthy initial attachments and repeated writes without a GitHub request per frame', async () => {
    const s = await insert('healthy'); const [first, second] = await Promise.all([attached(s.id), attached(s.id)]);
    expect(upstream).toHaveBeenCalledTimes(1);
    for (let sequence = 1; sequence <= 20; sequence++) { first.ws.send(JSON.stringify({ type: 'input', data: 'x', sequence })); await vi.waitFor(() => expect(first.messages.some(message => message.type === 'input-ack' && message.sequence === sequence)).toBe(true)); }
    second.ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 })); await vi.waitFor(() => expect(provider.resize).toHaveBeenCalledOnce());
    expect(upstream).toHaveBeenCalledTimes(1); expect(provider.timeout).not.toHaveBeenCalled();
  });
  for (const trigger of ['input', 'resize', 'poll']) it(`stops all attachments when repository permission is revoked before ${trigger}`, async () => {
    const s = await insert(`revoke-${trigger}`); const first = await attached(s.id), second = await attached(s.id);
    upstream.mockImplementation(async () => Response.json({ id: 1, permissions: { push: false } })); expireCache();
    if (trigger === 'input') first.ws.send(JSON.stringify({ type: 'input', data: 'must-not-run', sequence: 1 }));
    if (trigger === 'resize') first.ws.send(JSON.stringify({ type: 'resize', cols: 90, rows: 30 }));
    await vi.waitFor(() => { expect(first.ws.readyState).toBe(WebSocket.CLOSED); expect(second.ws.readyState).toBe(WebSocket.CLOSED); });
    expect(first.messages).toContainEqual({ type: 'error', message: 'Repository access could not be verified. Sign in and reconnect.' });
    expect(provider.write).not.toHaveBeenCalled(); expect(provider.resize).not.toHaveBeenCalled(); expect(provider.timeout).not.toHaveBeenCalled();
  });
  it('shares a slow pending check across polling and input, blocks queued operations, and fails closed for outage', async () => {
    const s = await insert('pending'); const { ws } = await attached(s.id); let fail!: (error: Error) => void;
    upstream.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; })); expireCache();
    ws.send(JSON.stringify({ type: 'input', data: 'blocked', sequence: 1 })); ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(2)); await new Promise(resolve => setTimeout(resolve, 100));
    expect(upstream).toHaveBeenCalledTimes(2); expect(provider.write).not.toHaveBeenCalled(); expect(provider.resize).not.toHaveBeenCalled();
    fail(new Error('private upstream outage')); await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
    expect(provider.write).not.toHaveBeenCalled(); expect(provider.resize).not.toHaveBeenCalled();
  });
  it('expires an attached browser without relying on the repository permission cache', async () => {
    const s = await insert('browser-expired'); const { ws } = await attached(s.id);
    await application.db.query("UPDATE browser_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE hash=$1", [digest('owner')]);
    ws.send(JSON.stringify({ type: 'input', data: 'blocked' })); await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
    expect(provider.write).not.toHaveBeenCalled(); expect(upstream).toHaveBeenCalledTimes(1);
  });
  it('keeps another valid browser attached when only one browser login expires', async () => {
    const s = await insert('browser-scope');
    await application.db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [digest('second-owner'), '42', 'fixture', '', seal('synthetic-access', key), new Date(Date.now() + 3600_000).toISOString()]);
    const first = await attached(s.id), second = await attached(s.id, 'second-owner');
    expect(upstream).toHaveBeenCalledTimes(2);
    await application.db.query("UPDATE browser_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE hash=$1", [digest('owner')]);
    await vi.waitFor(() => expect(first.ws.readyState).toBe(WebSocket.CLOSED));
    second.ws.send(JSON.stringify({ type: 'input', data: 'healthy', sequence: 1 }));
    await vi.waitFor(() => expect(provider.write).toHaveBeenCalledWith('healthy'));
    expect(second.ws.readyState).toBe(WebSocket.OPEN); expect(upstream).toHaveBeenCalledTimes(2);
  });
  it('discards a late successful authorization after the session owner changes', async () => {
    const s = await insert('late-owner'); let finish!: (response: Response) => void;
    upstream.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const rejection = denied(s.id); await vi.waitFor(() => expect(upstream).toHaveBeenCalledOnce());
    await application.repo.update({ ...s, userId: '99' }); finish(Response.json({ id: 1, permissions: { push: true } }));
    await rejection; expect(provider.connect).not.toHaveBeenCalled();
  });
  it('reauthorizes extend without a cached terminal success and preserves stop access after revocation', async () => {
    const s = await insert('extend-revoked'); await attached(s.id); expect(upstream).toHaveBeenCalledOnce();
    upstream.mockImplementation(async () => Response.json({ id: 1, permissions: { push: false } }));
    const denied = await extend(s.id); expect(denied.status).toBe(403); expect(provider.timeout).not.toHaveBeenCalled();
    expect((await application.repo.get(s.id))!.expiresAt).toBe(s.expiresAt);
    const stop = await realFetch(`${origin}/api/sessions/${s.id}/stop`, { method: 'POST', headers: { Cookie: '__Host-ephemeral=owner', 'X-Ephemeral-Request': '1' } });
    expect(stop.status).toBe(200);
  });
  it('extends after a healthy current repository check and rejects untyped error text at the HTTP boundary', async () => {
    const s = await insert('extend-healthy'); const response = await extend(s.id);
    expect(response.status).toBe(200); expect(upstream).toHaveBeenCalledOnce(); expect(provider.timeout).toHaveBeenCalledOnce();
    expect(Date.parse((await response.json()).expiresAt)).toBe(Date.parse(s.expiresAt) + 30 * 60_000);
    vi.spyOn(application.manager, 'extend').mockRejectedValueOnce(new Error('Repository branch {"password":"synthetic-private-value"}'));
    const failure = await extend(s.id); expect(failure.status).toBe(409); expect(await failure.json()).toEqual({ error: 'The operation could not be completed. Check configuration or retry.' });
  });
  it('retains helpful trusted lifecycle errors for inactive sessions and maximum lifetime', async () => {
    const s = await insert('trusted-errors'); await application.repo.update({ ...s, state: 'ended' });
    const inactive = await extend(s.id); expect(inactive.status).toBe(409); expect(await inactive.json()).toEqual({ error: 'Only an active, unexpired session can be extended.' });
    await application.repo.update({ ...s, maxExpiresAt: s.expiresAt });
    const maximum = await extend(s.id); expect(maximum.status).toBe(409); expect(await maximum.json()).toEqual({ error: 'This session has reached its maximum lifetime of 4 hours.' });
    expect(provider.timeout).not.toHaveBeenCalled();
  });
});
