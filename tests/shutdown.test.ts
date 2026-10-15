import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { connect, type Socket } from 'node:net';
import { WebSocket } from 'ws';
import { createServer } from 'node:http';
import { createPreviewViewer } from '../server/application-preview-viewer.js';
import type { ApplicationPreview, PreviewGrant } from '../server/application-preview.js';
import { beforeDeadline } from '../server/shutdown.js';
import { createApplication } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { PreviewProvider } from '../server/preview.js';
import { openDatabase } from '../server/db.js';

const control = vi.hoisted(() => ({ health: 'ok', failInit: false, fatal: undefined as (() => void) | undefined, closes: 0 }));
vi.mock('../server/db.js', async importOriginal => {
  const original = await importOriginal<typeof import('../server/db.js')>();
  return { ...original, async openDatabase(...args: Parameters<typeof original.openDatabase>) {
    const db = await original.openDatabase(...args);
    return { ...db,
      query: ((sql: string, ...args: unknown[]) => {
        if (control.failInit) { control.failInit = false; return Promise.reject(new Error('Injected initialization failure')); }
        if (sql === 'SELECT 1' && control.health === 'hang') return new Promise(() => {});
        if (sql === 'SELECT 1' && control.health === 'fail') return Promise.reject(new Error('Database unavailable'));
        return db.query(sql, ...args as []);
      }) as typeof db.query,
      onFatal(listener: () => void) { control.fatal = listener; return db.onFatal?.(listener) ?? (() => {}); },
      async close() { control.closes++; await db.close(); },
    };
  } };
});

