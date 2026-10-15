import type { Session } from './api';
import { REMINDER_SNAPSHOT_MAX_AGE_MS } from './expiry-reminders';

export function sessionDeadline(session: Pick<Session, 'expiresAt' | 'maxExpiresAt'>): number | null {
  const deadline = Math.min(Date.parse(session.expiresAt), Date.parse(session.maxExpiresAt));
  return Number.isFinite(deadline) ? deadline : null;
}
export function remainingSessionSeconds(session: Pick<Session, 'expiresAt' | 'maxExpiresAt'>, now: number): number | null {
  const deadline = sessionDeadline(session);
  return deadline === null ? null : Math.max(0, (deadline - now) / 1000);
}
export function workspaceSnapshotFresh(confirmedAt: number | null, now: number): boolean {
  return confirmedAt !== null && now >= confirmedAt && now - confirmedAt <= REMINDER_SNAPSHOT_MAX_AGE_MS;
}
/** Keep observed lifecycle states, including a running machine past its deadline. */
export function activeOwnedSessions(sessions: readonly Session[], ownerId: string | undefined): Session[] {
  if (!ownerId) return [];
  return sessions.filter(session => session.userId === ownerId && ['running', 'provisioning', 'cleanup_pending'].includes(session.state));
}
/** Native dialog restoration must never send focus to hidden shells or removed openers. */
export function canRestoreFocus(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected || element.matches(':disabled') || element.closest('[hidden], [inert], dialog:not([open])')) return false;
  const collapsed = element.closest('details:not([open])');
  if (collapsed && !collapsed.querySelector('summary')?.contains(element)) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return style?.display !== 'none' && style?.visibility !== 'hidden' && element.getClientRects().length > 0;
}
export function focusWorkspaceTarget(id: string, root: Pick<Document, 'getElementById'> & Partial<Pick<Document, 'querySelector'>> = document): boolean {
  if (root.querySelector?.('dialog[open]')) return false;
  const element = root.getElementById(id);
  if (!canRestoreFocus(element)) return false;
  element.focus({ preventScroll: true });
  // A jump should expose the panel below its tab, including in a short viewport.
  element.scrollIntoView?.({ block: 'start', inline: 'nearest', behavior: 'instant' });
  return true;
}

/** Explicit user navigation owns focus; background snapshots do not create intents. */
export class WorkspaceNavigationIntent {
  private revision = 0;
  invalidate(): void { this.revision += 1; }
  capture(): number { return this.revision; }
  current(revision: number): boolean { return this.revision === revision; }
}

/** Native close restoration may be queued, but must not override subsequent input or focus. */
export function deferWorkspaceFocusRestore(opener: HTMLElement | null, root: Document = document, schedule: typeof requestAnimationFrame = requestAnimationFrame): void {
  const active = root.activeElement;
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  root.addEventListener('pointerdown', interrupt, true);
  root.addEventListener('keydown', interrupt, true);
  root.addEventListener('focusin', interrupt, true);
  schedule(() => {
    root.removeEventListener('pointerdown', interrupt, true);
    root.removeEventListener('keydown', interrupt, true);
    root.removeEventListener('focusin', interrupt, true);
    if (!interrupted && root.activeElement === active) restoreWorkspaceFocus(opener, root);
  });
}
export function restoreWorkspaceFocus(opener: HTMLElement | null, root: Pick<Document, 'getElementById'> & Partial<Pick<Document, 'querySelector'>> = document): void {
  // A newly opened dialog takes precedence over a queued previous restoration.
  if (root.querySelector?.('dialog[open]')) return;
  // Only callers capture the dialog opener; never search for a terminal input.
  if (canRestoreFocus(opener)) { opener.focus({ preventScroll: true }); return; }
  if (!focusWorkspaceTarget('machine-detail-heading', root)) focusWorkspaceTarget('workspace-main', root);
}
