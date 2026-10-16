import { parseGitHubLaunchUrl, validGitHubBranch, type GitHubLaunchReview, type ParsedGitHubLaunch } from '../../shared/github-launch.js';
import type { Repo } from './api.js';
import { GitHubError } from './security.js';

interface LaunchAPI {
  repositories(token: string, signal?: AbortSignal): Promise<Repo[]>;
  request<T>(path: string, token: string, method?: string, body?: unknown, signal?: AbortSignal, maxResponseBytes?: number): Promise<T>;
}
export async function authorizeGitHubLaunch(api: Pick<LaunchAPI, 'repositories'>, parsed: ParsedGitHubLaunch, token: string, signal = AbortSignal.timeout(30_000)): Promise<Repo> {
  const repository = (await api.repositories(token, signal)).find(repo => repo.fullName.toLowerCase() === parsed.repository.toLowerCase());
  if (!repository) throw new GitHubError('This repository is not authorized for your current account and this GitHub App installation.', 403);
  if (!validGitHubBranch(repository.defaultBranch) || !Number.isSafeInteger(repository.id) || !Number.isSafeInteger(repository.installationId)) throw new GitHubError('GitHub returned invalid repository metadata.');
  return repository;
}
/** All requests use fixed API routes built from an authorized repository, never a pasted destination. */
export async function resolveGitHubLaunch(api: LaunchAPI, url: string, token: string): Promise<GitHubLaunchReview> {
  const signal = AbortSignal.timeout(30_000);
  let requests = 0;
  const read = async <T>(path: string): Promise<T> => {
    signal.throwIfAborted();
    if (++requests > 48) throw new GitHubError('GitHub URL resolution exceeds the supported request limit.', 413);
    const result = await api.request<T>(path, token, 'GET', undefined, signal, 2 * 1024 * 1024);
    signal.throwIfAborted(); return result;
  };
  const parsed = parseGitHubLaunchUrl(url), repository = await authorizeGitHubLaunch(api, parsed, token, signal);
  const root = `/repos/${repository.fullName}`;
  const readRef = async (branch: string): Promise<string> => {
    if (!validGitHubBranch(branch)) throw new GitHubError('GitHub returned an invalid branch name.', 409);
    const result = await read<{ ref: string; object: { sha: string; type: string } }>(`${root}/git/ref/heads/${encodeURIComponent(branch)}`);
    // GitHub may return a prefix match/list. Only one exact complete ref is usable.
    if (result.ref !== `refs/heads/${branch}` || result.object?.type !== 'commit' || !/^[a-f0-9]{40}$/i.test(result.object.sha)) {
      throw new GitHubError('This URL does not identify an exact repository branch. File and directory URLs are unsupported.', 409);
    }
    return result.object.sha.toLowerCase();
  };
  let baseBranch = repository.defaultBranch, ref = parsed.ref ?? baseBranch, commitSha: string;
  if (parsed.kind === 'pull_request') {
    const pr = await read<{ number: number; head: { sha: string; ref: string; repo: { id: number } | null }; base: { ref: string; repo: { id: number } | null } }>(`${root}/pulls/${parsed.pullRequestNumber}`);
    if (pr.number !== parsed.pullRequestNumber || pr.base?.repo?.id !== repository.id || !validGitHubBranch(pr.base.ref)) throw new GitHubError('GitHub could not verify the pull request base.', 409);
    if (pr.head?.repo?.id !== repository.id) throw new GitHubError('Fork pull requests are unsupported: their source repository cannot be authorized with this session’s repository-scoped credentials.', 409);
    if (!validGitHubBranch(pr.head.ref) || !/^[a-f0-9]{40}$/i.test(pr.head.sha)) throw new GitHubError('GitHub could not verify the pull request head.', 409);
    ref = pr.head.ref; baseBranch = pr.base.ref; commitSha = pr.head.sha.toLowerCase();
    await readRef(baseBranch);
    if (await readRef(ref) !== commitSha) throw new GitHubError('The pull request source branch changed or is unavailable. Review the URL again.', 409);
  } else {
    const defaultSha = await readRef(baseBranch);
    if (parsed.kind === 'repository') commitSha = defaultSha;
    else if (parsed.kind === 'branch') commitSha = ref === baseBranch ? defaultSha : await readRef(ref);
    else {
      const result = await read<{ sha: string }>(`${root}/git/commits/${ref}`);
      if (result.sha?.toLowerCase() !== ref) throw new GitHubError('GitHub could not verify the full commit ID.', 409);
      // GitHub can expose objects from the repository's fork network. Require
      // ancestry from a branch in this authorized repository before admitting it.
      const ancestor = async (head: string): Promise<boolean> => {
        try {
          const compared = await read<{ merge_base_commit: { sha: string } }>(`${root}/compare/${ref}...${head}`);
          return compared.merge_base_commit?.sha?.toLowerCase() === ref;
        } catch (error) {
          if (error instanceof GitHubError && error.upstreamStatus === 404) return false;
          throw error;
        }
      };
      let reachable = defaultSha === ref;
      if (!reachable) {
        reachable = await ancestor(defaultSha);
      }
      for (let page = 1; !reachable && page <= 100; page++) {
        const branches = await read<{ name: string; commit: { sha: string } }[]>(`${root}/branches?per_page=100&page=${page}`);
        for (const branch of branches) {
          const head = branch.commit?.sha;
          if (!validGitHubBranch(branch.name) || !/^[a-f0-9]{40}$/i.test(head)) throw new GitHubError('GitHub returned invalid branch metadata.');
          if (head.toLowerCase() === ref) { reachable = true; break; }
          if (await ancestor(head)) { reachable = true; break; }
        }
        if (branches.length < 100) break;
        if (page === 100 && !reachable) throw new GitHubError('Commit reachability exceeds the supported repository limit.', 413);
      }
      if (!reachable) throw new GitHubError('This commit is not reachable from a branch in the authorized repository.', 409);
      commitSha = ref;
    }
  }
  return { url: parsed.url, kind: parsed.kind, ref, commitSha, baseBranch, checkedAt: new Date().toISOString(),
    repository: repository.fullName, repositoryId: repository.id, installationId: repository.installationId,
    ...(parsed.pullRequestNumber ? { pullRequestNumber: parsed.pullRequestNumber } : {}), simulated: false };
}
