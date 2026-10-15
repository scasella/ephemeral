import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { WebSocket, WebSocketServer } from 'ws';
import { trackListener, WorkTracker } from './shutdown.js';
import type { Config } from './config.js';
import { generationViewerOrigin, previewGenerationForHost } from '../shared/preview-origin.js';
import { cookies } from './auth/index.js';
import { ApplicationPreviewError, type ApplicationPreview, type PreviewGrant } from './application-preview.js';

const REQUEST_LIMIT = 1024 * 1024, RESPONSE_LIMIT = 8 * 1024 * 1024;
const requestHeaders = new Set(['accept', 'accept-language', 'accept-encoding', 'content-type', 'if-none-match', 'if-modified-since', 'range']);
const responseHeaders = new Set(['content-type', 'content-encoding', 'content-language', 'etag', 'last-modified', 'accept-ranges', 'content-range']);
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; worker-src 'none'";
function safePath(raw: string | undefined) {
  if (!raw || raw.length > 8192 || !raw.startsWith('/') || raw.startsWith('//') || /[\\\x00-\x20\x7f]/.test(raw)) throw new ApplicationPreviewError(400, 'Invalid preview path.');
  let decoded: string;
  try { decoded = decodeURIComponent(raw.split('?')[0]); } catch { throw new ApplicationPreviewError(400, 'Invalid preview path.'); }
  if (/[\\\x00-\x1f\x7f-\x9f]/.test(decoded) || decoded.startsWith('//') || decoded.split('/').some(part => part === '.' || part === '..') || /%[0-9a-f]{2}/i.test(decoded)) throw new ApplicationPreviewError(400, 'Invalid preview path.');
  return decoded;
}
function targetOrigin(value: string, sandboxId: string, fixtureOrigin?: string) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new ApplicationPreviewError(502, 'Invalid private preview target.');
  if (u.origin !== `https://49152-${sandboxId}.e2b.app` && u.origin !== fixtureOrigin) throw new ApplicationPreviewError(502, 'Invalid private preview target.');
  return u;
}
async function body(req: IncomingMessage, limit: number, signal?: AbortSignal) {
  const parts: Buffer[] = []; let length = 0;
  signal?.throwIfAborted();
  if (Number(req.headers['content-length']) > limit) throw new ApplicationPreviewError(413, 'Preview request is too large.');
  const abort = () => req.destroy();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of req) { signal?.throwIfAborted(); const b = Buffer.from(chunk); length += b.length; if (length > limit) throw new ApplicationPreviewError(413, 'Preview request is too large.'); parts.push(b); }
    signal?.throwIfAborted(); return Buffer.concat(parts);
  } finally { signal?.removeEventListener('abort', abort); }
}
/** Dedicated browser origin. No control-plane routes, assets, or cookies exist here. */
export function createPreviewViewer(config: Config, preview: ApplicationPreview, tls: Pick<RequestOptions, 'ca'> & { fixtureOrigin?: string } = {}) {
  if (!config.previewPublicUrl) throw new Error('A separate preview origin is required.');
  const origin = new URL(config.previewPublicUrl), secure = origin.protocol === 'https:';
  // A caller-supplied CA and exact loopback origin permit real TLS fixture tests only.
  if (tls.fixtureOrigin && (!tls.ca || !['localhost', '127.0.0.1'].includes(new URL(tls.fixtureOrigin).hostname))) throw new Error('TLS fixtures require a loopback origin and explicit certificate.');
  const cookieName = secure ? '__Host-ephemeral-preview' : 'ephemeral-preview';
  const work = new WorkTracker();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const pendingUpgrades = new Set<() => void>();
  let active = 0;
  const sessionCounts = new Map<string, number>();
  const sockets = new Map<WebSocket, { grant: PreviewGrant; upstream: WebSocket; timer: NodeJS.Timeout; expiry: NodeJS.Timeout }>();
  const pending = new Map<string, Set<AbortController>>();
  function admitTotal() {
    if (closing) throw new ApplicationPreviewError(503, 'Preview is restarting.');
    if (active >= 64) throw new ApplicationPreviewError(429, 'Too many preview connections.');
    active++; let released = false;
    return () => { if (!released) { released = true; active--; } };
  }
  function admitSession(id: string) {
    if ((sessionCounts.get(id) || 0) >= 16) throw new ApplicationPreviewError(429, 'Too many preview connections.');
    sessionCounts.set(id, (sessionCounts.get(id) || 0) + 1); let released = false;
    return () => { if (released) return; released = true; const count = (sessionCounts.get(id) || 1) - 1; if (count) sessionCounts.set(id, count); else sessionCounts.delete(id); };
  }
  function checkRequest(req: IncomingMessage) {
    let generation: string;
    try { generation = previewGenerationForHost(origin.origin, req.headers.host); }
    catch { throw new ApplicationPreviewError(403, 'Preview host is not authorized.'); }
    return { path: safePath(req.url), generation, viewerOrigin: generationViewerOrigin(origin.origin, generation) };
  }
  const safeHeaders = (req: IncomingMessage, native: Record<string, string>) => {
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) if (requestHeaders.has(key) && value !== undefined) headers[key] = value;
    return { ...headers, ...native };
  };
  function error(res: ServerResponse, failure: unknown) {
    if (res.headersSent || res.destroyed) { res.destroy(); return; }
    res.statusCode = failure instanceof ApplicationPreviewError ? failure.status : 502;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(failure instanceof ApplicationPreviewError ? failure.message : 'Application preview could not connect. Check the selected port and retry.');
  }
  const server = createServer((req, res) => { void work.track((async () => {
    res.setHeader('Content-Security-Policy', CSP); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    let release: (() => void) | undefined, controller: AbortController | undefined, grant: PreviewGrant | undefined;
    const deadline = setTimeout(() => { controller?.abort(); if (!res.writableEnded) res.destroy(); }, 30_000);
    try {
      release = admitTotal();
      const { path, generation, viewerOrigin } = checkRequest(req);
      if (path.startsWith('/__ephemeral')) {
        if (req.url !== '/__ephemeral/open' || req.method !== 'POST') throw new ApplicationPreviewError(404, 'Preview route not found.');
        if (req.headers.origin !== config.publicUrl || (req.headers['sec-fetch-site'] && !['cross-site', 'same-site'].includes(String(req.headers['sec-fetch-site']))) || req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new ApplicationPreviewError(403, 'Preview handoff is not authorized.');
        const form = new URLSearchParams((await body(req, 8192)).toString('utf8'));
        if ([...form.keys()].some(key => key !== 'token') || form.getAll('token').length !== 1) throw new ApplicationPreviewError(400, 'Invalid preview handoff.');
        if (closing) throw new ApplicationPreviewError(503, 'Preview is restarting.');
        const result = await preview.consume(form.get('token') || '', generation);
        res.setHeader('Set-Cookie', `${cookieName}=${result.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor((Date.parse(result.expiresAt) - Date.now()) / 1000))}${secure ? '; Secure' : ''}`);
        res.statusCode = 303; res.setHeader('Location', '/'); res.end(); return;
      }
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method || '')) throw new ApplicationPreviewError(405, 'Preview method is unsupported.');
      if (!['GET', 'HEAD'].includes(req.method || '') && req.headers.origin !== viewerOrigin) throw new ApplicationPreviewError(403, 'Cross-origin preview requests are not permitted.');
      if (req.headers.origin && req.headers.origin !== viewerOrigin) throw new ApplicationPreviewError(403, 'Cross-origin preview requests are not permitted.');
      grant = await preview.readGrant(cookies(req)[cookieName] || '', generation);
      if (closing) throw new ApplicationPreviewError(503, 'Preview is restarting.');
      const totalRelease = release, sessionRelease = admitSession(grant.session_id); release = () => { totalRelease(); sessionRelease(); };
      controller = new AbortController();
      const set = pending.get(grant.session_id) || new Set<AbortController>(); set.add(controller); pending.set(grant.session_id, set);
      req.once('aborted', () => controller?.abort());
      res.once('close', () => { if (!res.writableEnded) controller?.abort(); });
      const target = await preview.target(grant), upstream = targetOrigin(target.origin, target.sandboxId, tls.fixtureOrigin);
      const payload = await body(req, REQUEST_LIMIT, controller.signal);
      await preview.validate(grant);
      controller.signal.throwIfAborted();
      if (req.aborted || res.destroyed || res.writableEnded) throw new ApplicationPreviewError(403, 'Preview request is no longer available.');
      const response = await new Promise<{ status: number; headers: IncomingMessage['headers']; payload: Buffer }>((resolve, reject) => {
        const request = httpsRequest(new URL(req.url!, upstream), { ...tls, method: req.method, headers: safeHeaders(req, target.headers), signal: controller!.signal, timeout: 20_000 }, incoming => {
          const parts: Buffer[] = []; let size = 0;
          incoming.on('data', (chunk: Buffer) => { size += chunk.length; if (size > RESPONSE_LIMIT) { request.destroy(new ApplicationPreviewError(502, 'Preview response is too large.')); return; } parts.push(chunk); });
          incoming.on('end', () => resolve({ status: incoming.statusCode || 502, headers: incoming.headers, payload: Buffer.concat(parts) }));
          incoming.on('error', reject);
        });
        request.on('timeout', () => request.destroy(new Error('Preview timeout'))); request.on('error', reject); request.end(payload);
      });
      await preview.validate(grant);
      if (response.headers.location) {
        const redirect = new URL(response.headers.location, new URL(req.url!, upstream));
        if (redirect.origin !== upstream.origin || redirect.username || redirect.password) throw new ApplicationPreviewError(502, 'The application attempted an external redirect.');
        safePath(redirect.pathname + redirect.search); if (redirect.pathname.startsWith('/__ephemeral')) throw new ApplicationPreviewError(502, 'The application attempted a reserved redirect.');
        res.setHeader('Location', redirect.pathname + redirect.search + redirect.hash);
      }
      for (const [key, value] of Object.entries(response.headers)) if (responseHeaders.has(key) && value !== undefined) res.setHeader(key, value);
      res.statusCode = response.status; res.end(req.method === 'HEAD' ? undefined : response.payload);
    } catch (failure) { error(res, failure); }
    finally { clearTimeout(deadline); release?.(); if (grant && controller) { const set = pending.get(grant.session_id); set?.delete(controller); if (!set?.size) pending.delete(grant.session_id); } }
  })()).catch(() => res.destroy()); });
  const listener = trackListener(server);
  server.requestTimeout = 30_000; server.headersTimeout = 10_000;
  const negotiatedProtocols = new WeakMap<IncomingMessage, string>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: REQUEST_LIMIT, perMessageDeflate: false,
    handleProtocols: (protocols, req) => { const selected = negotiatedProtocols.get(req); return selected && protocols.has(selected) ? selected : false; } });
  server.on('upgrade', (req, socket, head) => { void work.track((async () => {
    if (closing) { socket.destroy(); return; }
    let release: (() => void) | undefined, upstream: WebSocket | undefined;
    let cancelled = false;
    const cancel = () => {
      pendingUpgrades.delete(cancel);
      cancelled = true; clearTimeout(timeout); upstream?.terminate();
      release?.(); release = undefined; socket.destroy();
    };
    // The raw socket can reset while authorization or the upstream handshake
    // is pending, before ws has installed its own error handler.
    socket.on('error', cancel); socket.once('close', cancel);
    const timeout = setTimeout(cancel, 20_000);
    pendingUpgrades.add(cancel);
    const unavailable = () => {
      if (!closing && !cancelled && !socket.destroyed && socket.readable && socket.writable) return false;
      cancel(); return true;
    };
    try {
      release = admitTotal();
      const { path, generation, viewerOrigin } = checkRequest(req);
      if (path.startsWith('/__ephemeral') || req.headers.origin !== viewerOrigin) throw new ApplicationPreviewError(403, 'Preview websocket is not authorized.');
      const grant = await preview.readGrant(cookies(req)[cookieName] || '', generation);
      if (unavailable()) return;
      const totalRelease = release, sessionRelease = admitSession(grant.session_id); release = () => { totalRelease(); sessionRelease(); };
      const target = await preview.target(grant);
      if (unavailable()) return;
      const url = new URL(req.url!, targetOrigin(target.origin, target.sandboxId, tls.fixtureOrigin)); url.protocol = 'wss:';
      const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map(x => x.trim()).filter(Boolean);
      if (protocols.length > 8 || protocols.some(x => x.length > 128 || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(x))) throw new ApplicationPreviewError(400, 'Invalid websocket protocol.');
      upstream = new WebSocket(url, protocols, { ...tls, headers: target.headers, maxPayload: REQUEST_LIMIT, perMessageDeflate: false, followRedirects: false, handshakeTimeout: 10_000 });
      upstream.on('error', () => {});
      await new Promise<void>((resolve, reject) => { upstream!.once('open', resolve); upstream!.once('error', reject); upstream!.once('close', () => reject(new Error('Upstream closed'))); });
      if (unavailable()) return;
      await preview.validate(grant);
      if (unavailable()) return;
      clearTimeout(timeout);
      pendingUpgrades.delete(cancel);
      negotiatedProtocols.set(req, upstream.protocol);
      wss.handleUpgrade(req, socket, head, client => {
        const remote = upstream!; let checking = false;
        const close = () => { client.close(1000, 'Preview access ended'); remote.terminate(); };
        const timer = setInterval(() => {
          if (checking) return; checking = true;
          void work.track(preview.validate(grant).catch(close).finally(() => { checking = false; }));
        }, 2000);
        const expiry = setTimeout(close, Math.max(0, Date.parse(grant.expires_at) - Date.now()));
        sockets.set(client, { grant, upstream: remote, timer, expiry });
        client.on('error', () => {});
        client.on('message', (data, binary) => { if (remote.readyState === WebSocket.OPEN && remote.bufferedAmount < 2 * REQUEST_LIMIT) remote.send(data, { binary }); else close(); });
        remote.on('message', (data, binary) => { if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 2 * REQUEST_LIMIT) client.send(data, { binary }); else close(); });
        remote.on('close', () => client.close(1000, 'Application connection closed')); remote.on('error', close);
        client.once('close', () => { clearInterval(timer); clearTimeout(expiry); sockets.delete(client); remote.terminate(); release?.(); release = undefined; });
      });
    } catch {
      if (!cancelled && !socket.destroyed) socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      cancel();
    }
  })()).catch(() => socket.destroy()); });
  const unlisten = preview.onRevoke(id => {
    for (const [client, state] of sockets) if (state.grant.session_id === id) { client.close(1000, 'Preview closed'); state.upstream.terminate(); }
    for (const controller of pending.get(id) || []) controller.abort();
  });
  return { server, close() {
    if (closePromise) return closePromise;
    closing = true;
    for (const cancel of pendingUpgrades) cancel();
    unlisten(); for (const controllers of pending.values()) for (const controller of controllers) controller.abort();
    for (const [client, state] of sockets) { clearInterval(state.timer); clearTimeout(state.expiry); client.terminate(); state.upstream.terminate(); }
    closePromise = Promise.all([new Promise<void>(resolve => wss.close(() => resolve())), listener.close()]).then(() => work.drain());
    return closePromise;
  } };
}
