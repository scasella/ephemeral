import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createApplication } from '../server/app.js';
import { createPreviewViewer } from '../server/application-preview-viewer.js';
import { createPreviewTokenStore } from '../server/application-preview-secrets.js';
import { readConfig } from '../server/config.js';
import { digest, seal } from '../server/auth/crypto.js';
import type { Session } from '../server/contracts.js';
const stubs = vi.hoisted(() => ({ authorize: vi.fn(), target: vi.fn(), readinessAuthorize: vi.fn(), probe: vi.fn() }));
vi.mock('../server/preview-readiness.js', async importOriginal => ({ ...await importOriginal<typeof import('../server/preview-readiness.js')>(), probeApplicationPreview: stubs.probe }));
vi.mock('../server/auth/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/auth/index.js')>();
  return { ...actual, createAuth: async (...args: Parameters<typeof actual.createAuth>) => ({ ...await actual.createAuth(...args), authorizeSession: stubs.authorize }) };
});
vi.mock('../server/github/index.js', async () => {
  const { Router } = await import('express'); const { previewCredentials } = await import('../server/preview.js');
  return { createGitHubServices: async () => ({ router: Router(), credentials: previewCredentials, authorizeContinuation: stubs.readinessAuthorize, close: async () => {} }) };
});
vi.mock('../server/infra/e2b.js', async () => {
  const { PreviewProvider } = await import('../server/preview.js');
  return { E2BProvider: class extends PreviewProvider { previewTarget = stubs.target; async exists() { return true; } } };
});
const key = Buffer.alloc(32, 1).toString('base64');
const controlOrigin = 'http://127.0.0.1:4357', viewerBaseOrigin = 'http://localhost:4358';
let viewerOrigin = viewerBaseOrigin;
const tokenOrigins = new Map<string, string>(), cookieOrigins = new Map<string, string>();
const ownerHeaders = { Cookie: 'ephemeral=preview-owner', 'X-Ephemeral-Request': '1', Origin: controlOrigin, 'Content-Type': 'application/json' };

