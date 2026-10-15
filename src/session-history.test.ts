import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bootstrap, Session } from './api';
import { SessionHistory, selectSessionHistoryResult } from './SessionHistory';
import { workspacePanelMemory } from './panel-state';
import { emptyHistoryFilters, filterSessionHistory, historyFocusIndex, historySearchKey, mergeSessionLabel, ownedSessionHistory, reconcileLabelDraft, reconcileSessionRefresh, saveSessionLabel, sessionName, SessionSnapshotGate, workspaceIdentity } from './session-history';
import { navigateSessionRoute, readSessionRoute, resolveSessionRoute, sessionRouteUrl } from './session-route';

const first: Session = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId: 'owner', label: 'Repair checkout', repository: 'owner/shop', repositoryId: 1, installationId: 2, baseBranch: 'main', branch: 'ephemeral/checkout', state: 'ended', createdAt: '2026-10-14T12:00:00Z', expiresAt: '2026-10-14T13:00:00Z', maxExpiresAt: '2026-10-14T13:00:00Z', sandboxId: null, endedAt: null, error: null, cleanup: { vm: 'confirmed', github: 'confirmed', gateway: 'confirmed', codex: 'not_applicable' }, codexRemoteRevocation: 'unverified' };
const second: Session = { ...first, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', label: undefined, repository: 'other/shop', branch: 'ephemeral/design', state: 'running' };
const boot: Bootstrap = { user: { id: 'owner', login: 'owner', avatarUrl: '' }, mode: 'live', configured: true, sessionMaxHours: 1, missing: [], githubInstallUrl: null };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('searchable session history', () => {
  it('searches names, owner/repo, exact IDs and both branches, without changing source selection', () => {
    const sessions = [second, first];
    for (const query of ['repair checkout', 'OWNER/SHOP', first.id, 'checkout', 'main']) expect(filterSessionHistory(sessions, { ...emptyHistoryFilters, query })).toContain(first);
    expect(filterSessionHistory(sessions, { ...emptyHistoryFilters, query: 'owner/shop checkout' })).toEqual([first]);
    expect(filterSessionHistory(sessions, { query: '', state: 'running', repository: 'owner/shop' })).toEqual([]);
    expect(filterSessionHistory(sessions, { query: 'shop', state: 'running', repository: 'other/shop' })).toEqual([second]);
    const selectedId = first.id;
    expect(filterSessionHistory(sessions, { ...emptyHistoryFilters, state: 'running' }).some(session => session.id === selectedId)).toBe(false);
    expect(selectedId).toBe(first.id);
    expect(filterSessionHistory(sessions, emptyHistoryFilters)).toEqual(sessions);
    expect(sessionName(second)).toBe('machine-bbbbbb');
  });
  it('renders full identities, creation dates, status and accessible selected state', () => {
    const html = renderToStaticMarkup(createElement(SessionHistory, { sessions: [first, second], selectedId: first.id, onSelect: () => {} }));
    expect(html).toContain('Search machines'); expect(html).toContain('type="search"');
    expect(html).toContain('Repair checkout'); expect(html).toContain('owner/shop'); expect(html).toContain('other/shop');
    expect(html).toContain('dateTime="2026-10-14T12:00:00Z"'); expect(html).toContain('aria-current="true"');
    expect(html).toContain('All statuses'); expect(html).toContain('All repositories');
    const empty = renderToStaticMarkup(createElement(SessionHistory, { sessions: [], selectedId: null, onSelect: () => {} }));
    expect(empty).toContain('No machines yet.');
  });
  it('supports keyboard search and bounded focus navigation without implicit selection', () => {
    expect(historySearchKey('Escape')).toBe('clear'); expect(historySearchKey('ArrowDown')).toBe('focus-results'); expect(historySearchKey('Enter')).toBeNull();
    expect(historyFocusIndex('ArrowDown', 0, 3)).toBe(1); expect(historyFocusIndex('ArrowDown', 2, 3)).toBe(2);
    expect(historyFocusIndex('ArrowUp', 0, 3)).toBe(0); expect(historyFocusIndex('Home', 2, 3)).toBe(0); expect(historyFocusIndex('End', 0, 3)).toBe(2);
    expect(historyFocusIndex('Enter', 0, 3)).toBeNull(); expect(historyFocusIndex('ArrowDown', 0, 0)).toBeNull();
  });
  it('collapses history after an explicit activation, including the already selected row', () => {
    const scope = 'history-explicit-selection';
    const disclosure = { tagName: 'DETAILS', open: true } as unknown as HTMLDetailsElement;
    const onSelect = vi.fn(() => true);
    const root = { getElementById: vi.fn(() => disclosure) };
    for (const id of [second.id, second.id]) {
      disclosure.open = true;
      workspacePanelMemory.remember('history', scope, id, true);
      expect(selectSessionHistoryResult(id, scope, onSelect, root)).toBe(true);
      expect(disclosure.open).toBe(false);
      expect(workspacePanelMemory.expanded('history', scope, id)).toBe(false);
    }
    expect(onSelect.mock.calls).toEqual([[second.id], [second.id]]);
  });
  it('preserves the disclosure when selection is rejected', () => {
    const disclosure = { tagName: 'DETAILS', open: true } as unknown as HTMLDetailsElement;
    const root = { getElementById: vi.fn(() => disclosure) };
    expect(selectSessionHistoryResult('missing', 'rejected-history-selection', () => false, root)).toBe(false);
    expect(disclosure.open).toBe(true);
    expect(root.getElementById).not.toHaveBeenCalled();
  });
  it('keeps polling lifecycle text out of the explicit selection announcement', () => {
    const html = renderToStaticMarkup(createElement(SessionHistory, { sessions: [first], selectedId: first.id, onSelect: () => {} }));
    expect(html).toContain('class="panel-disclosure-status" aria-live="off"');
  });
});

describe('bookmark and Back route state', () => {
  it('reloads the same machine/tab, normalizes UUID case, and preserves unrelated parameters and hashes', () => {
    const original = new URL(`https://example.test/?preview=1&flag=a&flag=b&session=${first.id.toUpperCase()}&tab=settings#notes`);
    const parsed = readSessionRoute(original);
    expect(parsed.sessionId).toBe(first.id); expect(parsed.tab).toBe('settings');
    expect(resolveSessionRoute(parsed, [second, first]).selectedId).toBe(first.id);
    const next = sessionRouteUrl(original, { sessionId: second.id, tab: 'activity', view: 'machines' });
    expect(next.searchParams.getAll('flag')).toEqual(['a', 'b']); expect(next.searchParams.get('preview')).toBe('1'); expect(next.hash).toBe('#notes');
    expect(resolveSessionRoute(readSessionRoute(next), [first, second]).selectedId).toBe(second.id);
    // Back reads the previous URL and restores both choices, independent of list order.
    expect(readSessionRoute(original).tab).toBe('settings'); expect(resolveSessionRoute(readSessionRoute(original), [second, first]).selectedId).toBe(first.id);
  });
  it('rejects malformed or repeated IDs without silently selecting another machine', () => {
    for (const suffix of ['session=bad', 'session=', `session=${first.id}&session=${second.id}`, 'session=%3Cscript%3E']) {
      const resolved = resolveSessionRoute(readSessionRoute(new URL(`https://example.test/?${suffix}`)), [first, second]);
      expect(resolved.selectedId).toBeNull(); expect(resolved.notice).toContain('invalid machine ID');
    }
  });
  it('recovers from a malformed link when a valid history machine is explicitly selected', () => {
    const invalid = readSessionRoute(new URL('https://example.test/?session=bad'));
    const selected = navigateSessionRoute(invalid, { sessionId: first.id });
    expect(selected.invalidSession).toBe(false); expect(selected.issue).toBe('');
    expect(resolveSessionRoute(selected, [first, second]).selectedId).toBe(first.id);
  });
  it('falls back to allowed tabs/views but never substitutes a missing or unauthorized linked session', () => {
    const invalidTab = readSessionRoute(new URL(`https://example.test/?session=${first.id}&tab=secret&view=bad`));
    expect(invalidTab.tab).toBe('terminal'); expect(invalidTab.view).toBe('machines');
    expect(resolveSessionRoute(invalidTab, [first]).selectedId).toBe(first.id);
    expect(resolveSessionRoute(readSessionRoute(new URL('https://example.test/?tab=bogus')), [first]).selectedId).toBe(first.id);
    const unavailable = resolveSessionRoute(readSessionRoute(new URL(`https://example.test/?session=${second.id}&tab=access`)), [first]);
    expect(unavailable.selectedId).toBeNull(); expect(unavailable.notice).toContain('unavailable'); expect(unavailable.notice).not.toContain(second.repository);
  });
});

describe('history refresh and naming races', () => {
  it('discards pre-mutation snapshots and older polls', async () => {
    const gate = new SessionSnapshotGate();
    let resolve!: (sessions: Session[]) => void;
    const revision = gate.begin();
    const pending = new Promise<Session[]>(done => { resolve = done; });
    let list = [first];
    const poll = pending.then(incoming => { if (gate.apply(revision)) list = incoming; });
    gate.invalidate(); list = [{ ...first, label: 'Saved new name' }, second];
    resolve([first]); await poll;
    expect(list.map(session => session.label)).toEqual(['Saved new name', undefined]);
    const earlier = gate.begin(); const later = gate.begin(); expect(gate.apply(later)).toBe(true); expect(gate.apply(earlier)).toBe(false);
  });
  it('makes progress with slow overlapping polls, then rejects an older completion', () => {
    const gate = new SessionSnapshotGate(); const slow = gate.begin(); const newerPending = gate.begin();
    expect(gate.apply(slow)).toBe(true);
    expect(gate.apply(newerPending)).toBe(true);
    expect(gate.apply(slow)).toBe(false);
  });
  it('retains newly selected local sessions across a poll started before their creation', () => {
    expect(reconcileSessionRefresh([first], [second, first], first.id, second.id)).toEqual([second, first]);
    expect(reconcileSessionRefresh([first], [second, first], second.id, second.id)).toEqual([first]);
  });
  it('keeps edited drafts across polls and merges labels without erasing current lifecycle state', () => {
    expect(reconcileLabelDraft('Unsaved draft', true, 'Server name')).toBe('Unsaved draft');
    expect(reconcileLabelDraft('Old name', false, 'Server name')).toBe('Server name');
    const current = { ...first, state: 'cleanup_pending' as const, cleanup: { ...first.cleanup, vm: 'pending' as const } };
    const merged = mergeSessionLabel(current, { ...first, label: 'Saved new name' });
    expect(merged.label).toBe('Saved new name'); expect(merged.state).toBe('cleanup_pending'); expect(merged.cleanup.vm).toBe('pending');
    expect(mergeSessionLabel(merged, { ...first, label: undefined })).not.toHaveProperty('label');
    expect(mergeSessionLabel(current, second)).toBe(current);
  });
  it('isolates identities and excludes another account’s sessions before resolving a bookmark', () => {
    const foreign = { ...second, userId: 'foreign', label: 'Private task' };
    expect(workspaceIdentity(boot)).not.toBe(workspaceIdentity({ ...boot, user: { ...boot.user!, id: 'foreign' } }));
    expect(workspaceIdentity(boot)).not.toBe(workspaceIdentity({ ...boot, mode: 'preview' }));
    expect(ownedSessionHistory([first, foreign], boot)).toEqual([first]);
    expect(ownedSessionHistory([first], { ...boot, user: null })).toEqual([]);
    expect(resolveSessionRoute(readSessionRoute(new URL(`https://example.test/?session=${foreign.id}`)), ownedSessionHistory([first, foreign], boot)).selectedId).toBeNull();
  });
});

describe('bounded task name saving', () => {
  it('posts the captured session ID and supports clearing, while preserving server errors', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ...first, label: undefined }) }).mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: 'Task name is too long' }) }); vi.stubGlobal('fetch', fetch);
    expect((await saveSessionLabel(first.id, '')).label).toBeUndefined();
    expect(fetch.mock.calls[0][0]).toBe(`/api/sessions/${first.id}/label`);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ label: '' });
    expect(fetch.mock.calls[0][1].headers['X-Ephemeral-Request']).toBe('1');
    await expect(saveSessionLabel(first.id, 'x')).rejects.toThrow('Task name is too long');
  });
  it('bounds a hung save, aborts the transport and leaves a retryable uncertainty message', async () => {
    vi.useFakeTimers(); let signal!: AbortSignal;
    vi.stubGlobal('fetch', vi.fn((_, options) => { signal = options.signal; return new Promise(() => {}); }));
    const pending = saveSessionLabel(first.id, 'Keep this draft').catch(error => error);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(signal.aborted).toBe(true); expect((await pending).message).toContain('Check the saved name before retrying');
    expect(vi.getTimerCount()).toBe(0);
  });
});
