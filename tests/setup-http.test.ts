import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { digest, seal } from '../server/auth/crypto.js';
import type { Session } from '../server/contracts.js';

const stubs = vi.hoisted(() => ({ authorize: vi.fn(), run: vi.fn() }));
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
  return { E2BProvider: class extends PreviewProvider { runSetup = stubs.run; async exists() { return true; } } };
});

const headers = { 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1', Cookie: 'ephemeral=owner-browser' };
const input = { label: 'Setup and test', command: 'npm ci && npm test', timeoutSeconds: 5 };

describe('repository setup HTTP boundary', () => {
  let application: Awaited<ReturnType<typeof createApplication>>, directory: string, origin: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ep-setup-http-'));
    const key = Buffer.alloc(32, 1).toString('base64');
    const config = readConfig({ EPHEMERAL_MODE: 'preview', DATA_DIR: directory, PUBLIC_URL: 'http://localhost:4327', ENCRYPTION_KEY: key, ALLOWED_GITHUB_IDS: '42,99' });
    application = await createApplication({ ...config, mode: 'live' });
    await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve));
    const address = application.server.address(); if (!address || typeof address === 'string') throw new Error('No server address'); origin = `http://127.0.0.1:${address.port}`;
    await application.db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
      [digest('owner-browser'), '42', 'owner', '', seal('test-credential', key), new Date(Date.now() + 3600_000).toISOString()]);
  }, 30_000);
  afterAll(async () => { await application?.close(); await rm(directory, { recursive: true, force: true }); }, 30_000);
  beforeEach(() => { stubs.authorize.mockReset().mockResolvedValue(undefined); stubs.run.mockReset().mockResolvedValue({ status: 'succeeded', exitCode: 0 }); });
  async function insert(id: string, changes: Partial<Session> = {}) {
    const s: Session = { id, userId: '42', repository: 'owner/repo', repositoryId: 1, installationId: 2, baseBranch: 'main', branch: `ephemeral/${id}`, state: 'running',
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(), maxExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      sandboxId: `preview-${id}`, endedAt: null, error: null, cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified', ...changes };
    await application.db.query("UPDATE ephemeral_sessions SET state='ended',data=jsonb_set(data,'{state}','\"ended\"'::jsonb) WHERE user_id=$1", [s.userId]);
    await application.repo.insert(s); return s;
  }
  const request = (id: string, method = 'GET', body?: unknown, extra = {}, suffix = '') => fetch(`${origin}/api/sessions/${id}/setup${suffix}`, { method, headers: { ...headers, ...extra }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

  it('requires authenticated ownership for reads, saves, runs and cancellation', async () => {
    const s = await insert('foreign', { userId: '99' });
    expect((await request(s.id, 'GET', undefined, { Cookie: '' })).status).toBe(401);
    expect((await request(s.id)).status).toBe(404);
    expect((await request(s.id, 'PUT', input)).status).toBe(404);
    expect((await request(s.id, 'POST', { recipeVersion: '00000000-0000-4000-8000-000000000000' }, {}, '/runs')).status).toBe(404);
    expect((await request(s.id, 'POST', {}, {}, '/runs/00000000-0000-4000-8000-000000000000/cancel')).status).toBe(404);
    expect(stubs.authorize).not.toHaveBeenCalled(); expect(stubs.run).not.toHaveBeenCalled();
  });

  it('enforces same origin, verification header, strict schemas, and bounded command/timeout fields', async () => {
    const s = await insert('validation');
    expect((await request(s.id, 'PUT', input, { Origin: 'https://evil.test' })).status).toBe(403);
    expect((await request(s.id, 'PUT', input, { 'X-Ephemeral-Request': '' })).status).toBe(403);
    for (const body of [{ ...input, timeoutSeconds: 0 }, { ...input, timeoutSeconds: 601 }, { ...input, timeoutSeconds: 5.5 }, { ...input, command: '' },
      { ...input, command: 'x'.repeat(8193) }, { ...input, command: 'echo\0private' }, { ...input, unknown: true }, []]) expect((await request(s.id, 'PUT', body)).status).toBe(400);
    expect(stubs.authorize).not.toHaveBeenCalled(); expect(stubs.run).not.toHaveBeenCalled();
  });

  it('saves only on explicit request, rejects stale reviewed versions, and exposes a retained completed run', async () => {
    const s = await insert('http-success');
    const saved = await request(s.id, 'PUT', input).then(r => r.json()); expect(saved).toMatchObject({ recipe: input, run: null, mode: 'live' }); expect(stubs.run).not.toHaveBeenCalled();
    const changed = await request(s.id, 'PUT', { ...input, command: 'npm test' }).then(r => r.json());
    expect((await request(s.id, 'POST', { recipeVersion: saved.recipe.version }, {}, '/runs')).status).toBe(409);
    const started = await request(s.id, 'POST', { recipeVersion: changed.recipe.version }, {}, '/runs'); expect(started.status).toBe(202);
    await vi.waitFor(async () => expect((await request(s.id).then(r => r.json())).run?.status).toBe('succeeded'));
    await application.repo.update({ ...s, state: 'ended' });
    const retained = await request(s.id).then(r => r.json()); expect(retained.run.recipe.command).toBe('npm test'); expect(retained.run.exitCode).toBe(0);
    expect((await request(s.id, 'PUT', input)).status).toBe(409);
    expect((await request(s.id, 'POST', { recipeVersion: changed.recipe.version }, {}, '/runs')).status).toBe(409);
  });

  it('refuses access loss and lifecycle changes during authorization without launching a command', async () => {
    const s = await insert('auth-race'); const saved = await request(s.id, 'PUT', input).then(r => r.json());
    stubs.authorize.mockRejectedValueOnce(new Error('Repository access denied'));
    expect((await request(s.id, 'POST', { recipeVersion: saved.recipe.version }, {}, '/runs')).status).toBe(409);
    stubs.authorize.mockImplementationOnce(async () => { await application.repo.update({ ...s, state: 'ended' }); });
    expect((await request(s.id, 'POST', { recipeVersion: saved.recipe.version }, {}, '/runs')).status).toBe(409);
    expect(stubs.run).not.toHaveBeenCalled(); expect((await request(s.id).then(r => r.json())).run).toBeNull();
  });
});
