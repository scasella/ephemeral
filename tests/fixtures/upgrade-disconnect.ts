// Real TCP sockets and real upgrade handlers; only authorization and providers
// are synthetic. No uncaughtException handler: an unguarded ECONNRESET is fatal.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Router } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { createPreviewViewer } from '../../server/application-preview-viewer.js';
import { PreviewProvider, previewCredentials } from '../../server/preview.js';
import type { ApplicationPreview, PreviewGrant } from '../../server/application-preview.js';
import type { Config } from '../../server/config.js';
import { loadEnvironmentCatalog } from '../../server/environments.js';
import type { Session } from '../../server/contracts.js';

const directory = await mkdtemp(join(tmpdir(), 'ep-upgrade-reset-'));
const controlOrigin = 'https://control.example.test';
const generation = '12345678-1234-1234-1234-123456789abc';
const viewerOrigin = `http://${generation}.localhost:4358`;
const config: Config = {
  environmentProfiles: loadEnvironmentCatalog({ mode: 'live', templateId: 'synthetic' }),
  mode: 'live', port: 4357, publicUrl: controlOrigin, secure: true, sessionMaxHours: 1,
  previewPublicUrl: null, previewPort: 4358, previewHost: '127.0.0.1', previewLocalOnly: true,
  host: '127.0.0.1', missing: [], databaseUrl: undefined, dataDir: directory,
  e2bApiKey: 'synthetic', e2bTemplateId: 'synthetic', githubAppId: 'synthetic', githubAppSlug: 'synthetic',
  privateKey: '', githubClientId: 'synthetic', githubClientSecret: 'synthetic',
  encryptionKey: Buffer.alloc(32, 7).toString('base64'), allowedIds: new Set(['42']),
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
let stage = '', waiting = deferred(), resume = deferred();
async function hold(name: string) {
  if (stage !== name) return;
  const gate = resume;
  waiting.resolve();
  await gate.promise;
}
function pause(name: string) { stage = name; waiting = deferred(); resume = deferred(); }
const address = (server: { address(): ReturnType<import('node:http').Server['address']> }) => {
  const value = server.address(); assert(value && typeof value !== 'string'); return value.port;
};
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out at ${stage}`)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}
let upgrades = 0;
const originalUpgrade = WebSocketServer.prototype.handleUpgrade;
WebSocketServer.prototype.handleUpgrade = function (...args) { upgrades++; return originalUpgrade.apply(this, args); };

async function resetDuringWait(server: import('node:http').Server, path: string, origin: string) {
  // Observe close without adding an error listener: only the actual handler
  // may prevent an unhandled raw-socket error from killing this child.
  const serverClosed = new Promise<void>(resolve => server.once('upgrade', (_req, socket) => socket.once('close', () => resolve())));
  const client = connect(address(server), '127.0.0.1');
  client.on('error', () => {});
  await once(client, 'connect');
  client.write(`GET ${path} HTTP/1.1\r\nHost: ${new URL(origin).host}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`);
  await bounded(waiting.promise);
  client.resetAndDestroy();
  await bounded(serverClosed);
}
async function open(server: import('node:http').Server, path: string, origin: string) {
  const client = new WebSocket(`ws://127.0.0.1:${address(server)}${path}`, { origin, headers: { Host: new URL(origin).host } });
  await bounded(once(client, 'open'));
  return client;
}
async function closeClient(client: WebSocket) { const closed = once(client, 'close'); client.close(); await bounded(closed); }

