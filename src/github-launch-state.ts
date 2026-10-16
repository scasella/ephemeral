import { isEnvironmentRef, type EnvironmentRef } from '../shared/environments';
import { sameEnvironment } from './environment-selection';
import { copyGitHubLaunchSource, parseGitHubLaunchUrl, type GitHubLaunchReview } from '../shared/github-launch';
import type { Session } from './api';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export interface GitHubLaunchIntent { environment?: EnvironmentRef; accountKey: string; userId: string; requestId: string; createdAt: string; review: GitHubLaunchReview }
export const githubLaunchStorageKey = (accountKey: string) => `ephemeral:github-launch:${accountKey}`;

/** Only syntax is checked locally. Repository access and ref resolution belong to the server. */
export function githubLaunchInputError(input: string): string | null {
  if (!input.trim()) return 'Paste a GitHub repository, branch, full commit, or pull request URL.';
  try { parseGitHubLaunchUrl(input.trim()); return null; }
  catch { return 'Use a canonical HTTPS github.com repository, /tree/branch, /commit/full-40-character-SHA, or /pull/number URL.'; }
}
export function validGitHubLaunchReview(value: unknown): value is GitHubLaunchReview {
  try {
    if (!value || typeof value !== 'object') return false;
    const review = value as GitHubLaunchReview;
    if (typeof review.repository !== 'string' || typeof review.checkedAt !== 'string') return false;
    const source = copyGitHubLaunchSource(review), parsed = parseGitHubLaunchUrl(review.url);
    return source.url === review.url && parsed.repository.toLowerCase() === review.repository.toLowerCase()
      && typeof review.simulated === 'boolean'
      && Number.isSafeInteger(review.repositoryId) && review.repositoryId > 0
      && Number.isSafeInteger(review.installationId) && review.installationId > 0;
  } catch { return false; }
}

export function readGitHubLaunchIntent(raw: string | null, accountKey: string, userId: string, previewMode: boolean): GitHubLaunchIntent | null {
  try {
    const intent = raw ? JSON.parse(raw) as GitHubLaunchIntent : null;
    return intent && intent.accountKey === accountKey && intent.userId === userId && typeof intent.requestId === 'string' && uuid.test(intent.requestId)
      && typeof intent.createdAt === 'string' && Number.isFinite(Date.parse(intent.createdAt))
      && (intent.environment === undefined || isEnvironmentRef(intent.environment))
      && validGitHubLaunchReview(intent.review) && intent.review.simulated === previewMode ? intent : null;
  } catch { return null; }
}
export function githubLaunchReviewBlocked(review: GitHubLaunchReview | null, previewMode: boolean, now: number): string | null {
  if (!review) return 'Review the URL before launching.';
  if (!validGitHubLaunchReview(review) || review.simulated !== previewMode) return 'The review could not be verified. Review the URL again.';
  const age = now - Date.parse(review.checkedAt);
  return !Number.isFinite(age) || age < -5000 || age > 60_000 ? 'This review has expired. Review the URL again.' : null;
}

/** Input changes, cancellation, timeout, and disposal permanently fence older responses. */
export class GitHubLaunchReviewLoader {
  private revision = 0;
  private disposed = false;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private request: (url: string, signal: AbortSignal) => Promise<unknown>, private publish: (review: GitHubLaunchReview | null, checking: boolean, error: string) => void) {}
  invalidate() { ++this.revision; this.controller?.abort(); clearTimeout(this.timer); this.controller = null; if (!this.disposed) this.publish(null, false, ''); }
  async review(url: string) {
    if (this.disposed) return;
    this.invalidate();
    const error = githubLaunchInputError(url);
    if (error) { this.publish(null, false, error); return; }
    const revision = this.revision, controller = this.controller = new AbortController();
    this.publish(null, true, '');
    const timeout = new Promise<never>((_, reject) => { this.timer = setTimeout(() => { controller.abort(); reject(new Error('The URL review timed out. Review the URL again.')); }, 45_000); });
    try {
      const value = await Promise.race([this.request(url.trim(), controller.signal), timeout]);
      if (!this.disposed && revision === this.revision) {
        if (!validGitHubLaunchReview(value) || value.url !== parseGitHubLaunchUrl(url.trim()).url) throw new Error('The server returned an invalid URL review. Review the URL again.');
        this.publish(value, false, '');
      }
    } catch (error) { if (!this.disposed && revision === this.revision) this.publish(null, false, (error as Error).message); }
    finally { if (revision === this.revision) { clearTimeout(this.timer); this.controller = null; } }
  }
  dispose() { this.disposed = true; this.invalidate(); }
}
export class GitHubLaunchRequestError extends Error { constructor(message: string, readonly definite: boolean) { super(message); } }
/** A timeout or malformed success can follow an accepted request: retain the saved request ID. */
export async function submitGitHubLaunch(intent: GitHubLaunchIntent): Promise<Session> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new GitHubLaunchRequestError('The launch request timed out.', false)); }, 45_000); });
  const request = async () => {
    const { review } = intent;
    const response = await fetch('/api/github-launch', { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1' }, body: JSON.stringify({ url: review.url, expectedCommitSha: review.commitSha, expectedBaseBranch: review.baseBranch, expectedRepositoryId: review.repositoryId, expectedInstallationId: review.installationId, requestId: intent.requestId, ...(intent.environment ? { environment: intent.environment } : {}) }) });
    const data = await response.json();
    if (!response.ok) throw new GitHubLaunchRequestError(data.error || `Request failed (${response.status})`, response.status >= 400 && data.code === 'GITHUB_LAUNCH_REJECTED' && data.outcome === 'not_created');
    let sourceValid = false;
    try { sourceValid = copyGitHubLaunchSource(data.launchSource).baseBranch === review.baseBranch; } catch { /* Preserve an uncertain result. */ }
    if ((intent.environment && !sameEnvironment(intent.environment, data.environment)) || !sourceValid || typeof data.id !== 'string' || !data.id || data.userId !== intent.userId || data.repository !== review.repository || data.repositoryId !== review.repositoryId || data.installationId !== review.installationId || data.baseBranch !== review.baseBranch || data.launchSource?.commitSha?.toLowerCase() !== review.commitSha.toLowerCase() || data.launchSource?.url !== review.url || data.launchSource?.kind !== review.kind || data.launchSource?.ref !== review.ref) throw new GitHubLaunchRequestError('The response could not confirm the launched machine.', false);
    return data as Session;
  };
  try { return await Promise.race([request(), timeout]); }
  catch (error) { if (error instanceof GitHubLaunchRequestError) throw error; throw new GitHubLaunchRequestError((error as Error).message || 'The launch outcome is uncertain.', false); }
  finally { clearTimeout(timer); }
}
