import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExpiryReminderController, expiryReminderUrl, selectExpiryReminders, type ExpiryReminderState, type ReminderInput, type ReminderPorts, type ReminderSession, type ReminderStorage } from './expiry-reminders';

afterEach(() => vi.useRealTimers());
const start = Date.parse('2026-10-14T12:00:00Z');
const alice = { mode: 'live' as const, user: { id: 'alice', login: 'alice', avatarUrl: '' } };
const bob = { ...alice, user: { ...alice.user, id: 'bob' } };
function session(minutes: number, changes: Partial<ReminderSession> = {}): ReminderSession {
  return { id: '00000000-0000-4000-8000-000000000001', userId: 'alice', repository: 'owner/project', state: 'running', endedAt: null, expiresAt: new Date(start + minutes * 60_000).toISOString(), maxExpiresAt: new Date(start + 60 * 60_000).toISOString(), ...changes };
}
function input(sessions: ReminderSession[], confirmedAt: number | null = start, bootstrap: ReminderInput['bootstrap'] = alice): ReminderInput { return { bootstrap, sessions, confirmedAt }; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function memoryStorage(): ReminderStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}
function locks() {
  const tails = new Map<string, Promise<void>>();
  return (name: string, action: () => void) => {
    const tail = (tails.get(name) ?? Promise.resolve()).then(action);
    tails.set(name, tail.catch(() => {})); return tail;
  };
}
function harness(overrides: Partial<ReminderPorts> = {}) {
  let now = start;
  let permission: NotificationPermission = 'granted';
  const storage = overrides.storage ?? memoryStorage();
  const notices: { reminder: Parameters<ReminderPorts['notify']>[0]; click: () => void; close: ReturnType<typeof vi.fn> }[] = [];
  let state!: ExpiryReminderState;
  const ports: ReminderPorts = {
    now: () => now, storage, withLock: locks(), secure: true, supported: true,
    permission: () => permission,
    requestPermission: vi.fn(async () => { permission = 'granted'; return permission; }),
    notify: vi.fn((reminder, click) => { const close = vi.fn(); notices.push({ reminder, click, close }); return { close }; }),
    origin: 'https://ephemeral.example', focus: vi.fn(), navigate: vi.fn(), openSession: vi.fn(), ...overrides,
  };
  const publish = vi.fn((value: ExpiryReminderState) => { state = value; });
  const controller = new ExpiryReminderController(ports, publish);
  return { controller, ports, storage, notices, publish, state: () => state, time: (value: number) => { now = value; }, permission: (value: NotificationPermission) => { permission = value; } };
}

 describe('expiry reminder selection', () => {
  it('selects exact 10-minute and two-minute thresholds, only the urgent one on late load', () => {
    expect(selectExpiryReminders(input([session(10.001)]), start)).toEqual([]);
    expect(selectExpiryReminders(input([session(10)]), start)[0].thresholdMinutes).toBe(10);
    expect(selectExpiryReminders(input([session(2.001)]), start)[0].thresholdMinutes).toBe(10);
    expect(selectExpiryReminders(input([session(2)]), start).map(value => value.thresholdMinutes)).toEqual([2]);
    expect(selectExpiryReminders(input([session(1)]), start).map(value => value.thresholdMinutes)).toEqual([2]);
    expect(selectExpiryReminders(input([session(0), session(-1)]), start)).toEqual([]);
  });
  it('checks all owned machines and omits provisioning, cleanup, failed, ended and inconsistent running records', () => {
    const sessions = [session(5), session(1, { id: 'second' }), session(1, { id: 'other', userId: 'bob' }), ...(['provisioning', 'cleanup_pending', 'failed', 'ended'] as const).map(state => session(1, { state })), session(1, { endedAt: new Date(start).toISOString() })];
    expect(selectExpiryReminders(input(sessions), start).map(value => value.sessionId)).toEqual(['second', sessions[0].id]);
    expect(selectExpiryReminders(input(sessions, start, { ...alice, user: null }), start)).toEqual([]);
  });
  it('uses the earlier absolute deadline, rejects invalid timestamps and rearms when deadline changes', () => {
    const capped = session(20, { maxExpiresAt: session(2).expiresAt });
    expect(selectExpiryReminders(input([capped]), start)[0].thresholdMinutes).toBe(2);
    expect(selectExpiryReminders(input([session(1, { maxExpiresAt: 'invalid' })]), start)).toEqual([]);
    expect(selectExpiryReminders(input([session(5)]), start)[0].key).not.toBe(selectExpiryReminders(input([session(8)]), start)[0].key);
  });
  it('builds only clean same-origin machine terminal/save-guidance routes', () => {
    const route = new URL(expiryReminderUrl('https://user:secret@ephemeral.example/old?token=secret&preview=1#old', session(1).id));
    expect(route.origin).toBe('https://ephemeral.example'); expect(route.pathname).toBe('/'); expect(route.username).toBe(''); expect(route.password).toBe('');
    expect([...route.searchParams.keys()]).toEqual(['session', 'tab', 'view']); expect(route.searchParams.get('tab')).toBe('terminal'); expect(route.searchParams.get('view')).toBe('machines'); expect(route.hash).toBe('#save-guidance');
  });
});

