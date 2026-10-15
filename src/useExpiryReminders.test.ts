import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserReminderPorts } from './useExpiryReminders';
import type { ExpiryReminder } from './expiry-reminders';

const reminder: ExpiryReminder = { key: 'live:owner:machine:123:2', sessionId: 'machine', sessionName: 'Work machine', repository: 'private/confidential', deadline: 123, thresholdMinutes: 2, remainingMs: 60_000 };
afterEach(() => vi.unstubAllGlobals());
function browser(overrides: Record<string, unknown> = {}) {
  const storage = { getItem: vi.fn(), setItem: vi.fn() };
  const window = { localStorage: storage, isSecureContext: true, location: { origin: 'https://ephemeral.example' }, focus: vi.fn(), history: { replaceState: vi.fn() }, ...overrides };
  vi.stubGlobal('window', window); vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_name, _options, action) => action()) } });
  return window;
}

describe('expiry reminder browser ports', () => {
  it('creates ports without requesting permission or constructing any notification', () => {
    browser(); const requestPermission = vi.fn(); const ctor = vi.fn(); Object.assign(ctor, { permission: 'default', requestPermission }); vi.stubGlobal('Notification', ctor);
    const ports = createBrowserReminderPorts(vi.fn()); expect(ports.permission()).toBe('default'); expect(ports.secure).toBe(true); expect(ports.supported).toBe(true); expect(ctor).not.toHaveBeenCalled(); expect(requestPermission).not.toHaveBeenCalled();
    ports.requestPermission(); expect(requestPermission).toHaveBeenCalledTimes(1);
  });
  it('sends a minimal body without exposing repository names on OS surfaces and forwards only the callback', () => {
    const window = browser(); let notice!: { onclick: () => void; close: ReturnType<typeof vi.fn> }; const created = vi.fn();
    class FakeNotification {
      static permission = 'granted'; static requestPermission = vi.fn();
      onclick = () => {}; close = vi.fn();
      constructor(title: string, options: NotificationOptions) { created(title, options); notice = this; }
    }
    vi.stubGlobal('Notification', FakeNotification); const open = vi.fn(); const click = vi.fn(); const ports = createBrowserReminderPorts(open);
    ports.notify(reminder, click); expect(created).toHaveBeenCalledWith('Work machine expires within 2 minutes', expect.objectContaining({ tag: reminder.key, requireInteraction: true })); expect(created.mock.calls[0][1].body).not.toContain('private/confidential'); notice.onclick(); expect(click).toHaveBeenCalledTimes(1); expect(open).not.toHaveBeenCalled();
    ports.focus(); ports.navigate('https://ephemeral.example/?session=machine'); ports.openSession('machine'); expect(window.focus).toHaveBeenCalled(); expect(window.history.replaceState).toHaveBeenCalledWith(null, '', 'https://ephemeral.example/?session=machine'); expect(open).toHaveBeenCalledWith('machine');
  });
  it('holds the native Web Lock with exclusive mode for the supplied callback', async () => {
    browser(); vi.stubGlobal('Notification', undefined); const ports = createBrowserReminderPorts(vi.fn()); const action = vi.fn(); await ports.withLock!('account-reminder', action);
    expect(navigator.locks.request).toHaveBeenCalledWith('account-reminder', { mode: 'exclusive' }, action); expect(action).toHaveBeenCalledTimes(1);
  });
  it('reports unsupported APIs and inaccessible storage without throwing during mount', () => {
    const window = browser(); Object.defineProperty(window, 'localStorage', { get: () => { throw new Error('Storage denied'); } }); vi.stubGlobal('navigator', {}); vi.stubGlobal('Notification', undefined);
    const ports = createBrowserReminderPorts(vi.fn()); expect(ports.supported).toBe(false); expect(ports.storage).toBeUndefined(); expect(ports.withLock).toBeUndefined(); expect(ports.permission()).toBe('default');
  });
});