let directory = '', application: Awaited<ReturnType<typeof createApplication>> | undefined;
let sockets: Socket[] = [];
afterEach(async () => {
  for (const socket of sockets) socket.destroy(); sockets = [];
  if (application) { await application.close().catch(() => {}); await application.db.close(); application = undefined; }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  control.health = 'ok'; control.failInit = false; control.fatal = undefined; control.closes = 0;
  if (directory) await rm(directory, { recursive: true, force: true }); directory = '';
});
async function start(options: Parameters<typeof createApplication>[1] = {}) {
  vi.stubEnv('NODE_ENV', 'production');
  directory = await mkdtemp(join(tmpdir(), 'ephemeral-shutdown-'));
  application = await createApplication(readConfig({ EPHEMERAL_MODE: 'preview', DATA_DIR: directory }), options);
  await new Promise<void>(resolve => application!.server.listen(0, '127.0.0.1', resolve));
  const address = application.server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  return `http://127.0.0.1:${address.port}`;
}
async function raw(origin: string, request: string) {
  const url = new URL(origin), socket = connect(Number(url.port), url.hostname); sockets.push(socket);
  socket.on('error', () => {});
  await new Promise<void>(resolve => socket.once('connect', resolve)); socket.write(request); return socket;
}
describe('bounded application shutdown', () => {
  it('keeps the healthy response exact and bounds failed or unresponsive DB readiness checks', async () => {
    const origin = await start({ healthTimeoutMs: 30 });
    expect(await fetch(`${origin}/healthz`).then(r => r.json())).toEqual({ status: 'ok', mode: 'preview' });
    control.health = 'fail'; expect((await fetch(`${origin}/healthz`)).status).toBe(503);
    control.health = 'hang'; expect((await fetch(`${origin}/healthz`)).status).toBe(503);
  });
  it('closes held-open HTTP and terminal sockets, is idempotent, and releases embedded ownership', async () => {
    const origin = await start({ shutdownTimeoutMs: 1500 });
    await raw(origin, 'POST /api/sessions HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000\r\nContent-Type: application/json\r\n\r\n{');
    const session = await application!.manager.create({ userId: 'preview-user', repository: 'ephemeral/example-app', repositoryId: 101, installationId: 1, baseBranch: 'main' });
    await vi.waitFor(async () => expect((await application!.repo.get(session.id))?.state).toBe('running'));
    const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/api/sessions/${session.id}/terminal`, { origin: 'http://localhost:4310' });
    ws.on('error', () => {});
    const ready = new Promise<void>(resolve => { ws.on('message', data => { if (JSON.parse(String(data)).type === 'ready') resolve(); }); });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('unexpected-response', () => reject(new Error('Terminal was refused'))); });
    await beforeDeadline(ready, 1000);
    const wsClosed = new Promise<void>(resolve => ws.once('close', () => resolve()));
    const first = application!.close(); expect(application!.close()).toBe(first); await first; await wsClosed;
    expect(application!.server.listening).toBe(false);
    const reopened = await openDatabase('', join(directory, 'preview')); await reopened.close();
    ws.terminate();
  });
  it('fails boundedly and retains ownership for an unresponsive provider worker', async () => {
    await start({ shutdownTimeoutMs: 50 });
    let release!: (id: string) => void;
    const entered = vi.fn();
    vi.spyOn(PreviewProvider.prototype, 'create').mockImplementation(() => { entered(); return new Promise(resolve => { release = resolve; }); });
    await application!.manager.create({ userId: 'preview-user', repository: 'ephemeral/example-app', repositoryId: 101, installationId: 1, baseBranch: 'main' });
    await vi.waitFor(() => expect(entered).toHaveBeenCalled());
    await expect(application!.close()).rejects.toThrow('ownership is retained');
    expect(application!.server.listening).toBe(false);
    await access(join(directory, 'preview', 'control-plane.lock'));
    await expect(application!.manager.create({ userId: 'preview-user', repository: 'ephemeral/example-app', repositoryId: 101, installationId: 1, baseBranch: 'main' })).rejects.toThrow('shutting down');
    release('preview-finished'); await application!.manager.shutdown();
  });
  it('drains the actual admitted HTTP handler before releasing database ownership', async () => {
    const origin = await start({ shutdownTimeoutMs: 1500 });
    const session = await application!.manager.create({ userId: 'preview-user', repository: 'ephemeral/example-app', repositoryId: 101, installationId: 1, baseBranch: 'main' });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = application!.repo.setLabel.bind(application!.repo);
    const entered = vi.fn();
    vi.spyOn(application!.repo, 'setLabel').mockImplementation(async (...args) => { entered(); await gate; return original(...args); });
    const request = fetch(`${origin}/api/sessions/${session.id}/label`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1' }, body: JSON.stringify({ label: 'drained write' }) }).catch(() => undefined);
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    const closed = application!.close();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(control.closes).toBe(0);
    await expect(openDatabase('', join(directory, 'preview'))).rejects.toThrow('lock exists');
    release(); await closed; await request;
    const reopened = await openDatabase('', join(directory, 'preview'));
    try {
      const { rows } = await reopened.query<{ label: string }>("SELECT label FROM ephemeral_session_labels WHERE session_id=$1", [session.id]);
      expect(rows[0]?.label).toBe('drained write');
    } finally { await reopened.close(); }
  });
  it('closes the database when initialization fails before listening', async () => {
    vi.stubEnv('NODE_ENV', 'production'); directory = await mkdtemp(join(tmpdir(), 'ephemeral-init-failure-'));
    control.failInit = true;
    await expect(createApplication(readConfig({ EPHEMERAL_MODE: 'preview', DATA_DIR: directory }))).rejects.toThrow('Injected initialization failure');
    expect(control.closes).toBe(1);
    const reopened = await openDatabase('', join(directory, 'preview')); await reopened.close();
  });
  it('replays a database fatal signal and closes listeners', async () => {
    await start(); control.fatal!();
    const notified = vi.fn(); application!.onFatal(notified); expect(notified).toHaveBeenCalledOnce();
    await application!.close(); expect(application!.server.listening).toBe(false);
    const probe = createServer(application!.app);
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    try {
      const address = probe.address(); if (!address || typeof address === 'string') throw new Error('No address');
      expect((await fetch(`http://127.0.0.1:${address.port}/healthz`, { headers: { Connection: 'close' } })).status).toBe(503);
    } finally { await new Promise<void>(resolve => probe.close(() => resolve())); }
  });
  it('cancels a viewer upgrade while authorization is still pending', async () => {
    const config = { ...readConfig({ EPHEMERAL_MODE: 'preview', PUBLIC_URL: 'http://127.0.0.1:4310' }), previewPublicUrl: 'http://localhost:4312' };
    let release!: (grant: PreviewGrant) => void;
    const readGrant = vi.fn(() => new Promise<PreviewGrant>(resolve => { release = resolve; })), target = vi.fn();
    const viewer = createPreviewViewer(config, { readGrant, target, onRevoke: () => () => {} } as unknown as ApplicationPreview);
    await new Promise<void>(resolve => viewer.server.listen(0, '127.0.0.1', resolve));
    try {
      const address = viewer.server.address(); if (!address || typeof address === 'string') throw new Error('No address');
      const origin = 'http://12345678-1234-1234-1234-123456789abc.localhost:4312';
      const socket = await raw(`http://127.0.0.1:${address.port}`, `GET / HTTP/1.1\r\nHost: ${new URL(origin).host}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`);
      await vi.waitFor(() => expect(readGrant).toHaveBeenCalledOnce());
      const first = viewer.close(); expect(viewer.close()).toBe(first);
      await vi.waitFor(() => expect(socket.destroyed).toBe(true));
      release({} as PreviewGrant); await beforeDeadline(first, 300);
      expect(target).not.toHaveBeenCalled();
    } finally { await viewer.close(); }
  });
});
