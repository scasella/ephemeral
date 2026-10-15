import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/app.js';
import { createLiveApplication } from './helpers/create-live-application.js';
import { readConfig } from '../server/config.js';
import { digest, seal } from '../server/auth/crypto.js';
import type { Session } from '../server/contracts.js';
import { GitHubAPI } from '../server/github/api.js';
import { PublishedChangesError, type PublishedChanges } from '../server/github/published-changes.js';

const stubs = vi.hoisted(() => ({ authorize: vi.fn(), inspect: vi.fn(), create: vi.fn(), issue: vi.fn(), disable: vi.fn(), revoke: vi.fn(), vm: vi.fn() }));
vi.mock('../server/auth/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/auth/index.js')>();
  return { ...actual, createAuth: async (...args: Parameters<typeof actual.createAuth>) => ({ ...await actual.createAuth(...args), authorizeSession: stubs.authorize }) };
});
vi.mock('../server/github/index.js', async () => {
  const { Router } = await import('express'); const { previewCredentials } = await import('../server/preview.js');
  return { createGitHubServices: async () => ({ router: Router(), credentials: { issue: stubs.issue, disable: stubs.disable, revokeGitHub: stubs.revoke }, publishedChanges: stubs.inspect, createPullRequest: stubs.create, close: async () => {} }) };
});
vi.mock('../server/infra/e2b.js', async () => {
  const { PreviewProvider } = await import('../server/preview.js');
  return { E2BProvider: class extends PreviewProvider { inspectChanges = stubs.vm; create = stubs.vm; prepare = stubs.vm; async exists() { return true; } } };
});
const key = Buffer.alloc(32, 1).toString('base64');
const headers = { Cookie: 'ephemeral=changes-owner' };
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const known: PublishedChanges = { state: 'known', checkedAt: '2026-10-14T12:00:00.000Z', reason: null,
  repository: 'owner/repo', headBranch: 'ephemeral/test', baseBranch: 'main', headSha: head, baseSha: base,
  mergeBaseSha: base, aheadCommits: 1, behindCommits: 0, comparisonUrl: `https://github.com/owner/repo/compare/${base}...${head}`,
  files: [{ path: 'src/example.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, changes: 2 }], listTruncated: false, selected: null };
const pair = `expectedHeadSha=${head}&expectedBaseSha=${base}`;

describe('read-only published review HTTP boundaries', () => {
  let application: Awaited<ReturnType<typeof createApplication>>, preview: Awaited<ReturnType<typeof createApplication>>;
  let directory: string, origin: string, previewOrigin: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ep-changes-http-'));
    const config = readConfig({ EPHEMERAL_MODE: 'preview', DATA_DIR: directory, PUBLIC_URL: 'http://localhost:4355', ENCRYPTION_KEY: key, ALLOWED_GITHUB_IDS: '42,99' });
    application = await createLiveApplication({ ...config, mode: 'live' });
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
  const request = (id: string, query = '', extra = {}, base = origin) => fetch(`${base}/api/sessions/${id}/published-changes${query}`, { headers: { ...headers, ...extra } });
  it('requires invited current identity, ownership and same origin before GitHub reads', async () => {
    const foreign = await saved({ userId: '99' }); expect((await request(foreign.id)).status).toBe(404);
    expect((await request(randomUUID())).status).toBe(404);
    const s = await saved();
    for (const Cookie of ['', 'ephemeral=expired-changes-owner']) expect((await request(s.id, '', { Cookie })).status).toBe(401);
    for (const extra of [{ Origin: 'https://evil.test' }, { 'Sec-Fetch-Site': 'cross-site' }]) expect((await request(s.id, '', extra)).status).toBe(403);
    const uninvited = await application.db.query('UPDATE browser_sessions SET user_id=$2 WHERE hash=$1 RETURNING hash', [digest('changes-owner'), 'uninvited']);
    try { expect(uninvited.rows).toHaveLength(1); expect((await request(s.id)).status).toBe(401); }
    finally { await application.db.query('UPDATE browser_sessions SET user_id=$2 WHERE hash=$1', [digest('changes-owner'), '42']); }
    expect(stubs.inspect).not.toHaveBeenCalled();
  });
  it('rejects malformed, duplicate, unpinned and unsafe queries before GitHub reads', async () => {
    const s = await saved();
    for (const query of ['?extra=1', '?path=one&path=two', '?path[]=one', '?path=src/example.ts',
      `?expectedHeadSha=${head}`, `?expectedBaseSha=${base}`, `?${pair}&expectedHeadSha=${head}`, `?expectedHeadSha=bad&expectedBaseSha=${base}`,
      `?${pair}&path=%FF`, `?${pair}&path=%ED%A0%80`, `?${pair}&path=%`,
      ...['', '/etc/passwd', '../secret', 'src/../secret', './src', 'src//file', 'src/', 'C:/secret', 'a\0b', 'a\nb', 'a\tb', 'x'.repeat(4097), 'é'.repeat(2049)].map(path => `?${pair}&path=${encodeURIComponent(path)}`)]) {
      expect((await request(s.id, query)).status, query).toBe(400);
    }
    expect(stubs.inspect).not.toHaveBeenCalled();
  });
  it('passes current OAuth, SHA pair and abort signal and never provisions or issues installation credentials', async () => {
    const s = await saved({ state: 'ended', sandboxId: null });
    const path = 'src/a space #é.ts';
    const response = await request(s.id, `?${pair}&path=${encodeURIComponent(path)}`);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store'); expect(await response.json()).toEqual(known);
    expect(stubs.inspect).toHaveBeenCalledWith(s, 'credential', { path, expectedHeadSha: head, expectedBaseSha: base }, expect.any(AbortSignal));
    expect(stubs.authorize).not.toHaveBeenCalled(); expect(stubs.vm).not.toHaveBeenCalled();
    expect(stubs.issue).not.toHaveBeenCalled(); expect(stubs.disable).not.toHaveBeenCalled(); expect(stubs.revoke).not.toHaveBeenCalled();
    expect(await application.repo.get(s.id)).toEqual(s);
  });
  it('serves a known large comparison after stop without VM or installation credentials', async () => {
    const s = await saved({ state: 'ended', sandboxId: null });
    const api = new GitHubAPI('42', 'unused', 'app');
    const repositories = vi.spyOn(api, 'repositories').mockResolvedValue([{ id: 1, installationId: 2, fullName: 'owner/repo', defaultBranch: 'main' }]);
    const installation = vi.spyOn(api, 'prepareInstallationToken');
    const actualFetch = globalThis.fetch;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.origin !== 'https://api.github.com') return actualFetch(url, init);
      const json = (body: unknown) => new Response(JSON.stringify(body));
      if (parsed.pathname === '/repos/owner/repo') return json({ id: 1, full_name: 'owner/repo' });
      if (parsed.pathname === '/repos/owner/repo/git/ref/heads/main') return json({ ref: 'refs/heads/main', object: { type: 'commit', sha: base } });
      if (parsed.pathname === `/repos/owner/repo/git/ref/heads/${encodeURIComponent(s.branch)}`) return json({ ref: `refs/heads/${s.branch}`, object: { type: 'commit', sha: head } });
      if (parsed.pathname.startsWith('/repos/owner/repo/compare/')) return json({ status: 'ahead', ahead_by: 1, behind_by: 0,
        base_commit: { sha: base }, merge_base_commit: { sha: base }, files: [{ filename: 'large.txt', status: 'added',
          additions: 1, deletions: 0, changes: 1, patch: 'x'.repeat(3 * 1024 * 1024) }] });
      throw new Error('Unexpected GitHub endpoint');
    });
    stubs.inspect.mockImplementation((current, token, query, signal) => api.publishedChanges(current, token, query, signal));
    try {
      const response = await request(s.id, `?${pair}&path=large.txt`);
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.text(); expect(Buffer.byteLength(body)).toBeLessThan(10_000);
      expect(JSON.parse(body)).toMatchObject({ state: 'known', headSha: head, baseSha: base, aheadCommits: 1,
        files: [{ path: 'large.txt' }], selected: { state: 'too_large', text: null, truncated: true } });
      expect(stubs.vm).not.toHaveBeenCalled(); expect(stubs.issue).not.toHaveBeenCalled();
      expect(stubs.authorize).not.toHaveBeenCalled(); expect(installation).not.toHaveBeenCalled();
      expect(await application.repo.get(s.id)).toEqual(s);
    } finally { fetcher.mockRestore(); repositories.mockRestore(); installation.mockRestore(); }
  });
  it('returns the complete unavailable contract in preview without a GitHub read', async () => {
    const s = await saved({ userId: 'preview-user', state: 'ended', sandboxId: null }, preview);
    expect(await request(s.id, '', {}, previewOrigin).then(r => r.json())).toEqual({ state: 'unavailable', checkedAt: expect.any(String),
      reason: 'Preview cannot inspect published GitHub changes.', repository: s.repository, headBranch: s.branch, baseBranch: s.baseBranch,
      headSha: null, baseSha: null, mergeBaseSha: null, aheadCommits: null, behindCommits: null, comparisonUrl: null, files: [], listTruncated: false, selected: null });
    expect(stubs.inspect).not.toHaveBeenCalled();
  });
  it('surfaces sanitized repository authorization and stale-review errors', async () => {
    const s = await saved();
    stubs.inspect.mockRejectedValueOnce(new PublishedChangesError('Repository access could not be verified.', 403, 'published_access_denied'));
    const denied = await request(s.id); expect(denied.status).toBe(403); expect(await denied.json()).toEqual({ error: 'Repository access could not be verified.', code: 'published_access_denied' });
    stubs.inspect.mockRejectedValueOnce(new PublishedChangesError('The published review changed. Refresh to retry.', 409, 'published_review_changed'));
    const changed = await request(s.id, `?${pair}`); expect(changed.status).toBe(409); expect(await changed.json()).toMatchObject({ code: 'published_review_changed' });
  });
  it('rechecks browser identity and repository metadata after the GitHub read', async () => {
    const s = await saved();
    stubs.inspect.mockImplementationOnce(async () => {
      await application.db.query('UPDATE browser_sessions SET expires_at=$2 WHERE hash=$1', [digest('changes-owner'), new Date(Date.now() - 100).toISOString()]); return known;
    });
    expect((await request(s.id)).status).toBe(401);
    await application.db.query('UPDATE browser_sessions SET expires_at=$2 WHERE hash=$1', [digest('changes-owner'), new Date(Date.now() + 3600_000).toISOString()]);
    stubs.inspect.mockImplementationOnce(async () => { await application.repo.update({ ...s, baseBranch: 'other' }); return known; });
    expect(await request(s.id).then(r => r.json())).toMatchObject({ state: 'unavailable', files: [], selected: null });
  });
  it('allows a lifecycle transition to ended during a published read', async () => {
    const s = await saved();
    stubs.inspect.mockImplementationOnce(async () => { await application.repo.update({ ...s, state: 'ended', sandboxId: null }); return known; });
    expect(await request(s.id).then(r => r.json())).toEqual(known);
  });
  it('bounds per-session concurrent reads and releases admission after failure', async () => {
    const s = await saved(); let complete!: (value: PublishedChanges) => void;
    stubs.inspect.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const first = request(s.id); await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    const busy = await request(s.id); expect(busy.status).toBe(429); expect(busy.headers.get('retry-after')).toBe('1'); expect(stubs.inspect).toHaveBeenCalledTimes(1);
    complete(known); expect((await first).status).toBe(200);
    stubs.inspect.mockRejectedValueOnce(new Error('upstream Bearer SECRET')); expect((await request(s.id)).status).toBe(409);
    expect((await request(s.id)).status).toBe(200);
  });
  it('aborts GitHub work on client disconnect and releases the inspection slot', async () => {
    const s = await saved(); let signal: AbortSignal | undefined;
    stubs.inspect.mockImplementationOnce((_s: Session, _token: string, _query: unknown, incoming: AbortSignal) => {
      signal = incoming; return new Promise((_resolve, reject) => incoming.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    });
    const controller = new AbortController();
    const pending = fetch(`${origin}/api/sessions/${s.id}/published-changes`, { headers, signal: controller.signal }).catch(() => null);
    await vi.waitFor(() => expect(signal).toBeDefined()); controller.abort(); await pending;
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect((await request(s.id)).status).toBe(200);
  });
  it('bounds total in-flight reads across different sessions without queuing', async () => {
    const sessions = await Promise.all(Array.from({ length: 5 }, () => saved({ state: 'ended', sandboxId: null })));
    const complete: ((value: PublishedChanges) => void)[] = [];
    stubs.inspect.mockImplementation(() => new Promise(resolve => complete.push(resolve)));
    const pending = sessions.slice(0, 4).map(s => request(s.id));
    await vi.waitFor(() => expect(complete).toHaveLength(4));
    expect((await request(sessions[4].id)).status).toBe(429); expect(stubs.inspect).toHaveBeenCalledTimes(4);
    for (const resolve of complete) resolve(known);
    expect((await Promise.all(pending)).every(response => response.status === 200)).toBe(true);
  });
  it('bounds repeated refresh pressure', async () => {
    const s = await saved({ userId: '99' }), extra = { Cookie: 'ephemeral=changes-other' };
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      for (let i = 0; i < 16; i++) expect((await request(s.id, '', extra)).status).toBe(200);
      const response = await request(s.id, '', extra); expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('1');
    } finally { now.mockRestore(); }
  });
  it('forwards the reviewed PR pair and rejects partial or malformed bases before PR creation', async () => {
    const s = await saved(); stubs.create.mockResolvedValue({ url: 'https://github.com/owner/repo/pull/1' });
    const post = (input: unknown) => fetch(`${origin}/api/sessions/${s.id}/pull-request`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1' }, body: JSON.stringify(input) });
    for (const input of [{ title: 'Title' }, { title: 'Title', expectedHeadSha: head }, { title: 'Title', expectedBaseSha: base }, { title: 'Title', expectedHeadSha: head, expectedBaseSha: 'bad' }]) expect((await post(input)).status).toBe(400);
    expect(stubs.create).not.toHaveBeenCalled();
    expect((await post({ title: 'Title', expectedHeadSha: head, expectedBaseSha: base })).status).toBe(200);
    expect(stubs.create).toHaveBeenCalledWith(s, 'Title', undefined, head, base);
  });
});
