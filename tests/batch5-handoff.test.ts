import { afterEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Database, Session } from '../server/contracts.js';
import { GitHubAPI } from '../server/github/api.js';
import { createGitHubServices } from '../server/github/index.js';
import { createPullRequestRepository } from '../server/github/pull-requests.js';
import { GitHubError } from '../server/github/security.js';
import type { CredentialStore } from '../server/github/store.js';

// Keep the service, credential store, REST reads and PR mutation real. Gateway
// transport and policy have their own actual-Git coverage in github.test.ts.
vi.mock('../server/github/gateway.js', () => ({ GitGateway: class {
  router = {};
  constructor(private store: Pick<CredentialStore, 'enabled'>, private options: { getSession(id: string): Promise<Session>; authorizeSession?(session: Session): Promise<void> }) {}
  async start() {} async close() {}
  async serialize<T>(_id: string, action: () => Promise<T>) { return action(); }
  async authorizeLocal(id: string) {
    if (!await this.store.enabled(id)) throw new GitHubError('Invalid or disabled gateway credential', 401);
    const session = await this.options.getSession(id);
    if (session.state !== 'running' || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) {
      throw new GitHubError('Session is inactive or expired', 403);
    }
    return session;
  }
  async authorize(id: string) {
    const session = await this.authorizeLocal(id);
    await this.options.authorizeSession?.(session);
    return this.authorizeLocal(id);
  }
} }));

const head = 'a'.repeat(40), base = 'b'.repeat(40), moved = 'c'.repeat(40);
const pair = { expectedHeadSha: head, expectedBaseSha: base };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const largePatch = 'x'.repeat(3 * 1024 * 1024);
const comparison = (baseSha = base) => ({ status: 'ahead', ahead_by: 1, behind_by: 0,
  base_commit: { sha: baseSha }, merge_base_commit: { sha: baseSha },
  files: [{ filename: 'large.txt', status: 'added', additions: 1, deletions: 0, changes: 1, patch: largePatch },
    { filename: 'src/review.ts', status: 'modified', additions: 1, deletions: 1, changes: 2, patch: '@@ -1 +1 @@\n-old\n+new' }] });

function streamed(text: string, completed?: () => void) {
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === text.length) { completed?.(); controller.close(); return; }
    const end = Math.min(text.length, offset + 16_384);
    controller.enqueue(Buffer.from(text.slice(offset, end))); offset = end;
  } }), { headers: { 'content-type': 'application/json' } });
}

