import type { Bootstrap, Session } from './api';
import { sessionName } from './session-history';

export const REMINDER_SNAPSHOT_MAX_AGE_MS = 15_000;
export const REMINDER_PERMISSION_TIMEOUT_MS = 60_000;
class PermissionRequestTimeout extends Error {}
export type ReminderThreshold = 10 | 2;
export interface ExpiryReminder {
  key: string;
  sessionId: string;
  sessionName: string;
  repository: string;
  deadline: number;
  thresholdMinutes: ReminderThreshold;
  remainingMs: number;
}
export type ReminderSession = Pick<Session, 'id' | 'userId' | 'state' | 'expiresAt' | 'maxExpiresAt' | 'label' | 'repository' | 'endedAt'>;
export type ReminderAccount = Pick<Bootstrap, 'mode' | 'user'> | null;
export interface ReminderInput {
  bootstrap: ReminderAccount;
  sessions: readonly ReminderSession[];
  /** Completion time of an accepted, complete /sessions response; never a local mutation. */
  confirmedAt: number | null;
}
export type DesktopReminderStatus = 'permission-timeout' | 'requesting' | 'default' | 'granted' | 'denied' | 'unsupported' | 'insecure' | 'preview' | 'storage-failure' | 'coordination-unavailable' | 'error';
export interface DesktopReminderState { enabled: boolean; status: DesktopReminderStatus; message: string }
export interface ExpiryReminderState { reminders: ExpiryReminder[]; desktop: DesktopReminderState }
export interface ReminderStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface ReminderPorts {
  now(): number;
  storage?: ReminderStorage;
  /** Must hold an exclusive origin-wide lock for the whole callback. */
  withLock?: (name: string, action: () => void) => Promise<void>;
  supported: boolean;
  secure: boolean;
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  notify(reminder: ExpiryReminder, onClick: () => void): { close(): void };
  origin: string;
  focus(): void;
  navigate(url: string): void;
  openSession(id: string): void;
}
function scope(account: ReminderAccount): string {
  return account?.user ? `${account.mode}:${encodeURIComponent(account.user.id)}` : '';
}
/** A changed absolute deadline starts a new reminder cycle, including after extension.
 * On a late load only the most urgent crossed threshold is eligible. Native receipts
 * include account, mode, machine, deadline and threshold, and survive reloads.
 */
export function selectExpiryReminders(input: ReminderInput, now: number): ExpiryReminder[] {
  const owner = input.bootstrap?.user?.id;
  if (!owner) return [];
  return input.sessions.flatMap(session => {
    if (session.userId !== owner || session.state !== 'running' || session.endedAt !== null) return [];
    const deadline = Math.min(Date.parse(session.expiresAt), Date.parse(session.maxExpiresAt));
    const remainingMs = deadline - now;
    if (!Number.isFinite(deadline) || remainingMs <= 0 || remainingMs > 600_000) return [];
    const thresholdMinutes: ReminderThreshold = remainingMs <= 120_000 ? 2 : 10;
    return [{ key: `${scope(input.bootstrap)}:${encodeURIComponent(session.id)}:${deadline}:${thresholdMinutes}`, sessionId: session.id, sessionName: sessionName(session), repository: session.repository, deadline, thresholdMinutes, remainingMs }];
  }).sort((a, b) => a.deadline - b.deadline || a.sessionId.localeCompare(b.sessionId));
}
/** Build a clean same-origin route: inherited tokens, query flags and credentials are discarded. */
export function expiryReminderUrl(origin: string, sessionId: string): string {
  const url = new URL('/', new URL(origin).origin);
  url.searchParams.set('session', sessionId);
  url.searchParams.set('tab', 'terminal');
  url.searchParams.set('view', 'machines');
  url.hash = 'save-guidance';
  return url.href;
}
const messages: Record<DesktopReminderStatus, string> = {
  'permission-timeout': 'Browser permission request timed out. Desktop reminders remain off. Retry or check browser notification settings; in-app reminders remain available.',
  requesting: 'Waiting for browser permission. In-app reminders remain available.',
  default: 'Enable desktop reminders to request browser permission. In-app reminders remain available.',
  granted: 'Desktop reminders are best effort while this app is open. Browser suspension can delay or prevent alerts.',
  denied: 'Browser permission is denied. Change it in browser settings; in-app reminders remain available.',
  unsupported: 'This browser does not support desktop notifications. In-app reminders remain available.',
  insecure: 'Desktop notifications require a secure connection. In-app reminders remain available.',
  preview: 'Preview shows simulated in-app reminders only; it never sends desktop notifications.',
  'storage-failure': 'Browser storage is unavailable. Desktop reminders are off because delivery cannot be coordinated across tabs; in-app reminders remain available.',
  'coordination-unavailable': 'This browser cannot coordinate desktop reminders across tabs. Desktop reminders are off; in-app reminders remain available.',
  error: 'The browser could not show a desktop reminder. In-app reminders remain available.',
};

