import type { EnvironmentCatalog, EnvironmentProfile, EnvironmentRef } from '../shared/environments.js';
import { EnvironmentError } from './environments.js';
import { allowedSavedEnvironment, matchesEnvironmentRef, sameEnvironment, selectEnvironment } from './launch-environment.js';
import { randomUUID } from 'node:crypto';
import { copyGitHubLaunchSource, parseGitHubLaunchUrl, validGitHubBranch, type GitHubLaunchReview } from '../shared/github-launch.js';
import type { CreateSessionInput, Database, Session, SessionRepository } from './contracts.js';
import type { Repo } from './github/api.js';
import { GitHubError } from './github/security.js';
import { SessionNotCreatedError } from './core/provisioning.js';
import { SESSION_UUID } from './core/continuation.js';
import { previewRepositories } from './preview.js';

export class GitHubLaunchError extends Error {
  readonly code?: 'GITHUB_LAUNCH_REJECTED'; readonly outcome?: 'not_created';
  constructor(public status: number, message: string, rejected = false) {
    super(message); if (rejected) { this.code = 'GITHUB_LAUNCH_REJECTED'; this.outcome = 'not_created'; }
  }
}
interface LaunchGitHub {
  githubLaunchPreview(url: string, token: string): Promise<GitHubLaunchReview>;
  authorizeGitHubLaunch(url: string, token: string): Promise<Repo>;
}
interface Reservation {
  user_id: string; request_id: string; target_id: string; url: string; expected_sha: string; expected_base: string;
  review: GitHubLaunchReview; environment: EnvironmentProfile | null; status: 'reserved' | 'creating' | 'rejected'; rejection_reason: string | null;
}
interface SessionCreator { create(input: CreateSessionInput, options?: { id?: string }): Promise<Session> }
export function simulatedGitHubLaunch(url: string): GitHubLaunchReview {
  const parsed = parseGitHubLaunchUrl(url), repository = previewRepositories.find(repo => repo.fullName.toLowerCase() === parsed.repository.toLowerCase());
  if (!repository) throw new GitHubLaunchError(403, 'Local preview supports only the example repositories shown in the repository selector.');
  const branches: Record<string, string> = { main: 'a'.repeat(40), develop: 'b'.repeat(40), 'feature/demo': 'c'.repeat(40) };
  const ref = parsed.kind === 'pull_request' ? 'feature/demo' : parsed.ref ?? repository.defaultBranch;
  if (parsed.kind === 'pull_request' && parsed.pullRequestNumber !== 1) throw new GitHubLaunchError(404, 'Local preview simulates only pull request #1.');
  const commitSha = parsed.kind === 'commit' ? ref : Object.hasOwn(branches, ref) ? branches[ref] : undefined;
  if (!commitSha) throw new GitHubLaunchError(404, 'Local preview simulates only main, develop, and feature/demo branches.');
  return { url: parsed.url, kind: parsed.kind, ref, commitSha, baseBranch: repository.defaultBranch,
    checkedAt: new Date().toISOString(), repository: repository.fullName, repositoryId: repository.id,
    installationId: repository.installationId, simulated: true, ...(parsed.pullRequestNumber ? { pullRequestNumber: parsed.pullRequestNumber } : {}) };
}
export async function createGitHubLaunchController(db: Database, repo: SessionRepository, manager: SessionCreator, github: LaunchGitHub | null, environments?: EnvironmentCatalog) {
  await db.query(`CREATE TABLE IF NOT EXISTS ephemeral_github_launch_requests (
    user_id text NOT NULL, request_id text NOT NULL, target_id text UNIQUE NOT NULL,
    url text NOT NULL, expected_sha text NOT NULL, expected_base text NOT NULL, review jsonb NOT NULL,
    status text NOT NULL DEFAULT 'reserved', rejection_reason text,
    PRIMARY KEY(user_id,request_id)
  )`);
  await db.query('ALTER TABLE ephemeral_github_launch_requests ADD COLUMN IF NOT EXISTS environment jsonb');
  let closed = false, count = 0;
  const users = new Map<string, number>(), operations = new Set<Promise<unknown>>(), requests = new Map<string, Promise<void>>();
  function checkOpen() { if (closed) throw new GitHubLaunchError(503, 'GitHub launch service is shutting down.'); }
  function admitted<T>(userId: string, action: () => Promise<T>): Promise<T> {
    checkOpen();
    if (count >= 32 || (users.get(userId) ?? 0) >= 4) throw new GitHubLaunchError(429, 'Too many simultaneous GitHub launch requests. Retry shortly.');
    count++; users.set(userId, (users.get(userId) ?? 0) + 1);
    const result = Promise.resolve().then(action);
    operations.add(result);
    void result.then(() => {}, () => {}).finally(() => { count--; const remaining = users.get(userId)! - 1;
      if (remaining) users.set(userId, remaining); else users.delete(userId); operations.delete(result); });
    return result;
  }
  function parsedUrl(url: string) {
    try { return parseGitHubLaunchUrl(url).url; }
    catch { throw new GitHubLaunchError(400, 'Use a canonical HTTPS github.com repository, branch, full commit, or pull request URL.'); }
  }
  async function resolve(url: string, token: string) {
    try { return github ? await github.githubLaunchPreview(url, token) : simulatedGitHubLaunch(url); }
    catch (error) {
      if (error instanceof GitHubLaunchError) throw error;
      if (error instanceof GitHubError) throw new GitHubLaunchError(error.status, error.message);
      throw new GitHubLaunchError(502, 'GitHub could not resolve this URL. Retry the review.');
    }
  }
  async function authorize(url: string, token: string) {
    return github ? github.authorizeGitHubLaunch(url, token) : (() => { const review = simulatedGitHubLaunch(url);
      return { id: review.repositoryId, installationId: review.installationId, fullName: review.repository, defaultBranch: review.baseBranch }; })();
  }
  async function existing(row: Reservation): Promise<Session | null> {
    const target = await repo.get(row.target_id), reviewed = row.review;
    if (target && (target.userId !== row.user_id || target.repository !== reviewed.repository ||
      target.repositoryId !== reviewed.repositoryId || target.installationId !== reviewed.installationId ||
      !sameEnvironment(target.environment, row.environment) || target.baseBranch !== row.expected_base || target.branch !== `ephemeral/${row.target_id}` || target.continuation ||
      (!target.launchSource || JSON.stringify(copyGitHubLaunchSource(target.launchSource)) !== JSON.stringify(copyGitHubLaunchSource(reviewed))))) {
      throw new GitHubLaunchError(409, 'The saved GitHub launch could not be verified.');
    }
    return target;
  }
  async function start(userId: string, token: string, url: string, expectedSha: string, expectedBase: string, requestId: string, expectedRepositoryId: number, expectedInstallationId: number, environmentRef?: EnvironmentRef): Promise<Session> {
    const params = [userId, requestId.toLowerCase()];
    const read = async () => (await db.query<Reservation>('SELECT * FROM ephemeral_github_launch_requests WHERE user_id=$1 AND request_id=$2', params)).rows[0];
    // Recover an existing intent before resolving moving refs, but always reauthorize this browser first.
    let row = await read();
    if (row && (row.url !== url || row.expected_sha !== expectedSha || row.expected_base !== expectedBase || row.review.repositoryId !== expectedRepositoryId || row.review.installationId !== expectedInstallationId || !matchesEnvironmentRef(row.environment, environmentRef))) throw new GitHubLaunchError(409, 'This request ID was already used for a different GitHub launch.');
    if (row) {
      const authorized = await authorize(url, token);
      if (authorized.id !== row.review.repositoryId || authorized.installationId !== row.review.installationId || authorized.fullName !== row.review.repository) throw new GitHubLaunchError(403, 'The saved repository authorization changed.');
      const target = await existing(row); if (target) return target;
      if (row.status === 'rejected') throw new GitHubLaunchError(409, row.rejection_reason ?? 'Review this URL again.', true);
    }
    let environment: EnvironmentProfile | undefined;
    try { environment = row ? allowedSavedEnvironment(environments, row.environment) : selectEnvironment(environments, environmentRef); }
    catch (error) {
      if (!row && error instanceof EnvironmentError) throw new GitHubLaunchError(error.status, error.message, true);
      throw error;
    }
    // An accepted creation intent keeps its original immutable snapshot on retry.
    let checked: GitHubLaunchReview;
    try { checked = row?.status === 'creating' ? row.review : await resolve(url, token); }
    catch (error) {
      // A new intent has made no reservation or create attempt. Read-only
      // resolution failure is definitive even when its upstream outcome is unknown.
      // Existing intents retain their prior accepted history on every failure.
      if (!row && error instanceof GitHubLaunchError) throw new GitHubLaunchError(error.status, error.message, true);
      throw error;
    }
    checkOpen();
    if (!row && (checked.repositoryId !== expectedRepositoryId || checked.installationId !== expectedInstallationId)) throw new GitHubLaunchError(409, 'The repository or App installation changed. Review the URL again before launching.', true);
    if (!row) {
      await db.query(`INSERT INTO ephemeral_github_launch_requests(user_id,request_id,target_id,url,expected_sha,expected_base,review,environment)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) ON CONFLICT(user_id,request_id) DO NOTHING`,
      [...params, randomUUID(), url, expectedSha, expectedBase, JSON.stringify(checked), environment ? JSON.stringify(environment) : null]);
      row = await read();
    }
    if (!row || row.url !== url || row.expected_sha !== expectedSha || row.expected_base !== expectedBase || !matchesEnvironmentRef(row.environment, environmentRef)) throw new GitHubLaunchError(409, 'This request ID was already used for a different GitHub launch.');
    const reject = async (reason: string): Promise<never> => {
      const changed = await db.query(`UPDATE ephemeral_github_launch_requests SET status='rejected',rejection_reason=$3
        WHERE user_id=$1 AND request_id=$2 AND status='reserved' RETURNING target_id`, [...params, reason]);
      throw new GitHubLaunchError(409, reason, changed.rows.length > 0);
    };
    if (checked.commitSha !== expectedSha || checked.baseBranch !== expectedBase) return reject('The source commit or base branch changed. Review the URL again before launching.');
    if (row.review.repositoryId !== checked.repositoryId || row.review.installationId !== checked.installationId || row.review.repository !== checked.repository ||
      row.review.kind !== checked.kind || row.review.ref !== checked.ref || row.review.pullRequestNumber !== checked.pullRequestNumber) return reject('The GitHub launch source changed. Review the URL again.');
    checkOpen();
    const claimed = await db.query(`UPDATE ephemeral_github_launch_requests SET status='creating'
      WHERE user_id=$1 AND request_id=$2 AND status='reserved' RETURNING target_id`, params);
    if (!claimed.rows.length && row.status !== 'creating') { const target = await existing(row); if (target) return target;
      throw new GitHubLaunchError(409, 'Session creation is being recovered. Retry this same request ID.'); }
    try {
      return await manager.create({ userId, repository: checked.repository, repositoryId: checked.repositoryId,
        installationId: checked.installationId, baseBranch: checked.baseBranch, ...(environment ? { environment } : {}), launchSource: copyGitHubLaunchSource(row.review) }, { id: row.target_id });
    } catch (error) {
      const recovered = await existing(row); if (recovered) return recovered;
      if (error instanceof SessionNotCreatedError && claimed.rows.length > 0) {
        await db.query(`UPDATE ephemeral_github_launch_requests SET status='reserved' WHERE user_id=$1 AND request_id=$2 AND status='creating'`, params);
        throw new GitHubLaunchError(409, error.message, true);
      }
      throw new GitHubLaunchError(409, 'Session creation could not be confirmed. Retry this same request ID to recover the session.');
    }
  }
  return {
    preview(userId: string, token: string, url: string) { return admitted(userId, () => resolve(parsedUrl(url), token)); },
    launch(userId: string, token: string, url: string, expectedSha: string, expectedBase: string, requestId: string, expectedRepositoryId: number, expectedInstallationId: number, environmentRef?: EnvironmentRef) {
      if (!/^[a-f0-9]{40}$/i.test(expectedSha) || !SESSION_UUID.test(requestId.toLowerCase()) || !validGitHubBranch(expectedBase) || !Number.isSafeInteger(expectedRepositoryId) || expectedRepositoryId < 1 || !Number.isSafeInteger(expectedInstallationId) || expectedInstallationId < 1) throw new GitHubLaunchError(400, 'A reviewed full commit ID and request UUID are required.');
      const canonical = parsedUrl(url), key = JSON.stringify([userId, requestId.toLowerCase()]);
      return admitted(userId, async () => {
        const previous = requests.get(key) ?? Promise.resolve();
        const operation = previous.then(() => start(userId, token, canonical, expectedSha.toLowerCase(), expectedBase, requestId, expectedRepositoryId, expectedInstallationId, environmentRef));
        const settled = operation.then(() => {}, () => {}); requests.set(key, settled);
        try { return await operation; } finally { if (requests.get(key) === settled) requests.delete(key); }
      });
    },
    close() { closed = true; return Promise.allSettled([...operations]).then(() => {}); },
  };
}
