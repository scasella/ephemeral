import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import express from 'express';
import react from '@vitejs/plugin-react';
import { createServer as createViteServer, type InlineConfig, type ViteDevServer } from 'vite';
import { createApplication } from '../server/app.js';
import { generationViewerOrigin, previewFormSource } from '../shared/preview-origin.js';
import { createPreviewViewer } from '../server/application-preview-viewer.js';
import { previewGatewaySource, PREVIEW_DIAGNOSTIC_PATH } from '../server/infra/preview-gateway.js';
import { digest, seal } from '../server/auth/crypto.js';
import type { Config } from '../server/config.js';
import type { Session } from '../server/contracts.js';
import { TerminalAttachment, type TerminalState } from '../src/terminal-connection.js';

const local = vi.hoisted(() => ({ directory: '', ingress: '', native: 'synthetic-native-ingress-only', credential: 'synthetic-repository-only',
  terminal: { generation: 0, primaryOpen: true, nextRecoveryDelayed: false, nextAttachmentDelayed: false, failNextRecovery: false, writeDelayMs: 0,
    recoveryWaiting: [] as (() => void)[], attachmentWaiting: [] as (() => void)[], exits: new Set<() => void>(),
    recoveryCalls: 0, recoveries: 0, attachments: 0, activeAttachments: 0, writes: 0, inputBytes: 0, inputSha256: '', resetInput: undefined as (() => void) | undefined },
}));
// Reuse the real app and viewer. Only the provider and external GitHub service are synthetic.
vi.mock('../server/infra/e2b.js', async () => {
  const { PreviewProvider } = await import('../server/preview.js');
  const { createHash } = await import('node:crypto');
  const terminal = local.terminal;
  let inputHash = createHash('sha256');
  terminal.resetInput = () => { inputHash = createHash('sha256'); terminal.writes = 0; terminal.inputBytes = 0; terminal.inputSha256 = inputHash.copy().digest('hex'); };
  terminal.resetInput();
  return { E2BProvider: class extends PreviewProvider {
    async exists() { return true; }
    async inspectShell(session: Session, shellId: string) { return shellId === 'codex' ? terminal.primaryOpen ? 'open' as const : 'closed' as const : super.inspectShell(session, shellId); }
    async recoverPrimaryShell(_session: Session) {
      const generation = terminal.generation;
      ++terminal.recoveryCalls;
      if (terminal.nextRecoveryDelayed) { terminal.nextRecoveryDelayed = false; await new Promise<void>(done => terminal.recoveryWaiting.push(done)); }
      if (generation !== terminal.generation) throw new Error('Synthetic session was reset');
      if (terminal.failNextRecovery) { terminal.failNextRecovery = false; throw new Error('Synthetic primary recovery failure'); }
      if (!terminal.primaryOpen) { terminal.primaryOpen = true; ++terminal.recoveries; }
      return 'open' as const;
    }
    async connectTerminal(sandboxId: string, onData: (data: Uint8Array) => void, cols: number, rows: number, shellId = 'codex') {
      const generation = terminal.generation;
      if (shellId === 'codex' && terminal.nextAttachmentDelayed) { terminal.nextAttachmentDelayed = false; await new Promise<void>(done => terminal.attachmentWaiting.push(done)); }
      if (generation !== terminal.generation) throw new Error('Synthetic session was reset');
      if (shellId === 'codex' && !terminal.primaryOpen) throw new Error('Synthetic primary shell is stopped');
      const connection = await super.connectTerminal(sandboxId, onData, cols, rows, shellId);
      if (generation !== terminal.generation) { await connection.disconnect(); throw new Error('Synthetic session was reset'); }
      ++terminal.attachments; ++terminal.activeAttachments;
      let disconnected = false;
      const listeners = new Set<() => void>();
      return {
        async write(data: string) {
          if (terminal.writeDelayMs) await new Promise(done => setTimeout(done, terminal.writeDelayMs));
          if (disconnected || generation !== terminal.generation || (shellId === 'codex' && !terminal.primaryOpen)) throw new Error('Synthetic terminal stopped');
          inputHash.update(data); ++terminal.writes; terminal.inputBytes += Buffer.byteLength(data); terminal.inputSha256 = inputHash.copy().digest('hex');
          await connection.write(data);
        },
        resize: connection.resize.bind(connection),
        onExit(listener: () => void) {
          if (shellId === 'codex') { listeners.add(listener); terminal.exits.add(listener); }
          return () => { listeners.delete(listener); terminal.exits.delete(listener); };
        },
        async disconnect() {
          if (disconnected) return;
          disconnected = true; if (generation === terminal.generation) --terminal.activeAttachments;
          for (const listener of listeners) terminal.exits.delete(listener);
          listeners.clear(); await connection.disconnect();
        },
      };
    }
    async previewTarget(session: Session, port: number, signal?: AbortSignal) {
      // Readiness validates the canonical provider hostname before the exact test transport maps it locally.
      return { origin: signal ? `https://49152-${session.sandboxId}.e2b.app` : local.ingress,
        headers: { 'e2b-traffic-access-token': local.native, 'x-ephemeral-preview-port': String(port), origin: `http://localhost:${port}` } };
    }
  } };
});
vi.mock('../server/github/index.js', async () => {
  const { Router } = await import('express');
  const { previewCredentials, previewRepositories } = await import('../server/preview.js');
  return { createGitHubServices: async () => ({ router: Router(), credentials: previewCredentials,
    repositories: async () => previewRepositories, branches: async () => [{ name: 'main' }],
    authorizeContinuation: async (session: Session, credential: string, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (session.userId !== '42' || session.repository !== 'ephemeral/example-app' || credential !== local.credential) throw new Error('Synthetic identity mismatch');
    }, close: async () => {} }) };
});
vi.mock('vite', async importOriginal => {
  const actual = await importOriginal<typeof import('vite')>();
  return { ...actual, createServer: (options: InlineConfig = {}) => actual.createServer({
    ...options, configFile: false, envDir: local.directory, plugins: [react()],
  }) };
});

