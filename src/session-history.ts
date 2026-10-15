import { api, type Bootstrap, type Session } from './api';

export function workspaceIdentity(bootstrap: Bootstrap | null): string {
  return bootstrap ? `${bootstrap.mode}:${bootstrap.user?.id ?? 'anonymous'}` : '';
}
export function ownedSessionHistory(sessions: Session[], bootstrap: Bootstrap): Session[] {
  return bootstrap.user ? sessions.filter(session => session.userId === bootstrap.user?.id) : [];
}

export function generatedSessionName(id: string): string {
  return `machine-${id.replace(/[^a-zA-Z0-9]/g, '').slice(-6).toLowerCase()}`;
}
export function sessionName(session: Pick<Session, 'id' | 'label'>): string {
  return session.label || generatedSessionName(session.id);
}
export interface HistoryFilters { query: string; state: string; repository: string }
export const emptyHistoryFilters: HistoryFilters = { query: '', state: '', repository: '' };
export function filterSessionHistory(sessions: readonly Session[], filters: HistoryFilters): Session[] {
  const terms = filters.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return sessions.filter(session => {
    if (filters.state && session.state !== filters.state) return false;
    if (filters.repository && session.repository !== filters.repository) return false;
    const searchable = [sessionName(session), session.repository, session.id, session.baseBranch, session.branch].join(' ').toLocaleLowerCase();
    return terms.every(term => searchable.includes(term));
  });
}
/** Keyboard navigation moves focus only; selection still requires Enter or Space. */
export function historyFocusIndex(key: string, current: number, count: number): number | null {
  if (!count) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowDown') return Math.min(count - 1, current + 1);
  if (key === 'ArrowUp') return Math.max(0, current - 1);
  return null;
}
export function historySearchKey(key: string): 'clear' | 'focus-results' | null {
  return key === 'Escape' ? 'clear' : key === 'ArrowDown' ? 'focus-results' : null;
}
export function reconcileLabelDraft(draft: string, editing: boolean, serverLabel: string): string {
  return editing ? draft : serverLabel;
}

export function reconcileSessionRefresh(incoming: Session[], previous: Session[], startedId: string | null, currentId: string | null): Session[] {
  if (currentId && currentId !== startedId && !incoming.some(session => session.id === currentId)) {
    const justSelected = previous.find(session => session.id === currentId);
    if (justSelected) return [justSelected, ...incoming];
  }
  return incoming;
}

interface SnapshotRevision { request: number; mutation: number }
/** Accepts the latest completed snapshot and invalidates polls begun before a mutation. */
export class SessionSnapshotGate {
  private request = 0;
  private mutation = 0;
  private appliedRequest = 0;
  begin(): SnapshotRevision { return { request: ++this.request, mutation: this.mutation }; }
  invalidate(): void { this.mutation++; }
  accepts(revision: SnapshotRevision): boolean { return revision.mutation === this.mutation && revision.request >= this.appliedRequest; }
  apply(revision: SnapshotRevision): boolean {
    if (!this.accepts(revision)) return false;
    this.appliedRequest = revision.request;
    return true;
  }
}

export function mergeSessionLabel(current: Session, updated: Session): Session {
  if (current.id !== updated.id) return current;
  const merged = { ...current };
  if (updated.label) merged.label = updated.label;
  else delete merged.label;
  return merged;
}

export async function saveSessionLabel(id: string, label: string, signal?: AbortSignal): Promise<Session> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('Saving timed out. Check the saved name before retrying.')); }, 20_000);
  });
  try { return await Promise.race([api<Session>(`/sessions/${encodeURIComponent(id)}/label`, { label }, { signal: controller.signal }), timeout]); }
  catch (error) { if (timedOut) throw new Error('Saving timed out. Check the saved name before retrying.'); throw error; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
