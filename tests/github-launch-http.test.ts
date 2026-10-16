import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/app.js';
import { createLiveApplication } from './helpers/create-live-application.js';
import { readConfig } from '../server/config.js';
import { digest, seal } from '../server/auth/crypto.js';
import type { GitHubLaunchReview } from '../shared/github-launch.js';

const stubs = vi.hoisted(() => ({ preview: vi.fn(), authorize: vi.fn() }));
vi.mock('../server/github/index.js', async () => {
  const { Router } = await import('express'); const { previewCredentials } = await import('../server/preview.js');
  return { createGitHubServices: async () => ({ router: Router(), credentials: previewCredentials,
    repositories: async () => [{ id: 1, installationId: 2, fullName: 'owner/repo', defaultBranch: 'main' }], branches: async () => [{ name: 'main' }],
    githubLaunchPreview: stubs.preview, authorizeGitHubLaunch: stubs.authorize, close: async () => {} }) };
});
vi.mock('../server/infra/e2b.js', async () => {
  const { PreviewProvider } = await import('../server/preview.js'); return { E2BProvider: class extends PreviewProvider {} };
});
const sha = 'a'.repeat(40), url = 'https://github.com/owner/repo', key = Buffer.alloc(32, 1).toString('base64');
const headers = { 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1', Cookie: 'ephemeral=owner-browser' };
const intent = () => ({ url, expectedCommitSha: sha, expectedBaseBranch: 'main', expectedRepositoryId: 1, expectedInstallationId: 2, requestId: randomUUID() });

describe('reviewed GitHub URL launch HTTP boundary', () => {
  let app: Awaited<ReturnType<typeof createApplication>>, preview: typeof app, directory: string, origin: string, previewOrigin: string;
  const listen = async (application: typeof app) => {
    await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve)); const address = application.server.address();
    if (!address || typeof address === 'string') throw new Error('No address'); return `http://127.0.0.1:${address.port}`;
  };
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ep-url-http-'));
    const config = readConfig({ EPHEMERAL_MODE: 'preview', DATA_DIR: directory, PUBLIC_URL: 'http://localhost:4327', ENCRYPTION_KEY: key, ALLOWED_GITHUB_IDS: '42' });
    app = await createLiveApplication({ ...config, mode: 'live' }); origin = await listen(app);
    preview = await createApplication(config); previewOrigin = await listen(preview);
    for (const [cookie, expires] of [['owner-browser', Date.now() + 3600_000], ['expired-browser', Date.now() - 1]] as const) {
      await app.db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
        [digest(cookie), '42', 'owner', '', seal('CURRENT-OAUTH', key), new Date(expires).toISOString()]);
    }
  }, 30_000);
  afterAll(async () => { await app?.close(); await preview?.close(); await rm(directory, { recursive: true, force: true }); }, 30_000);
  beforeEach(() => {
    stubs.preview.mockReset().mockImplementation(async (): Promise<GitHubLaunchReview> => ({ url, kind: 'repository', ref: 'main', commitSha: sha,
      baseBranch: 'main', checkedAt: new Date().toISOString(), repository: 'owner/repo', repositoryId: 1, installationId: 2, simulated: false }));
    stubs.authorize.mockReset().mockResolvedValue({ id: 1, installationId: 2, fullName: 'owner/repo', defaultBranch: 'main' });
  });
  afterEach(async () => {
    for (const application of [app, preview]) {
      for (const session of await application.repo.list()) if (['provisioning', 'running', 'cleanup_pending'].includes(session.state)) await application.manager.stop(session.id);
      await vi.waitFor(async () => expect((await application.repo.list()).every(session => ['ended', 'failed'].includes(session.state))).toBe(true));
    }
  });
  const post = (path: string, body: unknown, extra = {}, base = origin) => fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });

  it('requires current authenticated browser, same origin and verification header before source resolution', async () => {
    expect((await post('/api/github-launch/preview', { url }, { Cookie: '' })).status).toBe(401);
    expect((await post('/api/github-launch', intent(), { Cookie: 'ephemeral=expired-browser' })).status).toBe(401);
    expect((await post('/api/github-launch/preview', { url }, { Origin: 'https://evil.test' })).status).toBe(403);
    expect((await post('/api/github-launch', intent(), { 'X-Ephemeral-Request': '' })).status).toBe(403);
    expect(stubs.preview).not.toHaveBeenCalled();
  });
  it('rejects arbitrary source, repository, branch, missing identity and malformed SHA/UUID input before creating', async () => {
    const valid = intent(), { expectedRepositoryId: _repo, ...missingRepo } = valid;
    for (const body of [{ ...valid, launchSource: {} }, { ...valid, repository: 'owner/other' }, { ...valid, baseBranch: 'other' },
      { ...valid, expectedCommitSha: 'abc' }, { ...valid, requestId: 'bad' }, { ...valid, expectedInstallationId: 0 }, missingRepo]) {
      expect((await post('/api/github-launch', body)).status).toBe(400);
    }
    expect((await post('/api/sessions', { repositoryId: 1, installationId: 2, baseBranch: 'main', launchSource: { url, commitSha: sha } })).status).toBe(400);
    expect(stubs.preview).not.toHaveBeenCalled();
  });
  it('reviews with current OAuth and launches a single pinned session on confirmed retry', async () => {
    const result = await post('/api/github-launch/preview', { url }); expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ url, commitSha: sha, repositoryId: 1, simulated: false });
    expect(stubs.preview).toHaveBeenCalledWith(url, 'CURRENT-OAUTH');
    const body = intent(), created = await post('/api/github-launch', body); expect(created.status).toBe(202); const child = await created.json();
    expect(child.launchSource).toMatchObject({ url, kind: 'repository', commitSha: sha, baseBranch: 'main' });
    expect((await post('/api/github-launch', body).then(response => response.json())).id).toBe(child.id);
    expect(stubs.authorize).toHaveBeenLastCalledWith(url, 'CURRENT-OAUTH');
  });
  it('rejects a changed repository or installation before creating a session at the same SHA/base', async () => {
    const body = intent(); body.expectedRepositoryId = 99;
    const result = await post('/api/github-launch', body); expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: 'GITHUB_LAUNCH_REJECTED', outcome: 'not_created' });
  });
  it('simulates only fixture URLs honestly and does not use the live resolver in preview mode', async () => {
    const fixtureUrl = 'https://github.com/ephemeral/example-app/pull/1';
    const reviewResponse = await post('/api/github-launch/preview', { url: fixtureUrl }, {}, previewOrigin); expect(reviewResponse.status).toBe(200);
    const reviewed = await reviewResponse.json(); expect(reviewed).toMatchObject({ simulated: true, ref: 'feature/demo', commitSha: 'c'.repeat(40), baseBranch: 'main' });
    const created = await post('/api/github-launch', { url: fixtureUrl, expectedCommitSha: reviewed.commitSha, expectedBaseBranch: reviewed.baseBranch,
      expectedRepositoryId: reviewed.repositoryId, expectedInstallationId: reviewed.installationId, requestId: randomUUID() }, {}, previewOrigin);
    expect(created.status).toBe(202); expect((await created.json()).launchSource).toMatchObject({ kind: 'pull_request', commitSha: 'c'.repeat(40) });
    expect((await post('/api/github-launch/preview', { url }, {}, previewOrigin)).status).toBe(403); expect(stubs.preview).not.toHaveBeenCalled();
  });
  it('exposes only the authenticated environment catalog and launches ordinary sessions with a trusted snapshot', async () => {
    expect((await fetch(`${origin}/api/environments`, { headers: { Cookie: '' } })).status).toBe(401);
    expect((await fetch(`${origin}/api/environments`, { headers: { Cookie: 'ephemeral=expired-browser' } })).status).toBe(401);
    const response = await fetch(`${origin}/api/environments`, { headers }); expect(response.status).toBe(200);
    const catalog = await response.json(); expect(catalog.defaultId).toBe('default'); expect(catalog.profiles).toHaveLength(3);
    const profile = catalog.profiles[1], environment = { id: profile.id, revision: profile.revision };
    const created = await post('/api/sessions', { repositoryId: 1, installationId: 2, baseBranch: 'main', environment });
    expect(created.status).toBe(202); expect((await created.json()).environment).toEqual(profile);
  });
  it('rejects untrusted environments before reserving either ordinary or URL launches, without burning request IDs', async () => {
    const catalog = await fetch(`${origin}/api/environments`, { headers }).then(response => response.json()), profile = catalog.profiles[1];
    const body = intent(), ordinary = { repositoryId: 1, installationId: 2, baseBranch: 'main' };
    const before = (await app.repo.list()).length;
    const requestCount = (await app.db.query('SELECT * FROM ephemeral_github_launch_requests')).rows.length;
    for (const [environment, status] of [[{ ...profile }, 400], [{ id: profile.id, revision: profile.revision, templateId: 'evil' }, 400],
      [{ id: profile.id, revision: profile.revision, code: 'evil' }, 400], [null, 400],
      [{ id: 'unknown', revision: profile.revision }, 409], [{ id: profile.id, revision: 'f'.repeat(64) }, 409]] as const) {
      expect((await post('/api/sessions', { ...ordinary, environment })).status).toBe(status);
      const response = await post('/api/github-launch', { ...body, environment }); expect(response.status).toBe(status);
      if (status === 409) expect(await response.json()).toMatchObject({ code: 'GITHUB_LAUNCH_REJECTED', outcome: 'not_created' });
    }
    expect((await app.repo.list()).length).toBe(before);
    expect((await app.db.query('SELECT * FROM ephemeral_github_launch_requests')).rows.length).toBe(requestCount);
    const environment = { id: profile.id, revision: profile.revision }, created = await post('/api/github-launch', { ...body, environment });
    expect(created.status).toBe(202); const child = await created.json(); expect(child.environment).toEqual(profile);
    const mismatch = await post('/api/github-launch', body); expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).not.toHaveProperty('outcome');
    expect((await post('/api/github-launch', { ...body, environment }).then(response => response.json())).id).toBe(child.id);
  });

});