const browserMode = process.env.EPHEMERAL_LOCAL_PREVIEW_BROWSER === '1';
const root = resolve('.'), nativeFetch = globalThis.fetch;
let application: Awaited<ReturnType<typeof createApplication>> | undefined;
let viewer: ReturnType<typeof createPreviewViewer> | undefined;
let fixture: ViteDevServer | undefined, ingress: https.Server | undefined, gateway: ChildProcess | undefined;
let api = '', viewerBase = '', currentViewerOrigin = '', gatewayPort = 0, appPort = 0, certificate: Buffer;
let session: Session, ownerCookie = '', fixturePath = '', quit: (() => void) | undefined;
let configuration: Config, metadataFailure = false, delayedShells = false;
const key = randomBytes(32).toString('base64');
const clients = new Set<WebSocket>(), ingressSockets = new Set<Duplex>();
const seenDiagnostics: { method?: string; path?: string; headers: http.IncomingHttpHeaders }[] = [];

async function listen(server: http.Server | https.Server, host: string, port = 0) {
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); done(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local listener');
  return address.port;
}
async function freePort() {
  // macOS ephemeral allocations start above the application's allowed range.
  for (let attempt = 0; attempt < 50; attempt++) {
    const server = http.createServer();
    try {
      const port = await listen(server, '127.0.0.1', 20_000 + Math.floor(Math.random() * 20_000));
      await new Promise<void>(done => server.close(() => done())); return port;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; }
  }
  throw new Error('No valid loopback application port available');
}
function tlsDiagnostic(input: URL, init: RequestInit) {
  return new Promise<Response>((done, reject) => {
    const request = https.request(new URL(input.pathname, local.ingress), { ca: certificate, method: init.method,
      headers: Object.fromEntries(new Headers(init.headers).entries()), signal: init.signal ?? undefined }, response => {
      const parts: Buffer[] = [];
      response.on('data', part => parts.push(Buffer.from(part))); response.on('error', reject);
      response.on('end', () => done(new Response(Buffer.concat(parts), { status: response.statusCode,
        headers: Object.fromEntries(Object.entries(response.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) })));
    }); request.on('error', reject); request.end();
  });
}
async function startFixture() {
  if (fixture) return;
  fixture = await createViteServer({ root: fixturePath, server: { host: '127.0.0.1', port: appPort, strictPort: true, forwardConsole: false } });
  // Observe the actual upstream request; the gateway must reduce readiness to precisely HEAD /.
  fixture.httpServer!.prependListener('request', request => { if (request.method === 'HEAD') seenDiagnostics.push({ method: request.method, path: request.url, headers: request.headers }); });
  try { await fixture.listen(); } catch (error) { await fixture.close(); fixture = undefined; throw error; }
}
async function stopFixture() { const current = fixture; fixture = undefined; await current?.close(); }
async function editFixture(after: boolean) {
  const filename = join(fixturePath, 'App.jsx');
  await writeFile(filename, (await readFile(join(root, 'scripts/fixtures/preview-vite/App.jsx'), 'utf8')).replace('VITE_HMR_BEFORE', after ? 'VITE_HMR_AFTER' : 'VITE_HMR_BEFORE'));
}
async function resetSession() {
  if (!application) throw new Error('Application missing');
  const now = Date.now();
  if (session) { await application.applicationPreview.revoke(session.id); await application.repo.update({ ...session, state: 'ended', endedAt: new Date().toISOString() }); }
  session = { id: randomUUID(), userId: '42', repository: 'ephemeral/example-app', repositoryId: 101, installationId: 1,
    baseBranch: 'main', branch: `ephemeral/${randomUUID()}`, state: 'running', createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30 * 60_000).toISOString(), maxExpiresAt: new Date(now + 30 * 60_000).toISOString(),
    sandboxId: 'local-synthetic-sandbox', endedAt: null, error: null, cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified' };
  await application.repo.insert(session);
  metadataFailure = false; delayedShells = false;
  for (const listener of [...local.terminal.exits]) listener();
  local.terminal.exits.clear(); ++local.terminal.generation;
  local.terminal.attachments = 0; local.terminal.activeAttachments = 0;
  for (const release of local.terminal.recoveryWaiting.splice(0)) release();
  for (const release of local.terminal.attachmentWaiting.splice(0)) release();
  local.terminal.primaryOpen = true; local.terminal.nextRecoveryDelayed = false; local.terminal.nextAttachmentDelayed = false;
  local.terminal.failNextRecovery = false; local.terminal.writeDelayMs = 0; local.terminal.recoveryCalls = 0; local.terminal.recoveries = 0;
  local.terminal.resetInput?.();
  if (viewerBase) configuration.previewPublicUrl = viewerBase;
}
const workspacePath = () => `/?session=${session.id}&tab=preview`;
function terminalStats() {
  const terminal = local.terminal;
  return { synthetic: true, primaryOpen: terminal.primaryOpen, nextRecoveryDelayed: terminal.nextRecoveryDelayed, nextAttachmentDelayed: terminal.nextAttachmentDelayed,
    failNextRecovery: terminal.failNextRecovery, writeDelayMs: terminal.writeDelayMs, recoveryWaiting: terminal.recoveryWaiting.length, attachmentWaiting: terminal.attachmentWaiting.length,
    recoveryCalls: terminal.recoveryCalls, recoveries: terminal.recoveries, attachments: terminal.attachments, activeAttachments: terminal.activeAttachments,
    writes: terminal.writes, inputBytes: terminal.inputBytes, inputSha256: terminal.inputSha256 };
}
function controls() {
  return `<!doctype html><meta charset="utf-8"><title>Local private preview E2E</title><h1>Local private preview E2E</h1>
  <p>Synthetic identity and provider. Real control plane, gateway, React/Vite and private viewer. All listeners are loopback.</p>
  <p>Application port: <strong>${appPort}</strong>. Vite: <strong>${fixture ? 'running' : 'stopped'}</strong>.</p>
  <p><a href="/__local_preview/sign-in">Open Ephemeral with synthetic sign-in</a></p>
  ${['start', 'stop', 'edit', 'restore', 'metadata-failure', 'missing-viewer', 'delay-shells', 'end-session', 'replace-preview', 'reset', 'quit'].map(action => `<form method="post" action="/__local_preview/${action}"><button>${action}</button></form>`).join('')}
  <h2>Synthetic terminal controls</h2>
  <p>These controls change only the local fake provider. No VM, shell command, model, account, or cloud connection exists.</p>
  <p><a href="/__local_preview/terminal-stats">Synthetic terminal counters and input SHA256 (no input contents)</a></p>
  <pre>${JSON.stringify(terminalStats(), null, 2)}</pre>
  ${['primary-exit', 'delay-next-recovery', 'release-recovery', 'delay-next-attachment', 'release-attachment', 'recovery-error-once', 'toggle-write-delay', 'terminal-reset-counters'].map(action => `<form method="post" action="/__local_preview/${action}"><button>Synthetic: ${action}</button></form>`).join('')}
  <p>Primary-exit marks the fake primary closed and invokes its real onExit subscription. Delay-next controls arm one recovery or attachment; release controls complete the pending operation. Toggle-write-delay switches each synthetic provider write between 0 and 100ms. Return to the workspace terminal to use its real Recover shell and Reconnect actions. Reset counters before a paste to compare input bytes and SHA256 without storing its text.</p>
  <p>Start is explicit. Enable the displayed port in Ephemeral, check, prepare access, and use its native Open action.
  For isolation proof, retain the first viewer tab, use replace-preview, and open another private preview. On the retained tab, Check retained page access must report HTTP 401. Reset creates a new machine for the same check. Each new opening uses a different hostname. Edit updates the Vite heading; restore reverts it. Reset stops Vite and creates a fresh disabled session. Quit cleans up.</p>`;
}
async function localControl(request: IncomingMessage, response: http.ServerResponse) {
  if (request.headers.host !== new URL(api).host) { response.writeHead(403); response.end(); return; }
  const path = new URL(request.url!, api).pathname;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  if (request.method === 'GET' && path === '/__local_preview/sign-in') {
    response.setHeader('Set-Cookie', `${ownerCookie}; Path=/; HttpOnly; SameSite=Lax`);
    response.writeHead(303, { Location: workspacePath() }); response.end(); return;
  }
  if (request.method === 'GET' && path === '/__local_preview/terminal-stats') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(terminalStats())); return; }
  if (request.method === 'GET' && path === '/__local_preview') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(controls()); return; }
  if (request.method !== 'POST' || request.headers.origin !== api || !['same-origin', 'none', undefined].includes(request.headers['sec-fetch-site'] as string | undefined)) {
    response.writeHead(403); response.end(); return;
  }
  request.resume();
  try {
    switch (path) {
      case '/__local_preview/primary-exit': local.terminal.primaryOpen = false; for (const listener of [...local.terminal.exits]) listener(); break;
      case '/__local_preview/delay-next-recovery': local.terminal.nextRecoveryDelayed = true; break;
      case '/__local_preview/release-recovery': for (const release of local.terminal.recoveryWaiting.splice(0)) release(); break;
      case '/__local_preview/delay-next-attachment': local.terminal.nextAttachmentDelayed = true; break;
      case '/__local_preview/release-attachment': for (const release of local.terminal.attachmentWaiting.splice(0)) release(); break;
      case '/__local_preview/recovery-error-once': local.terminal.failNextRecovery = true; break;
      case '/__local_preview/toggle-write-delay': local.terminal.writeDelayMs = local.terminal.writeDelayMs ? 0 : 100; break;
      case '/__local_preview/terminal-reset-counters': local.terminal.resetInput?.(); break;
      case '/__local_preview/start': await startFixture(); break;
      case '/__local_preview/stop': await stopFixture(); break;
      case '/__local_preview/edit': await editFixture(true); break;
      case '/__local_preview/restore': await editFixture(false); break;
      case '/__local_preview/metadata-failure': metadataFailure = !metadataFailure; break;
      case '/__local_preview/missing-viewer': configuration.previewPublicUrl = configuration.previewPublicUrl ? null : viewerBase; break;
      case '/__local_preview/delay-shells': delayedShells = !delayedShells; break;
      case '/__local_preview/end-session': await application!.repo.update({ ...session, state: 'ended', endedAt: new Date().toISOString() }); break;
      case '/__local_preview/replace-preview': await application!.applicationPreview.enable(session, appPort); break;
      case '/__local_preview/reset': await stopFixture(); await editFixture(false); await resetSession(); break;
      case '/__local_preview/quit': setImmediate(() => quit?.()); break;
      default: response.writeHead(404); response.end(); return;
    }
    response.writeHead(303, { Location: '/__local_preview' }); response.end();
  } catch { response.writeHead(500); response.end('Local fixture action failed.'); }
}

