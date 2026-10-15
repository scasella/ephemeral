import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database, SandboxProvider, Session } from '../server/contracts.js';
import { SessionManager } from '../server/core/lifecycle.js';
import { createSessionRepository } from '../server/core/repository.js';
import { GitHubAPI } from '../server/github/api.js';
import { GitGateway } from '../server/github/gateway.js';
import { createGitHubServices } from '../server/github/index.js';
import { createPullRequestRepository } from '../server/github/pull-requests.js';
import { CredentialStore } from '../server/github/store.js';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const session = (): Session => ({ id: 'test', userId: 'owner', repository: 'owner/repo', repositoryId: 1, installationId: 2,
  baseBranch: 'main', branch: 'ephemeral/test', state: 'running', createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(), maxExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  sandboxId: 'vm', endedAt: null, error: null, cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' },
  codexRemoteRevocation: 'unverified' });
const remotePr = { html_url: 'https://github.com/owner/repo/pull/7', number: 7, created_at: '2026-10-14T12:00:00.000Z',
  head: { sha: head, ref: 'ephemeral/test', repo: { id: 1 } }, base: { sha: base, ref: 'main', repo: { id: 1 } } };
function latch() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function fixture(existing = false) {
  const db = new PGlite(); cleanups.push(() => db.close());
  const repo = await createSessionRepository(db as unknown as Database), current = session(); await repo.insert(current);
  const records = await createPullRequestRepository(db as unknown as Database);
  // Only listener startup is stubbed. The real queue, credential store, local
  // authorization and SessionManager stop path all participate in these races.
  vi.spyOn(GitGateway.prototype, 'start').mockResolvedValue();
  vi.spyOn(GitHubAPI.prototype, 'prepareInstallationToken').mockReturnValue(async () => ({ token: 'synthetic-token', expires_at: new Date(Date.now() + 3_600_000).toISOString() }));
  const github = await createGitHubServices({ db: db as unknown as Database, pullRequests: records,
    appId: '42', privateKey: 'unused', encryptionKey: Buffer.alloc(32).toString('base64'), appSlug: 'app', publicUrl: 'http://localhost',
    getSession: id => repo.get(id) });
  cleanups.push(() => github.close());
  const provider = { discover: async () => [], exists: async () => false, kill: async () => {}, cleanupCodex: async () => true } as unknown as SandboxProvider;
  const manager = new SessionManager(repo, provider, github.credentials); cleanups.push(() => manager.shutdown());
  await github.credentials.issue(current);
  const entered = latch(), resume = latch(); let comparisons = 0;
  cleanups.push(async () => { resume.release(); });
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const json = (value: unknown) => new Response(JSON.stringify(value));
    if (path === '/repos/owner/repo') return json({ id: 1, full_name: 'owner/repo' });
    if (path.endsWith('/git/ref/heads/main')) return json({ ref: 'refs/heads/main', object: { sha: base, type: 'commit' } });
    if (path.endsWith('/git/ref/heads/ephemeral%2Ftest')) return json({ ref: 'refs/heads/ephemeral/test', object: { sha: head, type: 'commit' } });
    if (path.includes('/compare/')) {
      if (++comparisons === 2) { entered.release(); await resume.promise; }
      return json({ status: 'ahead', ahead_by: 1, behind_by: 0, base_commit: { sha: base }, merge_base_commit: { sha: base },
        files: [{ filename: 'change.txt', status: 'added', additions: 1, deletions: 0, changes: 1 }] });
    }
    if (path.endsWith('/pulls') && init?.method === 'GET') return json(existing ? [{ ...remotePr, state: 'open' }] : []);
    if (path.endsWith('/pulls') && init?.method === 'POST') return json(remotePr);
    if (path === '/installation/token' && init?.method === 'DELETE') return new Response(null, { status: 204 });
    throw new Error(`Unexpected synthetic GitHub request: ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const posts = () => fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  return { db, repo, current, records, github, manager, entered, resume, posts };
}

describe('PR lifecycle fence after final remote preflight', () => {
  it('does not start a PR POST after stop persists cleanup and disables its capability', async () => {
    const f = await fixture();
    const creation = f.github.createPullRequest(f.current, 'Title', '', head, base);
    const rejected = expect(creation).rejects.toMatchObject({ status: 401 });
    await f.entered.promise;
    const stopping = f.manager.stop(f.current.id);
    await expect.poll(async () => ({ state: (await f.repo.get(f.current.id))?.state,
      disabled: (await f.db.query<{ disabled: boolean }>('SELECT disabled FROM github_gateway_credentials WHERE session_id=$1', [f.current.id])).rows[0]?.disabled,
    })).toEqual({ state: 'cleanup_pending', disabled: true });
    f.resume.release(); await rejected; await stopping;
    expect(f.posts()).toEqual([]); expect(await f.records.list(f.current.id)).toEqual([]);
  });

  it('does not start a PR POST when the deadline passes during final remote verification', async () => {
    const f = await fixture();
    const creation = f.github.createPullRequest(f.current, 'Title', '', head, base);
    const rejected = expect(creation).rejects.toMatchObject({ status: 403 });
    await f.entered.promise;
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.current.expiresAt));
    f.resume.release(); await rejected;
    expect((await f.repo.get(f.current.id))?.state).toBe('running');
    expect(f.posts()).toEqual([]); expect(await f.records.list(f.current.id)).toEqual([]);
  });

  it('still records a matching PR already read from GitHub when the deadline passes', async () => {
    const f = await fixture(true);
    const creation = f.github.createPullRequest(f.current, 'Title', '', head, base);
    await f.entered.promise;
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.current.expiresAt));
    f.resume.release();
    expect(await creation).toMatchObject({ number: 7, headSha: head, baseSha: base });
    expect(f.posts()).toEqual([]); expect(await f.records.list(f.current.id)).toHaveLength(1);
  });
});

describe('gateway local authority after upstream authorization', () => {
  it.each(['disable', 'stop', 'expire'] as const)('rejects %s while upstream permission checking is in flight', async change => {
    const db = new PGlite(); cleanups.push(() => db.close());
    const store = new CredentialStore(db as unknown as Database, Buffer.alloc(32), { installationToken: vi.fn(), revoke: vi.fn() });
    await store.migrate(); let current = session(); const capability = await store.issue(current);
    const entered = latch(), resume = latch(); cleanups.push(async () => { resume.release(); });
    const authorizeSession = vi.fn(async () => { entered.release(); await resume.promise; });
    const gateway = new GitGateway(store, { getSession: async () => structuredClone(current), authorizeSession });
    cleanups.push(() => gateway.close());
    const authorization = gateway.authorize(current.id, true, capability);
    const rejected = expect(authorization).rejects.toMatchObject({ status: change === 'disable' ? 401 : 403 });
    await entered.promise;
    if (change === 'disable') await gateway.disable(current.id);
    if (change === 'stop') current = { ...current, state: 'cleanup_pending' };
    if (change === 'expire') vi.spyOn(Date, 'now').mockReturnValue(Date.parse(current.expiresAt));
    resume.release(); await rejected;
    expect(authorizeSession).toHaveBeenCalledTimes(1);
  });
});