async function terminal() {
  const auth = await import('../../server/auth/index.js');
  let attached = 0, authorized = 0;
  mock.module('../../server/auth/index.ts', { exports: { ...auth, createAuth: async () => ({
    router: Router(), read: async () => { await hold('identity'); return { id: '42', login: 'fixture', avatarUrl: '', accessToken: '' }; },
    authorizeSession: async () => { authorized++; await hold('authorization'); }, prune: async () => {},
    browserHash: () => 'fixture-browser',
  }) } });
  mock.module('../../server/infra/e2b.ts', { exports: { E2BProvider: class extends PreviewProvider {
    async exists() { return true; }
    async connectTerminal() { attached++; return { write: async () => {}, resize: async () => {}, disconnect: async () => {} }; }
  } } });
  mock.module('../../server/github/index.ts', { exports: { createGitHubServices: async () => ({ router: Router(), credentials: previewCredentials, close: async () => {} }) } });
  const { createApplication } = await import('../../server/app.js');
  const app = await createApplication(config, { terminalAuthorizationCacheMs: 0 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const session: Session = { id: '12345678-1234-1234-1234-123456789abc', userId: '42', repository: 'fixture/repo', repositoryId: 1, installationId: 1,
    baseBranch: 'main', branch: 'ephemeral/fixture', state: 'running', sandboxId: 'fixture-vm', createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), maxExpiresAt: new Date(Date.now() + 7200_000).toISOString(), endedAt: null, error: null,
    cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified' };
  await app.repo.insert(session);
  try {
    for (const phase of ['identity', 'authorization']) {
      pause(phase);
      const before = authorized;
      await resetDuringWait(app.server, `/api/sessions/${session.id}/terminal`, controlOrigin);
      resume.resolve(); await delay(50);
      assert.equal(attached, 0, 'disconnected terminal must never attach its provider');
      assert.equal(upgrades, 0, 'disconnected terminal must never reach handleUpgrade');
      if (phase === 'identity') assert.equal(authorized, before, 'disconnected identity lookup must not continue authorization');
      assert.equal((await fetch(`http://127.0.0.1:${address(app.server)}/healthz`)).status, 200);
    }
    stage = '';
    const client = new WebSocket(`ws://127.0.0.1:${address(app.server)}/api/sessions/${session.id}/terminal`, { origin: controlOrigin });
    const ready = once(client, 'message');
    await bounded(once(client, 'open')); await bounded(ready);
    assert.equal(attached, 1);
    await closeClient(client);
  } finally { await app.close(); }
}

async function viewer() {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  const cert = await readFile(join(directory, 'cert.pem'));
  const fixture = createHttpsServer({ cert, key: await readFile(join(directory, 'key.pem')) });
  const fixtureWs = new WebSocketServer({ noServer: true });
  let upstreams = 0, targets = 0, validations = 0;
  fixture.on('upgrade', (req, socket, head) => {
    upstreams++; socket.on('error', () => {});
    void hold('upstream').then(() => { if (!socket.destroyed) fixtureWs.handleUpgrade(req, socket, head, () => {}); });
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const fixtureOrigin = `https://127.0.0.1:${address(fixture)}`;
  const grant: PreviewGrant = { session_id: 'fixture', user_id: '42', browser_hash: 'fixture', generation, expires_at: new Date(Date.now() + 3600_000).toISOString() };
  const preview = {
    readGrant: async () => { await hold('grant'); return grant; },
    target: async () => { targets++; await hold('target'); return { origin: fixtureOrigin, sandboxId: 'fixture', headers: {} }; },
    validate: async () => { validations++; await hold('validation'); }, onRevoke: () => () => {},
  } as unknown as ApplicationPreview;
  const app = createPreviewViewer({ ...config, previewPublicUrl: 'http://localhost:4358' }, preview, { ca: cert, fixtureOrigin });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  try {
    for (const phase of ['grant', 'target', 'upstream', 'validation']) {
      pause(phase);
      const before = { targets, upstreams, validations, upgrades };
      await resetDuringWait(app.server, '/', viewerOrigin);
      const pendingGate = resume;
      stage = '';
      if (phase === 'upstream') await delay(50);
      pendingGate.resolve(); await delay(50);
      assert.equal(targets, before.targets + (phase === 'grant' ? 0 : 1));
      assert.equal(upstreams, before.upstreams + (['grant', 'target'].includes(phase) ? 0 : 1));
      assert.equal(validations, before.validations + (phase === 'validation' ? 1 : 0));
      assert.equal(upgrades, before.upgrades + (phase === 'validation' ? 1 : 0), 'cancelled viewer must never reach its handleUpgrade');
      assert.equal(fixtureWs.clients.size, 0, 'cancelled viewer must close its pending upstream');
      const client = await open(app.server, '/', viewerOrigin);
      await closeClient(client);
    }
    // More than the total admission cap disconnect while grant auth remains
    // pending; their reservations must be released immediately on close.
    for (const [phase, count] of [['grant', 65], ['target', 17]] as const) {
      pause(phase);
      for (let i = 0; i < count; i++) {
        waiting = deferred();
        await resetDuringWait(app.server, '/', viewerOrigin);
      }
      const pendingGate = resume; stage = '';
      const client = await open(app.server, '/', viewerOrigin);
      await closeClient(client); pendingGate.resolve(); await delay(50);
    }
  } finally {
    resume.resolve(); await app.close();
    fixtureWs.clients.forEach(client => client.terminate());
    await new Promise<void>(resolve => fixtureWs.close(() => resolve()));
    fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve()));
  }
}
try {
  assert.equal(process.versions.node.split('.')[0], '24', 'Run this regression with Node 24');
  if (process.argv[2] === 'terminal') await terminal(); else await viewer();
  console.log(`${process.argv[2]}: cancellation and subsequent connection passed`);
} finally { await rm(directory, { recursive: true, force: true }); }
