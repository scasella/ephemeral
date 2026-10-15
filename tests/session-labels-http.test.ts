import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/app.js';
import { createLiveApplication } from './helpers/create-live-application.js';
import { readConfig } from '../server/config.js';
import { digest, seal } from '../server/auth/crypto.js';
import type { Session } from '../server/contracts.js';

const operations = vi.hoisted(() => ({ issue: vi.fn(async () => 'unused-token'), create: vi.fn(async () => 'unused-vm') }));
vi.mock('../server/github/index.js', async () => {
  const { Router } = await import('express'); const { previewCredentials } = await import('../server/preview.js');
  return { createGitHubServices: async () => ({ router: Router(), credentials: { ...previewCredentials, issue: operations.issue }, close: async () => {} }) };
});
vi.mock('../server/infra/e2b.js', async () => {
  const { PreviewProvider } = await import('../server/preview.js');
  return { E2BProvider: class extends PreviewProvider { create = operations.create; } };
});
const key = Buffer.alloc(32, 1).toString('base64');
const headers = { 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1', Cookie: 'ephemeral=label-owner' };

describe('session label HTTP ownership and input', () => {
  let application: Awaited<ReturnType<typeof createApplication>>, directory: string, origin: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ep-label-http-'));
    const config = readConfig({ EPHEMERAL_MODE: 'preview', DATA_DIR: directory, PUBLIC_URL: 'http://localhost:4329', ENCRYPTION_KEY: key, ALLOWED_GITHUB_IDS: '42,99' });
    application = await createLiveApplication({ ...config, mode: 'live' });
    await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve));
    const address = application.server.address(); if (!address || typeof address === 'string') throw new Error('No server address');
    origin = `http://127.0.0.1:${address.port}`;
    for (const [cookie, expires] of [['label-owner', Date.now() + 3600_000], ['expired-owner', Date.now() - 1]] as const) {
      await application.db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
        [digest(cookie), '42', 'owner', '', seal('OWNER-CREDENTIAL', key), new Date(expires).toISOString()]);
    }
  }, 30_000);
  afterAll(async () => { await application?.close(); if (directory) await rm(directory, { recursive: true, force: true }); }, 30_000);
  async function insert(state: Session['state'] = 'ended', userId = '42') {
    const id = randomUUID(), now = new Date().toISOString();
    const session: Session = { id, userId, repository: 'owner/repo', repositoryId: 1, installationId: 2,
      baseBranch: 'main', branch: `ephemeral/${id}`, state, createdAt: now,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), maxExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
      sandboxId: state === 'running' ? 'existing-vm' : null, endedAt: state === 'ended' ? now : null, error: null,
      cleanup: { vm: 'not_applicable', github: 'not_applicable', gateway: 'not_applicable', codex: 'not_applicable' }, codexRemoteRevocation: 'unverified' };
    await application.repo.insert(session); return session;
  }
  const post = (id: string, body: unknown = { label: 'Investigate checkout' }, extra = {}) =>
    fetch(`${origin}/api/sessions/${id}/label`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });

  it('requires current browser identity and hides foreign or missing sessions', async () => {
    const s = await insert('ended', '99');
    expect((await post(s.id, undefined, { Cookie: '' })).status).toBe(401);
    expect((await post(s.id, undefined, { Cookie: 'ephemeral=expired-owner' })).status).toBe(401);
    expect((await post(s.id)).status).toBe(404); expect((await post(randomUUID())).status).toBe(404);
    expect(await application.repo.get(s.id)).toEqual(s);
  });
  it('enforces same origin and request verification before changing metadata', async () => {
    const s = await insert();
    expect((await post(s.id, undefined, { Origin: 'https://evil.test' })).status).toBe(403);
    expect((await post(s.id, undefined, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await post(s.id, undefined, { 'X-Ephemeral-Request': '' })).status).toBe(403);
    expect(await application.repo.get(s.id)).toEqual(s);
  });
  it('rejects extra fields, nonstrings, oversized labels and raw controls without changing an existing label', async () => {
    const s = await insert(); await post(s.id, { label: 'Keep this label' });
    for (const body of [{}, [], null, { label: null }, { label: 1 }, { label: 'x'.repeat(81) },
      { label: 'allowed', userId: '99' }, { label: 'allowed', state: 'running' },
      ...['\0', '\n', '\r', '\t', '\x7f', '\u0085'].map(control => ({ label: `${control}label${control}` }))]) {
      expect((await post(s.id, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await application.repo.get(s.id))?.label).toBe('Keep this label');
  });
  it('trims and renames running and ended sessions, lists labels, and clears them without resources or credentials', async () => {
    for (const state of ['ended', 'running'] as const) {
      const s = await insert(state), label = state === 'ended' ? 'x'.repeat(80) : 'Running checkout task';
      const result = await post(s.id, { label: `  ${label}  ` });
      expect(result.status).toBe(200); expect(await result.json()).toEqual({ ...s, label });
      expect(await fetch(`${origin}/api/sessions/${s.id}`, { headers }).then(r => r.json())).toEqual({ ...s, label });
      expect(await fetch(`${origin}/api/sessions`, { headers }).then(r => r.json())).toContainEqual({ ...s, label });
      expect(await post(s.id, { label: 'Renamed task' }).then(r => r.json())).toEqual({ ...s, label: 'Renamed task' });
      expect(await post(s.id, { label: '   ' }).then(r => r.json())).toEqual(s);
    }
    expect(operations.issue).not.toHaveBeenCalled(); expect(operations.create).not.toHaveBeenCalled();
  });
});
