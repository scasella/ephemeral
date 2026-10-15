import type { Session } from './api';
import type { PublishedViewState } from './published-changes';

export function needsRecoverySummary(session: Session): boolean {
  return ['ended', 'failed', 'cleanup_pending'].includes(session.state);
}

export function computeOutcome(session: Session): { title: string; detail: string; confirmed: boolean } {
  if (session.cleanup.vm === 'confirmed') return { title: 'Compute ended', detail: 'Sandbox destruction is confirmed. The former local workspace cannot be inspected.', confirmed: true };
  return {
    title: session.state === 'failed' ? 'Machine failed · compute cleanup unconfirmed' : 'Compute cleanup unconfirmed',
    detail: 'Local inspection is unavailable in this machine state. Sandbox destruction has not been confirmed; review Access for the independent cleanup results.',
    confirmed: false,
  };
}

export interface PublishedOutcome {
  title: string;
  detail: string;
  checkedAt: string | null;
  age: string | null;
  headSha: string | null;
  confirmed: boolean;
}

export function evidenceAge(checkedAt: string, now: number): string {
  const at = Date.parse(checkedAt);
  if (!Number.isFinite(at) || at > now + 5_000) return 'check time unconfirmed';
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Published reads have their own scope and freshness; a clean local check is never recovery evidence. */
export function publishedOutcome(session: Session, state: PublishedViewState | null | undefined, now: number): PublishedOutcome {
  const unknown = { title: 'Published work not checked', detail: 'Review Published to check the assigned GitHub branch independently of the former local workspace.', checkedAt: null, age: null, headSha: null, confirmed: false };
  if (!state) return unknown;
  const value = state.snapshot ?? state.latest;
  if (!value) return { ...unknown, title: state.loading ? 'Checking published work…' : state.error ? 'Published check unconfirmed' : unknown.title, detail: state.error || unknown.detail };
  if (value.repository !== session.repository || value.headBranch !== session.branch || value.baseBranch !== session.baseBranch) return { ...unknown, title: 'Published evidence does not match this machine', detail: 'Review Published to check this machine’s repository, assigned branch and base.' };
  const checkedAt = Number.isFinite(Date.parse(value.checkedAt)) ? value.checkedAt : null;
  const age = evidenceAge(value.checkedAt, now);
  const timeConfirmed = age !== 'check time unconfirmed';
  const prior = state.loading || state.stale || Boolean(state.error) || !timeConfirmed || now - Date.parse(value.checkedAt) > 60_000;
  if (state.snapshot && prior) return {
    title: state.loading ? 'Rechecking published work · prior evidence' : state.error ? 'Published recheck unconfirmed · prior evidence' : 'Prior published evidence · current work unconfirmed',
    detail: state.loading ? 'Wait for the published check to finish. A prior comparison is a dated observation, not current recovery readiness.' : state.error || 'Refresh Published to confirm the current branches. A prior comparison is a dated observation, not current recovery readiness.',
    checkedAt, age, headSha: value.headSha, confirmed: false,
  };
  if (value.state === 'known' || value.state === 'no_changes') {
    if (!value.headSha || !value.baseSha || !value.mergeBaseSha) return { ...unknown, title: 'Published commits unconfirmed', checkedAt, age };
    return {
      title: value.state === 'no_changes' ? 'No pushed contribution found against the base at this check' : 'Pushed contribution independently checked',
      detail: `Compared the assigned branch with ${session.baseBranch}. ${value.listTruncated ? 'The published file list is partial. ' : ''}This does not confirm that all local work survived or that a continuation can launch.`,
      checkedAt, age, headSha: value.headSha, confirmed: true,
    };
  }
  return {
    title: value.state === 'unpublished' ? 'Assigned remote branch not found at this check' : `Published contribution ${value.state} · current work unconfirmed`,
    detail: value.reason || 'Review Published for the latest check and recovery limits.', checkedAt, age, headSha: null, confirmed: false,
  };
}

export function compactEndedOutcome(session: Session, state: PublishedViewState | null | undefined, now: number): string {
  const published = publishedOutcome(session, state, now);
  const counts = Object.values(session.cleanup).reduce((result, value) => { result[value] = (result[value] ?? 0) + 1; return result; }, {} as Partial<Record<Session['cleanup']['vm'], number>>);
  const cleanup = (['failed', 'pending', 'confirmed', 'not_applicable'] as const).filter(value => counts[value]).map(value => `${counts[value]} ${value.replace('_', ' ')}`).join(', ');
  return `${computeOutcome(session).title} · ${published.title}${published.age ? ` (${published.age})` : ''} · Local work survival unconfirmed · Reported resource cleanup: ${cleanup} · Remote Codex revocation unverified`;
}
