import { afterEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database, Session } from '../server/contracts.js';
import { GitHubAPI } from '../server/github/api.js';
import { createPullRequestRepository, type SavedPullRequest } from '../server/github/pull-requests.js';
import { createGitHubServices } from '../server/github/index.js';

// The queue is deterministic here; real gateway scope and authorization are covered in github.test.ts.
vi.mock('../server/github/gateway.js', () => ({ GitGateway: class {
  router = {}; constructor(_store: unknown, private options: { getSession(id: string): Promise<Session> }) {}
  async start() {} async close() {} async serialize<T>(_id: string, action: () => Promise<T>) { return action(); }
  async authorize(id: string) { return this.options.getSession(id); }
  async authorizeLocal(id: string) { return this.options.getSession(id); }
} }));
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const session: Session = { id: 'test', userId: 'owner', repository: 'owner/repo', repositoryId: 1, installationId: 2,
  baseBranch: 'main', branch: 'ephemeral/test', state: 'running', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), maxExpiresAt: new Date(Date.now() + 3600000).toISOString(), sandboxId: 'vm', endedAt: null, error: null,
  cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified' };
const pr: SavedPullRequest = { url: 'https://github.com/owner/repo/pull/7', number: 7, headSha: head, baseSha: base, headBranch: session.branch, baseBranch: 'main', createdAt: '2026-10-14T12:00:00.000Z' };
const remotePr = { html_url: pr.url, number: pr.number, created_at: pr.createdAt, head: { sha: head, ref: session.branch, repo: { id: 1 } }, base: { sha: base, ref: 'main', repo: { id: 1 } } };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const changedFile = { filename: 'src/main.ts', status: 'modified', additions: 1, deletions: 1, changes: 2 };
function ready(ahead = 1, files: unknown[] = [changedFile], options: { missing?: 'base' | 'head'; malformedBase?: boolean; comparisonBase?: string } = {}) {
  const fetcher = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (path === '/repos/owner/repo') return json({ id: 1, full_name: 'owner/repo' });
    if (path === '/repos/owner/repo/git/ref/heads/main') return json({ ref: 'refs/heads/main', object: { sha: options.malformedBase ? 'bad' : base, type: 'commit' } }, options.missing === 'base' ? 404 : 200);
    if (path === '/repos/owner/repo/git/ref/heads/ephemeral%2Ftest') return json({ ref: `refs/heads/${session.branch}`, object: { sha: head, type: 'commit' } }, options.missing === 'head' ? 404 : 200);
    if (path.startsWith('/repos/owner/repo/compare/')) return json({ status: ahead ? 'ahead' : 'identical', ahead_by: ahead, behind_by: 0,
      base_commit: { sha: options.comparisonBase ?? base }, merge_base_commit: { sha: base }, files });
    throw new Error(`Unexpected GitHub path: ${path}`);
  });
  vi.stubGlobal('fetch', fetcher); return fetcher;
}
describe('remote PR preflight', () => {
  it('verifies exact remote head and base with read-only requests', async () => {
    const api = new GitHubAPI('42', 'unused', 'app'), request = ready();
    expect(await api.pullRequestPreview(session, 'token')).toMatchObject({ state: 'ready', headSha: head, baseSha: base, aheadCommits: 1 });
    expect(request.mock.calls.every(call => call[1]?.method === 'GET')).toBe(true);
    expect(request.mock.calls[2][0]).toContain('/git/ref/heads/ephemeral%2Ftest');
    expect(request.mock.calls[3][0]).toContain(`/compare/${base}...${head}`);
  });
  it('blocks an unpublished head and zero changes', async () => {
    const api = new GitHubAPI('42', 'unused', 'app');
    ready(1, [changedFile], { missing: 'head' });
    expect(await api.pullRequestPreview(session, 'token')).toMatchObject({ state: 'unpublished', headSha: null });
    ready(0, []);
    expect(await api.pullRequestPreview(session, 'token')).toMatchObject({ state: 'no_changes', aheadCommits: 0 });
  });
  it('treats empty commit diffs, missing base, malformed data, and failures honestly', async () => {
    const api = new GitHubAPI('42', 'unused', 'app'); ready(1, []);
    expect((await api.pullRequestPreview(session, 'token')).state).toBe('no_changes');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Bearer private-token upstream body')));
    const unknown = await api.pullRequestPreview(session, 'token');
    expect(unknown.state).toBe('unknown'); expect(JSON.stringify(unknown)).not.toContain('private-token');
    ready(1, [changedFile], { missing: 'base' });
    expect((await api.pullRequestPreview(session, 'token')).state).toBe('unavailable');
    ready(1, [changedFile], { malformedBase: true });
    expect((await api.pullRequestPreview(session, 'token')).state).toBe('unknown');
  });
  it('retains actual GitHub metadata and rejects foreign URLs or branch identity', async () => {
    const api = new GitHubAPI('42', 'unused', 'app'), request = vi.spyOn(api, 'request').mockResolvedValue(remotePr);
    expect(await api.pullRequest(session, 'token', 'Title')).toEqual(pr);
    request.mockResolvedValueOnce({ ...remotePr, html_url: 'https://evil.test/pull/7' });
    await expect(api.pullRequest(session, 'token', 'Title')).rejects.toThrow('metadata');
    request.mockResolvedValueOnce({ ...remotePr, head: { ...remotePr.head, ref: 'main' } });
    await expect(api.pullRequest(session, 'token', 'Title')).rejects.toThrow('metadata');
  });
  it('recovers only the matching open PR and rejects malformed comparisons', async () => {
    const api = new GitHubAPI('42', 'unused', 'app');
    const request = vi.spyOn(api, 'request').mockResolvedValueOnce([{ ...remotePr, state: 'closed' }, { ...remotePr, state: 'open' }]);
    expect(await api.existingPullRequest(session, 'token')).toEqual(pr);
    expect(request.mock.calls[0][0]).toContain('state=open');
    vi.restoreAllMocks();
    ready(1, [changedFile], { comparisonBase: head });
    expect((await api.pullRequestPreview(session, 'token')).state).toBe('unknown');
  });
});
describe('creation preflight and retry recovery', () => {
  async function services() {
    const db = new PGlite(); const records = await createPullRequestRepository(db as unknown as Database);
    const github = await createGitHubServices({ db: db as unknown as Database, pullRequests: records, appId: '42', privateKey: 'unused', encryptionKey: Buffer.alloc(32).toString('base64'), appSlug: 'app', publicUrl: 'http://localhost', getSession: async () => session });
    await github.credentials.issue(session);
    vi.spyOn(GitHubAPI.prototype, 'prepareInstallationToken').mockImplementation(function (this: GitHubAPI, s) { return () => this.installationToken(s); });
    vi.spyOn(GitHubAPI.prototype, 'installationToken').mockResolvedValue({ token: 'test-token', expires_at: new Date(Date.now() + 3600000).toISOString() });
    return { db, records, github };
  }
  it('requires the reviewed pair before acquiring any installation token', async () => {
    const f = await services();
    try {
      const issue = vi.spyOn(GitHubAPI.prototype, 'installationToken');
      for (const [headId, baseId] of [[undefined, undefined], [head, undefined], [undefined, base], ['bad', base]]) {
        await expect(f.github.createPullRequest(session, 'Title', '', headId, baseId)).rejects.toMatchObject({ status: 400 });
      }
      expect(issue).not.toHaveBeenCalled();
    } finally { await f.github.close(); await f.db.close(); }
  });
  it('rejects a changed head or failed preflight before any PR mutation', async () => {
    const f = await services();
    try {
      const preview = vi.spyOn(GitHubAPI.prototype, 'pullRequestPreview').mockResolvedValue({ state: 'ready', headSha: head, baseSha: base, baseBranch: 'main', headBranch: session.branch, aheadCommits: 1, checkedAt: new Date().toISOString(), reason: null });
      const create = vi.spyOn(GitHubAPI.prototype, 'pullRequest');
      await expect(f.github.createPullRequest(session, 'Title', '', 'c'.repeat(40), base)).rejects.toThrow('changed');
      preview.mockResolvedValueOnce({ ...(await preview.mock.results[0].value), state: 'unknown', reason: 'Verification unavailable' });
      await expect(f.github.createPullRequest(session, 'Title', '', head, base)).rejects.toThrow('Verification unavailable');
      expect(create).not.toHaveBeenCalled(); expect(await f.records.list(session.id)).toEqual([]);
    } finally { await f.github.close(); await f.db.close(); }
  });
  it('recovers an existing PR without posting a duplicate and persists idempotently', async () => {
    const f = await services();
    try {
      vi.spyOn(GitHubAPI.prototype, 'pullRequestPreview').mockResolvedValue({ state: 'ready', headSha: head, baseSha: base, baseBranch: 'main', headBranch: session.branch, aheadCommits: 1, checkedAt: new Date().toISOString(), reason: null });
      vi.spyOn(GitHubAPI.prototype, 'existingPullRequest').mockResolvedValue(pr);
      const create = vi.spyOn(GitHubAPI.prototype, 'pullRequest');
      expect(await f.github.createPullRequest(session, 'Title', '', head, base)).toEqual(pr);
      expect(await f.github.createPullRequest(session, 'Title', '', head, base)).toEqual(pr);
      expect(create).not.toHaveBeenCalled(); expect(await f.records.list(session.id)).toEqual([pr]);
    } finally { await f.github.close(); await f.db.close(); }
  });
  it('rejects a stale reviewed base before looking up or creating a PR', async () => {
    const f = await services();
    try {
      vi.spyOn(GitHubAPI.prototype, 'pullRequestPreview').mockResolvedValue({ state: 'ready', headSha: head, baseSha: 'c'.repeat(40), baseBranch: 'main', headBranch: session.branch, aheadCommits: 1, checkedAt: new Date().toISOString(), reason: null });
      const existing = vi.spyOn(GitHubAPI.prototype, 'existingPullRequest'), create = vi.spyOn(GitHubAPI.prototype, 'pullRequest');
      await expect(f.github.createPullRequest(session, 'Title', '', head, base)).rejects.toMatchObject({ status: 409 });
      expect(existing).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(await f.records.list(session.id)).toEqual([]);
    } finally { await f.github.close(); await f.db.close(); }
  });
  it('rechecks the reviewed pair after PR lookup and before mutation', async () => {
    const f = await services();
    try {
      const preview = { state: 'ready' as const, headSha: head, baseSha: base, baseBranch: 'main', headBranch: session.branch, aheadCommits: 1, checkedAt: new Date().toISOString(), reason: null };
      vi.spyOn(GitHubAPI.prototype, 'pullRequestPreview').mockResolvedValueOnce(preview).mockResolvedValueOnce({ ...preview, baseSha: 'c'.repeat(40) });
      vi.spyOn(GitHubAPI.prototype, 'existingPullRequest').mockResolvedValue(null);
      const create = vi.spyOn(GitHubAPI.prototype, 'pullRequest');
      await expect(f.github.createPullRequest(session, 'Title', '', head, base)).rejects.toMatchObject({ status: 409 });
      expect(create).not.toHaveBeenCalled(); expect(await f.records.list(session.id)).toEqual([]);
    } finally { await f.github.close(); await f.db.close(); }
  });
  it('persists the actual returned PR snapshot if GitHub refs move after preflight', async () => {
    const f = await services();
    try {
      vi.spyOn(GitHubAPI.prototype, 'pullRequestPreview').mockResolvedValue({ state: 'ready', headSha: head, baseSha: base, baseBranch: 'main', headBranch: session.branch, aheadCommits: 1, checkedAt: new Date().toISOString(), reason: null });
      vi.spyOn(GitHubAPI.prototype, 'existingPullRequest').mockResolvedValue(null);
      const actual = { ...pr, baseSha: 'c'.repeat(40) };
      vi.spyOn(GitHubAPI.prototype, 'pullRequest').mockResolvedValue(actual);
      expect(await f.github.createPullRequest(session, 'Title', '', head, base)).toEqual(actual);
      expect(await f.records.list(session.id)).toEqual([actual]);
    } finally { await f.github.close(); await f.db.close(); }
  });
  it('recovers after a PR was created but durable storage initially failed', async () => {
    const f = await services();
    try {
      vi.spyOn(GitHubAPI.prototype, 'pullRequestPreview').mockResolvedValue({ state: 'ready', headSha: head, baseSha: base, baseBranch: 'main', headBranch: session.branch, aheadCommits: 1, checkedAt: new Date().toISOString(), reason: null });
      vi.spyOn(GitHubAPI.prototype, 'existingPullRequest').mockResolvedValueOnce(null).mockResolvedValueOnce(pr);
      const create = vi.spyOn(GitHubAPI.prototype, 'pullRequest').mockResolvedValue(pr);
      vi.spyOn(f.records, 'save').mockRejectedValueOnce(new Error('storage unavailable'));
      await expect(f.github.createPullRequest(session, 'Title', '', head, base)).rejects.toThrow('storage unavailable');
      expect(await f.github.createPullRequest(session, 'Title', '', head, base)).toEqual(pr);
      expect(create).toHaveBeenCalledTimes(1); expect(await f.records.list(session.id)).toEqual([pr]);
    } finally { await f.github.close(); await f.db.close(); }
  });
});
describe('durable session PR records', () => {
  it('retains links after reopening storage independently of session lifecycle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ep-pr-test-'));
    let db = new PGlite(directory);
    try {
      let records = await createPullRequestRepository(db as unknown as Database);
      await records.save(session.id, pr); await records.save(session.id, pr);
      await db.close(); db = new PGlite(directory);
      records = await createPullRequestRepository(db as unknown as Database);
      expect(await records.list(session.id)).toEqual([pr]);
      expect(await records.list('another-session')).toEqual([]);
    } finally { await db.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