async function fixture() {
  const db = new PGlite(), records = await createPullRequestRepository(db as unknown as Database);
  const now = new Date().toISOString();
  let session: Session = { id: 'session', userId: '42', repository: 'owner/repo', repositoryId: 1, installationId: 2,
    branch: 'ephemeral/session', baseBranch: 'main', state: 'running', createdAt: now,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), maxExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
    sandboxId: null, endedAt: null, error: null,
    cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified' };
  const authorize = vi.fn(async (_session: Session) => {});
  const github = await createGitHubServices({ db: db as unknown as Database, pullRequests: records,
    appId: '42', privateKey: 'unused', encryptionKey: Buffer.alloc(32).toString('base64'), appSlug: 'app', publicUrl: 'http://localhost',
    getSession: async () => session, authorizeSession: authorize });
  await github.credentials.issue(session);
  const mint = vi.fn(async () => ({ token: 'INSTALLATION-TOKEN', expires_at: new Date(Date.now() + 3600_000).toISOString() }));
  const prepare = vi.spyOn(GitHubAPI.prototype, 'prepareInstallationToken').mockReturnValue(mint);
  const refs = { head, base };
  let afterCompare: (() => void) | undefined;
  let comparisonResponse: (() => Response) | undefined;
  let access = true;
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/user/installations') return json({ installations: access ? [{ id: 2, app_id: 42, app_slug: 'app', suspended_at: null }] : [] });
    if (path === '/user/installations/2/repositories') return json({ repositories: [{ id: 1, full_name: 'owner/repo', permissions: { push: true }, default_branch: 'main' }] });
    if (path === '/repos/owner/repo') return json({ id: 1, full_name: 'owner/repo' });
    if (path === '/repos/owner/repo/git/ref/heads/main') return json({ ref: 'refs/heads/main', object: { type: 'commit', sha: refs.base } });
    if (path === '/repos/owner/repo/git/ref/heads/ephemeral%2Fsession') return json({ ref: 'refs/heads/ephemeral/session', object: { type: 'commit', sha: refs.head } });
    if (path.startsWith('/repos/owner/repo/compare/')) return comparisonResponse?.() ?? streamed(JSON.stringify(comparison(refs.base)), afterCompare);
    if (path === '/repos/owner/repo/pulls' && init?.method === 'GET') return json([]);
    if (path === '/repos/owner/repo/pulls' && init?.method === 'POST') return json({
      html_url: 'https://github.com/owner/repo/pull/7', number: 7, created_at: now,
      head: { sha: refs.head, ref: session.branch, repo: { id: 1 } }, base: { sha: refs.base, ref: session.baseBranch, repo: { id: 1 } },
    });
    throw new Error(`Unexpected GitHub path: ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const mutations = () => fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  return { github, session, records, prepare, mint, refs, authorize, fetcher, mutations,
    moveDuringCompare(action: () => void) { afterCompare = action; },
    respondWith(response: () => Response) { comparisonResponse = response; },
    end() { session = { ...session, state: 'ended' }; }, revoke() { access = false; },
    async close() { await github.close(); await db.close(); } };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('large published comparison handoff', () => {
  it('keeps a >2 MiB patch-heavy review known and hands its exact pair to a draft PR', async () => {
    const f = await fixture();
    try {
      expect(Buffer.byteLength(JSON.stringify(comparison()))).toBeGreaterThan(2 * 1024 * 1024);
      const review = await f.github.publishedChanges(f.session, 'CURRENT-OAUTH', { ...pair, path: 'large.txt' });
      expect(review).toMatchObject({ state: 'known', headSha: head, baseSha: base, aheadCommits: 1,
        selected: { state: 'too_large', text: null, truncated: true } });
      expect(review.files.map(file => file.path)).toEqual(['large.txt', 'src/review.ts']);
      expect(f.prepare).not.toHaveBeenCalled(); expect(f.mint).not.toHaveBeenCalled(); expect(f.authorize).not.toHaveBeenCalled();
      expect(f.fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
      expect(f.fetcher.mock.calls.every(([, init]) => (init?.headers as Record<string, string>).Authorization === 'Bearer CURRENT-OAUTH')).toBe(true);
      const result = await f.github.createPullRequest(f.session, 'Reviewed title', 'Reviewed description', review.headSha!, review.baseSha!);
      expect(result).toMatchObject({ headSha: head, baseSha: base });
      expect(await f.records.list(f.session.id)).toEqual([result]);
      expect(f.mint).toHaveBeenCalledTimes(1);
      const mutation = f.mutations(); expect(mutation).toHaveLength(1);
      expect(mutation[0][1]?.headers).toMatchObject({ Authorization: 'Bearer INSTALLATION-TOKEN' });
      expect(JSON.parse(String(mutation[0][1]?.body))).toEqual({ title: 'Reviewed title', body: 'Reviewed description',
        head: f.session.branch, base: f.session.baseBranch, draft: true });
    } finally { await f.close(); }
  });

  it.each(['head', 'base'] as const)('rejects a %s that moves while the large review streams', async rail => {
    const f = await fixture();
    try {
      f.moveDuringCompare(() => { f.refs[rail] = moved; });
      await expect(f.github.publishedChanges(f.session, 'CURRENT-OAUTH', pair)).rejects.toMatchObject({ status: 409, code: 'published_review_changed' });
      expect(f.prepare).not.toHaveBeenCalled(); expect(f.mutations()).toEqual([]);
    } finally { await f.close(); }
  });

  it.each(['head', 'base'] as const)('rejects a stale reviewed %s before a PR mutation after a large review', async rail => {
    const f = await fixture();
    try {
      const review = await f.github.publishedChanges(f.session, 'CURRENT-OAUTH', pair);
      expect(review.state).toBe('known');
      f.refs[rail] = moved;
      await expect(f.github.createPullRequest(f.session, 'Title', '', head, base)).rejects.toMatchObject({ status: 409 });
      expect(f.mutations()).toEqual([]); expect(await f.records.list(f.session.id)).toEqual([]);
    } finally { await f.close(); }
  });

  it('retains current account and running-session gates after a large review', async () => {
    const f = await fixture();
    try {
      expect((await f.github.publishedChanges(f.session, 'CURRENT-OAUTH', pair)).state).toBe('known');
      f.revoke();
      await expect(f.github.publishedChanges(f.session, 'CURRENT-OAUTH', pair)).rejects.toMatchObject({ status: 403 });
      f.authorize.mockRejectedValueOnce(new GitHubError('Repository access revoked', 403));
      await expect(f.github.createPullRequest(f.session, 'Title', '', head, base)).rejects.toMatchObject({ status: 403 });
      f.end();
      await expect(f.github.createPullRequest(f.session, 'Title', '', head, base)).rejects.toMatchObject({ status: 403 });
      expect(f.prepare).not.toHaveBeenCalled(); expect(f.mutations()).toEqual([]);
    } finally { await f.close(); }
  });

  it('keeps wire-limit failure unknown and blocks a PR even with an older verified pair', async () => {
    const f = await fixture(), cancel = vi.fn();
    try {
      expect((await f.github.publishedChanges(f.session, 'CURRENT-OAUTH', pair)).state).toBe('known');
      f.respondWith(() => new Response(new ReadableStream({ cancel }), { headers: { 'content-length': String(32 * 1024 * 1024 + 1) } }));
      const review = await f.github.publishedChanges(f.session, 'CURRENT-OAUTH', pair);
      expect(review).toMatchObject({ state: 'unknown', headSha: null, baseSha: null, files: [], selected: null });
      await expect(f.github.createPullRequest(f.session, 'Title', '', head, base)).rejects.toMatchObject({ status: 409 });
      expect(cancel).toHaveBeenCalledTimes(2); expect(f.mutations()).toEqual([]);
      expect(await f.records.list(f.session.id)).toEqual([]);
    } finally { await f.close(); }
  });

  it('cancels a stalled preflight at its deadline and never creates a PR', async () => {
    const f = await fixture(), cancel = vi.fn();
    try {
      // Acquire the scoped token before replacing timers; the subsequent real
      // preflight must still finish or fail under the reader's own deadline.
      expect((await f.github.pullRequestPreview(f.session)).state).toBe('ready');
      let started!: () => void;
      const reading = new Promise<void>(resolve => { started = resolve; });
      f.respondWith(() => { started(); return new Response(new ReadableStream({ cancel })); });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const pending = f.github.createPullRequest(f.session, 'Title', '', head, base);
      const rejected = expect(pending).rejects.toMatchObject({ status: 409 });
      await reading; await vi.advanceTimersByTimeAsync(20_000); await rejected;
      expect(cancel).toHaveBeenCalledTimes(1); expect(f.mutations()).toEqual([]);
      expect(await f.records.list(f.session.id)).toEqual([]);
    } finally { vi.useRealTimers(); await f.close(); }
  });
});
