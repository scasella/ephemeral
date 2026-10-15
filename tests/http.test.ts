import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { WebSocket } from 'ws';

// Use a real HTTP server and embedded PostgreSQL; no provider or account is touched.
describe('HTTP access boundary and preview honesty', () => {
  let application: Awaited<ReturnType<typeof createApplication>>;
  let directory: string; let origin: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ephemeral-http-test-'));
    const config = readConfig({ EPHEMERAL_MODE: 'preview', DATA_DIR: directory, PORT: '4319' });
    application = await createApplication(config);
    await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve));
    const address = application.server.address(); if (!address || typeof address === 'string') throw new Error('No server address');
    origin = `http://127.0.0.1:${address.port}`;
  }, 30_000);
  afterAll(async () => { await application?.close(); if (directory) await rm(directory, { recursive: true, force: true }); }, 30_000);
  it('labels preview and never exposes an OAuth credential', async () => {
    const data = await fetch(`${origin}/api/bootstrap`).then(r => r.json());
    expect(data.mode).toBe('preview'); expect(data.configured).toBe(false);
    expect(data.user).not.toHaveProperty('accessToken');
  });
  it('rejects CSRF before creating a session', async () => {
    const response = await fetch(`${origin}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(403);
    const crossOrigin = await fetch(`${origin}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1', Origin: 'https://evil.test' }, body: '{}' });
    expect(crossOrigin.status).toBe(403);
  });
  it('rejects forged repository IDs', async () => {
    const response = await fetch(`${origin}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1' }, body: JSON.stringify({ repositoryId: 999, installationId: 999, baseBranch: 'main' }) });
    expect(response.status).toBe(403);
  });
  it('does not reveal or stop another user session', async () => {
    const session = await application.manager.create({ userId: 'another-user', repository: 'example/private', repositoryId: 99, installationId: 99, baseBranch: 'main' });
    expect((await fetch(`${origin}/api/sessions/${session.id}`)).status).toBe(404);
    expect((await fetch(`${origin}/api/sessions/${session.id}/events`)).status).toBe(404);
    expect((await fetch(`${origin}/api/sessions/${session.id}/stop`, { method: 'POST', headers: { 'X-Ephemeral-Request': '1' } })).status).toBe(404);
  });
  it('rejects a terminal WebSocket from an untrusted Origin', async () => {
    const result = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/api/sessions/nonexistent/terminal`, { origin: 'https://evil.test' });
      ws.on('unexpected-response', (_request, response) => { response.resume(); ws.terminate(); resolve(response.statusCode || 0); });
      ws.on('error', () => {}); ws.on('open', () => { ws.close(); reject(new Error('Untrusted terminal opened')); });
    });
    expect(result).toBe(403);
  });
  it('rejects fake PR creation in preview', async () => {
    const response = await fetch(`${origin}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1' }, body: JSON.stringify({ repositoryId: 101, installationId: 1, baseBranch: 'main' }) });
    expect(response.status).toBe(202);
    const session = await response.json();
    const pr = await fetch(`${origin}/api/sessions/${session.id}/pull-request`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1' }, body: JSON.stringify({ title: 'Demo', expectedHeadSha: 'a'.repeat(40), expectedBaseSha: 'b'.repeat(40) }) });
    expect(pr.status).toBe(409); expect((await pr.json()).error).toMatch(/Preview does not create/);
  });
});
