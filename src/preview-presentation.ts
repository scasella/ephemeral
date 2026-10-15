import type { Session } from './api';
import { sessionDeadline } from './workspace-navigation';

export interface PreviewUnavailablePresentation { title: string; reason: string; guidance: string; recovery: boolean }

/** Presentation only: access eligibility is still enforced by the preview client. */
export function previewUnavailablePresentation(session: Pick<Session, 'state' | 'expiresAt' | 'maxExpiresAt'>, simulation: boolean, now: number): PreviewUnavailablePresentation | null {
  const lifecycle = previewLifecyclePresentation(session, now);
  if (lifecycle) return simulation ? { ...lifecycle, guidance: `${lifecycle.guidance} Preview simulation: published evidence and continuation here are simulated.` } : lifecycle;
  if (simulation) return { title: 'Preview simulation', reason: 'Private application access is unavailable in this local simulation.', guidance: 'Use a running live machine to start a server and open its private viewer.', recovery: false };
  return null;
}

function previewLifecyclePresentation(session: Pick<Session, 'state' | 'expiresAt' | 'maxExpiresAt'>, now: number): PreviewUnavailablePresentation | null {
  if (session.state === 'provisioning') return { title: 'Machine preparation in progress', reason: 'Private application access becomes available when this machine is running.', guidance: 'Wait for preparation to finish, then return to Preview to start your server.', recovery: false };
  if (session.state === 'cleanup_pending') return { title: 'Machine cleanup is pending', reason: 'Private application access is unavailable while this machine is being cleaned up.', guidance: 'Review published work for recovery evidence. Continuation still requires the existing cleanup and published-source checks.', recovery: true };
  if (session.state === 'failed') return { title: 'This machine failed', reason: 'Private application access is unavailable for this machine.', guidance: 'Review published work, then review continuation from a verified published source. Former local application processes cannot be inspected here.', recovery: true };
  if (session.state === 'ended') return { title: 'This machine has ended', reason: 'Its private application viewer is no longer available.', guidance: 'Review published work, then review continuation from a verified published source. A new machine needs its own application server and preview access.', recovery: true };
  const deadline = sessionDeadline(session);
  if (deadline === null) return { title: 'Machine deadline unconfirmed', reason: 'Private application access is unavailable because this machine’s lifetime could not be confirmed.', guidance: 'Wait for an updated machine status with a confirmed deadline before starting or opening a private preview.', recovery: false };
  if (deadline <= now) return { title: 'This machine’s lifetime has expired', reason: 'Private application access is unavailable. Shutdown and cleanup may still be awaiting confirmation.', guidance: 'Review published work for recovery evidence. Continuation requires confirmed machine shutdown and the existing cleanup checks.', recovery: true };
  return null;
}
