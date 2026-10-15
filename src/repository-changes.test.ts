import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChangesPreview, RepositoryChanges } from './RepositoryChanges';
import { changeStatusLabel, ChangesLoader, changesRequestUrl, changesUnavailableReason, emptyChangesView, reduceChanges, requestChanges, validateChanges, type ChangesAction, type WorkspaceChanges } from './repository-changes';

const checkedAt = '2026-10-14T12:00:00Z';
const now = Date.parse(checkedAt);
const snapshot: WorkspaceChanges = { state: 'known', checkedAt, reason: null, headSha: 'a'.repeat(40), files: [{ path: 'src/file.ts', oldPath: null, status: ' M', kind: 'tracked' }], listTruncated: false, selected: null };
function selection(path = 'src/file.ts', text = '+new\n-old'): WorkspaceChanges { return { ...snapshot, files: [{ ...snapshot.files[0], path }], selected: { path, state: 'text', text, reason: null, truncated: false } }; }
function deferred() { let resolve!: (value: WorkspaceChanges) => void; const promise = new Promise<WorkspaceChanges>(done => { resolve = done; }); return { promise, resolve }; }
function loaded(value = snapshot, path: string | null = null) { return reduceChanges(reduceChanges(emptyChangesView, { type: 'start', path }), { type: 'result', path, value }); }
function markup(state = loaded(), unavailable = false, clock = now) { return renderToStaticMarkup(createElement(ChangesPreview, { state, now: clock, unavailable, onSelect: () => {} })); }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('bounded changes response validation', () => {
  it('accepts list, both hash formats, rename, and opaque unusual names', () => {
    expect(validateChanges(snapshot, null)).toBe(snapshot);
    const oddPath = 'space and\n<script>&?#%\\quote".txt';
    const renamed = { ...selection(oddPath), headSha: 'b'.repeat(64), files: [{ path: oddPath, oldPath: 'old\nfile', status: 'RM', kind: 'tracked' }] };
    expect(validateChanges(renamed, oddPath)).toBe(renamed);
  });
  it('rejects malformed, excessive, duplicate or unsafe file lists', () => {
    for (const value of [null, [], {}, { ...snapshot, checkedAt: 'invalid' }, { ...snapshot, headSha: 'invalid' }, { ...snapshot, reason: {} }, { ...snapshot, files: Array.from({ length: 201 }, () => snapshot.files[0]) }, { ...snapshot, files: [snapshot.files[0], snapshot.files[0]] }]) expect(() => validateChanges(value, null)).toThrow('could not be verified');
    for (const path of ['/etc/passwd', '../a', 'a/../b', 'a//b', 'a/./b', 'C:thing', 'x\0y', '😀'.repeat(1025)]) expect(() => validateChanges({ ...snapshot, files: [{ ...snapshot.files[0], path }] }, null)).toThrow();
    for (const status of ['  ', '??', 'M', ' XX']) expect(() => validateChanges({ ...snapshot, files: [{ ...snapshot.files[0], status }] }, null)).toThrow();
  });
  it('requires matching selection with correct text bounds and explicit preview state', () => {
    expect(validateChanges(selection(), 'src/file.ts').selected?.text).toBe('+new\n-old');
    for (const value of [selection('other'), selection('src/file.ts', 'x'.repeat(65537)), selection('src/file.ts', '😀'.repeat(16385)), { ...selection(), selected: { ...selection().selected!, text: null } }, snapshot]) expect(() => validateChanges(value, 'src/file.ts')).toThrow();
    expect(() => validateChanges(selection(), null)).toThrow();
    for (const state of ['binary', 'too_large', 'symlink', 'unavailable'] as const) {
      const value = { ...selection(), selected: { ...selection().selected!, state, text: null } };
      expect(validateChanges(value, 'src/file.ts').selected?.state).toBe(state);
      expect(() => validateChanges({ ...value, selected: { ...value.selected, text: 'unexpected' } }, 'src/file.ts')).toThrow();
    }
    expect(validateChanges({ ...snapshot, files: [] }, 'removed').selected).toBeNull();
    expect(() => validateChanges({ ...snapshot, files: [], listTruncated: true }, 'missing')).toThrow();
  });
  it('never accepts unknown/unavailable observations carrying a supposedly clean or current preview', () => {
    for (const state of ['unknown', 'unavailable']) {
      expect(validateChanges({ ...snapshot, state, files: [], selected: null }, null).state).toBe(state);
      expect(() => validateChanges({ ...snapshot, state }, null)).toThrow();
    }
  });
  it('uses an encoded GET with exact path round trip and validates its response', async () => {
    const path = 'a ?#&%\n".ts';
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => selection(path) }); vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    await requestChanges('session/id', path, signal);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe(`/api${changesRequestUrl('session/id', path)}`);
    expect(new URL(url, 'https://test').searchParams.get('path')).toBe(path);
    expect(url).toContain('session%2Fid'); expect(options.method).toBeUndefined(); expect(options.signal).toBe(signal);
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ...snapshot, state: 'clean' }) });
    await expect(requestChanges('id', null, signal)).rejects.toThrow('could not be verified');
  });
});