beforeAll(async () => {
  local.directory = await mkdtemp(join(tmpdir(), 'ephemeral-local-preview-e2e-'));
  const frontendPath = join(local.directory, 'frontend-dist');
  try {
    const index = await readFile(join(root, 'dist/index.html'), 'utf8');
    if (!index.includes('/assets/') || index.includes('/src/')) throw new Error('Not a production frontend build');
    await cp(join(root, 'dist'), frontendPath, { recursive: true });
  } catch (error) {
    if (browserMode) throw new Error('Browser harness requires the current production frontend. Run npm run build first.', { cause: error });
    // API/gateway checks do not require a frontend build in a clean test checkout.
    await mkdir(frontendPath, { recursive: true });
    await writeFile(join(frontendPath, 'index.html'), '<!doctype html><title>Local Preview API check</title>');
  }
  const serveFrontend = express();
  serveFrontend.disable('x-powered-by');
  serveFrontend.use(express.static(frontendPath));
  serveFrontend.use((_request, response) => { response.status(404).end(); });
  fixturePath = join(local.directory, 'vite-app');
  await cp(join(root, 'scripts/fixtures/preview-vite'), fixturePath, { recursive: true });
  await symlink(join(root, 'node_modules'), join(fixturePath, 'node_modules'), 'dir');
  appPort = await freePort();
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', join(local.directory, 'key.pem'),
    '-out', join(local.directory, 'cert.pem'), '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  certificate = await readFile(join(local.directory, 'cert.pem'));
  const ready = join(local.directory, 'ready.json'), source = join(local.directory, 'gateway.mjs');
  // Change only the fixture's bind address. Production source and all gateway boundary logic remain intact.
  await writeFile(source, previewGatewaySource(0, ready).replace("server.listen(port, '0.0.0.0'", "server.listen(port, '127.0.0.1'"));
  gateway = spawn(process.execPath, [source], { env: { PATH: process.env.PATH }, stdio: 'ignore' });
  await vi.waitFor(async () => { gatewayPort = JSON.parse(await readFile(ready, 'utf8')).port; }, { timeout: 5000 });
  ingress = https.createServer({ cert: certificate, key: await readFile(join(local.directory, 'key.pem')) }, (request, response) => {
    if (request.headers['e2b-traffic-access-token'] !== local.native) { response.writeHead(403); response.end(); return; }
    const upstream = http.request({ hostname: '127.0.0.1', port: gatewayPort, path: request.url, method: request.method, headers: request.headers }, reply => { response.writeHead(reply.statusCode!, reply.headers); reply.pipe(response); });
    upstream.on('error', () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  ingress.on('connection', socket => { ingressSockets.add(socket); socket.once('close', () => ingressSockets.delete(socket)); });
  ingress.on('upgrade', (request, socket, head) => {
    if (request.headers['e2b-traffic-access-token'] !== local.native) { socket.destroy(); return; }
    const upstream = net.connect(gatewayPort, '127.0.0.1'); ingressSockets.add(upstream);
    upstream.once('close', () => ingressSockets.delete(upstream)); upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    socket.once('close', () => upstream.destroy()); upstream.once('close', () => socket.destroy());
    upstream.once('connect', () => { upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${Object.entries(request.headers).map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n`); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
  });
  local.ingress = `https://127.0.0.1:${await listen(ingress, '127.0.0.1')}`;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    // Exact synthetic GET only: no OAuth exchange, account lookup, redirects, or other external transport exists.
    if (url.href === 'https://api.github.com/repos/ephemeral/example-app' && (init.method ?? 'GET') === 'GET' &&
      new Headers(init.headers).get('authorization') === `Bearer ${local.credential}`) return new Response(JSON.stringify({ id: 101, permissions: { push: true } }));
    if (url.href === `https://49152-local-synthetic-sandbox.e2b.app${PREVIEW_DIAGNOSTIC_PATH}` && init.method === 'GET' && init.redirect === 'manual') return tlsDiagnostic(url, init);
    throw new Error('External transport is disabled in the local preview harness');
  });
  // Construct test-only configuration directly. Importing readConfig would load the operator's .env.
  const config: Config = configuration = { mode: 'live', port: 4310, publicUrl: 'http://127.0.0.1:4310', secure: false, sessionMaxHours: 1,
    previewPublicUrl: 'http://localhost:4312', previewPort: 4312, previewHost: '127.0.0.1', previewLocalOnly: true,
    host: '127.0.0.1', missing: [], databaseUrl: undefined, dataDir: local.directory,
    e2bApiKey: '', e2bTemplateId: '', githubAppId: '', githubAppSlug: '', privateKey: '', githubClientId: '', githubClientSecret: '', encryptionKey: key, allowedIds: new Set(['42']) };
  // Select the real server's static branch. The preview application's independent Vite remains in development mode.
  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { application = await createApplication(config, { previewAuthorizationCacheMs: 0 }); }
  finally { process.env.NODE_ENV = previousEnvironment; }
  const handlers = application.server.listeners('request'); application.server.removeAllListeners('request');
  application.server.on('request', (request, response) => {
    if (request.url?.startsWith('/__local_preview')) { void localControl(request, response); return; }
    if (request.url?.startsWith('/auth') || request.url?.startsWith('/gateway')) { response.writeHead(403); response.end('External authentication is disabled in this local harness.'); return; }
    if (!request.url?.startsWith('/api/') && request.url !== '/healthz') {
      // Serve an immutable snapshot so a later build cannot remove a lazy chunk already referenced by this page.
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'origin');
      response.setHeader('X-Frame-Options', 'DENY');
      response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'${configuration.previewPublicUrl ? ` ${previewFormSource(configuration.previewPublicUrl)}` : ''}`);
      if (request.url?.startsWith('/src/') || request.url?.startsWith('/@')) { response.writeHead(404); response.end(); return; }
      serveFrontend(request, response); return;
    }
    if (metadataFailure && request.method === 'GET' && request.url === `/api/sessions/${session.id}/preview`) { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'Synthetic preview metadata failure' })); return; }
    const dispatch = () => { if (!response.destroyed) for (const handler of handlers) handler.call(application!.server, request, response); };
    if (delayedShells && request.method === 'GET' && request.url === `/api/sessions/${session.id}/shells`) {
      const timer = setTimeout(dispatch, 10_000); response.once('close', () => clearTimeout(timer)); return;
    }
    dispatch();
  });
  api = `http://127.0.0.1:${await listen(application.server, '127.0.0.1')}`; config.publicUrl = api;
  viewer = createPreviewViewer(config, application.applicationPreview, { ca: certificate, fixtureOrigin: local.ingress });
  viewerBase = `http://localhost:${await listen(viewer.server, '127.0.0.1')}`; config.previewPublicUrl = viewerBase;
  // Viewer checks retain their configured URL object, so recreate after allocating the final port.
  const viewerPort = Number(new URL(viewerBase).port); await viewer.close();
  viewer = createPreviewViewer(config, application.applicationPreview, { ca: certificate, fixtureOrigin: local.ingress });
  await new Promise<void>(done => viewer!.server.listen(viewerPort, '127.0.0.1', done));
  ownerCookie = `ephemeral=${randomBytes(32).toString('base64url')}`;
  await application.db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
    [digest(ownerCookie.split('=')[1]), '42', 'local-synthetic-owner', '', seal(local.credential, key), new Date(Date.now() + 3600_000).toISOString()]);
  await resetSession();
}, 30_000);

afterAll(async () => {
  for (const release of local.terminal.recoveryWaiting.splice(0)) release();
  for (const release of local.terminal.attachmentWaiting.splice(0)) release();
  for (const client of clients) client.terminate();
  await stopFixture(); await viewer?.close(); await application?.close();
  for (const socket of ingressSockets) socket.destroy();
  if (ingress?.listening) await new Promise<void>(done => ingress!.close(() => done()));
  if (gateway && gateway.exitCode === null) { const exited = once(gateway, 'exit'); gateway.kill('SIGTERM'); await exited; }
  vi.unstubAllGlobals();
  if (local.directory) await rm(local.directory, { recursive: true, force: true });
}, 30_000);

const apiRequest = (suffix = '', body?: object) => nativeFetch(`${api}/api/sessions/${session.id}/preview${suffix}`, {
  method: body ? 'POST' : 'GET', headers: { Cookie: ownerCookie, Origin: api, 'X-Ephemeral-Request': '1', 'Content-Type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'manual',
});
// Resolve synthetic generation hosts explicitly: OS DNS need not implement *.localhost.
function viewerRequest(origin: string, path = '/', init: RequestInit = {}): Promise<Response> {
  const url = new URL(path, origin);
  return new Promise((done, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: new URL(viewerBase).port, path: url.pathname + url.search,
      method: init.method || 'GET', headers: { Host: url.host, ...Object.fromEntries(new Headers(init.headers).entries()) } }, response => {
      const parts: Buffer[] = []; response.on('data', part => parts.push(Buffer.from(part))); response.on('error', reject);
      response.on('end', () => done(new Response(Buffer.concat(parts), { status: response.statusCode,
        headers: Object.fromEntries(Object.entries(response.headers).filter(([, value]) => value !== undefined).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value as string])) })));
    }); request.on('error', reject); request.end(init.body?.toString());
  });
}
async function grant() {
  const prepared = await apiRequest('/open', {}).then(response => response.json());
  currentViewerOrigin = generationViewerOrigin(viewerBase, prepared.generation);
  expect(prepared.action).toBe(`${currentViewerOrigin}/__ephemeral/open`);
  const response = await viewerRequest(currentViewerOrigin, '/__ephemeral/open', { method: 'POST', headers: { Origin: api, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: prepared.token }) });
  expect(response.status).toBe(303); expect(response.headers.get('location')).toBe('/');
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  expect(cookie).not.toContain(ownerCookie.split('=')[1]);
  return cookie;
}
it('crosses real readiness, application assets, Vite HMR and grant revocation boundaries locally', async () => {
  expect((await nativeFetch(`${api}/src/Terminal.tsx`)).status).toBe(404);
  expect((await nativeFetch(`${api}/@vite/client`)).status).toBe(404);
  const frontend = await nativeFetch(api).then(response => response.text());
  expect(frontend).not.toContain('/src/');
  const modulePath = frontend.match(/<script[^>]+src="([^"]+)"/)?.[1];
  if (modulePath) { expect(modulePath).toMatch(/^\/assets\//); expect((await nativeFetch(new URL(modulePath, api))).status).toBe(200); }
  expect((await nativeFetch(`${api}/auth/github`, { redirect: 'manual' })).status).toBe(403);
  await expect(fetch('https://github.com/login/oauth/access_token', { method: 'POST' })).rejects.toThrow('External transport is disabled');
  expect((await nativeFetch(`${api}/__local_preview/start`, { method: 'POST', redirect: 'manual' })).status).toBe(403);
  expect(fixture).toBeUndefined();
  const shellResponse = await nativeFetch(`${api}/api/sessions/${session.id}/shells`, { method: 'POST', headers: {
    Cookie: ownerCookie, Origin: api, 'X-Ephemeral-Request': '1', 'Content-Type': 'application/json',
  }, body: JSON.stringify({ requestId: randomUUID(), name: 'Local Preview shell' }) });
  expect(shellResponse.status).toBe(200);
  const shellList = await shellResponse.json();
  expect(shellList.shells).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'supplemental', state: 'open' }), expect.objectContaining({ id: 'codex', kind: 'primary' })]));
  expect((await apiRequest('', { port: appPort })).status).toBe(200);
  expect(await apiRequest('/check', {}).then(response => response.json())).toMatchObject({ state: 'connection_refused', port: appPort, httpStatus: null });
  // Starting the actual app is explicit, separate from enabling or checking preview.
  expect((await nativeFetch(`${api}/__local_preview/start`, { method: 'POST', headers: { Origin: api }, redirect: 'manual' })).status).toBe(303);
  expect(await apiRequest('/check', {}).then(response => response.json())).toMatchObject({ state: 'responded', port: appPort, httpStatus: 200 });
  expect(seenDiagnostics).toHaveLength(1); expect(seenDiagnostics[0]).toMatchObject({ method: 'HEAD', path: '/' });
  for (const name of ['cookie', 'authorization', 'e2b-traffic-access-token', 'x-ephemeral-preview-port']) expect(seenDiagnostics[0].headers).not.toHaveProperty(name);
  const cookie = await grant(), firstOrigin = currentViewerOrigin, read = (path: string) => viewerRequest(firstOrigin, path, { headers: { Cookie: cookie } });
  const html = await read('/'); expect(html.status).toBe(200); expect(html.headers.get('content-security-policy')).toContain("connect-src 'self'");
  expect(await html.text()).toContain('/@vite/client');
  expect(await read('/App.jsx').then(response => response.text())).toContain('VITE_HMR_BEFORE');
  const clientCode = await read('/@vite/client').then(response => response.text());
  const wsToken = clientCode.match(/const wsToken = ["']([^"']+)["']/)?.[1];
  expect(wsToken).toBeTruthy();
  const ws = new WebSocket(`${viewerBase.replace('localhost', '127.0.0.1').replace('http:', 'ws:')}/?token=${wsToken}`, 'vite-hmr', { headers: { Host: new URL(firstOrigin).host, Cookie: cookie, Origin: firstOrigin } });
  clients.add(ws); ws.on('error', () => {}); await once(ws, 'open');
  const messages: { type: string; updates?: { path: string }[] }[] = [];
  ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
  await new Promise(done => setTimeout(done, 100));
  await editFixture(true);
  await vi.waitFor(() => expect(messages.some(message => message.type === 'update' && message.updates?.some(update => update.path === '/App.jsx'))).toBe(true), { timeout: 10_000 });
  expect(await read('/App.jsx').then(response => response.text())).toContain('VITE_HMR_AFTER');
  const closed = once(ws, 'close'); expect((await apiRequest('/close', {})).status).toBe(200); await closed;
  expect((await read('/')).status).toBe(401);
  await apiRequest('', { port: appPort }); const endedCookie = await grant();
  await application!.repo.update({ ...session, state: 'ended', endedAt: new Date().toISOString() });
  expect((await viewerRequest(currentViewerOrigin, '/', { headers: { Cookie: endedCookie } })).status).toBe(403);
  expect((await viewerRequest(firstOrigin, '/', { headers: { Cookie: endedCookie } })).status).toBe(401);
  await stopFixture(); await editFixture(false); await resetSession();
}, 30_000);

