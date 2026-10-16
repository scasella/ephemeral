import { afterEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyGitHubLaunchSource, parseGitHubLaunchUrl, type GitHubLaunchReview } from '../shared/github-launch.js';
import { createGitHubLaunchController, simulatedGitHubLaunch } from '../server/github-launch.js';
import { resolveGitHubLaunch } from '../server/github/launch.js';
import { createSessionRepository } from '../server/core/repository.js';
import { GitHubAPI } from '../server/github/api.js';
import { GitHubError } from '../server/github/security.js';
import { SessionNotCreatedError } from '../server/core/provisioning.js';
import type { CreateSessionInput, Database, Session, SessionRepository } from '../server/contracts.js';

const sha = 'a'.repeat(40), other = 'b'.repeat(40), base = 'c'.repeat(40), url = 'https://github.com/owner/repo';
const repository = { id: 1, installationId: 2, fullName: 'owner/repo', defaultBranch: 'main' };
const review = (changes: Partial<GitHubLaunchReview> = {}): GitHubLaunchReview => ({ url, kind: 'repository', ref: 'main', commitSha: sha,
  baseBranch: 'main', checkedAt: new Date().toISOString(), repository: 'owner/repo', repositoryId: 1, installationId: 2, simulated: false, ...changes });
const close: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of close.splice(0).reverse()) await action(); vi.restoreAllMocks(); });
function creator(repo: SessionRepository) {
  return { create: vi.fn(async (input: CreateSessionInput, options?: { id?: string }): Promise<Session> => {
    const id = options!.id!, session: Session = { ...input, id, branch: `ephemeral/${id}`, state: 'provisioning',
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(), maxExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      sandboxId: null, endedAt: null, error: null, codexRemoteRevocation: 'unverified', cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' } };
    await repo.insert(session); return session;
  }) };
}
async function fixture() {
  const db = new PGlite(); close.push(() => db.close()); const repo = await createSessionRepository(db as unknown as Database), manager = creator(repo);
  const github = { githubLaunchPreview: vi.fn(async () => review()), authorizeGitHubLaunch: vi.fn(async () => repository) };
  const controller = await createGitHubLaunchController(db as unknown as Database, repo, manager, github); close.push(() => controller.close());
  const launch = (request = randomUUID(), overrides: { url?: string; sha?: string; base?: string; user?: string } = {}) =>
    controller.launch(overrides.user ?? '42', 'CURRENT-OAUTH', overrides.url ?? url, overrides.sha ?? sha, overrides.base ?? 'main', request, 1, 2);
  return { db, repo, manager, github, controller, launch };
}

describe('strict GitHub URL parsing and copied provenance', () => {
  it('accepts only supported complete locations, including complete slash branch refs', () => {
    expect(parseGitHubLaunchUrl(`${url}/`)).toEqual({ url, repository: 'owner/repo', kind: 'repository' });
    expect(parseGitHubLaunchUrl(`${url}/tree/feature/auth/fix`)).toMatchObject({ kind: 'branch', ref: 'feature/auth/fix' });
    expect(parseGitHubLaunchUrl(`${url}/commit/${sha.toUpperCase()}`)).toMatchObject({ kind: 'commit', ref: sha });
    expect(parseGitHubLaunchUrl(`${url}/pull/42`)).toMatchObject({ kind: 'pull_request', pullRequestNumber: 42 });
    const source = copyGitHubLaunchSource(review()); expect(source).not.toHaveProperty('repository');
    expect(() => copyGitHubLaunchSource(review({ ref: 'develop' }))).toThrow('Invalid');
  });
  it.each(['http://github.com/owner/repo', 'https://github.com.evil.test/owner/repo', 'https://user@github.com/owner/repo',
    'https://github.com:443/owner/repo', 'https://github.com/owner/repo?x=1', 'https://github.com/owner/repo#x',
    ' https://github.com/owner/repo', 'https://github.com/owner/repo\n', 'https://github.com/owner/repo/../secret',
    'https://github.com/owner/repo/tree/main/../../secret', 'https://github.com/owner/repo/tree/%2e%2e',
    'https://github.com/owner/repo/tree/feature%2ffix', 'https://github.com/owner/repo/tree/main\\file',
    'https://github.com/owner/repo/blob/main/file', 'https://github.com/owner/repo/issues/1', 'https://github.com/owner/repo/pull/01',
    'https://github.com/owner/repo/pull/1/files', 'https://github.com/owner/repo/commit/abc123', 'https://github.com/owner/repo/tree/-option',
    'https://github.com/owner/repo/tree/main/.git', 'https://github.com/owner/repo/tree/main.lock'])('rejects unsafe or unsupported URL %j', input => {
    expect(() => parseGitHubLaunchUrl(input)).toThrow();
  });
});

describe('GitHub launch authorization and exact resolution', () => {
  function apiFixture() {
    const api = new GitHubAPI('42', 'unused', 'app');
    const repos = vi.spyOn(api, 'repositories').mockResolvedValue([repository]);
    const request = vi.spyOn(api, 'request').mockImplementation(async path => {
      const branch = path.split('/git/ref/heads/')[1];
      if (branch) return { ref: `refs/heads/${decodeURIComponent(branch)}`, object: { type: 'commit', sha: branch === 'main' ? base : sha } };
      throw new Error(`Unexpected path ${path}`);
    });
    return { api, repos, request };
  }
  it('authorizes current OAuth and uses only constructed GitHub API GETs; slash refs remain exact', async () => {
    const { api, repos, request } = apiFixture();
    expect(await resolveGitHubLaunch(api, `${url}/tree/feature/auth/fix`, 'CURRENT-OAUTH')).toMatchObject({ kind: 'branch', ref: 'feature/auth/fix', commitSha: sha, baseBranch: 'main', simulated: false });
    expect(repos).toHaveBeenCalledWith('CURRENT-OAUTH', expect.any(AbortSignal));
    expect(request.mock.calls.map(call => call.slice(0, 4))).toEqual([
      ['/repos/owner/repo/git/ref/heads/main', 'CURRENT-OAUTH', 'GET', undefined],
      ['/repos/owner/repo/git/ref/heads/feature%2Fauth%2Ffix', 'CURRENT-OAUTH', 'GET', undefined],
    ]);
    expect(request.mock.calls.every(call => call[4] instanceof AbortSignal)).toBe(true);
  });
  it('rejects unauthorized repos before source reads and never follows a pasted network location', async () => {
    const { api, repos, request } = apiFixture(); repos.mockResolvedValue([]);
    await expect(resolveGitHubLaunch(api, url, 'oauth')).rejects.toMatchObject({ status: 403 }); expect(request).not.toHaveBeenCalled();
    await expect(resolveGitHubLaunch(api, 'https://evil.test/owner/repo', 'oauth')).rejects.toThrow(); expect(request).not.toHaveBeenCalled();
  });
  it('rejects prefix/file-path matches instead of silently launching a shorter branch', async () => {
    const { api, request } = apiFixture(); request.mockResolvedValueOnce({ ref: 'refs/heads/main', object: { type: 'commit', sha: base } })
      .mockResolvedValueOnce({ ref: 'refs/heads/feature', object: { type: 'commit', sha } });
    await expect(resolveGitHubLaunch(api, `${url}/tree/feature/directory`, 'oauth')).rejects.toThrow('exact repository branch');
  });
  it('resolves same-repository PR SHA and base, but rejects forks, deleted heads, and moving head metadata', async () => {
    const { api, request } = apiFixture();
    const pr = { number: 1, head: { sha, ref: 'feature/auth', repo: { id: 1 } }, base: { ref: 'develop', repo: { id: 1 } } };
    request.mockResolvedValueOnce(pr);
    expect(await resolveGitHubLaunch(api, `${url}/pull/1`, 'oauth')).toMatchObject({ ref: 'feature/auth', baseBranch: 'develop', commitSha: sha, pullRequestNumber: 1 });
    request.mockResolvedValueOnce({ ...pr, head: { ...pr.head, repo: { id: 9 } } });
    await expect(resolveGitHubLaunch(api, `${url}/pull/1`, 'oauth')).rejects.toThrow('Fork pull requests');
    request.mockResolvedValueOnce(pr).mockResolvedValueOnce({ ref: 'refs/heads/develop', object: { type: 'commit', sha: base } }).mockRejectedValueOnce(new GitHubError('missing', 502, 404));
    await expect(resolveGitHubLaunch(api, `${url}/pull/1`, 'oauth')).rejects.toThrow('missing');
    request.mockResolvedValueOnce(pr).mockResolvedValueOnce({ ref: 'refs/heads/develop', object: { type: 'commit', sha: base } })
      .mockResolvedValueOnce({ ref: 'refs/heads/feature/auth', object: { type: 'commit', sha: other } });
    await expect(resolveGitHubLaunch(api, `${url}/pull/1`, 'oauth')).rejects.toThrow('source branch changed');
  });
  it('verifies old commits as ancestors of a repository branch and accepts orphan-branch tips after compare404', async () => {
    const { api, request } = apiFixture();
    request.mockResolvedValueOnce({ ref: 'refs/heads/main', object: { type: 'commit', sha: base } }).mockResolvedValueOnce({ sha })
      .mockResolvedValueOnce({ merge_base_commit: { sha } });
    expect(await resolveGitHubLaunch(api, `${url}/commit/${sha}`, 'oauth')).toMatchObject({ kind: 'commit', commitSha: sha, ref: sha, baseBranch: 'main' });
    request.mockResolvedValueOnce({ ref: 'refs/heads/main', object: { type: 'commit', sha: base } }).mockResolvedValueOnce({ sha })
      .mockRejectedValueOnce(new GitHubError('no shared history', 502, 404)).mockResolvedValueOnce([{ name: 'orphan', commit: { sha } }]);
    expect(await resolveGitHubLaunch(api, `${url}/commit/${sha}`, 'oauth')).toMatchObject({ commitSha: sha });
  });
  it('rejects fork-network-only commits and enforces a hard request budget', async () => {
    const { api, request } = apiFixture();
    request.mockImplementation(async path => {
      if (path.includes('/git/ref/')) return { ref: 'refs/heads/main', object: { type: 'commit', sha: base } };
      if (path.includes('/commits/')) return { sha };
      if (path.includes('/compare/')) return { merge_base_commit: { sha: other } };
      if (path.includes('/branches?')) return [];
      throw new Error('Unexpected');
    });
    await expect(resolveGitHubLaunch(api, `${url}/commit/${sha}`, 'oauth')).rejects.toThrow('not reachable');
    request.mockClear();
    request.mockImplementation(async path => {
      if (path.includes('/git/ref/')) return { ref: 'refs/heads/main', object: { type: 'commit', sha: base } };
      if (path.includes('/commits/')) return { sha };
      if (path.includes('/compare/')) return { merge_base_commit: { sha: other } };
      return Array.from({ length: 100 }, (_, i) => ({ name: `branch-${i}`, commit: { sha: base } }));
    });
    await expect(resolveGitHubLaunch(api, `${url}/commit/${sha}`, 'oauth')).rejects.toMatchObject({ status: 413 }); expect(request).toHaveBeenCalledTimes(48);
  });
  it('simulation uses only fixture repositories and never accesses the network', () => {
    const network = vi.spyOn(globalThis, 'fetch');
    expect(simulatedGitHubLaunch('https://github.com/ephemeral/example-app/pull/1')).toMatchObject({ simulated: true, commitSha: 'c'.repeat(40), baseBranch: 'main' });
    expect(() => simulatedGitHubLaunch(url)).toThrow('example repositories');
    for (const branch of ['constructor', '__proto__', 'toString']) expect(() => simulatedGitHubLaunch(`https://github.com/ephemeral/example-app/tree/${branch}`)).toThrow('simulates only');
    expect(network).not.toHaveBeenCalled();
  });
});

describe('durable reviewed GitHub launch intent', () => {
  it('concurrent identical intents create one exact target and replay with current authorization after refs move', async () => {
    const f = await fixture(), request = randomUUID();
    const [one, two] = await Promise.all([f.launch(request), f.launch(request)]); expect(one.id).toBe(two.id); expect(f.manager.create).toHaveBeenCalledTimes(1);
    expect(one.launchSource).toEqual(copyGitHubLaunchSource(review({ checkedAt: one.launchSource!.checkedAt })));
    f.github.githubLaunchPreview.mockResolvedValue(review({ commitSha: other }));
    const reopened = await createGitHubLaunchController(f.db as unknown as Database, f.repo, f.manager, f.github);
    expect((await reopened.launch('42', 'FRESH-OAUTH', url, sha, 'main', request, 1, 2)).id).toBe(one.id);
    expect(f.github.authorizeGitHubLaunch).toHaveBeenLastCalledWith(url, 'FRESH-OAUTH'); expect(f.github.githubLaunchPreview).toHaveBeenCalledTimes(1);
    f.github.authorizeGitHubLaunch.mockRejectedValueOnce(new GitHubError('access revoked', 403));
    await expect(f.launch(request)).rejects.toMatchObject({ status: 403 });
    await expect(f.launch(request, { sha: other })).rejects.toThrow('different GitHub launch');
    await expect(f.launch(request, { url: `${url}/tree/main` })).rejects.toThrow('different GitHub launch');
    await expect(f.controller.launch('42', 'oauth', url, sha, 'main', request, 99, 2)).rejects.toThrow('different GitHub launch');
    await expect(f.controller.launch('42', 'oauth', url, sha, 'main', request, 1, 99)).rejects.toThrow('different GitHub launch');
    f.github.authorizeGitHubLaunch.mockResolvedValueOnce({ ...repository, installationId: 99 });
    await expect(f.launch(request)).rejects.toThrow('authorization changed');
  });
  it.each([{ commitSha: other }, { baseBranch: 'develop', ref: 'develop' }])('durably rejects a moved reviewed source before insertion: %j', async change => {
    const f = await fixture(), request = randomUUID(); f.github.githubLaunchPreview.mockResolvedValueOnce(review(change));
    await expect(f.launch(request)).rejects.toMatchObject({ status: 409, code: 'GITHUB_LAUNCH_REJECTED', outcome: 'not_created' });
    await expect(f.launch(request)).rejects.toMatchObject({ code: 'GITHUB_LAUNCH_REJECTED' });
    expect(f.manager.create).not.toHaveBeenCalled(); expect(await f.repo.list()).toEqual([]);
  });
  it.each([{ repositoryId: 99 }, { installationId: 99 }])('rejects repository identity changes before reservation even when SHA and base match: %j', async change => {
    const f = await fixture(); f.github.githubLaunchPreview.mockResolvedValue(review(change));
    await expect(f.launch()).rejects.toMatchObject({ status: 409, code: 'GITHUB_LAUNCH_REJECTED', outcome: 'not_created' });
    expect(f.manager.create).not.toHaveBeenCalled(); expect((await f.db.query('SELECT * FROM ephemeral_github_launch_requests')).rows).toHaveLength(0);
  });
  it.each([new GitHubError('Repository access is unavailable.', 403), new GitHubError('The reviewed pull request head is missing.', 409), new Error('secret transport details')])('reports fresh read-only resolution failure as definite before any reservation or session: %s', async failure => {
    const f = await fixture(); f.github.githubLaunchPreview.mockRejectedValueOnce(failure);
    let rejected: unknown;
    try { await f.launch(); } catch (error) { rejected = error; }
    expect(rejected).toMatchObject({ status: failure instanceof GitHubError ? failure.status : 502, code: 'GITHUB_LAUNCH_REJECTED', outcome: 'not_created' });
    expect((rejected as Error).message).not.toContain('secret'); expect(f.manager.create).not.toHaveBeenCalled();
    expect((await f.db.query('SELECT * FROM ephemeral_github_launch_requests')).rows).toHaveLength(0); expect(await f.repo.list()).toHaveLength(0);
  });
  it('preserves uncertainty when reauthorization fails after a prior accepted creation attempt', async () => {
    const f = await fixture(), request = randomUUID(); f.manager.create.mockRejectedValueOnce(new Error('ambiguous accepted insertion'));
    await expect(f.launch(request)).rejects.toMatchObject({ status: 409, code: undefined });
    f.github.authorizeGitHubLaunch.mockRejectedValueOnce(new GitHubError('current access is unavailable', 403));
    let rejected: unknown; try { await f.launch(request); } catch (error) { rejected = error; }
    expect(rejected).toMatchObject({ status: 403 }); expect(rejected).not.toHaveProperty('code'); expect(rejected).not.toHaveProperty('outcome');
    expect((await f.db.query<{ status: string }>('SELECT status FROM ephemeral_github_launch_requests')).rows[0].status).toBe('creating');
    expect(f.manager.create).toHaveBeenCalledTimes(1); expect(f.github.githubLaunchPreview).toHaveBeenCalledTimes(1);
  });
  it('keeps uncertain insertion creating, then recovers the same target and accepted SHA after refs move', async () => {
    const f = await fixture(), request = randomUUID(); f.manager.create.mockRejectedValueOnce(new Error('uncertain insertion transport'));
    await expect(f.launch(request)).rejects.toMatchObject({ status: 409, code: undefined });
    const row = (await f.db.query<{ status: string; target_id: string }>('SELECT status,target_id FROM ephemeral_github_launch_requests')).rows[0]; expect(row.status).toBe('creating');
    f.github.githubLaunchPreview.mockResolvedValue(review({ commitSha: other }));
    const child = await f.launch(request); expect(child.id).toBe(row.target_id); expect(child.launchSource?.commitSha).toBe(sha);
    expect(f.github.githubLaunchPreview).toHaveBeenCalledTimes(1);
  });
  it('does not downgrade a prior ambiguous creation after a later trusted preinsert failure', async () => {
    const f = await fixture(), request = randomUUID();
    f.manager.create.mockRejectedValueOnce(new Error('ambiguous original insertion'));
    await expect(f.launch(request)).rejects.toMatchObject({ code: undefined });
    f.manager.create.mockRejectedValueOnce(new SessionNotCreatedError('service is shutting down'));
    await expect(f.launch(request)).rejects.toMatchObject({ code: undefined });
    expect((await f.db.query<{ status: string }>('SELECT status FROM ephemeral_github_launch_requests')).rows[0].status).toBe('creating');
    f.github.githubLaunchPreview.mockResolvedValue(review({ commitSha: other }));
    expect((await f.launch(request)).launchSource?.commitSha).toBe(sha);
  });
  it('recovers a persisted insert with a lost acknowledgement and refuses tampered persisted provenance', async () => {
    const f = await fixture(), request = randomUUID(), insert = f.repo.insert.bind(f.repo);
    vi.spyOn(f.repo, 'insert').mockImplementationOnce(async session => { await insert(session); throw new Error('lost acknowledgement'); });
    const child = await f.launch(request); expect((await f.launch(request)).id).toBe(child.id); expect(await f.repo.list()).toHaveLength(1);
    await f.repo.update({ ...child, launchSource: { ...child.launchSource!, commitSha: other } });
    await expect(f.launch(request)).rejects.toThrow('could not be verified');
  });
  it('resets only proven preinsert conflicts and preserves the reserved target for the same retry', async () => {
    const f = await fixture(), child = await f.launch(), request = randomUUID();
    await expect(f.launch(request)).rejects.toMatchObject({ code: 'GITHUB_LAUNCH_REJECTED', outcome: 'not_created' });
    const row = (await f.db.query<{ target_id: string; status: string }>('SELECT target_id,status FROM ephemeral_github_launch_requests WHERE request_id=$1', [request])).rows[0]; expect(row.status).toBe('reserved');
    await f.repo.update({ ...child, state: 'ended' }); expect((await f.launch(request)).id).toBe(row.target_id);
  });
  it('bounds user admission and closes synchronously before draining pending work', async () => {
    const f = await fixture(); let finish!: (value: GitHubLaunchReview) => void;
    const blocked = new Promise<GitHubLaunchReview>(resolve => { finish = resolve; }); f.github.githubLaunchPreview.mockReturnValue(blocked);
    const pending = Array.from({ length: 4 }, () => f.controller.preview('42', 'oauth', url));
    expect(() => f.controller.preview('42', 'oauth', url)).toThrow('Too many');
    const closing = f.controller.close(); expect(() => f.controller.preview('other-user', 'oauth', url)).toThrow('shutting down');
    finish(review()); await Promise.all(pending); await closing;
  });
  it('restores an accepted creating/no-session intent through an actual database restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ep-url-restart-')); let db = new PGlite(directory);
    try {
      let repo = await createSessionRepository(db as unknown as Database), manager = creator(repo);
      const github = { githubLaunchPreview: vi.fn(async () => review()), authorizeGitHubLaunch: vi.fn(async () => repository) };
      let controller = await createGitHubLaunchController(db as unknown as Database, repo, manager, github);
      const request = randomUUID(); manager.create.mockRejectedValueOnce(new Error('interrupted before insert'));
      await expect(controller.launch('42', 'oauth', url, sha, 'main', request, 1, 2)).rejects.toThrow('could not be confirmed');
      const row = (await db.query<{ target_id: string }>('SELECT target_id FROM ephemeral_github_launch_requests')).rows[0];
      await controller.close(); await db.close(); db = new PGlite(directory);
      repo = await createSessionRepository(db as unknown as Database); manager = creator(repo);
      github.githubLaunchPreview.mockResolvedValue(review({ commitSha: other }));
      controller = await createGitHubLaunchController(db as unknown as Database, repo, manager, github);
      const child = await controller.launch('42', 'fresh-oauth', url, sha, 'main', request, 1, 2);
      expect(child.id).toBe(row.target_id); expect(child.launchSource?.commitSha).toBe(sha); expect(github.githubLaunchPreview).toHaveBeenCalledTimes(1);
      await controller.close();
    } finally { await db.close(); await rm(directory, { recursive: true, force: true }); }
  }, 30_000);
});