describe('observation and selection state', () => {
  it('hides old file content during refresh or a new selection and ignores mismatched results', () => {
    const prior = loaded(selection(), 'src/file.ts');
    const checking = reduceChanges(prior, { type: 'start', path: 'other' });
    expect(checking.snapshot?.selected).toBeNull(); expect(checking.selectedPath).toBe('other'); expect(checking.loading).toBe(true); expect(checking.stale).toBe(true);
    expect(reduceChanges(checking, { type: 'result', path: 'src/file.ts', value: selection() })).toBe(checking);
    const next = reduceChanges(checking, { type: 'result', path: 'other', value: selection('other') });
    expect(next.snapshot?.selected?.path).toBe('other'); expect(next.stale).toBe(false);
  });
  it('retains only explicitly prior lists on error, unknown checks, or lifecycle invalidation', () => {
    const prior = loaded(selection(), 'src/file.ts');
    const refresh = reduceChanges(prior, { type: 'start', path: 'src/file.ts' });
    const actions: ChangesAction[] = [{ type: 'failure', message: 'Connection lost' }, { type: 'invalidate', message: 'Machine ended' }, { type: 'result', path: 'src/file.ts', value: { ...snapshot, state: 'unknown', files: [], reason: 'Inspection failed' } }];
    for (const action of actions) {
      const state = reduceChanges(refresh, action);
      expect(state.snapshot?.files).toEqual(snapshot.files); expect(state.snapshot?.selected).toBeNull(); expect(state.stale).toBe(true); expect(state.loading).toBe(false); expect(state.error).toBeTruthy();
    }
  });
  it('clears a removed selection and never silently reuses its text', () => {
    const state = reduceChanges(loaded(selection(), 'src/file.ts'), { type: 'result', path: 'src/file.ts', value: { ...snapshot, files: [], selected: { ...selection().selected!, state: 'unavailable', text: null, reason: 'Removed' } } });
    expect(state.selectedPath).toBeNull(); expect(state.snapshot?.selected).toBeNull(); expect(state.selectionNotice).toContain('no longer');
    const limited = reduceChanges(loaded(selection(), 'src/file.ts'), { type: 'result', path: 'src/file.ts', value: { ...snapshot, files: [], listTruncated: true, selected: { ...selection().selected!, state: 'unavailable', text: null, reason: 'Not listed' } } });
    expect(limited.selectedPath).toBe('src/file.ts'); expect(limited.selectionNotice).toBe('');
  });
  it('explains staged/unstaged status and bounds lifecycle inspection', () => {
    expect(changeStatusLabel('MM')).toBe('Staged: modified · Unstaged: modified'); expect(changeStatusLabel('R ')).toContain('renamed'); expect(changeStatusLabel(' D')).toContain('deleted'); expect(changeStatusLabel('??')).toBe('Untracked'); expect(changeStatusLabel('AA')).toBe('Merge conflict');
    const session = { state: 'running' as const, expiresAt: '2026-10-14T13:00:00Z' };
    expect(changesUnavailableReason(session, false, now)).toBeNull(); expect(changesUnavailableReason(session, true, now)).toContain('no repository inspection'); expect(changesUnavailableReason(session, false, now + 3_600_000)).toContain('expired'); expect(changesUnavailableReason({ ...session, state: 'ended' }, false, now)).toContain('no longer');
  });
});

