import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/app.js';
import { createChangeInspectionGate } from '../server/changes.js';
import { readConfig } from '../server/config.js';
import { digest, seal } from '../server/auth/crypto.js';
import type { Session } from '../server/contracts.js';
import type { WorkspaceChanges } from '../server/workspace-changes.js';

const stubs = vi.hoisted(() => ({ authorize: vi.fn(), inspect: vi.fn() }));
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
  return { E2BProvider: class extends PreviewProvider { inspectChanges = stubs.inspect; async exists() { return true; } } };
});
const key = Buffer.alloc(32, 1).toString('base64');
const headers = { Cookie: 'ephemeral=changes-owner' };
const known: WorkspaceChanges = { state: 'known', checkedAt: '2026-10-14T12:00:00.000Z', reason: null, headSha: 'a'.repeat(40),
  files: [{ path: 'src/example.ts', oldPath: null, status: ' M', kind: 'tracked' }], listTruncated: false, selected: null };

describe('read-only change review HTTP boundaries', () => {
  let application: Awaited<ReturnType<typeof createApplication>>, preview: Awaited<ReturnType<typeof createApplication>>;
  let directory: string, origin: string, previewOrigin: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ep-changes-http-'));
    const config = readConfig({ EPHEMERAL_MODE: 'preview', DATA_DIR: directory, PUBLIC_URL: 'http://localhost:4355', ENCRYPTION_KEY: key, ALLOWED_GITHUB_IDS: '42,99' });
    application = await createApplication({ ...config, mode: 'live' });
    preview = await createApplication(config);
    for (const app of [application, preview]) await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const url = (app: typeof application) => { const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('No address'); return `http://127.0.0.1:${address.port}`; };
    origin = url(application); previewOrigin = url(preview);
    for (const [cookie, expires] of [['changes-owner', Date.now() + 3600_000], ['expired-changes-owner', Date.now() - 100]] as const) {
      await application.db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
        [digest(cookie), '42', 'owner', '', seal('credential', key), new Date(expires).toISOString()]);
    }
    await application.db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
      [digest('changes-other'), '99', 'other', '', seal('credential', key), new Date(Date.now() + 3600_000).toISOString()]);
  }, 30_000);
  afterAll(async () => { await application?.close(); await preview?.close(); if (directory) await rm(directory, { recursive: true, force: true }); }, 30_000);
  beforeEach(async () => {
    vi.clearAllMocks(); stubs.authorize.mockReset().mockResolvedValue(undefined); stubs.inspect.mockReset().mockResolvedValue(known);
    await application.db.query('UPDATE browser_sessions SET expires_at=$2 WHERE hash=$1', [digest('changes-owner'), new Date(Date.now() + 3600_000).toISOString()]);
  });
  async function saved(changes: Partial<Session> = {}, app = application) {
    const id = randomUUID(), now = new Date().toISOString();
    const session: Session = { id, userId: '42', repository: 'owner/repo', repositoryId: 1, installationId: 2, baseBranch: 'main', branch: `ephemeral/${id}`,
      state: 'running', createdAt: now, expiresAt: new Date(Date.now() + 3600_000).toISOString(), maxExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
      sandboxId: 'fake-vm', endedAt: null, error: null, cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified', ...changes };
    await app.db.query("UPDATE ephemeral_sessions SET state='ended',data=jsonb_set(data,'{state}','\"ended\"'::jsonb) WHERE user_id=$1", [session.userId]);
    await app.repo.insert(session); return session;
  }
  const request = (id: string, query = '', extra = {}, base = origin) => fetch(`${base}/api/sessions/${id}/changes${query}`, { headers: { ...headers, ...extra } });
  it('requires current identity, ownership and same origin before inspection', async () => {
    const foreign = await saved({ userId: '99' }); expect((await request(foreign.id)).status).toBe(404); expect((await request(randomUUID())).status).toBe(404);
    const s = await saved();
    for (const Cookie of ['', 'ephemeral=expired-changes-owner']) expect((await request(s.id, '', { Cookie })).status).toBe(401);
    for (const extra of [{ Origin: 'https://evil.test' }, { 'Sec-Fetch-Site': 'cross-site' }]) expect((await request(s.id, '', extra)).status).toBe(403);
    expect(stubs.authorize).not.toHaveBeenCalled(); expect(stubs.inspect).not.toHaveBeenCalled();
  });
  it('rejects unknown or duplicate query keys and unsafe paths without invoking the provider', async () => {
    const s = await saved();
    for (const query of ['?other=1', '?path=one&path=two', '?path[]=one', '?path=one&extra=1',
      ...['', '/etc/passwd', '../secret', 'src/../secret', './src', 'src//file', 'src/', 'C:/secret', 'a\0b', 'x'.repeat(4097), 'é'.repeat(2049)].map(path => `?path=${encodeURIComponent(path)}`)]) {
      const response = await request(s.id, query); expect(response.status, query).toBe(400); expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(stubs.authorize).not.toHaveBeenCalled(); expect(stubs.inspect).not.toHaveBeenCalled();
  });
  it('returns explicit unavailable states for ended, expired, missing sandbox and preview sessions', async () => {
    for (const changes of [{ state: 'ended' as const }, { state: 'failed' as const }, { state: 'provisioning' as const }, { state: 'cleanup_pending' as const },
      { expiresAt: new Date(Date.now() - 100).toISOString() }, { expiresAt: 'invalid' }, { sandboxId: null }]) {
      const s = await saved(changes), response = await request(s.id);
      expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ state: 'unavailable', files: [], selected: null, headSha: null });
    }
    const s = await saved({ userId: 'preview-user' }, preview);
    expect(await request(s.id, '', {}, previewOrigin).then(r => r.json())).toMatchObject({ state: 'unavailable', reason: 'Preview cannot inspect real workspace changes.' });
    expect(stubs.authorize).not.toHaveBeenCalled(); expect(stubs.inspect).not.toHaveBeenCalled();
  });
  it('checks current repository access and sanitizes authorization failures', async () => {
    const s = await saved(); stubs.authorize.mockRejectedValueOnce(new Error('Bearer SECRET upstream sdk body'));
    const response = await request(s.id); expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Repository access could not be verified. Check access and retry.' }); expect(stubs.inspect).not.toHaveBeenCalled();
  });
  it('does not inspect a session that ends while access is being authorized', async () => {
    for (const changes of [{ state: 'ended' as const }, { expiresAt: new Date(Date.now() - 100).toISOString() }]) {
      const s = await saved(); stubs.authorize.mockImplementationOnce(async () => { await application.repo.update({ ...s, ...changes }); });
      expect(await request(s.id).then(r => r.json())).toMatchObject({ state: 'unavailable', files: [], selected: null });
    }
    expect(stubs.inspect).not.toHaveBeenCalled();
  });
  it('discards inspected content when the session ends or expires during inspection', async () => {
    for (const changes of [{ state: 'ended' as const }, { expiresAt: new Date(Date.now() - 100).toISOString() }, { sandboxId: 'replacement-vm' }]) {
      const s = await saved(); stubs.inspect.mockImplementationOnce(async () => { await application.repo.update({ ...s, ...changes }); return known; });
      expect(await request(s.id).then(r => r.json())).toMatchObject({ state: 'unavailable', files: [], selected: null, headSha: null });
    }
  });
  it('rechecks browser identity and current access before returning inspected content', async () => {
    const s = await saved(); stubs.authorize.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('access revoked SECRET'));
    expect((await request(s.id)).status).toBe(403); expect(stubs.inspect).toHaveBeenCalledTimes(1);
    stubs.authorize.mockResolvedValue(undefined);
    stubs.inspect.mockImplementationOnce(async () => { await application.db.query('UPDATE browser_sessions SET expires_at=$2 WHERE hash=$1', [digest('changes-owner'), new Date(Date.now() - 100).toISOString()]); return known; });
    expect((await request(s.id)).status).toBe(401);
  });
  it('discards content if the session ends during the final authorization', async () => {
    const s = await saved(); stubs.authorize.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { await application.repo.update({ ...s, state: 'ended' }); });
    expect(await request(s.id).then(r => r.json())).toMatchObject({ state: 'unavailable', files: [], selected: null });
  });
  it('returns sanitized unknown on provider failure and a valid selected diff without persisting it', async () => {
    const s = await saved(); stubs.inspect.mockRejectedValueOnce(new Error('sdk stderr ghp_SECRET'));
    expect(await request(s.id).then(r => r.json())).toMatchObject({ state: 'unknown', reason: 'Workspace changes could not be inspected. Refresh to retry.', files: [], selected: null });
    const path = '-odd [*] "quote"\nname\\file.ts';
    const selected: WorkspaceChanges = { ...known, files: [{ path, oldPath: null, status: ' M', kind: 'tracked' }], selected: { path, state: 'text', text: '@@ -1 +1 @@\n-old\n+new\n', reason: null, truncated: false } };
    stubs.inspect.mockResolvedValueOnce(selected);
    const response = await request(s.id, `?path=${encodeURIComponent(path)}`); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store'); expect(await response.json()).toEqual(selected);
    expect(stubs.inspect).toHaveBeenLastCalledWith(s, path); expect(await application.repo.get(s.id)).toEqual(s);
  });
  it('rejects concurrent inspection immediately and releases admission after failure', async () => {
    const s = await saved(); let complete!: (value: WorkspaceChanges) => void;
    stubs.inspect.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const first = request(s.id); await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    const busy = await request(s.id); expect(busy.status).toBe(429); expect(busy.headers.get('retry-after')).toBe('1'); expect(stubs.inspect).toHaveBeenCalledTimes(1);
    complete(known); const response = await first; expect(response.status).toBe(200); expect(await response.json()).toEqual(known);
    stubs.inspect.mockRejectedValueOnce(new Error('failed')); expect((await request(s.id)).status).toBe(200);
  });
  it('rejects repeated refresh pressure with a bounded retry response', async () => {
    const s = await saved({ userId: '99' }); const extra = { Cookie: 'ephemeral=changes-other' };
    // Use a fixed gate clock while the HTTP server and database keep their real timers.
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      for (let i = 0; i < 16; i++) expect((await request(s.id, '', extra)).status).toBe(200);
      const response = await request(s.id, '', extra); expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('1');
      expect(stubs.inspect).toHaveBeenCalledTimes(16);
    } finally { now.mockRestore(); }
  });
});

it('bounds total change inspections and burst pressure without queuing', () => {
  const gate = createChangeInspectionGate();
  const releases = Array.from({ length: 4 }, (_, i) => gate.acquire(`owner-${i}`, `session-${i}`));
  expect(releases.every(Boolean)).toBe(true); expect(gate.acquire('fifth', 'fifth')).toBeNull(); expect(gate.acquire('owner-0', 'session-0')).toBeNull();
  for (const release of releases) release!();
  const burst = createChangeInspectionGate();
  for (let i = 0; i < 16; i++) { const release = burst.acquire('owner', 'session'); expect(release).toBeTypeOf('function'); release!(); }
  expect(burst.acquire('owner', 'session')).toBeNull();
});
