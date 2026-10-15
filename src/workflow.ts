import type { WorkStatus } from '../server/workspace-status';
export type { WorkStatus } from '../server/workspace-status';
export type { PullRequestPreview, SavedPullRequest } from '../server/github/pull-requests';
export function workCheckTimeUnconfirmed(status: WorkStatus, now: number) {
  const checkedAt = Date.parse(status.checkedAt);
  return !Number.isFinite(checkedAt) || checkedAt > now + 5_000;
}
export function workNeedsAcknowledgement(status: WorkStatus | null, now = Date.now()) {
  return !status || workCheckTimeUnconfirmed(status, now) || now - Date.parse(status.checkedAt) > 60_000 || status.state !== 'known' || status.branchMatches !== true || status.remoteExists !== true ||
    !status.headSha || !status.remoteSha || status.dirtyFiles !== 0 || status.untrackedFiles !== 0 || status.aheadCommits !== 0;
}
export function shellQuote(value: string) { return `'${value.replace(/'/g, `'\\''`)}'`; }
export function saveCommands(branch: string) {
  return `git status --short --branch\ngit diff\ngit branch --show-current\n# Confirm the current branch is ${shellQuote(branch)}.\n# Replace PATH with each file you intend to keep.\ngit add -- PATH\ngit diff --cached\ngit commit -m 'Describe your change'\ngit push origin HEAD:refs/heads/${shellQuote(branch)}`;
}
export const prDescriptionTemplate = `## Objective\n<!-- What problem does this change solve? -->\n\n## Behavior changes\n<!-- Describe the resulting behavior. -->\n\n## Tests and results (developer-reported)\n<!-- List the checks you ran and their results, or state that tests were not run. -->\n\n## Unresolved concerns\n<!-- Note remaining risks or state none known. -->`;