describe('desktop reminder delivery', () => {
  it('requires explicit per-account opt-in even when browser permission is already granted', async () => {
    const h = harness(); h.controller.update(input([session(5)])); await h.controller.tick();
    expect(h.notices).toHaveLength(0); expect(h.ports.requestPermission).not.toHaveBeenCalled();
    await h.controller.enableDesktop(); expect(h.notices).toHaveLength(1);
    h.controller.update(input([session(5, { userId: 'bob' })], start, bob)); await h.controller.tick(); expect(h.notices).toHaveLength(1); expect(h.state().desktop.enabled).toBe(false); expect(h.notices[0].close).toHaveBeenCalled();
  });
  it('allows simulation banners but never permission requests or native alerts in preview', async () => {
    const h = harness(); h.controller.update(input([session(1)], start, { ...alice, mode: 'preview' })); await h.controller.enableDesktop(); await h.controller.tick();
    expect(h.state().reminders).toHaveLength(1); expect(h.state().desktop.status).toBe('preview'); expect(h.notices).toHaveLength(0); expect(h.ports.requestPermission).not.toHaveBeenCalled();
  });
  it('requests permission synchronously only in explicit enable, and coalesces repeated gestures', async () => {
    const pending = deferred<NotificationPermission>(); const requestPermission = vi.fn(() => pending.promise);
    const h = harness({ requestPermission }); h.permission('default'); h.controller.update(input([session(1)])); await h.controller.tick(); expect(requestPermission).not.toHaveBeenCalled();
    const enabling = h.controller.enableDesktop(); expect(requestPermission).toHaveBeenCalledTimes(1); expect(h.state().desktop.status).toBe('requesting'); await h.controller.enableDesktop(); expect(requestPermission).toHaveBeenCalledTimes(1);
    h.permission('granted'); pending.resolve('granted'); await enabling; expect(h.notices).toHaveLength(1);
  });
  it('keeps pending permission disabled on reload and commits opt-in only after the owning grant', async () => {
    const storage = memoryStorage(); const permission = deferred<NotificationPermission>();
    const original = harness({ storage, requestPermission: () => permission.promise }); original.permission('default'); original.controller.update(input([session(1)]));
    const enabling = original.controller.enableDesktop(); const prospective = storage.getItem('ephemeral:expiry:opt-in:live:alice'); expect(prospective).toMatch(/^pending:/); expect(original.state().desktop.enabled).toBe(false);
    const reload = harness({ storage }); reload.permission('default'); reload.controller.update(input([session(1)])); await reload.controller.tick();
    expect(reload.state().desktop.enabled).toBe(false); expect(reload.state().desktop.status).toBe('default'); expect(reload.notices).toHaveLength(0); expect(reload.ports.requestPermission).not.toHaveBeenCalled();
    original.permission('granted'); permission.resolve('granted'); await enabling; expect(storage.getItem('ephemeral:expiry:opt-in:live:alice')).toBe('true'); expect(original.notices).toHaveLength(1);
  });
  it('does not enable a reloaded tab on an unrelated storage event while browser permission is default', async () => {
    const storage = memoryStorage(); storage.setItem('ephemeral:expiry:opt-in:live:alice', 'true'); const h = harness({ storage }); h.permission('default'); h.controller.update(input([session(1)])); h.controller.storageChanged(); await h.controller.tick();
    expect(h.state().desktop.enabled).toBe(false); expect(h.state().desktop.status).toBe('default'); expect(h.notices).toHaveLength(0);
  });
  it.each(['pending', 'granted'] as const)('an older rejected permission request preserves a newer %s choice', async phase => {
    const storage = memoryStorage(); const oldPermission = deferred<NotificationPermission>(); const newPermission = deferred<NotificationPermission>();
    const oldTab = harness({ storage, requestPermission: () => oldPermission.promise }); oldTab.permission('default'); oldTab.controller.update(input([session(1)])); const oldEnable = oldTab.controller.enableDesktop();
    const newTab = harness({ storage, requestPermission: () => newPermission.promise }); newTab.permission('default'); newTab.controller.update(input([session(1)])); const newEnable = newTab.controller.enableDesktop(); const newest = storage.getItem('ephemeral:expiry:opt-in:live:alice');
    if (phase === 'granted') { newTab.permission('granted'); newPermission.resolve('granted'); await newEnable; }
    oldPermission.reject(new Error('Old prompt rejected')); await oldEnable;
    expect(storage.getItem('ephemeral:expiry:opt-in:live:alice')).toBe(phase === 'granted' ? 'true' : newest);
    if (phase === 'pending') { newTab.permission('granted'); newPermission.resolve('granted'); await newEnable; }
    expect(newTab.notices).toHaveLength(1); expect(oldTab.notices).toHaveLength(0);
  });
  it('an older granted permission request cannot replace a newer pending marker', async () => {
    const storage = memoryStorage(); const oldPermission = deferred<NotificationPermission>(); const newPermission = deferred<NotificationPermission>();
    const oldTab = harness({ storage, requestPermission: () => oldPermission.promise }); oldTab.permission('default'); oldTab.controller.update(input([session(1)])); const oldEnable = oldTab.controller.enableDesktop();
    const newTab = harness({ storage, requestPermission: () => newPermission.promise }); newTab.permission('default'); newTab.controller.update(input([session(1)])); const newEnable = newTab.controller.enableDesktop(); const newest = storage.getItem('ephemeral:expiry:opt-in:live:alice');
    oldTab.permission('granted'); oldPermission.resolve('granted'); await oldEnable; expect(storage.getItem('ephemeral:expiry:opt-in:live:alice')).toBe(newest); expect(oldTab.notices).toHaveLength(0);
    newTab.permission('granted'); newPermission.resolve('granted'); await newEnable; expect(storage.getItem('ephemeral:expiry:opt-in:live:alice')).toBe('true'); expect(newTab.notices).toHaveLength(1);
  });
  it('clears only its own pending marker when permission rejects', async () => {
    const storage = memoryStorage(); const permission = deferred<NotificationPermission>(); const h = harness({ storage, requestPermission: () => permission.promise }); h.permission('default'); h.controller.update(input([session(1)])); const enabling = h.controller.enableDesktop(); expect(storage.getItem('ephemeral:expiry:opt-in:live:alice')).toMatch(/^pending:/);
    permission.reject(new Error('Rejected')); await enabling; expect(storage.getItem('ephemeral:expiry:opt-in:live:alice')).toBe('false'); expect(h.state().desktop.enabled).toBe(false);
  });
  it('times out an unresolved permission request after 60 seconds and ignores a late grant', async () => {
    vi.useFakeTimers(); const storage = memoryStorage(); const permission = deferred<NotificationPermission>(); const h = harness({ storage, requestPermission: () => permission.promise }); h.permission('default'); h.controller.update(input([session(5)])); const enabling = h.controller.enableDesktop();
    await vi.advanceTimersByTimeAsync(59_999); expect(h.state().desktop.status).toBe('requesting'); expect(storage.getItem('ephemeral:expiry:opt-in:live:alice')).toMatch(/^pending:/);
    await vi.advanceTimersByTimeAsync(1); await enabling; expect(h.state().desktop.status).toBe('permission-timeout'); expect(h.state().desktop.message).toContain('Retry or check browser notification settings'); expect(h.state().desktop.enabled).toBe(false); expect(storage.getItem('ephemeral:expiry:opt-in:live:alice')).toBe('false'); expect(h.notices).toHaveLength(0);
    h.time(start + 60_000); h.controller.update(input([session(5)], start + 60_000));
    h.permission('granted'); permission.resolve('granted'); await Promise.resolve(); await h.controller.tick(); expect(h.notices).toHaveLength(0); expect(storage.getItem('ephemeral:expiry:opt-in:live:alice')).toBe('false');
    await h.controller.enableDesktop(); expect(h.state().desktop.status).toBe('granted'); expect(h.notices).toHaveLength(1);
  });
  it("an older request timeout cannot erase another tab’s newer pending choice", async () => {
    vi.useFakeTimers(); const storage = memoryStorage(); const oldPermission = deferred<NotificationPermission>(); const newPermission = deferred<NotificationPermission>();
    const oldTab = harness({ storage, requestPermission: () => oldPermission.promise }); oldTab.permission('default'); oldTab.controller.update(input([session(1)])); const oldEnable = oldTab.controller.enableDesktop(); await vi.advanceTimersByTimeAsync(30_000);
    const newTab = harness({ storage, requestPermission: () => newPermission.promise }); newTab.permission('default'); newTab.controller.update(input([session(1)])); const newEnable = newTab.controller.enableDesktop(); const newest = storage.getItem('ephemeral:expiry:opt-in:live:alice');
    await vi.advanceTimersByTimeAsync(30_000); await oldEnable; expect(oldTab.state().desktop.status).toBe('permission-timeout'); expect(storage.getItem('ephemeral:expiry:opt-in:live:alice')).toBe(newest); expect(newTab.state().desktop.status).toBe('requesting');
    newTab.permission('granted'); newPermission.resolve('granted'); await newEnable; expect(storage.getItem('ephemeral:expiry:opt-in:live:alice')).toBe('true'); expect(newTab.notices).toHaveLength(1); expect(oldTab.notices).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['default', 'denied'] as const)('keeps in-app reminders after permission resolves %s', async permission => {
    const h = harness({ requestPermission: vi.fn(async () => permission) }); h.permission('default'); h.controller.update(input([session(1)])); await h.controller.enableDesktop();
    h.permission(permission); await h.controller.tick(); expect(h.state().desktop.status).toBe(permission); expect(h.state().reminders).toHaveLength(1); expect(h.notices).toHaveLength(0); expect(h.state().desktop.enabled).toBe(false);
  });
  it.each(['unsupported', 'insecure', 'coordination-unavailable', 'storage-failure'] as const)('fails safely with %s and retains banners', async status => {
    const overrides: Partial<ReminderPorts> = status === 'unsupported' ? { supported: false } : status === 'insecure' ? { secure: false } : status === 'coordination-unavailable' ? { withLock: undefined } : { storage: { getItem: () => { throw new Error('Blocked'); }, setItem: () => { throw new Error('Blocked'); } } };
    const h = harness(overrides); h.controller.update(input([session(1)])); await h.controller.enableDesktop(); await h.controller.tick();
    expect(h.state().desktop.status).toBe(status); expect(h.state().reminders).toHaveLength(1); expect(h.notices).toHaveLength(0); expect(h.ports.requestPermission).not.toHaveBeenCalled();
  });
  it('reports storage failure on rejected writes even when reads work', async () => {
    const h = harness({ storage: { getItem: () => null, setItem: () => { throw new Error('Quota'); } } }); h.controller.update(input([session(1)])); await h.controller.enableDesktop();
    expect(h.state().desktop.status).toBe('storage-failure'); expect(h.state().desktop.enabled).toBe(false); expect(h.notices).toHaveLength(0);
  });
  it('handles rejected permission without unhandled work or dropping banners', async () => {
    const h = harness({ requestPermission: vi.fn(async () => { throw new Error('Browser rejected'); }) }); h.permission('default'); h.controller.update(input([session(1)])); await h.controller.enableDesktop();
    expect(h.state().desktop.status).toBe('error'); expect(h.state().desktop.enabled).toBe(false); expect(h.state().reminders).toHaveLength(1);
  });
  it('coordinates concurrent tabs and survives reloads with durable receipts', async () => {
    const storage = memoryStorage(); const withLock = locks(); const first = harness({ storage, withLock }); const second = harness({ storage, withLock });
    first.controller.update(input([session(1)])); second.controller.update(input([session(1)]));
    await Promise.all([first.controller.enableDesktop(), second.controller.enableDesktop()]); expect(first.notices.length + second.notices.length).toBe(1);
    const reload = harness({ storage, withLock }); reload.controller.update(input([session(1)])); await reload.controller.tick(); expect(reload.notices).toHaveLength(0);
    const raw = storage.values.get('ephemeral:expiry:receipts:live:alice')!; expect(raw).not.toContain('owner/project'); expect(Object.keys(JSON.parse(raw))).toHaveLength(2);
  });
  it('delivers 10 then two minutes once each, and an extension starts a new deadline cycle', async () => {
    const h = harness(); h.controller.update(input([session(10)])); await h.controller.enableDesktop(); await h.controller.tick(); expect(h.notices.map(n => n.reminder.thresholdMinutes)).toEqual([10]);
    h.time(start + 8 * 60_000); h.controller.update(input([session(10)], start + 8 * 60_000)); await h.controller.tick(); expect(h.notices.map(n => n.reminder.thresholdMinutes)).toEqual([10, 2]); expect(h.notices[0].close).toHaveBeenCalled();
    h.controller.update(input([session(30)], start + 8 * 60_000)); await h.controller.tick(); expect(h.notices[1].close).toHaveBeenCalled();
    h.time(start + 20 * 60_000); h.controller.update(input([session(30)], start + 20 * 60_000)); await h.controller.tick(); expect(h.notices.map(n => n.reminder.thresholdMinutes)).toEqual([10, 2, 10]);
  });
  it('consumes the earlier threshold on late load even if the clock moves backwards', async () => {
    const h = harness(); h.controller.update(input([session(1)])); await h.controller.enableDesktop(); h.time(start - 4 * 60_000); h.controller.update(input([session(1)], start - 4 * 60_000)); await h.controller.tick(); expect(h.notices.map(n => n.reminder.thresholdMinutes)).toEqual([2]);
  });
  it('prunes expired receipt cycles under the delivery lock', async () => {
    const storage = memoryStorage(); storage.setItem('ephemeral:expiry:receipts:live:alice', JSON.stringify({ old: start - 1 }));
    const h = harness({ storage }); h.controller.update(input([session(5)])); await h.controller.enableDesktop(); const ledger = JSON.parse(storage.getItem('ephemeral:expiry:receipts:live:alice')!); expect(ledger.old).toBeUndefined(); expect(Object.keys(ledger)).toHaveLength(1);
  });
  it('does not silently evict unexpired receipts when the bounded journal is full', async () => {
    const storage = memoryStorage(); storage.setItem('ephemeral:expiry:receipts:live:alice', JSON.stringify(Object.fromEntries(Array.from({ length: 512 }, (_, i) => [`active-${i}`, start + 600_000]))));
    const h = harness({ storage }); h.controller.update(input([session(1)])); await h.controller.enableDesktop(); expect(h.notices).toHaveLength(0); expect(h.state().desktop.status).not.toBe('granted'); expect(Object.keys(JSON.parse(storage.getItem('ephemeral:expiry:receipts:live:alice')!))).toHaveLength(512);
  });
  it('fails safely when lock acquisition rejects or native construction throws', async () => {
    const lock = harness({ withLock: async () => { throw new Error('Lock failed'); } }); lock.controller.update(input([session(1)])); await lock.controller.enableDesktop(); expect(lock.state().desktop.status).toBe('coordination-unavailable');
    const native = harness({ notify: () => { throw new Error('Native failed'); } }); native.controller.update(input([session(1)])); await native.controller.enableDesktop(); expect(native.state().desktop.status).toBe('error'); expect(native.state().reminders).toHaveLength(1);
  });
  it('keeps in-app dismissal independent of native delivery and rearms on extension', async () => {
    const h = harness(); h.controller.update(input([session(5)])); h.controller.dismiss(h.state().reminders[0].key); expect(h.state().reminders).toHaveLength(0); await h.controller.enableDesktop(); expect(h.notices).toHaveLength(1);
    h.controller.update(input([session(8)])); expect(h.state().reminders).toHaveLength(1);
  });
});

describe('freshness and lifecycle races', () => {
  it('suppresses desktop alerts from stale or failed snapshots without dropping banners', async () => {
    const h = harness(); h.time(start + 15_001); h.controller.update(input([session(5)])); await h.controller.enableDesktop(); expect(h.notices).toHaveLength(0); expect(h.state().reminders).toHaveLength(1);
    h.controller.update(input([session(5)], start + 15_001)); await h.controller.tick(); expect(h.notices).toHaveLength(1);
    h.controller.update(input([session(5)], null)); expect(h.notices[0].close).toHaveBeenCalled();
  });
  it('closes notifications when the clock passes snapshot freshness or permission changes', async () => {
    const h = harness(); h.controller.update(input([session(5)])); await h.controller.enableDesktop(); h.time(start + 15_001); await h.controller.tick(); expect(h.notices[0].close).toHaveBeenCalled();
    const other = harness(); other.controller.update(input([session(5)])); await other.controller.enableDesktop(); other.permission('denied'); await other.controller.tick(); expect(other.notices[0].close).toHaveBeenCalled();
  });
  it('requires a newly confirmed snapshot after visibility/focus wake', async () => {
    const h = harness(); const snapshot = input([session(5)]); h.controller.update(snapshot); h.controller.pauseDesktopUntilSnapshot(); await h.controller.enableDesktop(); expect(h.notices).toHaveLength(0);
    h.controller.update(snapshot); await h.controller.tick(); expect(h.notices).toHaveLength(0);
    h.controller.update(input([session(5)], start)); await h.controller.tick(); expect(h.notices).toHaveLength(1);
  });
  it('retains an already-shown current alert during wake and lets its click open guidance', async () => {
    const h = harness(); h.controller.update(input([session(5)])); await h.controller.enableDesktop(); expect(h.notices).toHaveLength(1);
    h.controller.pauseDesktopUntilSnapshot(); await h.controller.tick(); expect(h.notices[0].close).not.toHaveBeenCalled(); expect(h.notices).toHaveLength(1);
    h.notices[0].click(); expect(h.ports.focus).toHaveBeenCalledTimes(1); expect(h.ports.openSession).toHaveBeenCalledWith(session(5).id); expect(h.ports.navigate).toHaveBeenCalledWith(expiryReminderUrl(h.ports.origin, session(5).id));
  });
  it('retains an already-shown alert during wake but closes it on a confirmed stopped snapshot', async () => {
    const h = harness(); h.controller.update(input([session(5)])); await h.controller.enableDesktop(); h.controller.pauseDesktopUntilSnapshot(); await h.controller.tick(); expect(h.notices[0].close).not.toHaveBeenCalled();
    h.controller.update(input([session(5, { state: 'ended', endedAt: new Date(start).toISOString() })])); expect(h.notices[0].close).toHaveBeenCalledTimes(1); h.notices[0].click(); expect(h.ports.openSession).not.toHaveBeenCalled();
  });
  it('retains wake-paused alerts only while their existing snapshot remains actually fresh', async () => {
    const h = harness(); h.controller.update(input([session(5)])); await h.controller.enableDesktop(); h.controller.pauseDesktopUntilSnapshot(); h.time(start + 15_000); await h.controller.tick(); expect(h.notices[0].close).not.toHaveBeenCalled();
    h.time(start + 15_001); await h.controller.tick(); expect(h.notices[0].close).toHaveBeenCalledTimes(1);
  });
  it.each(['stopped', 'logout', 'account', 'disposed', 'stale', 'disabled'] as const)('guards pending locks after %s', async action => {
    const lock = deferred<void>(); const h = harness({ withLock: async (_key, perform) => { await lock.promise; perform(); } }); h.controller.update(input([session(1)])); const enabling = h.controller.enableDesktop();
    if (action === 'stopped') h.controller.update(input([session(1, { state: 'ended' })]));
    if (action === 'logout') h.controller.update(input([], null, null));
    if (action === 'account') h.controller.update(input([session(1, { userId: 'bob' })], start, bob));
    if (action === 'disposed') h.controller.dispose();
    if (action === 'stale') h.time(start + 15_001);
    if (action === 'disabled') h.controller.disableDesktop();
    lock.resolve(); await enabling; expect(h.notices).toHaveLength(0);
  });
  it.each(['logout', 'account', 'disposed', 'disabled'] as const)('guards pending permission after %s', async action => {
    const permission = deferred<NotificationPermission>(); const h = harness({ requestPermission: () => permission.promise }); h.permission('default'); h.controller.update(input([session(1)])); const enabling = h.controller.enableDesktop();
    if (action === 'logout') h.controller.update(input([], null, null));
    if (action === 'account') h.controller.update(input([session(1, { userId: 'bob' })], start, bob));
    if (action === 'disposed') h.controller.dispose();
    if (action === 'disabled') h.controller.disableDesktop();
    const published = h.publish.mock.calls.length; h.permission('granted'); permission.resolve('granted'); await enabling; expect(h.notices).toHaveLength(0); expect(h.publish).toHaveBeenCalledTimes(published);
  });
  it('rechecks stored opt-in under the lock even before another-tab storage event arrives', async () => {
    const storage = memoryStorage(); const lock = deferred<void>(); const h = harness({ storage, withLock: async (_name, perform) => { await lock.promise; perform(); } });
    h.controller.update(input([session(1)])); const enabling = h.controller.enableDesktop(); storage.setItem('ephemeral:expiry:opt-in:live:alice', 'false'); lock.resolve(); await enabling; expect(h.notices).toHaveLength(0);
  });
  it('respects another-tab disable while permission is pending', async () => {
    const storage = memoryStorage(); const permission = deferred<NotificationPermission>(); const h = harness({ storage, requestPermission: () => permission.promise }); h.permission('default'); h.controller.update(input([session(1)])); const enabling = h.controller.enableDesktop();
    storage.setItem('ephemeral:expiry:opt-in:live:alice', 'false'); h.permission('granted'); permission.resolve('granted'); await enabling; expect(h.notices).toHaveLength(0); expect(h.state().desktop.enabled).toBe(false); expect(storage.getItem('ephemeral:expiry:opt-in:live:alice')).toBe('false');
  });
  it('closes outstanding notifications when another tab disables reminders', async () => {
    const storage = memoryStorage(); const h = harness({ storage }); h.controller.update(input([session(5)])); await h.controller.enableDesktop(); storage.setItem('ephemeral:expiry:opt-in:live:alice', 'false'); h.controller.storageChanged(); expect(h.notices[0].close).toHaveBeenCalled(); expect(h.state().desktop.enabled).toBe(false);
  });
  it('routes native clicks to the correct machine and guidance, never after stop/account change/disposal', async () => {
    const h = harness(); h.controller.update(input([session(5)])); await h.controller.enableDesktop(); h.notices[0].click(); expect(h.ports.focus).toHaveBeenCalledTimes(1); expect(h.ports.openSession).toHaveBeenCalledWith(session(5).id); expect(h.ports.navigate).toHaveBeenCalledWith(expiryReminderUrl(h.ports.origin, session(5).id));
    h.controller.update(input([session(5, { state: 'ended' })])); h.notices[0].click(); expect(h.ports.focus).toHaveBeenCalledTimes(1);
    h.controller.update(input([session(5, { userId: 'bob' })], start, bob)); h.notices[0].click(); expect(h.ports.focus).toHaveBeenCalledTimes(1); h.controller.dispose(); h.notices[0].click(); expect(h.ports.focus).toHaveBeenCalledTimes(1);
  });
});
