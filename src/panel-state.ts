import { workCheckTimeUnconfirmed, workNeedsAcknowledgement, type WorkStatus } from './workflow';

export type WorkspacePanel = 'history' | 'work-status';

/** Only disclosure preferences live here; no workspace contents enter storage. */
export class PanelStateMemory {
  private readonly states = new Map<string, boolean>();
  constructor(private readonly limit = 200) {}
  expanded(panel: WorkspacePanel, scope: string, sessionId: string | null): boolean {
    return this.states.get(this.key(panel, scope, sessionId)) ?? (panel === 'history' && sessionId === null);
  }
  remember(panel: WorkspacePanel, scope: string, sessionId: string | null, expanded: boolean): void {
    const key = this.key(panel, scope, sessionId);
    this.states.delete(key);
    this.states.set(key, expanded);
    if (this.states.size > this.limit) this.states.delete(this.states.keys().next().value!);
  }
  private key(panel: WorkspacePanel, scope: string, sessionId: string | null): string {
    return JSON.stringify([panel, scope, sessionId]);
  }
}

export const workspacePanelMemory = new PanelStateMemory();

/** The collapsed view must carry the same uncertainty as the full inspection. */
export function compactWorkStatus(status: WorkStatus | null, loading: boolean, now: number): string {
  if (!status) return loading ? 'Checking workspace and remote branch…' : 'Work status unavailable · Review before teardown';
  const counts = `${status.dirtyFiles ?? 'Unknown'} changed · ${status.untrackedFiles ?? 'Unknown'} untracked · ${status.aheadCommits ?? 'Unknown'} unpushed`;
  const warnings: string[] = [];
  if (loading) warnings.push('Refreshing work status…');
  if (status.state !== 'known') warnings.push(`Work status ${status.state}`);
  if (workCheckTimeUnconfirmed(status, now)) warnings.push('Check time unconfirmed');
  else if (now - Date.parse(status.checkedAt) > 60_000) warnings.push('Check is stale');
  if (status.branchMatches === false) warnings.push('Branch differs');
  else if (status.branchMatches !== true) warnings.push('Branch unconfirmed');
  if (status.remoteExists === false) warnings.push('Remote branch missing');
  else if (status.remoteExists !== true || !status.remoteSha || !status.headSha) warnings.push('Remote commit unconfirmed');
  if (!workNeedsAcknowledgement(status, now)) return loading ? 'Refreshing work status… · Last check: no unsaved work detected' : 'No unsaved work detected on assigned branch';
  return [...warnings, counts, 'Review before teardown'].join(' · ');
}
