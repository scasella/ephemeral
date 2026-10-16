export type GitHubLaunchKind = 'repository' | 'branch' | 'commit' | 'pull_request';
export interface GitHubLaunchSource {
  url: string; kind: GitHubLaunchKind; ref: string; commitSha: string; baseBranch: string; checkedAt: string;
  pullRequestNumber?: number;
}
export interface GitHubLaunchReview extends GitHubLaunchSource {
  repository: string; repositoryId: number; installationId: number; simulated: boolean;
}
export interface ParsedGitHubLaunch { url: string; repository: string; kind: GitHubLaunchKind; ref?: string; pullRequestNumber?: number }
export function validGitHubBranch(value: string): boolean {
  return value.length > 0 && value.length <= 240 && value !== '@' && !/[\x00-\x20\x7f~^:?*\[\\%#]/.test(value) &&
    !value.includes('..') && !value.includes('@{') && !value.startsWith('-') && !value.endsWith('.') &&
    value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock'));
}
/** Parse only canonical GitHub locations. Never use the pasted URL as a network destination. */
export function parseGitHubLaunchUrl(value: string): ParsedGitHubLaunch {
  const invalid = () => { throw new Error('Use a canonical HTTPS github.com repository, branch, full commit, or pull request URL.'); };
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f-\x9f%\\?#]/.test(value)) return invalid();
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)(\/.*)?$/.exec(value);
  if (!match || ['.', '..'].includes(match[2]) || match[2].endsWith('.git')) return invalid();
  const repository = `${match[1]}/${match[2]}`, root = `https://github.com/${repository}`, suffix = match[3] ?? '';
  if (!suffix || suffix === '/') return { url: root, repository, kind: 'repository' };
  if (suffix.startsWith('/tree/')) {
    const ref = suffix.slice(6); if (!validGitHubBranch(ref)) return invalid();
    return { url: `${root}/tree/${ref}`, repository, kind: 'branch', ref };
  }
  const commit = /^\/commit\/([a-f0-9]{40})$/i.exec(suffix);
  if (commit) return { url: `${root}/commit/${commit[1].toLowerCase()}`, repository, kind: 'commit', ref: commit[1].toLowerCase() };
  const pr = /^\/pull\/([1-9][0-9]{0,9})$/.exec(suffix);
  if (pr && Number.isSafeInteger(Number(pr[1]))) return { url: `${root}/pull/${Number(pr[1])}`, repository, kind: 'pull_request', pullRequestNumber: Number(pr[1]) };
  return invalid();
}
/** Copy trusted resolved metadata before scheduling provision work. */
export function copyGitHubLaunchSource(value: GitHubLaunchSource): GitHubLaunchSource {
  const parsed = parseGitHubLaunchUrl(value.url);
  if (parsed.kind !== value.kind || !/^[a-f0-9]{40}$/.test(value.commitSha) || !validGitHubBranch(value.baseBranch) ||
    !Number.isFinite(Date.parse(value.checkedAt)) ||
    (value.kind === 'commit' ? parsed.ref !== value.commitSha || value.ref !== value.commitSha : !validGitHubBranch(value.ref)) ||
    (value.kind === 'repository' && value.ref !== value.baseBranch) ||
    (value.kind === 'branch' && parsed.ref !== value.ref) ||
    (value.kind === 'pull_request' ? parsed.pullRequestNumber !== value.pullRequestNumber : value.pullRequestNumber !== undefined)) {
    throw new Error('Invalid GitHub launch source.');
  }
  return { url: parsed.url, kind: value.kind, ref: value.ref, commitSha: value.commitSha, baseBranch: value.baseBranch,
    checkedAt: value.checkedAt, ...(value.pullRequestNumber ? { pullRequestNumber: value.pullRequestNumber } : {}) };
}