describe('bounded, scoped requests', () => {
  it('coalesces repeated refreshes and publishes one result', async () => {
    const pending = deferred(), request = vi.fn(() => pending.promise), publish = vi.fn(); const loader = new ChangesLoader(request, publish);
    const first = loader.refresh(null), second = loader.refresh(null); await Promise.resolve();
    expect(second).toBe(first); expect(request).toHaveBeenCalledTimes(1);
    pending.resolve(snapshot); await first; expect(publish.mock.calls.map(([action]) => action.type)).toEqual(['start', 'result']); loader.dispose();
  });
  it('settles cancelled requests, aborts their transport and rejects late file results', async () => {
    const old = deferred(), next = deferred(); let signal!: AbortSignal;
    const publish = vi.fn(), request = vi.fn((path, value) => { if (path === 'src/file.ts') signal = value; return path === 'src/file.ts' ? old.promise : next.promise; });
    const loader = new ChangesLoader(request, publish); const first = loader.refresh('src/file.ts'); await Promise.resolve();
    const second = loader.refresh('other'); await first; expect(signal.aborted).toBe(true);
    next.resolve(selection('other')); await second; old.resolve(selection()); await Promise.resolve();
    expect(publish.mock.calls.filter(([action]) => action.type === 'result').map(([action]) => action.path)).toEqual(['other']); loader.dispose();
  });
  it('cannot publish after session, account, expiry, or end invalidates its scope', async () => {
    for (const changed of ['other session', 'other account', 'expired', 'ended']) {
      let scope = 'current'; const pending = deferred(), publish = vi.fn();
      const loader = new ChangesLoader(() => pending.promise, publish, () => scope === 'current');
      const run = loader.refresh(null); await Promise.resolve(); scope = changed;
      pending.resolve(snapshot); await run;
      expect(publish.mock.calls.map(([action]) => action.type)).toEqual(['start']); loader.dispose();
    }
  });
  it('disposal settles a transport that ignores abort without publishing an error', async () => {
    const publish = vi.fn(); const loader = new ChangesLoader(() => new Promise(() => {}), publish);
    const run = loader.refresh(null); await Promise.resolve(); loader.dispose(); await run;
    expect(publish.mock.calls.map(([action]) => action.type)).toEqual(['start']);
    await loader.refresh(null); expect(publish).toHaveBeenCalledTimes(1);
  });
  it('times out hung transport and permits retry without a late result replacing it', async () => {
    vi.useFakeTimers(); const old = deferred(), publish = vi.fn(); let signal!: AbortSignal;
    const request = vi.fn().mockImplementationOnce((_, value) => { signal = value; return old.promise; }).mockResolvedValue(snapshot);
    const loader = new ChangesLoader(request, publish); const run = loader.refresh(null);
    await vi.advanceTimersByTimeAsync(60_000); await run;
    expect(signal.aborted).toBe(true); expect(publish).toHaveBeenLastCalledWith({ type: 'failure', message: expect.stringContaining('timed out') });
    await loader.refresh(null); old.resolve(selection()); await Promise.resolve();
    expect(publish.mock.calls.filter(([action]) => action.type === 'result')).toHaveLength(1); expect(vi.getTimerCount()).toBe(0); loader.dispose();
  });
});

describe('safe and explicit read-only rendering', () => {
  it('renders repository-controlled paths and text as plain text with no executable markup or links', () => {
    const path = '<img src=x onerror=alert(1)>.txt', value = selection(path, '<script>alert(1)</script>\n+https://example.test');
    value.files[0].oldPath = 'old<svg>.txt'; value.files[0].status = 'R ';
    const html = markup(loaded(value, path));
    expect(html).toContain('&lt;img'); expect(html).toContain('&lt;script&gt;'); expect(html).toContain('From: old&lt;svg&gt;'); expect(html).not.toContain('<script>'); expect(html).not.toContain('<a '); expect(html).not.toContain('<img '); expect(html).toContain('aria-pressed="true"'); expect(html).toContain('tabindex="0"');
  });
  it('hides prior text and disables file selection while loading', () => {
    const html = markup(reduceChanges(loaded(selection(), 'src/file.ts'), { type: 'start', path: 'src/file.ts' }));
    expect(html).not.toContain('+new'); expect(html).toContain('hidden while'); expect(html).toContain('disabled=""'); expect(html).toContain('Prior observation');
  });
  it('never renders a clean claim after failure or an expired observation', () => {
    const clean = loaded({ ...snapshot, files: [] });
    expect(markup(clean)).toContain('No uncommitted changes were found at this check');
    const failed = reduceChanges(clean, { type: 'failure', message: 'Disconnected' });
    expect(markup(failed)).not.toContain('No uncommitted changes were found'); expect(markup(failed)).toContain('Current changes have not been confirmed');
    expect(markup(clean, false, now + 60_001)).toContain('Prior observation');
  });
  it('explains bounded list/text previews, binary, symlink and oversized results', () => {
    const truncated = selection(); truncated.listTruncated = true; truncated.selected!.truncated = true;
    const html = markup(loaded(truncated, 'src/file.ts')); expect(html).toContain('File list truncated'); expect(html).toContain('Text preview truncated'); expect(html).toContain('Combined staged and unstaged diff');
    for (const [state, message] of [['binary', 'Binary file'], ['too_large', 'size limit'], ['symlink', 'Symbolic link'], ['unavailable', 'unavailable for preview']] as const) {
      const value = selection(); value.selected = { ...value.selected!, state, text: null };
      expect(markup(loaded(value, 'src/file.ts'))).toContain(message);
    }
    const untracked = selection(); untracked.files[0].kind = 'untracked'; untracked.files[0].status = '??'; expect(markup(loaded(untracked, 'src/file.ts'))).toContain('Untracked file text');
  });
  it('shows the scope and preview/no-inspection state before effects or live requests', () => {
    const session = { id: 'id', userId: 'owner', state: 'running', expiresAt: '2026-10-14T13:00:00Z' } as Parameters<typeof RepositoryChanges>[0]['session'];
    const html = renderToStaticMarkup(createElement(RepositoryChanges, { session, preview: true, now, accountKey: 'preview:owner' }));
    expect(html).toContain('Uncommitted changes compared with HEAD'); expect(html).toContain('commits are not shown'); expect(html).toContain('no repository inspection'); expect(html).toContain('disabled=""');
  });
});
