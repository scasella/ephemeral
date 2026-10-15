import type { Session } from './api';
import { sessionName } from './session-history';
import { REMINDER_SNAPSHOT_MAX_AGE_MS, type DesktopReminderState, type ExpiryReminder } from './expiry-reminders';
import './expiry-reminders.css';

/** Run after the destination machine and terminal tab have rendered. */
export function revealSaveGuidance(root: Pick<Document, 'getElementById'> = document): boolean {
  const guidance = root.getElementById('save-guidance');
  if (!guidance || guidance.tagName !== 'DETAILS') return false;
  const workStatus = guidance.closest?.('details#work-status-details');
  if (workStatus) (workStatus as HTMLDetailsElement).open = true;
  (guidance as HTMLDetailsElement).open = true;
  const summary = guidance.querySelector('summary');
  summary?.focus({ preventScroll: true });
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  guidance.scrollIntoView?.({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
  return true;
}

interface ExpiryRemindersProps {
  reminders: readonly ExpiryReminder[];
  sessions: readonly Session[];
  now: number;
  preview: boolean;
  confirmedAt: number | null;
  onOpenSession: (id: string) => void;
}

export function ExpiryReminders({ reminders, sessions, now, preview, confirmedAt, onOpenSession }: ExpiryRemindersProps) {
  const expired = sessions.filter(session => {
    const deadline = Math.min(Date.parse(session.expiresAt), Date.parse(session.maxExpiresAt));
    return session.state === 'running' && session.endedAt === null && Number.isFinite(deadline) && deadline <= now;
  });
  const pending = reminders.filter(reminder => !expired.some(session => session.id === reminder.sessionId));
  if (!pending.length && !expired.length) return null;
  // The live region contains threshold text only; ticking countdowns must not be announced.
  const announcement = [...pending.map(reminder => `${reminder.sessionName}: ${reminder.thresholdMinutes} minutes or less remain. Commit and push the work you want to keep.`), ...expired.map(session => `${sessionName(session)}: lifetime expired. Waiting for the server to confirm shutdown and cleanup.`)].join(' ');
  return <section className="expiry-reminders" aria-label="Machine expiry reminders">
    <p className="expiry-announcement" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
    {pending.map(reminder => <div className={`workspace-expiry-warning ${reminder.thresholdMinutes === 2 ? 'critical' : ''}`} key={reminder.key}>
      <div><strong>{reminder.sessionName}: {reminder.thresholdMinutes} minutes or less remain.</strong><p>{reminder.repository} · Expires at <time dateTime={new Date(reminder.deadline).toISOString()}>{new Date(reminder.deadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>.</p><p>Commit and push the changes you want to keep. Unpushed work will be lost.</p></div>
      <button type="button" className="button subtle small" onClick={() => onOpenSession(reminder.sessionId)}>Review save commands</button>
    </div>)}
    {expired.map(session => <div className="workspace-expiry-warning critical" key={`expired:${session.id}:${session.expiresAt}`}><div><strong>{sessionName(session)}: Lifetime expired.</strong><p>Waiting for the server to confirm shutdown and cleanup. Unpushed work will be lost.</p></div><button type="button" className="button subtle small" onClick={() => onOpenSession(session.id)}>Review save commands</button></div>)}
    {preview && <p className="expiry-reminder-note">Preview reminders are simulated. No operating system notifications are sent.</p>}
    {(confirmedAt === null || now - confirmedAt > REMINDER_SNAPSHOT_MAX_AGE_MS) && <p className="expiry-reminder-note">Machine status could not be confirmed recently. These reminders use the last known deadline. Background checks may be delayed.</p>}
  </section>;
}

export function ExpiryNotificationSettings({ desktop, preview, onEnable, onDisable }: { desktop: DesktopReminderState; preview: boolean; onEnable: () => Promise<void>; onDisable: () => void }) {
  const unavailable = preview || ['unsupported', 'insecure', 'denied', 'preview', 'storage-failure', 'coordination-unavailable', 'requesting'].includes(desktop.status);
  return <section className="integration-card expiry-notification-settings" aria-labelledby="expiry-notification-heading">
    <div className="integration-card-header"><div><h3 id="expiry-notification-heading">Expiry reminders</h3><p>Warnings appear throughout your workspace at 10 minutes and 2 minutes remaining.</p></div></div>
    <p>{preview ? 'Preview reminders are simulated. Operating system notifications are unavailable in preview.' : desktop.message}</p>
    <div className="expiry-settings-actions">{desktop.enabled ? <button type="button" className="button subtle small" onClick={onDisable}>Disable desktop notifications</button> : <button type="button" className="button subtle small" disabled={unavailable} onClick={() => { void onEnable(); }}>{desktop.status === 'requesting' ? 'Waiting for browser permission…' : 'Enable desktop notifications'}</button>}<span>{desktop.enabled ? 'Enabled for this account and mode' : 'Desktop notifications off'}</span></div>
    <p className="expiry-reminder-note">Reminders are best effort while this workspace is open. Browsers can delay background checks. Keep track of the deadline and save early. Reminders never commit, push, or extend a machine.</p>
  </section>;
}