export class ExpiryReminderController {
  private input: ReminderInput = { bootstrap: null, sessions: [], confirmedAt: null };
  private account = '';
  private generation = 0;
  private disposed = false;
  private enabled = false;
  private permissionRequest = false;
  private fault: DesktopReminderStatus | null = null;
  private dismissed = new Set<string>();
  private pending = new Set<string>();
  private notifications = new Map<string, { close(): void }>();
  private wakeSnapshot: { sessions: readonly ReminderSession[]; confirmedAt: number | null } | null = null;
  constructor(private ports: ReminderPorts, private publish: (state: ExpiryReminderState) => void) {}
  private preferenceKey() { return `ephemeral:expiry:opt-in:${this.account}`; }
  private receiptKey() { return `ephemeral:expiry:receipts:${this.account}`; }
  private receipts(): Record<string, number> {
    const raw = this.read(this.receiptKey());
    if (raw === null) return {};
    if (raw.length > 600_000) { this.fault = 'storage-failure'; throw new Error('Invalid receipt storage'); }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch (error) { this.fault = 'storage-failure'; throw error; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { this.fault = 'storage-failure'; throw new Error('Invalid receipt storage'); }
    const entries = Object.entries(parsed);
    if (entries.length > 512 || entries.some(([key, deadline]) => key.length > 1024 || typeof deadline !== 'number' || !Number.isFinite(deadline))) { this.fault = 'storage-failure'; throw new Error('Invalid receipt storage'); }
    // Ended deadlines cannot dispatch. Keep only unexpired cycles to bound retention.
    return Object.fromEntries(entries.filter(([, deadline]) => (deadline as number) > this.ports.now())) as Record<string, number>;
  }
  private read(key: string): string | null {
    if (!this.ports.storage) throw new Error('Storage unavailable');
    try { return this.ports.storage.getItem(key); }
    catch (error) { this.fault = 'storage-failure'; throw error; }
  }
  private write(key: string, value: string): void {
    if (!this.ports.storage) throw new Error('Storage unavailable');
    try {
      this.ports.storage.setItem(key, value);
      if (this.ports.storage.getItem(key) !== value) throw new Error('Storage write was not retained');
    } catch (error) { this.fault = 'storage-failure'; throw error; }
  }
  private status(): DesktopReminderStatus {
    if (this.input.bootstrap?.mode === 'preview') return 'preview';
    if (!this.ports.supported) return 'unsupported';
    if (!this.ports.secure) return 'insecure';
    if (this.fault) return this.fault;
    if (this.permissionRequest) return 'requesting';
    if (!this.ports.storage) return 'storage-failure';
    if (!this.ports.withLock) return 'coordination-unavailable';
    return this.ports.permission();
  }
  private emit(): void {
    if (this.disposed) return;
    const status = this.status();
    this.publish({ reminders: selectExpiryReminders(this.input, this.ports.now()).filter(reminder => !this.dismissed.has(reminder.key)), desktop: { enabled: this.enabled, status, message: messages[status] } });
  }
  private closeAll(): void {
    for (const notification of this.notifications.values()) { try { notification.close(); } catch { /* Best effort browser resource cleanup. */ } }
    this.notifications.clear();
  }
  update(input: ReminderInput): void {
    if (this.disposed) return;
    const account = scope(input.bootstrap);
    if (account !== this.account) {
      this.generation++; this.closeAll(); this.enabled = false; this.permissionRequest = false; this.fault = null; this.dismissed.clear(); this.wakeSnapshot = null;
      this.account = account;
      if (account) {
        try { this.enabled = this.read(this.preferenceKey()) === 'true' && this.ports.permission() === 'granted'; }
        catch { this.fault = 'storage-failure'; }
      }
    }
    if (this.wakeSnapshot && (input.sessions !== this.wakeSnapshot.sessions || input.confirmedAt !== this.wakeSnapshot.confirmedAt) && input.confirmedAt !== null) this.wakeSnapshot = null;
    this.input = input;
    this.reconcile(); this.emit();
  }
  private snapshotFresh(): boolean {
    const age = this.input.confirmedAt === null ? Infinity : this.ports.now() - this.input.confirmedAt;
    return age >= 0 && age <= REMINDER_SNAPSHOT_MAX_AGE_MS;
  }
  private fresh(): boolean { return this.snapshotFresh() && !this.wakeSnapshot; }
  private eligible(key: string, generation: number): ExpiryReminder | undefined {
    if (this.disposed || generation !== this.generation || !this.account || !this.enabled || this.input.bootstrap?.mode !== 'live' || this.status() !== 'granted' || !this.fresh()) return;
    try {
      if (this.read(this.preferenceKey()) !== 'true') return;
    } catch { this.fault = 'storage-failure'; this.closeAll(); this.emit(); return; }
    return selectExpiryReminders(this.input, this.ports.now()).find(reminder => reminder.key === key);
  }
  private reconcile(): void {
    const keys = new Set(selectExpiryReminders(this.input, this.ports.now()).map(reminder => reminder.key));
    for (const key of this.dismissed) if (!keys.has(key)) this.dismissed.delete(key);
    if (this.enabled) {
      try { if (this.read(this.preferenceKey()) !== 'true') { this.generation++; this.enabled = false; this.permissionRequest = false; } }
      catch { this.enabled = false; }
    }
    // Waking blocks new dispatch, but must not remove a current alert before a
    // human can click it. Retain it until the snapshot actually becomes stale.
    if (!this.snapshotFresh() || this.status() !== 'granted') { this.closeAll(); return; }
    for (const [key, notification] of this.notifications) {
      if (!keys.has(key) || !this.enabled) { try { notification.close(); } catch { /* Best effort. */ } this.notifications.delete(key); }
    }
  }
  /** Tick is called on accepted snapshots and the clock; it never requests permission. */
  async tick(): Promise<void> {
    if (this.disposed) return;
    this.reconcile(); this.emit();
    const generation = this.generation;
    const candidates = selectExpiryReminders(this.input, this.ports.now());
    await Promise.all(candidates.map(async candidate => {
      if (!this.eligible(candidate.key, generation) || this.pending.has(candidate.key)) return;
      this.pending.add(candidate.key);
      try {
        await this.ports.withLock!(`ephemeral:expiry:${this.account}`, () => {
          const current = this.eligible(candidate.key, generation);
          if (!current) return;
          const receipts = this.receipts();
          if (Object.hasOwn(receipts, current.key)) return;
          // Fail closed on an unexpectedly large active set; never evict an active receipt.
          const consumedKey = current.key.replace(/:2$/, ':10');
          const additionalReceipts = current.thresholdMinutes === 2 && !Object.hasOwn(receipts, consumedKey) ? 2 : 1;
          if (Object.keys(receipts).length + additionalReceipts > 512) { this.fault = 'storage-failure'; throw new Error('Receipt capacity exceeded'); }
          // Persist before constructing: a failed browser alert is not retried, avoiding
          // duplicates after crashes or an ambiguous native notification result.
          receipts[current.key] = current.deadline;
          // A critical late load consumes the earlier threshold for this same deadline.
          if (current.thresholdMinutes === 2) receipts[consumedKey] = current.deadline;
          this.write(this.receiptKey(), JSON.stringify(receipts));
          if (!this.eligible(current.key, generation)) return;
          let notification: { close(): void };
          try { notification = this.ports.notify(current, () => {
            if (this.disposed || generation !== this.generation) return;
            const valid = selectExpiryReminders(this.input, this.ports.now()).some(reminder => reminder.key === current.key);
            if (!valid) return;
            try { notification.close(); } catch { /* Best effort native cleanup. */ } this.notifications.delete(current.key);
            this.ports.focus(); this.ports.navigate(expiryReminderUrl(this.ports.origin, current.sessionId)); this.ports.openSession(current.sessionId);
          }); } catch (error) { this.fault = 'error'; throw error; }
          this.notifications.set(current.key, notification);
        });
      } catch {
        if (!this.disposed && generation === this.generation) {
          // Probe storage independently so lock and native failures have honest states.
          try { this.read(this.preferenceKey()); this.fault ??= 'coordination-unavailable'; }
          catch { this.fault = 'storage-failure'; }
          this.enabled = false; this.closeAll(); this.emit();
        }
      } finally { this.pending.delete(candidate.key); }
    }));
  }
  /** ONLY call from a direct user button gesture. The permission call occurs before any await. */
  async enableDesktop(): Promise<void> {
    if (this.disposed || this.permissionRequest || !this.account || this.input.bootstrap?.mode !== 'live') return;
    const generation = this.generation;
    this.fault = null;
    const status = this.status();
    if (['unsupported', 'insecure', 'storage-failure', 'coordination-unavailable'].includes(status)) { this.emit(); return; }
    const preferenceKey = this.preferenceKey();
    // A prospective choice is not opt-in: reloads and other tabs may only deliver
    // after this exact request confirms permission and commits 'true'.
    const pendingPreference = `pending:${crypto.randomUUID()}`;
    let permissionTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.enabled = false;
      this.write(preferenceKey, pendingPreference);
      this.permissionRequest = true; this.emit();
      let permission = this.ports.permission();
      if (permission === 'default') {
        // Start the native request during the click gesture, before any await.
        const requested = this.ports.requestPermission();
        const timedOut = new Promise<never>((_resolve, reject) => {
          permissionTimer = setTimeout(() => reject(new PermissionRequestTimeout('Browser permission request timed out')), REMINDER_PERMISSION_TIMEOUT_MS);
        });
        permission = await Promise.race([requested, timedOut]);
      }
      if (this.disposed || generation !== this.generation) return;
      this.permissionRequest = false;
      // Another tab may have disabled alerts while browser permission was pending.
      if (this.read(preferenceKey) !== pendingPreference) { this.enabled = false; this.emit(); return; }
      this.enabled = permission === 'granted';
      this.write(preferenceKey, this.enabled ? 'true' : 'false');
      this.emit(); await this.tick();
    } catch (error) {
      // Cleanup only this request's marker. A rejected older permission request
      // cannot erase a newer tab's pending choice, grant or explicit disable.
      try {
        if (this.ports.storage?.getItem(preferenceKey) === pendingPreference) this.ports.storage.setItem(preferenceKey, 'false');
      } catch { if (!this.disposed && generation === this.generation) this.fault = 'storage-failure'; }
      if (this.disposed || generation !== this.generation) return;
      this.enabled = false; this.permissionRequest = false; this.fault ??= error instanceof PermissionRequestTimeout ? 'permission-timeout' : 'error';
      this.emit();
    } finally { clearTimeout(permissionTimer); }
  }
  disableDesktop(): void {
    if (this.disposed) return;
    this.generation++; this.enabled = false; this.permissionRequest = false; this.closeAll();
    if (this.account) { try { this.write(this.preferenceKey(), 'false'); } catch { this.fault = 'storage-failure'; } }
    this.emit();
  }
  /** Refresh preferences when another tab explicitly enables/disables this account. */
  storageChanged(): void {
    if (this.disposed || !this.account) return;
    try { this.enabled = this.read(this.preferenceKey()) === 'true' && this.ports.permission() === 'granted'; }
    catch { this.enabled = false; this.fault = 'storage-failure'; }
    if (!this.enabled) { this.generation++; this.permissionRequest = false; this.closeAll(); }
    this.emit(); void this.tick();
  }
  pauseDesktopUntilSnapshot(): void {
    if (!this.disposed) this.wakeSnapshot = { sessions: this.input.sessions, confirmedAt: this.input.confirmedAt };
  }
  dismiss(key: string): void { this.dismissed.add(key); this.emit(); }
  dispose(): void { this.disposed = true; this.generation++; this.closeAll(); }
}
