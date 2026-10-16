import { authorizeGitHubLaunch, resolveGitHubLaunch } from './launch.js';
import { parseGitHubLaunchUrl } from '../../shared/github-launch.js';
import type { Database, GatewayCredentials, Session } from '../contracts.js';
import { GitHubAPI, type Repo } from './api.js';
import { GitGateway, type GateOptions } from './gateway.js';
import { CredentialStore } from './store.js';
import { encryptionKey, GitHubError } from './security.js';
import type { PullRequestRepository } from './pull-requests.js';
import type { PublishedChangesQuery } from './published-changes.js';
import { beforeDeadline, SHUTDOWN_TIMEOUT_MS } from '../shutdown.js';
export type { Repo } from './api.js';
export interface GitHubOptions extends GateOptions {
  db: Database; appId: string; privateKey: string; encryptionKey: string; appSlug: string; publicUrl: string;
  pullRequests: PullRequestRepository;
  registerClose?(close: () => Promise<void>): void;
}
export async function createGitHubServices(options: GitHubOptions) {
  const api = new GitHubAPI(options.appId, options.privateKey.replaceAll('\\n', '\n'), options.appSlug);
  const store = new CredentialStore(options.db, encryptionKey(options.encryptionKey), api);
  await store.migrate();
  const gateway = new GitGateway(store, options);
  options.registerClose?.(() => gateway.close());
  try { await gateway.start(); await store.retryRotated(); }
  catch (error) {
    if (!options.registerClose) await beforeDeadline(gateway.close(), SHUTDOWN_TIMEOUT_MS);
    throw error;
  }
  const credentials: GatewayCredentials = {
    issue: session => gateway.serialize(session.id, () => store.issue(session)),
    disable: id => gateway.disable(id),
    revokeGitHub: id => gateway.serialize(id, () => store.revoke(id)),
  };
  return {
    credentials,
    githubLaunchPreview: (url: string, token: string) => resolveGitHubLaunch(api, url, token),
    authorizeGitHubLaunch: (url: string, token: string) => authorizeGitHubLaunch(api, parseGitHubLaunchUrl(url), token),
    router: gateway.router,
    repositories: (userAccessToken: string): Promise<Repo[]> => api.repositories(userAccessToken),
    branches: (userAccessToken: string, installationId: number, repositoryId: number) => api.branches(userAccessToken, installationId, repositoryId),
    authorizeContinuation: (session: Session, userAccessToken: string, signal?: AbortSignal) => api.authorizeContinuation(session, userAccessToken, signal),
    continuationPreview: (session: Session, userAccessToken: string) => api.continuationPreview(session, userAccessToken),
    // Published review uses current user OAuth and never touches sandbox or gateway credentials.
    publishedChanges: (session: Session, userAccessToken: string, query: PublishedChangesQuery, signal?: AbortSignal) => api.publishedChanges(session, userAccessToken, query, signal),
    pullRequestPreview: (session: Session) => gateway.serialize(session.id, async () => {
      const current = await gateway.authorize(session.id, true);
      const token = await store.token(current);
      await gateway.authorize(session.id, true);
      return api.pullRequestPreview(current, token);
    }),
    createPullRequest: (session: Session, title: string, body?: string, expectedHeadSha?: string, expectedBaseSha?: string) => gateway.serialize(session.id, async () => {
      if (!expectedHeadSha || !expectedBaseSha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(expectedHeadSha) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(expectedBaseSha)) throw new GitHubError('Both reviewed head and base commit IDs are required.', 400);
      const current = await gateway.authorize(session.id, true);
      const token = await store.token(current);
      const verify = async () => {
        const preview = await api.pullRequestPreview(current, token);
        if (preview.state !== 'ready' || !preview.headSha || !preview.baseSha) throw new GitHubError(preview.reason ?? 'GitHub could not verify pull request changes', 409);
        if (preview.headSha.toLowerCase() !== expectedHeadSha.toLowerCase() ||
          preview.baseSha.toLowerCase() !== expectedBaseSha.toLowerCase()) {
          throw new GitHubError('The published branch or selected base changed. Refresh the published review before creating a pull request.', 409);
        }
      };
      await verify();
      const existing = await api.existingPullRequest(current, token);
      await gateway.authorize(session.id, true);
      // External pushes can move either ref while the matching-PR lookup is in flight.
      await verify();
      // A stop or deadline can arrive during the final remote verification.
      // Re-read only local authority so another upstream wait cannot stale it.
      if (!existing) await gateway.authorizeLocal(session.id, true);
      const result = existing ?? await api.pullRequest(current, token, title, body);
      await options.pullRequests.save(current.id, result);
      return result;
    }),
    close: () => gateway.close(),
  };
}
