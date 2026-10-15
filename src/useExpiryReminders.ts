import { useLayoutEffect, useRef, useState } from 'react';
import type { Bootstrap, Session } from './api';
import { ExpiryReminderController, type ExpiryReminderState, type ReminderPorts } from './expiry-reminders';

export interface UseExpiryRemindersOptions {
  bootstrap: Bootstrap | null;
  /** Complete accepted /sessions rows, without locally retained selection rows. */
  sessions: readonly Session[];
  confirmedAt: number | null;
  now: number;
  refreshSessions(): Promise<void>;
  onOpenSession(id: string): void;
}
export function createBrowserReminderPorts(openSession: (id: string) => void): ReminderPorts {
  let storage: Storage | undefined;
  try { storage = window.localStorage; } catch { /* Controller explains in-app fallback. */ }
  const supported = typeof Notification !== 'undefined';
  return {
    now: Date.now, storage, secure: window.isSecureContext, supported,
    withLock: navigator.locks ? (name, action) => navigator.locks.request(name, { mode: 'exclusive' }, action) : undefined,
    permission: () => supported ? Notification.permission : 'default',
    requestPermission: () => Notification.requestPermission(),
    notify: (reminder, onClick) => {
      const notification = new Notification(`${reminder.sessionName} expires within ${reminder.thresholdMinutes} minutes`, { body: 'Commit and push intentional changes before expiry. Click to open this machine and save guidance.', tag: reminder.key, requireInteraction: true });
      notification.onclick = onClick;
      return notification;
    },
    origin: window.location.origin,
    focus: () => window.focus(),
    navigate: url => window.history.replaceState(null, '', url),
    openSession,
  };
}
/** Preferences and receipts belong to account+mode, independent of selection and reconnects. */
export function useExpiryReminders(options: UseExpiryRemindersOptions) {
  const latest = useRef(options); latest.current = options;
  const controller = useRef<ExpiryReminderController | null>(null);
  const [lifecycleRevision, setLifecycleRevision] = useState(0);
  const [state, setState] = useState<ExpiryReminderState>({ reminders: [], desktop: { enabled: false, status: 'default', message: 'In-app reminders remain available.' } });
  const accountScope = options.bootstrap?.user ? `${options.bootstrap.mode}:${options.bootstrap.user.id}` : '';
  useLayoutEffect(() => {
    const current = new ExpiryReminderController(createBrowserReminderPorts(id => latest.current.onOpenSession(id)), setState);
    controller.current = current;
    current.update(latest.current); void current.tick();
    let waking = false;
    const wake = () => {
      if (document.visibilityState === 'hidden' || waking) return;
      // Block before refreshing: the old background snapshot must never dispatch.
      current.pauseDesktopUntilSnapshot(); waking = true;
      void latest.current.refreshSessions().catch(() => { /* Remains paused until an accepted snapshot. */ }).finally(() => { waking = false; });
    };
    const storageChanged = (event: StorageEvent) => { if (event.key?.startsWith('ephemeral:expiry:opt-in:')) current.storageChanged(); };
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('storage', storageChanged);
    return () => {
      current.dispose(); if (controller.current === current) controller.current = null;
      window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake); window.removeEventListener('storage', storageChanged);
    };
  }, [accountScope, lifecycleRevision]);
  useLayoutEffect(() => {
    controller.current?.update(options); void controller.current?.tick();
  }, [options.bootstrap, options.sessions, options.confirmedAt, options.now]);
  return {
    ...state,
    enableDesktop: () => controller.current?.enableDesktop() ?? Promise.resolve(),
    disableDesktop: () => controller.current?.disableDesktop(),
    dismiss: (key: string) => controller.current?.dismiss(key),
    openSession: (id: string) => latest.current.onOpenSession(id),
    dispose: () => {
      controller.current?.dispose();
      controller.current = null;
      // A lifecycle revision also revives the same account after a failed logout,
      // even if React batches the temporary anonymous scope out of the render.
      setLifecycleRevision(value => value + 1);
      setState(previous => ({ ...previous, reminders: [], desktop: { ...previous.desktop, enabled: false } }));
    },
  };
}
