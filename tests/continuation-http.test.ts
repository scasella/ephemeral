import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/app.js';
import { createLiveApplication } from './helpers/create-live-application.js';
import { readConfig } from '../server/config.js';
import { digest, seal } from '../server/auth/crypto.js';
import { continuationPreview } from '../server/continuation.js';
import type { Session } from '../server/contracts.js';

const stubs = vi.hoisted(() => ({ preview: vi.fn(), authorize: vi.fn(), setup: vi.fn() }));
vi.mock('../server/github/index.js', async () => {
  const { Router } = await import('express'); const { previewCredentials } = await import('../server/preview.js');
  return { createGitHubServices: async () => ({ router: Router(), credentials: previewCredentials,
    repositories: async () => [{ id: 1, installationId: 2, fullName: 'owner/repo', defaultBranch: 'main' }],
    branches: async () => [{ name: 'main' }], continuationPreview: stubs.preview, authorizeContinuation: stubs.authorize, close: async () => {} }) };
});
vi.mock('../server/infra/e2b.js', async () => {
  const { PreviewProvider } = await import('../server/preview.js');
  return { E2BProvider: class extends PreviewProvider { runSetup = stubs.setup; } };
});
const sha = 'a'.repeat(40), headers = { 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1', Cookie: 'ephemeral=owner-browser' };
const key = Buffer.alloc(32, 1).toString('base64');

describe('continuation HTTP ownership, intent and preview honesty', () => {
  let application: Awaited<ReturnType<typeof createApplication>>, preview: typeof application, directory: string, origin: string, previewOrigin: string;
  async function listen(app: typeof application) {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('No server address'); return `http://127.0.0.1:${address.port}`;
  }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ep-continue-http-'));
    const config = readConfig({ EPHEMERAL_MODE: 'preview', DATA_DIR: directory, PUBLIC_URL: 'http://localhost:4327', ENCRYPTION_KEY: key, ALLOWED_GITHUB_IDS: '42,99' });
    application = await createLiveApplication({ ...config, mode: 'live' }); origin = await listen(application);
    preview = await createApplication(config); previewOrigin = await listen(preview);
    for (const [cookie, userId, expires] of [['owner-browser', '42', Date.now() + 3600_000], ['expired-browser', '42', Date.now() - 1]] as const) {
      await application.db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
        [digest(cookie), userId, 'owner', '', seal('CURRENT-BROWSER-OAUTH', key), new Date(expires).toISOString()]);
    }
  }, 30000);
  afterAll(async () => { await application?.close(); await preview?.close(); await rm(directory, { recursive: true, force: true }); }, 30000);
  beforeEach(() => {
    stubs.authorize.mockReset().mockResolvedValue(undefined); stubs.setup.mockReset();
    stubs.preview.mockReset().mockImplementation(async (s: Session) => ({ ...continuationPreview(s, 'ready', null), commitSha: sha }));
  });
  afterEach(async () => {
    for (const s of await application.repo.list('42')) if (['provisioning', 'running', 'cleanup_pending'].includes(s.state)) await application.manager.stop(s.id);
    await vi.waitFor(async () => expect((await application.repo.list('42')).every(s => ['ended', 'failed'].includes(s.state))).toBe(true));
    vi.restoreAllMocks();
  });
  async function insert(changes: Partial<Session> = {}, app = application) {
    const id = randomUUID(), s: Session = { id, userId: '42', repository: 'owner/repo', repositoryId: 1, installationId: 2,
      baseBranch: 'main', branch: `ephemeral/${id}`, state: 'ended', createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(),
      maxExpiresAt: new Date().toISOString(), sandboxId: null, endedAt: new Date().toISOString(), error: null,
      cleanup: { vm: 'confirmed', github: 'confirmed', gateway: 'confirmed', codex: 'not_applicable' }, codexRemoteRevocation: 'unverified', ...changes };
    await app.repo.insert(s); return s;
  }
  const get = (id: string, extra = {}) => fetch(`${origin}/api/sessions/${id}/continuation-preview`, { headers: { ...headers, ...extra } });
  const post = (id: string, body: unknown = { expectedHeadSha: sha, requestId: randomUUID() }, extra = {}) =>
    fetch(`${origin}/api/sessions/${id}/continue`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });

  it('requires current browser identity and owner access, including expired browser cookies', async () => {
    const s = await insert({ userId: '99' });
    expect((await get(s.id, { Cookie: '' })).status).toBe(401); expect((await post(s.id, undefined, { Cookie: '' })).status).toBe(401);
    expect((await get(s.id, { Cookie: 'ephemeral=expired-browser' })).status).toBe(401);
    expect((await get(s.id)).status).toBe(404); expect((await post(s.id)).status).toBe(404);
    expect(stubs.preview).not.toHaveBeenCalled(); expect(stubs.authorize).not.toHaveBeenCalled();
  });
  it('enforces same origin, request verification and strict SHA/UUID input with no arbitrary repo/ref/provenance', async () => {
    const s = await insert(); const intent = { expectedHeadSha: sha, requestId: randomUUID() };
    expect((await post(s.id, intent, { Origin: 'https://evil.test' })).status).toBe(403);
    expect((await post(s.id, intent, { 'X-Ephemeral-Request': '' })).status).toBe(403);
    for (const body of [{ ...intent, branch: 'main' }, { ...intent, repositoryId: 9 }, { ...intent, continuation: {} }, { ...intent, requestId: 'not-uuid' }, { ...intent, expectedHeadSha: 'a'.repeat(64) }, {}, []]) expect((await post(s.id, body)).status).toBe(400);
    const ordinary = await fetch(`${origin}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ repositoryId: 1, installationId: 2, baseBranch: 'main', continuation: { sourceSessionId: s.id, sourceBranch: s.branch, commitSha: sha } }) });
    expect(ordinary.status).toBe(400); expect(stubs.preview).not.toHaveBeenCalled();
  });
  it('verifies using this browser OAuth and creates one fresh session on identical POST retry, without setup or source mutation', async () => {
    const s = await insert(), intent = { expectedHeadSha: sha, requestId: randomUUID() };
    expect(await get(s.id).then(r => r.json())).toMatchObject({ state: 'ready', sourceSessionId: s.id, commitSha: sha });
    const result = await post(s.id, intent); expect(result.status).toBe(202); const child = await result.json();
    expect(child.id).not.toBe(s.id); expect(child.branch).toBe(`ephemeral/${child.id}`); expect(child.continuation).toMatchObject({ sourceSessionId: s.id, commitSha: sha });
    expect((await post(s.id, intent).then(r => r.json())).id).toBe(child.id);
    expect(stubs.preview).toHaveBeenCalledWith(s, 'CURRENT-BROWSER-OAUTH'); expect(stubs.authorize).toHaveBeenCalledWith(s, 'CURRENT-BROWSER-OAUTH');
    expect(stubs.setup).not.toHaveBeenCalled(); expect(await application.repo.get(s.id)).toEqual(s);
  });
  it('returns a durable definitive rejection for a moved head, while generic uncertain failures retain no-create ambiguity', async () => {
    const s = await insert(), intent = { expectedHeadSha: 'b'.repeat(40), requestId: randomUUID() };
    const moved = await post(s.id, intent); expect(moved.status).toBe(409);
    expect(await moved.json()).toMatchObject({ code: 'CONTINUATION_REJECTED', outcome: 'not_created' });
    stubs.preview.mockRejectedValueOnce(new Error('secret upstream uncertainty'));
    const uncertain = await post(s.id); expect(uncertain.status).toBe(409);
    const body = await uncertain.json(); expect(body.code).toBeUndefined(); expect(body.outcome).toBeUndefined(); expect(JSON.stringify(body)).not.toContain('secret');
  });
  it('declines incomplete cleanup and honestly marks preview integrations unavailable', async () => {
    const s = await insert({ cleanup: { vm: 'failed', github: 'confirmed', gateway: 'confirmed', codex: 'not_applicable' } });
    expect(await get(s.id).then(r => r.json())).toMatchObject({ state: 'unavailable', commitSha: null }); expect((await post(s.id)).status).toBe(409);
    const p = await insert({ userId: 'preview-user' }, preview);
    expect(await fetch(`${previewOrigin}/api/sessions/${p.id}/continuation-preview`).then(r => r.json())).toMatchObject({ state: 'unavailable', commitSha: null });
    expect((await fetch(`${previewOrigin}/api/sessions/${p.id}/continue`, { method: 'POST', headers, body: JSON.stringify({ expectedHeadSha: sha, requestId: randomUUID() }) })).status).toBe(409);
    expect(stubs.preview).not.toHaveBeenCalled();
  });
  it('resolves an explicit continuation environment and rejects injected or stale selections before durable reservation', async () => {
    const s = await insert(), intent = { expectedHeadSha: sha, requestId: randomUUID() };
    const catalog = await fetch(`${origin}/api/environments`, { headers }).then(response => response.json()), profile = catalog.profiles[2];
    const requestCount = (await application.db.query('SELECT * FROM ephemeral_continuation_requests')).rows.length;
    for (const [environment, status] of [[profile, 400], [{ id: profile.id, revision: profile.revision, templateRef: 'evil:v1' }, 400],
      [null, 400], [{ id: 'removed', revision: profile.revision }, 409], [{ id: profile.id, revision: 'f'.repeat(64) }, 409]] as const) {
      const response = await post(s.id, { ...intent, environment }); expect(response.status).toBe(status);
      if (status === 409) expect(await response.json()).toMatchObject({ code: 'CONTINUATION_REJECTED', outcome: 'not_created' });
    }
    expect((await application.db.query('SELECT * FROM ephemeral_continuation_requests')).rows.length).toBe(requestCount);
    const environment = { id: profile.id, revision: profile.revision }, response = await post(s.id, { ...intent, environment });
    expect(response.status).toBe(202); const child = await response.json(); expect(child.environment).toEqual(profile);
    expect((await post(s.id, { ...intent, environment }).then(response => response.json())).id).toBe(child.id);
    const changed = await post(s.id, intent); expect(changed.status).toBe(409); expect(await changed.json()).not.toHaveProperty('outcome');
  });

});