it('exercises synthetic primary exit, explicit delayed recovery and ready, and ACK-controlled Unicode paste through the real application', async () => {
  const action = async (name: string) => expect((await nativeFetch(`${api}/__local_preview/${name}`, { method: 'POST', headers: { Origin: api }, redirect: 'manual' })).status).toBe(303);
  const stats = () => nativeFetch(`${api}/__local_preview/terminal-stats`).then(response => response.json());
  const shells = (suffix = '', body?: object) => nativeFetch(`${api}/api/sessions/${session.id}/shells${suffix}`, { method: body ? 'POST' : 'GET',
    headers: { Cookie: ownerCookie, Origin: api, 'X-Ephemeral-Request': '1', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const states: TerminalState[] = [];
  const ready = vi.fn();
  const attachment = new TerminalAttachment(() => {
    const socket = new WebSocket(`${api.replace('http:', 'ws:')}/api/sessions/${session.id}/terminal`, { headers: { Cookie: ownerCookie, Origin: api } });
    socket.on('error', () => {}); clients.add(socket);
    return socket as unknown as globalThis.WebSocket;
  }, state => states.push(state), () => {}, ready);
  try {
    attachment.connect();
    await vi.waitFor(() => expect(states.at(-1)?.phase).toBe('connected'));
    expect(ready).toHaveBeenCalledTimes(1);
    await action('primary-exit');
    await vi.waitFor(() => expect(states.at(-1)?.phase).toBe('disconnected'));
    expect(attachment.input('must not run')).toBe(false);
    expect(await shells().then(response => response.json())).toMatchObject({ shells: expect.arrayContaining([expect.objectContaining({ id: 'codex', state: 'closed' })]) });
    await action('recovery-error-once');
    expect((await shells('/codex/recover', {})).status).toBe(409);
    expect((await stats()).primaryOpen).toBe(false);
    await action('delay-next-recovery'); await action('delay-next-attachment');
    const recovery = shells('/codex/recover', {});
    await vi.waitFor(async () => expect((await stats()).recoveryWaiting).toBe(1));
    expect(states.at(-1)?.phase).toBe('disconnected');
    await action('release-recovery');
    const recovered = await recovery; expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ shells: expect.arrayContaining([expect.objectContaining({ id: 'codex', state: 'open' })]) });
    attachment.connect(true);
    await vi.waitFor(async () => expect((await stats()).attachmentWaiting).toBe(1));
    expect(states.at(-1)?.phase).toBe('attaching');
    expect(attachment.input('not ready yet')).toBe(false);
    expect(ready).toHaveBeenCalledTimes(1);
    await action('release-attachment');
    await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(2));
    expect(states.at(-1)?.phase).toBe('connected');
    await action('terminal-reset-counters'); await action('toggle-write-delay');
    const paste = '\x1b[200~' + '🙂漢字é'.repeat(9000) + '\x1b[201~';
    expect(attachment.input(paste)).toBe(true);
    await vi.waitFor(async () => expect(await stats()).toMatchObject({ synthetic: true, inputBytes: Buffer.byteLength(paste), inputSha256: createHash('sha256').update(paste).digest('hex') }), { timeout: 5000 });
    expect((await stats()).writes).toBeGreaterThan(1);
    expect(states.at(-1)?.phase).toBe('connected');
    const recoveries = (await stats()).recoveries;
    expect((await shells('/codex/recover', {})).status).toBe(200);
    expect((await stats()).recoveries).toBe(recoveries);
    expect((await stats()).recoveryWaiting).toBe(0);
  } finally { attachment.dispose(); await resetSession(); }
  expect(await stats()).toMatchObject({ primaryOpen: true, writeDelayMs: 0, recoveryWaiting: 0, attachmentWaiting: 0,
    nextRecoveryDelayed: false, nextAttachmentDelayed: false, failNextRecovery: false, inputBytes: 0, writes: 0, recoveries: 0, recoveryCalls: 0, attachments: 0, activeAttachments: 0 });
}, 15_000);

it.skipIf(!browserMode)('keeps the explicit local browser harness available for up to fifteen minutes', async () => {
  console.log(`\nLocal Preview E2E controls: ${api}/__local_preview\nSynthetic sign-in: ${api}/__local_preview/sign-in\nApplication port: ${appPort}\nUse the controls to start Vite explicitly. No account, provider, or OAuth credentials are used.\n`);
  await new Promise<void>(done => {
    let finished = false;
    const finish = () => { if (finished) return; finished = true; clearInterval(poll); clearTimeout(deadline); done(); };
    quit = finish;
    const poll = setInterval(() => {
      const controller = process.env.EPHEMERAL_LOCAL_PREVIEW_CONTROL_DIR;
      if (controller) void access(join(controller, 'stop')).then(finish).catch(() => {});
    }, 250);
    const deadline = setTimeout(finish, 15 * 60_000);
  });
}, 16 * 60_000);