describe('private application preview HTTP and websocket boundaries', () => {
  let application: Awaited<ReturnType<typeof createApplication>>, viewer: ReturnType<typeof createPreviewViewer>;
  let directory: string, api: string, viewerBase: string, upstreamOrigin: string;
  let fixture: ReturnType<typeof createHttpsServer>, fixtureWs: WebSocketServer;
  let lastHeaders: Record<string, unknown> = {}, requests = 0;
  const address = (server: typeof application.server) => { const a = server.address(); if (!a || typeof a === 'string') throw new Error('No address'); return `http://127.0.0.1:${a.port}`; };
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ep-app-preview-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
    const cert = await readFile(join(directory, 'cert.pem')), privateKey = await readFile(join(directory, 'key.pem'));
    fixture = createHttpsServer({ cert, key: privateKey }, async (req, res) => {
      requests++; lastHeaders = req.headers;
      if (req.url === '/external') { res.writeHead(302, { Location: 'https://evil.test/path' }); res.end(); return; }
      if (req.url === '/redirect') { res.writeHead(302, { Location: `${upstreamOrigin}/asset.js` }); res.end(); return; }
      if (req.url === '/oversize') { res.end(Buffer.alloc(8 * 1024 * 1024 + 1)); return; }
      if (req.url === '/echo') { const parts: Buffer[] = []; for await (const chunk of req) parts.push(Buffer.from(chunk)); res.end(Buffer.concat(parts)); return; }
      res.setHeader('Set-Cookie', 'ephemeral=upstream-secret'); res.setHeader('Authorization', 'Bearer hidden');
      res.setHeader('E2B-Traffic-Access-Token', 'hidden'); res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Content-Security-Policy', 'default-src *');
      res.setHeader('Content-Type', req.url === '/asset.js' ? 'application/javascript' : 'text/html');
      res.end(req.url === '/asset.js' ? 'console.log("asset")' : '<html><script src="/asset.js"></script>fixture</html>');
    });
    fixtureWs = new WebSocketServer({ server: fixture }); fixtureWs.on('connection', (ws, req) => { lastHeaders = req.headers; ws.on('message', (data, binary) => ws.send(data, { binary })); });
    await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve)); upstreamOrigin = address(fixture).replace('http:', 'https:');
    const config = { ...readConfig({ EPHEMERAL_MODE: 'preview', PUBLIC_URL: controlOrigin, PREVIEW_PUBLIC_URL: viewerBaseOrigin, PREVIEW_PORT: '4358', PREVIEW_LOCAL_ONLY: '1', DATA_DIR: directory, ENCRYPTION_KEY: key, ALLOWED_GITHUB_IDS: '42,99' }), mode: 'live' as const };
    application = await createApplication(config, { previewAuthorizationCacheMs: 0 }); viewer = createPreviewViewer(config, application.applicationPreview, { ca: cert, fixtureOrigin: upstreamOrigin });
    for (const server of [application.server, viewer.server]) await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); api = address(application.server); viewerBase = address(viewer.server);
    for (const [secret, id] of [['preview-owner', '42'], ['preview-other', '99'], ['preview-sibling', '42']]) {
      await application.db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [digest(secret), id, 'owner', '', seal('credential', key), new Date(Date.now() + 3600_000).toISOString()]);
    }
  }, 30_000);
  afterAll(async () => {
    await viewer?.close(); await application?.close(); fixtureWs?.clients.forEach(ws => ws.terminate()); await new Promise<void>(resolve => fixtureWs?.close(() => resolve()));
    fixture?.closeAllConnections(); await new Promise<void>(resolve => fixture?.close(() => resolve())); await rm(directory, { recursive: true, force: true });
  }, 30_000);
  beforeEach(async () => {
    stubs.authorize.mockReset().mockResolvedValue(undefined); stubs.target.mockReset().mockResolvedValue({ origin: upstreamOrigin, headers: { 'e2b-traffic-access-token': 'native-secret' } }); requests = 0;
    stubs.readinessAuthorize.mockReset().mockResolvedValue(undefined);
    stubs.probe.mockReset().mockImplementation(async (_provider, _session, port) => ({ state: 'responded', checkedAt: new Date().toISOString(), port, httpStatus: 200, reason: null, remedy: null }));
    await application.db.query('UPDATE browser_sessions SET expires_at=$2 WHERE hash=$1', [digest('preview-owner'), new Date(Date.now() + 3600_000).toISOString()]);
  });
  async function saved(changes: Partial<Session> = {}) {
    const id = randomUUID(), s: Session = { id, userId: '42', repository: 'owner/repo', repositoryId: 1, installationId: 2, baseBranch: 'main', branch: `ephemeral/${id}`, state: 'running', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(), maxExpiresAt: new Date(Date.now() + 7200_000).toISOString(), sandboxId: 'fake-vm', endedAt: null, error: null, cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified', ...changes };
    await application.db.query("UPDATE ephemeral_sessions SET state='ended',data=jsonb_set(data,'{state}','\"ended\"'::jsonb) WHERE user_id=$1", [s.userId]); await application.repo.insert(s); return s;
  }
  const request = (id: string, suffix = '', method = 'GET', value?: unknown, extra = {}) => fetch(`${api}/api/sessions/${id}/preview${suffix}`, { method, headers: { ...ownerHeaders, ...extra }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const view = (cookie = '', path = '/', init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
    const base = new URL(viewerBase);
    const req = httpRequest({ hostname: base.hostname, port: base.port, path, method: init.method || 'GET', headers: { Host: new URL(cookieOrigins.get(cookie.split(';')[0]) || viewerOrigin).host, Cookie: cookie, ...Object.fromEntries(new Headers(init.headers).entries()) } }, res => {
      const parts: Buffer[] = []; res.on('data', chunk => parts.push(Buffer.from(chunk))); res.on('error', reject);
      res.on('end', () => resolve(new Response(Buffer.concat(parts), { status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).filter(([, value]) => value !== undefined).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value as string])) })));
    });
    req.on('error', reject); req.end(init.body?.toString());
  });
  async function handoff(s: Session) {
    expect((await request(s.id, '', 'POST', { port: 3000 })).status).toBe(200);
    const opened = await request(s.id, '/open', 'POST', {}).then(r => r.json());
    viewerOrigin = new URL(opened.action).origin; tokenOrigins.set(opened.token, viewerOrigin);
    return opened as { token: string; action: string; expiresAt: string; generation: string; port: number };
  }
  async function consume(secret: string, extra = {}) {
    return view('', '/__ephemeral/open', { method: 'POST', headers: { Host: new URL(tokenOrigins.get(secret) || viewerOrigin).host, Origin: controlOrigin, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/x-www-form-urlencoded', ...extra }, body: new URLSearchParams({ token: secret }) });
  }
  async function grant(s: Session) { const opened = await handoff(s); const response = await consume(opened.token); expect(response.status).toBe(303); const cookie = response.headers.get('set-cookie')!.split(';')[0]; cookieOrigins.set(cookie, new URL(opened.action).origin); return cookie; }
  it('checks only an explicit empty-body request for the saved enabled port without writing or opening preview', async () => {
    const s = await saved();
    expect(await request(s.id, '/check', 'POST', {}).then(r => r.json())).toMatchObject({ state: 'unavailable', port: null, httpStatus: null });
    expect(stubs.probe).not.toHaveBeenCalled(); expect(stubs.readinessAuthorize).not.toHaveBeenCalled();
    await handoff(s);
    const sql = vi.spyOn(application.db, 'query');
    try {
      const result = await request(s.id, '/check', 'POST', {}).then(r => r.json());
      expect(result).toMatchObject({ state: 'responded', port: 3000, httpStatus: 200, reason: null, remedy: null });
      expect(Object.keys(result).sort()).toEqual(['checkedAt', 'httpStatus', 'port', 'reason', 'remedy', 'state']);
      expect(stubs.probe).toHaveBeenCalledTimes(1);
      expect(stubs.probe.mock.calls[0][1]).toMatchObject({ id: s.id, userId: s.userId, sandboxId: s.sandboxId });
      expect(stubs.probe.mock.calls[0][2]).toBe(3000);
      expect(stubs.readinessAuthorize).toHaveBeenCalledTimes(2);
      expect(stubs.readinessAuthorize.mock.calls.every(call => call[1] === 'credential' && call[2] instanceof AbortSignal)).toBe(true);
      expect(sql.mock.calls.every(([statement]) => /^SELECT\b/.test(statement))).toBe(true);
      expect(requests).toBe(0); expect(stubs.target).not.toHaveBeenCalled();
    } finally { sql.mockRestore(); }
  });
  it('guards readiness schema, ownership, CSRF and unavailable lifecycle without probing', async () => {
    const s = await saved();
    for (const value of [undefined, { port: 3000 }, { generation: 'caller' }, [], null]) expect((await request(s.id, '/check', 'POST', value)).status).toBe(400);
    expect((await request(s.id, '/check', 'POST', {}, { Cookie: '' })).status).toBe(401);
    expect((await request(s.id, '/check', 'POST', {}, { Cookie: 'ephemeral=preview-other' })).status).toBe(404);
    expect((await request(s.id, '/check', 'POST', {}, { Origin: 'https://evil.test' })).status).toBe(403);
    expect((await request(s.id, '/check', 'POST', {}, { 'X-Ephemeral-Request': '' })).status).toBe(403);
    await handoff(s); await application.repo.update({ ...s, state: 'ended' });
    expect(await request(s.id, '/check', 'POST', {}).then(r => r.json())).toMatchObject({ state: 'unavailable', httpStatus: null });
    expect(stubs.probe).not.toHaveBeenCalled(); expect(stubs.readinessAuthorize).not.toHaveBeenCalled();
  });
  it('freshly verifies repository access before and after checks and sanitizes failures', async () => {
    const s = await saved(); await handoff(s);
    const denied = Object.assign(new Error('Bearer native-secret upstream body'), { status: 403 });
    stubs.readinessAuthorize.mockRejectedValueOnce(denied);
    const before = await request(s.id, '/check', 'POST', {}); expect(before.status).toBe(403); expect(await before.text()).not.toContain('native-secret'); expect(stubs.probe).not.toHaveBeenCalled();
    stubs.readinessAuthorize.mockResolvedValueOnce(undefined).mockRejectedValueOnce(denied);
    const after = await request(s.id, '/check', 'POST', {}); expect(after.status).toBe(403); expect(await after.text()).not.toContain('native-secret'); expect(stubs.probe).toHaveBeenCalledTimes(1);
    stubs.readinessAuthorize.mockRejectedValueOnce(new Error('secret diagnostic'));
    const unknown = await request(s.id, '/check', 'POST', {}); expect(unknown.status).toBe(200); expect(await unknown.json()).toMatchObject({ state: 'unknown', httpStatus: null }); expect(stubs.probe).toHaveBeenCalledTimes(1);
  });
  it('discards readiness after session, expiry, saved generation and exact browser changes', async () => {
    for (const action of ['end', 'expiry', 'sandbox', 'port', 'generation', 'close', 'browser'] as const) {
      const s = await saved(); await handoff(s);
      stubs.probe.mockImplementationOnce(async () => {
        if (action === 'end') await application.repo.update({ ...s, state: 'ended' });
        else if (action === 'expiry') await application.repo.update({ ...s, expiresAt: new Date(Date.now() - 1000).toISOString() });
        else if (action === 'sandbox') await application.repo.update({ ...s, sandboxId: 'replacement' });
        else if (action === 'port' || action === 'generation') await request(s.id, '', 'POST', { port: action === 'port' ? 3001 : 3000 });
        else if (action === 'close') expect((await request(s.id, '/close', 'POST', {})).status).toBe(200);
        else await application.db.query('UPDATE browser_sessions SET expires_at=$2 WHERE hash=$1', [digest('preview-owner'), new Date(Date.now() - 1000).toISOString()]);
        return { state: 'responded', checkedAt: new Date().toISOString(), port: 3000, httpStatus: 200, reason: null, remedy: null };
      });
      const result = await request(s.id, '/check', 'POST', {});
      if (action === 'browser') { expect(result.status).toBe(401); await application.db.query('UPDATE browser_sessions SET expires_at=$2 WHERE hash=$1', [digest('preview-owner'), new Date(Date.now() + 3600_000).toISOString()]); }
      else expect(await result.json(), action).toMatchObject({ state: 'unavailable', port: null, httpStatus: null });
    }
  });
  it('allows close during a check, bounds concurrent checks and releases admission on disconnect', async () => {
    const s = await saved(); await handoff(s);
    let signal!: AbortSignal;
    stubs.probe.mockImplementationOnce(async (_provider, _session, _port, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    });
    const client = httpRequest(`${api}/api/sessions/${s.id}/preview/check`, { method: 'POST', headers: ownerHeaders });
    client.on('error', () => {}); client.end('{}');
    await vi.waitFor(() => expect(signal).toBeInstanceOf(AbortSignal));
    expect((await request(s.id, '/check', 'POST', {})).status).toBe(429);
    expect((await request(s.id, '/close', 'POST', {})).status).toBe(200);
    client.destroy(); await vi.waitFor(() => expect(signal.aborted).toBe(true));
    await vi.waitFor(async () => expect((await request(s.id, '/check', 'POST', {})).status).toBe(200));
  });
  it('aborts authorization at the whole-check deadline and releases the check gate', async () => {
    const s = await saved(); await handoff(s);
    let signal!: AbortSignal;
    stubs.readinessAuthorize.mockImplementationOnce(async (_session, _credential, abortSignal) => {
      signal = abortSignal;
      return new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    });
    const started = Date.now(), response = await request(s.id, '/check', 'POST', {});
    expect(Date.now() - started).toBeLessThan(11_000);
    expect(signal.aborted).toBe(true);
    expect(await response.json()).toMatchObject({ state: 'unknown', port: null, httpStatus: null });
    expect(stubs.probe).not.toHaveBeenCalled();
    expect((await request(s.id, '/check', 'POST', {})).status).toBe(200);
  }, 15_000);
  it('guards API auth, ownership, CSRF, port schema and lifecycle', async () => {
    const s = await saved();
    expect((await request(s.id, '', 'GET', undefined, { Cookie: '' })).status).toBe(401);
    expect((await request(s.id, '', 'GET', undefined, { Cookie: 'ephemeral=preview-other' })).status).toBe(404);
    expect((await request(s.id, '', 'POST', { port: 3000 }, { Origin: 'https://evil.test' })).status).toBe(403);
    expect((await request(s.id, '', 'POST', { port: 3000 }, { 'X-Ephemeral-Request': '' })).status).toBe(403);
    for (const value of [{ port: 80 }, { port: 49152 }, { port: '3000' }, { port: 3000, host: 'evil.test' }, {}]) expect((await request(s.id, '', 'POST', value)).status).toBe(400);
    expect((await request(s.id, '/open', 'POST')).status).toBe(400);
    expect((await request(s.id, '/open', 'POST', {})).status).toBe(409);
    await application.repo.update({ ...s, state: 'ended' }); expect(await request(s.id).then(r => r.json())).toMatchObject({ state: 'unavailable' });
    expect(stubs.target).not.toHaveBeenCalled();
  });
  it('stores one durable selected port and replaces its generation', async () => {
    const s = await saved(); const first = await request(s.id, '', 'POST', { port: 3000 }).then(r => r.json());
    const second = await request(s.id, '', 'POST', { port: 3000 }).then(r => r.json()); expect(first.generation).not.toBe(second.generation);
    expect(await request(s.id).then(r => r.json())).toMatchObject({ state: 'enabled', port: 3000, viewerOrigin: `http://${second.generation}.localhost:4358`, generation: second.generation });
    expect(await request(s.id, '/close', 'POST', {}).then(r => r.json())).toMatchObject({ state: 'disabled', port: 3000 });
  });
  it('requires a one-use fixed-origin POST handoff and sets only an isolated cookie', async () => {
    const s = await saved(), opened = await handoff(s); expect(opened).toMatchObject({ action: `${viewerOrigin}/__ephemeral/open`, port: 3000 }); expect(opened.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await view('', `/?token=${opened.token}`)).status).toBe(401); expect((await view('', '/__ephemeral/open')).status).toBe(404);
    expect((await consume(opened.token, { Origin: 'https://evil.test' })).status).toBe(403);
    const response = await consume(opened.token); expect(response.status).toBe(303); expect(response.headers.get('location')).toBe('/');
    const cookie = response.headers.get('set-cookie')!; expect(cookie).toMatch(/^ephemeral-preview=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax;/); expect(cookie).not.toContain('preview-owner');
    expect((await consume(opened.token)).status).toBe(401); expect(requests).toBe(0);
  });
  it('binds handoffs and HTTP/websocket grants to their generation host', async () => {
    const s = await saved(), first = await handoff(s), firstOrigin = new URL(first.action).origin;
    const unrelatedHost = `${randomUUID()}.localhost:4358`;
    expect((await consume(first.token, { Host: unrelatedHost })).status).toBe(401);
    expect((await consume(first.token, { Host: new URL(viewerBaseOrigin).host })).status).toBe(403);
    const response = await consume(first.token); expect(response.status).toBe(303);
    const firstCookie = response.headers.get('set-cookie')!.split(';')[0]; cookieOrigins.set(firstCookie, firstOrigin);
    expect((await view(firstCookie)).status).toBe(200);
    const nextCookie = await grant(s), nextOrigin = cookieOrigins.get(nextCookie)!;
    expect(nextOrigin).not.toBe(firstOrigin);
    // Even manually replaying the new cookie on the retained old origin must fail.
    expect((await view(nextCookie, '/', { headers: { Host: new URL(firstOrigin).host } })).status).toBe(401);
    expect((await view(nextCookie, '/', { headers: { Host: new URL(viewerBaseOrigin).host } })).status).toBe(403);
    expect((await view(nextCookie)).status).toBe(200);
    const denied = new WebSocket(viewerBase.replace('http:', 'ws:') + '/hmr', { headers: { Host: new URL(firstOrigin).host, Origin: firstOrigin, Cookie: nextCookie } });
    expect(await new Promise<number>(resolve => { denied.once('unexpected-response', (_req, res) => { resolve(res.statusCode || 0); res.resume(); }); denied.once('error', () => {}); })).toBe(403); denied.terminate();
    // A valid destination cookie cannot authorize scripts whose Origin is the old document.
    expect((await view(nextCookie, '/', { headers: { Origin: firstOrigin } })).status).toBe(403);
    const other = await saved(), otherCookie = await grant(other);
    expect((await view(otherCookie, '/', { headers: { Host: new URL(nextOrigin).host } })).status).toBe(401);
    expect((await view(otherCookie)).status).toBe(200);
    expect(requests).toBe(3);
  });
  it('forwards root/assets and POST while stripping browser credentials and upstream response headers', async () => {
    const s = await saved(), cookie = await grant(s);
    const response = await view(`${cookie}; ephemeral=control-cookie; app=app-cookie`, '/', { headers: { Authorization: 'Bearer browser-secret', 'E2B-Traffic-Access-Token': 'browser-native-secret', Origin: viewerOrigin } });
    expect(response.status).toBe(200); expect(await response.text()).toContain('/asset.js');
    expect(lastHeaders).toMatchObject({ 'e2b-traffic-access-token': 'native-secret' }); expect(lastHeaders.cookie).toBeUndefined(); expect(lastHeaders.authorization).toBeUndefined(); expect(lastHeaders.origin).toBeUndefined();
    for (const name of ['set-cookie', 'authorization', 'e2b-traffic-access-token', 'access-control-allow-origin']) expect(response.headers.get(name)).toBeNull();
    expect(response.headers.get('content-security-policy')).toContain("worker-src 'none'"); expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect(await view(cookie, '/asset.js').then(r => r.text())).toContain('console.log');
    expect((await view(cookie, '/echo', { method: 'POST', body: 'hello', headers: { Origin: viewerOrigin } })).status).toBe(200);
    expect(await view(cookie, '/echo', { method: 'POST', body: 'hello', headers: { Origin: viewerOrigin } }).then(r => r.text())).toBe('hello');
    expect((await view(cookie, '/echo', { method: 'POST', body: 'hello' })).status).toBe(403);
  });
  it('rejects foreign hosts, unsafe paths, unsafe targets, external redirects and large buffers', async () => {
    const cookie = await grant(await saved());
    expect((await view(cookie, '/', { headers: { Host: 'evil.test' } })).status).toBe(403);
    for (const path of ['/__ephemeral/secret', '/%2e%2e/secret', '/%2f%2fevil.test', '/%252e%252e/secret', '/%00file']) expect([400, 404]).toContain((await view(cookie, path)).status);
    expect((await view(cookie, '/external')).status).toBe(502); const redirected = await view(cookie, '/redirect'); expect(redirected.headers.get('location')).toBe('/asset.js');
    expect((await view(cookie, '/oversize')).status).toBe(502);
    expect((await view(cookie, '/echo', { method: 'POST', headers: { Origin: viewerOrigin }, body: 'x'.repeat(1024 * 1024 + 1) })).status).toBe(413);
    stubs.target.mockResolvedValueOnce({ origin: 'http://127.0.0.1:1', headers: {} }); expect((await view(cookie)).status).toBe(502);
  });
  it('fences generation, close, browser logout, session end and session expiry', async () => {
    const s = await saved(), cookie = await grant(s); const opened = await request(s.id, '/open', 'POST', {}).then(r => r.json());
    await request(s.id, '', 'POST', { port: 3000 }); expect((await consume(opened.token)).status).toBe(401); expect((await view(cookie)).status).toBe(401);
    const closedCookie = await grant(s); await request(s.id, '/close', 'POST', {}); expect((await view(closedCookie)).status).toBe(401);
    const expiredCookie = await grant(s); await application.db.query('UPDATE browser_sessions SET expires_at=$2 WHERE hash=$1', [digest('preview-owner'), new Date(Date.now() - 1000).toISOString()]); expect((await view(expiredCookie)).status).toBe(403);
    // Another valid login for the same owner must not keep the original viewer grant alive.
    expect((await request(s.id, '', 'GET', undefined, { Cookie: 'ephemeral=preview-sibling' })).status).toBe(200);
    await application.db.query('UPDATE browser_sessions SET expires_at=$2 WHERE hash=$1', [digest('preview-owner'), new Date(Date.now() + 3600_000).toISOString()]);
    const endedCookie = await grant(s); await application.repo.update({ ...s, state: 'ended' }); expect((await view(endedCookie)).status).toBe(403);
    await application.repo.update(s); const timedCookie = await grant(s); await application.repo.update({ ...s, expiresAt: new Date(Date.now() - 1000).toISOString() }); expect((await view(timedCookie)).status).toBe(403);
  });
  it('rejects expired handoffs and grants and discards content when access changes during forwarding', async () => {
    const s = await saved(), opened = await handoff(s); await application.db.query('UPDATE preview_handoffs SET expires_at=$2 WHERE hash=$1', [digest(opened.token), new Date(Date.now() - 1000).toISOString()]); expect((await consume(opened.token)).status).toBe(401);
    const cookie = await grant(s); stubs.target.mockImplementationOnce(async () => { await application.repo.update({ ...s, state: 'ended' }); return { origin: upstreamOrigin, headers: {} }; }); expect((await view(cookie)).status).toBe(403); expect(requests).toBe(0);
    await application.repo.update(s); const timedCookie = await grant(s); await application.db.query('UPDATE preview_grants SET expires_at=$2 WHERE hash=$1', [digest(timedCookie.split('=')[1]), new Date(Date.now() - 1000).toISOString()]); expect((await view(timedCookie)).status).toBe(401);
    const finalCookie = await grant(s); stubs.authorize.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { await application.repo.update({ ...s, state: 'ended' }); });
    const discarded = await view(finalCookie); expect(discarded.status).toBe(403); expect(await discarded.text()).not.toContain('fixture');
  });
  it('never dispatches a slow request body after preview close, replacement or session end', async () => {
    for (const action of ['close', 'replace', 'end'] as const) {
      const s = await saved(), cookie = await grant(s), target = vi.spyOn(application.applicationPreview, 'target');
      const base = new URL(viewerBase);
      let client!: ReturnType<typeof httpRequest>;
      const response = new Promise<number | string>(resolve => {
        client = httpRequest({ hostname: base.hostname, port: base.port, path: '/echo', method: 'POST', headers: {
          Host: new URL(viewerOrigin).host, Cookie: cookie, Origin: viewerOrigin, 'Content-Length': '7',
        } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode || 0)); });
        client.once('error', error => resolve((error as NodeJS.ErrnoException).code || 'closed'));
        client.write('mut');
      });
      try {
        await vi.waitFor(() => expect(target).toHaveBeenCalledTimes(1));
        await target.mock.results[0].value;
        if (action === 'close') expect((await request(s.id, '/close', 'POST', {})).status).toBe(200);
        else if (action === 'replace') expect((await request(s.id, '', 'POST', { port: 3001 })).status).toBe(200);
        else await application.repo.update({ ...s, state: 'ended' });
        client.end('ate!');
        expect([403, 'ECONNRESET', 'EPIPE']).toContain(await response);
        expect(requests, action).toBe(0);
      } finally { client.destroy(); target.mockRestore(); }
    }
  });
  it('relays websocket/HMR frames and immediately closes them on preview replacement and stop', async () => {
    const s = await saved(), cookie = await grant(s);
    const connect = () => new WebSocket(viewerBase.replace('http:', 'ws:') + '/hmr', { headers: { Host: new URL(viewerOrigin).host, Origin: viewerOrigin, Cookie: cookie } });
    const ws = connect(); await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const message = new Promise<string>(resolve => ws.once('message', data => resolve(data.toString()))); ws.send('hmr'); expect(await message).toBe('hmr'); expect(lastHeaders.cookie).toBeUndefined();
    const closed = new Promise<void>(resolve => ws.once('close', () => resolve())); await request(s.id, '', 'POST', { port: 3001 }); await closed;
    const nextCookie = await grant(s), next = new WebSocket(viewerBase.replace('http:', 'ws:') + '/hmr', { headers: { Host: new URL(viewerOrigin).host, Origin: viewerOrigin, Cookie: nextCookie } });
    await new Promise<void>((resolve, reject) => { next.once('open', resolve); next.once('error', reject); });
    const stopped = new Promise<void>(resolve => next.once('close', () => resolve())); await fetch(`${api}/api/sessions/${s.id}/stop`, { method: 'POST', headers: ownerHeaders, body: '{}' }); await stopped;
    const denied = connect(); expect(await new Promise<number>(resolve => { denied.once('unexpected-response', (_req, res) => { resolve(res.statusCode || 0); res.resume(); }); denied.once('error', () => {}); })).toBe(403); denied.terminate();
  });
  it('rechecks the exact original browser login for an open websocket', async () => {
    const s = await saved(), cookie = await grant(s);
    const ws = new WebSocket(viewerBase.replace('http:', 'ws:') + '/hmr', { headers: { Host: new URL(viewerOrigin).host, Origin: viewerOrigin, Cookie: cookie } });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const closed = new Promise<void>(resolve => ws.once('close', () => resolve()));
    await fetch(`${api}/api/logout`, { method: 'POST', headers: ownerHeaders, body: '{}' }); await closed;
    expect((await view(cookie)).status).toBe(403);
    await application.db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [digest('preview-owner'), '42', 'owner', '', seal('credential', key), new Date(Date.now() + 3600_000).toISOString()]);
  }, 10_000);
  it('does not enable preview if repository access or lifecycle changes during authorization', async () => {
    const s = await saved(); stubs.authorize.mockRejectedValueOnce(new Error('Bearer native-secret upstream body'));
    const denied = await request(s.id, '', 'POST', { port: 3000 }); expect(denied.status).toBe(403); expect(await denied.text()).not.toContain('native-secret');
    stubs.authorize.mockImplementationOnce(async () => { await application.repo.update({ ...s, state: 'ended' }); });
    expect((await request(s.id, '', 'POST', { port: 3000 })).status).toBe(409);
    await application.repo.update(s);
    stubs.authorize.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { await application.repo.update({ ...s, state: 'ended' }); });
    expect((await request(s.id, '', 'POST', { port: 3000 })).status).toBe(409);
    expect(await request(s.id).then(r => r.json())).toMatchObject({ state: 'unavailable' });
  });
  it('fences overlapping enable/open/close mutations instead of rolling back a newer generation', async () => {
    const s = await saved(); let complete!: () => void;
    stubs.authorize.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
    const first = request(s.id, '', 'POST', { port: 3000 }); await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    expect((await request(s.id, '', 'POST', { port: 3001 })).status).toBe(429);
    expect((await request(s.id, '/close', 'POST', {})).status).toBe(429);
    expect((await request(s.id, '/open', 'POST', {})).status).toBe(429);
    complete(); expect((await first).status).toBe(200);
    expect(await request(s.id).then(r => r.json())).toMatchObject({ state: 'enabled', port: 3000 });
  });
  it('persists encrypted scoped ingress credentials and prunes ended sessions', async () => {
    const s = await saved(), store = await createPreviewTokenStore(application.db, key);
    await store.save(s, s.sandboxId!, 'native-vault-secret'); const raw = await application.db.query<{ credential: string }>('SELECT credential FROM preview_ingress_credentials WHERE sandbox_id=$1', [s.sandboxId]); expect(raw.rows[0].credential).not.toContain('native-vault-secret');
    const restarted = await createPreviewTokenStore(application.db, key); expect(await restarted.read(s, s.sandboxId!)).toBe('native-vault-secret'); expect(await restarted.read({ ...s, userId: '99' }, s.sandboxId!)).toBeNull();
    await application.repo.update({ ...s, state: 'ended' }); await store.prune(); expect(await restarted.read(s, s.sandboxId!)).toBeNull();
  });
});
