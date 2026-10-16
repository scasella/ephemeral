import { copyGitHubLaunchSource } from '../../shared/github-launch.js';
import type { Session } from '../contracts.js';
import { copyContinuation, SESSION_UUID } from '../core/continuation.js';

export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
export const SOURCE_CHANGED_EXIT = 42;

/** Clone through the new capability; compare the fetched ref before checkout. */
export function prepareGitCommand(session: Session, gatewayUrl: string, workspace: string): string {
  const launch = session.launchSource ? copyGitHubLaunchSource(session.launchSource) : undefined;
  if (launch && (session.continuation || !SESSION_UUID.test(session.id) || session.branch !== `ephemeral/${session.id}` || launch.baseBranch !== session.baseBranch)) throw new Error('Invalid pinned launch.');
  const continuation = session.continuation ? copyContinuation(session.continuation) : undefined;
  if (continuation && (!SESSION_UUID.test(session.id) || session.id === continuation.sourceSessionId || session.branch !== `ephemeral/${session.id}`)) {
    throw new Error('A fresh assigned session branch is required.');
  }
  const source = continuation?.sourceBranch ?? session.baseBranch;
  const commands = [
    'set -eu',
    `GIT_TERMINAL_PROMPT=0 git clone --single-branch --branch ${shellQuote(source)} -- ${shellQuote(gatewayUrl)} ${shellQuote(workspace)}`,
  ];
  if (launch) {
    commands.push(
      `source_head=$(git -C ${shellQuote(workspace)} rev-parse --verify ${shellQuote(`refs/remotes/origin/${session.baseBranch}^{commit}`)})`,
      `[ "$source_head" = ${shellQuote(launch.commitSha)} ] || exit ${SOURCE_CHANGED_EXIT}`,
      `git -C ${shellQuote(workspace)} checkout -b ${shellQuote(session.branch)} ${shellQuote(launch.commitSha)}`,
    );
  } else if (continuation) {
    commands.push(
      `source_head=$(git -C ${shellQuote(workspace)} rev-parse --verify ${shellQuote(`refs/remotes/origin/${source}^{commit}`)})`,
      `[ "$source_head" = ${shellQuote(continuation.commitSha)} ] || exit ${SOURCE_CHANGED_EXIT}`,
      // Refresh after clone as well: the ref can move after advertisement while
      // Git still finishes downloading the originally advertised object.
      `source_remote=$(GIT_TERMINAL_PROMPT=0 git -C ${shellQuote(workspace)} ls-remote --exit-code origin ${shellQuote(`refs/heads/${source}`)})`,
      `[ "$source_remote" = "$(printf '%s\\t%s' ${shellQuote(continuation.commitSha)} ${shellQuote(`refs/heads/${source}`)})" ] || exit ${SOURCE_CHANGED_EXIT}`,
      `git -C ${shellQuote(workspace)} checkout -b ${shellQuote(session.branch)} ${shellQuote(continuation.commitSha)}`,
    );
  } else commands.push(`git -C ${shellQuote(workspace)} checkout -b ${shellQuote(session.branch)}`);
  return commands.join('; ');
}
