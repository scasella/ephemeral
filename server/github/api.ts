import { appJWT, GitHubError, GitHubRequestRejectedError, InstallationTokenIssuanceError, safeRepository } from './security.js';
import type { Session } from '../contracts.js';
import type { PullRequestPreview, SavedPullRequest } from './pull-requests.js';
import { continuationPreview, type ContinuationPreview } from '../continuation.js';
import { readPublishedChanges, type PublishedChanges, type PublishedChangesQuery } from './published-changes.js';

export interface Repo { id: number; fullName: string; defaultBranch: string; installationId: number }
interface RemoteRepo { id: number; full_name: string; default_branch: string; archived?: boolean; disabled?: boolean; permissions?: { push?: boolean } }
interface RemotePullRequest {
  html_url: string; number: number; created_at: string;
  head: { sha: string; ref: string; repo: { id: number } | null };
  base: { sha: string; ref: string; repo: { id: number } | null };
}
const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
export class GitHubAPI {
  constructor(private appId: string, private privateKey: string, private appSlug: string) {}
  async request<T>(path: string, token: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const response = await fetch(`https://api.github.com${path}`, {
      method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', 'User-Agent': 'Ephemeral' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000), redirect: 'error',
    });
    if (!response.ok) throw new GitHubRequestRejectedError(`GitHub rejected the ${method} request (${response.status})`, response.status === 401 || response.status === 403 ? 403 : 502, response.status);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
  async repositories(userToken: string, signal?: AbortSignal): Promise<Repo[]> {
    const read = async <T>(path: string): Promise<T> => {
      signal?.throwIfAborted();
      const result = signal ? await this.request<T>(path, userToken, 'GET', undefined, signal) : await this.request<T>(path, userToken);
      signal?.throwIfAborted();
      return result;
    };
    const repos: Repo[] = [];
    for (let page = 1; page <= 100; page++) {
      const result = await read<{ installations: { id: number; app_id: number; app_slug?: string; suspended_at: string | null }[] }>(`/user/installations?per_page=100&page=${page}`);
      for (const installation of result.installations) {
        if (String(installation.app_id) !== this.appId || installation.suspended_at || (installation.app_slug && installation.app_slug !== this.appSlug)) continue;
        for (let repoPage = 1; repoPage <= 100; repoPage++) {
          const listing = await read<{ repositories: RemoteRepo[] }>(`/user/installations/${installation.id}/repositories?per_page=100&page=${repoPage}`);
          for (const r of listing.repositories) if (r.permissions?.push && !r.archived && !r.disabled) {
            repos.push({ id: r.id, fullName: safeRepository(r.full_name), defaultBranch: r.default_branch, installationId: installation.id });
          }
          if (listing.repositories.length < 100) break;
          if (repoPage === 100) throw new GitHubError('Repository listing exceeds the supported limit', 413);
        }
      }
      if (result.installations.length < 100) break;
      if (page === 100) throw new GitHubError('Installation listing exceeds the supported limit', 413);
    }
    return repos;
  }
  async branches(userToken: string, installationId: number, repositoryId: number): Promise<{ name: string }[]> {
    const repository = (await this.repositories(userToken)).find(r => r.installationId === installationId && r.id === repositoryId);
    if (!repository) throw new GitHubError('Repository is not accessible to this user', 403);
    const branches: { name: string }[] = [];
    for (let page = 1; page <= 100; page++) {
      const result = await this.request<{ name: string }[]>(`/repos/${repository.fullName}/branches?per_page=100&page=${page}`, userToken);
      branches.push(...result.map(b => ({ name: b.name })));
      if (result.length < 100) return branches;
    }
    throw new GitHubError('Branch listing exceeds the supported limit', 413);
  }
  prepareInstallationToken(session: Session): () => Promise<{ token: string; expires_at: string }> {
    if (!Number.isSafeInteger(session.installationId) || session.installationId < 1 || !Number.isSafeInteger(session.repositoryId) || session.repositoryId < 1) {
      throw new GitHubError('Invalid installation token scope', 400);
    }
    const path = `/app/installations/${session.installationId}/access_tokens`;
    const jwt = appJWT(this.appId, this.privateKey);
    const body = { repository_ids: [session.repositoryId], permissions: { contents: 'write', pull_requests: 'write' } };
    // Finish signing and serialization before the store records a remote attempt.
    JSON.stringify(body);
    return async () => {
      try { return await this.request(path, jwt, 'POST', body); }
      catch (error) {
        // 408, arbitrary 4xx, transport failures, and all 5xx remain ambiguous.
        if (error instanceof GitHubRequestRejectedError && [400, 401, 403, 404, 422, 429].includes(error.upstreamStatus ?? 0)) {
          throw new InstallationTokenIssuanceError('not_issued');
        }
        throw new InstallationTokenIssuanceError('unknown');
      }
    };
  }
  async installationToken(session: Session): Promise<{ token: string; expires_at: string }> {
    return this.prepareInstallationToken(session)();
  }
  async revoke(token: string): Promise<void> { await this.request('/installation/token', token, 'DELETE'); }
  async authorizeContinuation(session: Session, userToken: string, signal?: AbortSignal): Promise<void> {
    const accessible = (await (signal ? this.repositories(userToken, signal) : this.repositories(userToken))).some(r => r.id === session.repositoryId &&
      r.installationId === session.installationId && r.fullName === session.repository);
    if (!accessible) throw new GitHubError('Repository is no longer accessible to this account and App installation', 403);
  }
  async publishedChanges(session: Session, userToken: string, query: PublishedChangesQuery = {}, signal?: AbortSignal): Promise<PublishedChanges> {
    return readPublishedChanges(session, userToken, readSignal => this.authorizeContinuation(session, userToken, readSignal), query, signal);
  }
  async continuationPreview(session: Session, userToken: string): Promise<ContinuationPreview> {
    const result = continuationPreview(session, 'unknown', 'GitHub could not verify the saved branch. Refresh to retry.');
    await this.authorizeContinuation(session, userToken);
    try {
      let base: { object: { sha: string; type: string } };
      try { base = await this.request(`/repos/${safeRepository(session.repository)}/git/ref/heads/${encodeURIComponent(session.baseBranch)}`, userToken); }
      catch (error) {
        if (error instanceof GitHubError && error.upstreamStatus === 404) return { ...result, state: 'unavailable', reason: 'The original base branch no longer exists on GitHub.' };
        throw error;
      }
      if (base.object?.type !== 'commit' || !/^[a-f0-9]{40}$/i.test(base.object.sha)) throw new Error('Invalid base ref');
      let head: { object: { sha: string; type: string } };
      try { head = await this.request(`/repos/${session.repository}/git/ref/heads/${encodeURIComponent(session.branch)}`, userToken); }
      catch (error) {
        if (error instanceof GitHubError && error.upstreamStatus === 404) return { ...result, state: 'unpublished', reason: 'No published source branch is available on GitHub. Unpushed work cannot be restored.' };
        throw error;
      }
      if (head.object?.type !== 'commit' || !/^[a-f0-9]{40}$/i.test(head.object.sha)) throw new Error('Invalid source ref');
      return { ...result, state: 'ready', reason: null, commitSha: head.object.sha };
    } catch (error) {
      if (error instanceof GitHubError && error.status === 403) throw error;
      return result;
    }
  }
  async pullRequestPreview(session: Session, token: string): Promise<PullRequestPreview> {
    // Gateway authorization surrounds this installation-token read. Reuse the
    // bounded projection and final ref checks used by the user OAuth review.
    const review = await readPublishedChanges(session, token, async () => {});
    return { state: review.state === 'known' ? 'ready' : review.state,
      checkedAt: review.checkedAt, reason: review.reason, headSha: review.headSha, baseSha: review.baseSha,
      baseBranch: review.baseBranch, headBranch: review.headBranch, aheadCommits: review.aheadCommits };
  }
  private savedPullRequest(session: Session, result: RemotePullRequest): SavedPullRequest {
    if (!Number.isSafeInteger(result.number) || result.number < 1 || result.html_url !== `https://github.com/${session.repository}/pull/${result.number}` ||
      result.head?.ref !== session.branch || result.base?.ref !== session.baseBranch || result.head.repo?.id !== session.repositoryId || result.base.repo?.id !== session.repositoryId ||
      !shaPattern.test(result.head.sha) || !shaPattern.test(result.base.sha) || !Number.isFinite(Date.parse(result.created_at))) throw new GitHubError('Unable to verify returned pull request metadata');
    return { url: result.html_url, number: result.number, headSha: result.head.sha, baseSha: result.base.sha, headBranch: result.head.ref, baseBranch: result.base.ref, createdAt: result.created_at };
  }
  async existingPullRequest(session: Session, token: string): Promise<SavedPullRequest | null> {
    const owner = session.repository.split('/')[0];
    const query = new URLSearchParams({ state: 'open', head: `${owner}:${session.branch}`, base: session.baseBranch, per_page: '100' });
    const results = await this.request<(RemotePullRequest & { state: string })[]>(`/repos/${safeRepository(session.repository)}/pulls?${query}`, token);
    const existing = results.find(pr => pr.head?.ref === session.branch && pr.base?.ref === session.baseBranch && pr.head.repo?.id === session.repositoryId && pr.state === 'open');
    return existing ? this.savedPullRequest(session, existing) : null;
  }
  async pullRequest(session: Session, token: string, title: string, body?: string): Promise<SavedPullRequest> {
    safeRepository(session.repository);
    // Match the HTTP schema's code-point count for non-BMP titles.
    if (!title.trim() || [...title].length > 256 || (body?.length ?? 0) > 65_536) throw new GitHubError('Invalid pull request title or body', 400);
    const result = await this.request<RemotePullRequest>(`/repos/${session.repository}/pulls`, token, 'POST', {
      title, body: body ?? '', head: session.branch, base: session.baseBranch, draft: true,
    });
    return this.savedPullRequest(session, result);
  }
}
