import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { WorkspaceFiles } from './WorkspaceFiles';
import { FileRequestError, FileSelectionFocusIntent, WorkspaceFilesClient, WorkspaceFilesRegistry, draftDirty, filesUnavailableReason, isFileSaveShortcut, validWorkspacePath, validWorkspaceText, workspaceLineEndings, normalizeWorkspaceEdit, validateWorkspaceDirectory, validateWorkspaceFile, type FilesTransport } from './workspace-files';
import type { Session } from './api';
const version = 'a'.repeat(64), nextVersion = 'b'.repeat(64);
const file = (content = 'base', path = 'src/app.ts', v = version) => ({ path, content, version: v, simulation: true });
const directory = { path: '', entries: [{ path: 'src', name: 'src', kind: 'directory' }], truncated: false, simulation: true };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
afterEach(() => vi.useRealTimers());

describe('workspace file boundaries', () => {
  it('matches canonical server paths, supports Unicode and spaces, and rejects traversal and Git metadata', () => {
    for (const path of ['src/app.ts', 'a file.txt', '嵌套/🍃.txt']) expect(validWorkspacePath(path)).toBe(true);
    for (const path of ['', '/etc/passwd', '../a', 'x/../a', 'a//b', './a', 'a/', 'a\\b', '.git/config', 'x/.GiT/config', 'C:/temp', 'c:relative', 'a\u0085b', '\ud800', 'a\nb', 'x/'.repeat(32) + 'a', 'é'.repeat(513)]) expect(validWorkspacePath(path), path).toBe(false);
    expect(validWorkspacePath('', true)).toBe(true);
    expect(validWorkspacePath('a/'.repeat(31) + 'b')).toBe(true);
    expect(validWorkspaceText('hello\tworld\r\n🍃')).toBe(true);
    for (const text of ['x\0', 'x\u000b', '\u007f', '\u0085', '\udfff']) expect(validWorkspaceText(text)).toBe(false);
  });
  it('verifies exact paths, versions, text size, simulation and directory children before showing data', () => {
    expect(validateWorkspaceFile(file(), 'src/app.ts')).toEqual(file());
    for (const value of [file('x', 'wrong'), { ...file(), version: 'bad' }, { ...file(), simulation: undefined }, file('\0'), file('é'.repeat(65_537))]) expect(() => validateWorkspaceFile(value, 'src/app.ts')).toThrow();
    expect(validateWorkspaceDirectory(directory, '')).toEqual(directory);
    for (const value of [{ ...directory, entries: [...directory.entries, ...directory.entries] }, { ...directory, entries: [{ name: 'escape', path: '../escape', kind: 'file' }] }, { ...directory, entries: [{ name: '.git', path: '.git', kind: 'directory' }] }, { ...directory, entries: Array.from({ length: 201 }, (_, i) => ({ name: `${i}`, path: `${i}`, kind: 'file' })) }]) expect(() => validateWorkspaceDirectory(value, '')).toThrow();
  });
  it('preserves tablist focus on retained remount and cancels delayed editor focus after newer keyboard or focus input', () => {
    const focus = new FileSelectionFocusIntent();
    expect(focus.consume('retained.txt')).toBe(false);
    focus.request('opened.txt'); expect(focus.consume('opened.txt')).toBe(true);
    expect(focus.consume('opened.txt')).toBe(false);
    focus.request('loading.txt'); focus.interrupt(); expect(focus.consume('loading.txt')).toBe(false);
    focus.request('first.txt'); focus.request('second.txt'); expect(focus.consume('first.txt')).toBe(false); expect(focus.consume('second.txt')).toBe(true);
    focus.request('old.txt'); focus.interrupt(); expect(new FileSelectionFocusIntent().consume('old.txt')).toBe(false);
  });
  it('labels preview simulation before the first response and clean files by their actual save mode', async () => {
    const session = { id: 'session', state: 'running', expiresAt: '2030-01-01', maxExpiresAt: '2030-01-02' } as Session;
    const client = new WorkspaceFilesClient('session', vi.fn<FilesTransport>().mockResolvedValue(file()));
    const initial = renderToStaticMarkup(createElement(WorkspaceFiles, { session, client, now: 0, preview: true }));
    expect(initial).toContain('Local simulation.'); expect(initial).not.toContain('Saves write to this disposable machine.');
    await client.open('src/app.ts');
    const simulated = renderToStaticMarkup(createElement(WorkspaceFiles, { session, client, now: 0, preview: true }));
    expect(simulated).toContain('Saved in simulation'); expect(simulated).not.toContain('Saved in machine');
    client.dispose();
    const live = new WorkspaceFilesClient('live', vi.fn<FilesTransport>().mockResolvedValue({ ...file(), simulation: false }));
    await live.open('src/app.ts');
    const real = renderToStaticMarkup(createElement(WorkspaceFiles, { session, client: live, now: 0 }));
    expect(real).toContain('Saved in machine'); expect(real).not.toContain('Saved in simulation'); live.dispose();
  });
  it('preserves uniform CRLF and CR baselines when textarea edits use LF, and declares mixed normalization', async () => {
    expect(workspaceLineEndings('a\r\nb\r\n')).toBe('CRLF'); expect(workspaceLineEndings('a\rb\r')).toBe('CR');
    expect(workspaceLineEndings('a\nb')).toBe('LF'); expect(workspaceLineEndings('plain')).toBe('none'); expect(workspaceLineEndings('a\r\nb\nc\r')).toBe('mixed');
    expect(normalizeWorkspaceEdit('a\nb\nc', 'a\r\nb\r\n')).toBe('a\r\nb\r\nc');
    expect(normalizeWorkspaceEdit('a\nb\nc', 'a\rb\r')).toBe('a\rb\rc');
    expect(normalizeWorkspaceEdit('a\r\nb\rc', 'a\nb')).toBe('a\nb\nc');
    expect(normalizeWorkspaceEdit('a\r\nb\rc', '', true)).toBe('a\nb\nc');
    expect(normalizeWorkspaceEdit('a\r\nb\nc', 'a\r\nb\nc')).toBe('a\nb\nc');
    const request = vi.fn<FilesTransport>().mockResolvedValueOnce(file('a\r\nb\r\n')).mockResolvedValueOnce(file('a\r\nb edited\r\n', 'src/app.ts', nextVersion));
    const client = new WorkspaceFilesClient('session', request); await client.open('src/app.ts'); client.edit('a\nb edited\n');
    expect(client.selected).toMatchObject({ content: 'a\r\nb edited\r\n', baseline: 'a\r\nb\r\n', version });
    await client.save(); expect(request.mock.calls[1][1]).toEqual({ path: 'src/app.ts', content: 'a\r\nb edited\r\n', expectedVersion: version }); client.dispose();
    const mixed = new WorkspaceFilesClient('mixed', vi.fn<FilesTransport>().mockResolvedValue(file('a\r\nb\nc'))); await mixed.open('src/app.ts');
    const html = renderToStaticMarkup(createElement(WorkspaceFiles, { client: mixed, session: { id: 'mixed', state: 'running', expiresAt: '2030-01-01', maxExpiresAt: '2030-01-02' } as Session, now: 0 }));
    expect(html).toContain('Mixed endings · saves normalize to LF'); mixed.dispose();
  });
  it('enforces UTF8 byte limits after restoring CRLF and preserves the prior draft on overflow', async () => {
    const client = new WorkspaceFilesClient('session', vi.fn<FilesTransport>().mockResolvedValue(file('a\r\n'))); await client.open('src/app.ts');
    expect(client.edit('\n'.repeat(65_536))).toBe(true); expect(client.selected?.content.length).toBe(131_072);
    expect(client.edit('\n'.repeat(65_537))).toBe(false); expect(client.selected?.content).toBe('\r\n'.repeat(65_536)); client.dispose();
  });
  it('recognizes explicit Save shortcuts without swallowing composition or alternate keys', () => {
    const base = { key: 's', ctrlKey: false, metaKey: false, altKey: false, isComposing: false };
    expect(isFileSaveShortcut({ ...base, ctrlKey: true })).toBe(true);
    expect(isFileSaveShortcut({ ...base, key: 'S', metaKey: true })).toBe(true);
    expect(isFileSaveShortcut(base)).toBe(false);
    expect(isFileSaveShortcut({ ...base, ctrlKey: true, altKey: true })).toBe(false);
    expect(isFileSaveShortcut({ ...base, ctrlKey: true, isComposing: true })).toBe(false);
  });
  it('makes ended, expired and provisioning workspaces explicitly unavailable', () => {
    const running = { state: 'running', expiresAt: '2030-01-01', maxExpiresAt: '2030-01-02' } as Session;
    expect(filesUnavailableReason(running, 0)).toBe('');
    expect(filesUnavailableReason({ ...running, state: 'ended' }, 0)).toContain('stopped');
    expect(filesUnavailableReason({ ...running, state: 'provisioning' }, 0)).toContain('running');
    expect(filesUnavailableReason(running, Date.parse('2031-01-01'))).toContain('expired');
    const client = new WorkspaceFilesClient('id');
    client.create('draft.txt'); client.edit('<script>alert(1)</script>'); client.setAvailable(false);
    const html = renderToStaticMarkup(createElement(WorkspaceFiles, { client, now: 0, session: { ...running, id: 'id', state: 'ended' } }));
    expect(html).toContain('Files unavailable'); expect(html).toContain('readOnly'); expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).toContain('Your browser drafts are still held in memory');
    client.dispose();
  });
});

describe('explicit file editing and memory retention', () => {
  it('lists, opens and edits without writes, saves only on request with the observed version', async () => {
    const request = vi.fn<FilesTransport>().mockResolvedValueOnce(directory).mockResolvedValueOnce(file()).mockResolvedValueOnce(file('edited', 'src/app.ts', nextVersion));
    const client = new WorkspaceFilesClient('session', request);
    await client.directory(); await client.open('src/app.ts'); client.edit('edited');
    expect(request).toHaveBeenCalledTimes(2); expect(client.dirty).toBe(true);
    await client.save(); expect(request.mock.calls[2]).toEqual(['/sessions/session/file', { path: 'src/app.ts', content: 'edited', expectedVersion: version }, expect.any(AbortSignal)]);
    expect(client.selected).toMatchObject({ content: 'edited', baseline: 'edited', version: nextVersion }); expect(client.dirty).toBe(false); expect(client.state.notice).toContain('simulation'); client.dispose();
  });
  it('keeps newer typing dirty after a delayed save acknowledgment', async () => {
    const delayed = deferred<unknown>(); const request = vi.fn<FilesTransport>().mockResolvedValueOnce(file()).mockImplementationOnce(() => delayed.promise);
    const client = new WorkspaceFilesClient('session', request); await client.open('src/app.ts'); client.edit('submitted');
    const saving = client.save(); client.edit('typed during save'); delayed.resolve(file('submitted', 'src/app.ts', nextVersion)); await saving;
    expect(client.selected).toMatchObject({ content: 'typed during save', baseline: 'submitted', version: nextVersion }); expect(client.dirty).toBe(true); expect(client.state.notice).toContain('Newer edits remain unsaved'); client.dispose();
  });
  it('keeps in-flight writes dirty if typing returns to the old baseline, and cancellation requires reconciliation', async () => {
    const delayed = deferred<unknown>(); const request = vi.fn<FilesTransport>().mockResolvedValueOnce(file()).mockImplementationOnce(() => delayed.promise);
    const dirtyChanged = vi.fn(); const client = new WorkspaceFilesClient('session', request, 35_000, dirtyChanged);
    await client.open('src/app.ts'); client.edit('submitted B'); const saving = client.save(); client.edit('base');
    expect(client.selected?.content).toBe(client.selected?.baseline); expect(client.dirty).toBe(true);
    client.suspend(); await saving;
    expect(client.dirty).toBe(true); expect(client.selected?.uncertain).toBe(true); expect(client.state.error).toContain('unconfirmed');
    delayed.resolve(file('submitted B', 'src/app.ts', nextVersion)); await Promise.resolve();
    expect(client.selected?.content).toBe('base'); expect(client.selected?.uncertain).toBe(true); client.dispose();
  });
  it('tracks a save acknowledged after returning to the old baseline as unsaved against the new remote version', async () => {
    const delayed = deferred<unknown>(); const request = vi.fn<FilesTransport>().mockResolvedValueOnce(file()).mockImplementationOnce(() => delayed.promise);
    const client = new WorkspaceFilesClient('session', request); await client.open('src/app.ts'); client.edit('submitted B'); const saving = client.save(); client.edit('base');
    expect(client.dirty).toBe(true); delayed.resolve(file('submitted B', 'src/app.ts', nextVersion)); await saving;
    expect(client.selected).toMatchObject({ content: 'base', baseline: 'submitted B', version: nextVersion }); expect(client.dirty).toBe(true); client.dispose();
  });
  it('retains multiple drafts across file selection and registry navigation; refresh never replaces text', async () => {
    const request = vi.fn<FilesTransport>().mockResolvedValueOnce(file()).mockResolvedValueOnce(directory);
    const client = new WorkspaceFilesClient('session', request); await client.open('src/app.ts'); client.edit('my draft'); client.create('notes.txt'); client.edit('notes draft');
    await client.directory(); await client.open('src/app.ts');
    expect(client.selected?.content).toBe('my draft'); expect(client.state.drafts.get('notes.txt')?.content).toBe('notes draft'); expect(request).toHaveBeenCalledTimes(2);
    const registry = new WorkspaceFilesRegistry(); const first = registry.get('one')!; first.create('one.txt'); first.edit('retained'); registry.get('two');
    expect(registry.get('one')).toBe(first); expect(registry.get('one')?.selected?.content).toBe('retained'); expect(registry.dirtyFor('one')).toBe(true);
    registry.dispose(); client.dispose();
  });
  it('never silently evicts dirty drafts or replaces one with a new file of the same path', () => {
    const client = new WorkspaceFilesClient('session');
    for (let i = 0; i < 12; i++) { expect(client.create(`${i}.txt`)).toBe(true); client.edit(`draft ${i}`); }
    expect(client.create('overflow.txt')).toBe(false); expect(client.state.drafts.size).toBe(12); expect(client.state.error).toContain('12');
    expect(client.create('0.txt')).toBe(false); expect(client.selected?.content).toBe('draft 0');
    expect(client.edit('é'.repeat(65_537))).toBe(false); expect(client.selected?.content).toBe('draft 0');
    client.discard('0.txt'); expect(client.create('replacement.txt')).toBe(true); client.dispose();
  });
  it('uses null only for explicit new creates and never sends a second request automatically', async () => {
    const request = vi.fn<FilesTransport>().mockRejectedValue(new FileRequestError('Already exists', 409, 'conflict'));
    const client = new WorkspaceFilesClient('session', request); client.create('new.txt'); client.edit('hello'); await client.save();
    expect(request).toHaveBeenCalledTimes(1); expect(request.mock.calls[0][1]?.expectedVersion).toBeNull();
    await client.save(); client.resolveLatest(true); await client.save(); expect(request).toHaveBeenCalledTimes(1); expect(client.selected?.conflict).toBe(true); client.dispose();
  });
  it('blocks direct selection and writes while unavailable while allowing copyable retained drafts', async () => {
    const request = vi.fn<FilesTransport>(); const client = new WorkspaceFilesClient('session', request); client.create('draft.txt'); client.edit('keep'); client.setAvailable(false);
    expect(client.edit('changed')).toBe(false); await client.save(); await client.open('other.txt'); await client.directory();
    expect(client.selected?.content).toBe('keep'); expect(request).not.toHaveBeenCalled(); client.dispose();
  });
});

describe('conflicts, ambiguous saves and cancellation', () => {
  it('preserves conflict drafts, requires a fresh read and lets the user explicitly choose the reviewed baseline', async () => {
    const request = vi.fn<FilesTransport>().mockResolvedValueOnce(file()).mockRejectedValueOnce(new FileRequestError('Changed', 409, 'conflict')).mockResolvedValueOnce(file('Codex edit', 'src/app.ts', nextVersion)).mockResolvedValueOnce(file('my edit', 'src/app.ts', 'c'.repeat(64)));
    const client = new WorkspaceFilesClient('session', request); await client.open('src/app.ts'); client.edit('my edit'); await client.save();
    expect(client.selected).toMatchObject({ content: 'my edit', conflict: true, uncertain: false }); await client.save(); expect(request).toHaveBeenCalledTimes(2);
    await client.reconcile(); expect(client.selected?.content).toBe('my edit'); expect(client.selected?.latest?.content).toBe('Codex edit');
    client.resolveLatest(true); expect(client.selected?.reviewed).toBe(false); expect(client.selected?.version).toBe(nextVersion); expect(client.dirty).toBe(true); await client.save();
    expect(request.mock.calls[3][1]?.expectedVersion).toBe(nextVersion); expect(client.dirty).toBe(false); client.dispose();
  });
  it.each(['network', 'server', 'malformed', 'mismatch'])('treats %s save outcome as unknown and never retries', async mode => {
    const request = vi.fn<FilesTransport>().mockResolvedValueOnce(file());
    if (mode === 'network') request.mockRejectedValueOnce(new Error('Offline'));
    if (mode === 'server') request.mockRejectedValueOnce(new FileRequestError('Unavailable', 503, 'outcome_unknown', true));
    if (mode === 'malformed') request.mockResolvedValueOnce({ success: true });
    if (mode === 'mismatch') request.mockResolvedValueOnce(file('different'));
    const client = new WorkspaceFilesClient('session', request); await client.open('src/app.ts'); client.edit('keep this'); await client.save();
    expect(client.selected).toMatchObject({ content: 'keep this', uncertain: true }); expect(client.state.error).toContain('unconfirmed'); await client.save(); expect(request).toHaveBeenCalledTimes(2); client.dispose();
  });
  it('reconciles a create with a fresh404 without automatic retry or silent draft discard', async () => {
    const request = vi.fn<FilesTransport>().mockRejectedValueOnce(new Error('Disconnected')).mockRejectedValueOnce(new FileRequestError('Absent', 404, 'not_found')).mockResolvedValueOnce(file('new content', 'new.txt'));
    const client = new WorkspaceFilesClient('session', request); client.create('new.txt'); client.edit('new content'); await client.save();
    client.resolveLatest(true); expect(client.selected?.uncertain).toBe(true); await client.save(); expect(request).toHaveBeenCalledTimes(1);
    await client.reconcile(); expect(client.selected?.reviewed).toBe(true); expect(client.selected?.content).toBe('new content'); expect(client.selected?.uncertain).toBe(true); expect(request).toHaveBeenCalledTimes(2);
    const html = renderToStaticMarkup(createElement(WorkspaceFiles, { client, now: 0, session: { id: 'session', state: 'running', expiresAt: '2030-01-01', maxExpiresAt: '2030-01-02' } as Session }));
    expect(html).toContain('Prepare create again'); expect(html).not.toContain('Recreate deleted file');
    client.resolveLatest(true); await client.save(); expect(request.mock.calls[2][1]?.expectedVersion).toBeNull(); expect(client.dirty).toBe(false); client.dispose();
  });
  it('recovers a deleted existing file only after explicit recreate preparation and a separate save', async () => {
    const request = vi.fn<FilesTransport>().mockResolvedValueOnce(file()).mockRejectedValueOnce(new FileRequestError('Deleted', 409, 'conflict')).mockRejectedValueOnce(new FileRequestError('Absent', 404, 'not_found')).mockResolvedValueOnce(file('my edit', 'src/app.ts', nextVersion));
    const client = new WorkspaceFilesClient('session', request); await client.open('src/app.ts'); client.edit('my edit'); await client.save();
    await client.reconcile();
    expect(client.selected).toMatchObject({ content: 'my edit', baseline: 'base', version, isNew: false, conflict: true, reviewed: true, latest: null });
    await client.save(); expect(request).toHaveBeenCalledTimes(3);
    const session = { id: 'session', state: 'running', expiresAt: '2030-01-01', maxExpiresAt: '2030-01-02' } as Session;
    const html = renderToStaticMarkup(createElement(WorkspaceFiles, { session, client, now: 0 }));
    expect(html).toContain('Recreate deleted file'); expect(html).toContain('Select Save file separately');
    client.resolveLatest(false); expect(client.selected?.content).toBe('my edit'); expect(client.selected?.reviewed).toBe(true);
    client.resolveLatest(true);
    expect(client.selected).toMatchObject({ content: 'my edit', version: null, isNew: true, conflict: false, reviewed: false }); expect(request).toHaveBeenCalledTimes(3);
    await client.save(); expect(request.mock.calls[3][1]).toEqual({ path: 'src/app.ts', content: 'my edit', expectedVersion: null }); expect(client.dirty).toBe(false); client.dispose();
  });
  it('keeps an uncertain existing write and newer typing intact through a missing-file reconciliation', async () => {
    const absent = deferred<unknown>();
    const request = vi.fn<FilesTransport>().mockResolvedValueOnce(file()).mockRejectedValueOnce(new Error('Disconnected')).mockImplementationOnce(() => absent.promise);
    const client = new WorkspaceFilesClient('session', request); await client.open('src/app.ts'); client.edit('submitted'); await client.save();
    const reading = client.reconcile(); client.edit('typed while checking'); absent.reject(new FileRequestError('Absent', 404, 'not_found')); await reading;
    expect(client.selected).toMatchObject({ content: 'typed while checking', baseline: 'base', version, isNew: false, uncertain: true, reviewed: true, latest: null });
    await client.save(); expect(request).toHaveBeenCalledTimes(3);
    client.resolveLatest(true); expect(client.selected).toMatchObject({ content: 'typed while checking', version: null, isNew: true, uncertain: false }); expect(request).toHaveBeenCalledTimes(3); client.dispose();
  });
  it('makes a clean missing existing file dirty only when recreation is explicitly prepared', async () => {
    const request = vi.fn<FilesTransport>().mockResolvedValueOnce(file()).mockRejectedValueOnce(new FileRequestError('Absent', 404, 'not_found'));
    const client = new WorkspaceFilesClient('session', request); await client.open('src/app.ts'); await client.reconcile();
    expect(client.selected).toMatchObject({ content: 'base', baseline: 'base', version, isNew: false, reviewed: true }); expect(client.dirty).toBe(false);
    await client.save(); expect(request).toHaveBeenCalledTimes(2);
    client.resolveLatest(true); expect(client.selected).toMatchObject({ content: 'base', isNew: true, version: null }); expect(client.dirty).toBe(true); expect(request).toHaveBeenCalledTimes(2); client.dispose();
  });
  it('preserves the draft when a file appears after deletion review and before the separate recreate save', async () => {
    const request = vi.fn<FilesTransport>().mockResolvedValueOnce(file()).mockRejectedValueOnce(new FileRequestError('Absent', 404, 'not_found')).mockRejectedValueOnce(new FileRequestError('Already exists', 409, 'conflict')).mockResolvedValueOnce(file('appeared', 'src/app.ts', nextVersion));
    const client = new WorkspaceFilesClient('session', request); await client.open('src/app.ts'); client.edit('keep mine'); await client.reconcile(); client.resolveLatest(true); await client.save();
    expect(request.mock.calls[2][1]).toEqual({ path: 'src/app.ts', content: 'keep mine', expectedVersion: null });
    expect(client.selected).toMatchObject({ content: 'keep mine', isNew: true, conflict: true, uncertain: false });
    await client.save(); expect(request).toHaveBeenCalledTimes(3);
    await client.reconcile(); expect(client.selected).toMatchObject({ content: 'keep mine', latest: { content: 'appeared', version: nextVersion }, reviewed: true }); client.dispose();
  });
  it.each([401, 403, 410, 503])('does not treat HTTP%s during reconciliation as a missing file or clear save uncertainty', async status => {
    const request = vi.fn<FilesTransport>().mockResolvedValueOnce(file()).mockRejectedValueOnce(new Error('Disconnected')).mockRejectedValueOnce(new FileRequestError('Unavailable', status));
    const client = new WorkspaceFilesClient('session', request); await client.open('src/app.ts'); client.edit('keep'); await client.save(); await client.reconcile();
    expect(client.selected).toMatchObject({ content: 'keep', baseline: 'base', version, isNew: false, uncertain: true, reviewed: false }); expect(client.state.error).toContain('Unavailable');
    client.resolveLatest(true); await client.save(); expect(request).toHaveBeenCalledTimes(3); client.dispose();
  });
  it.each(['network', 'malformed'])('does not treat a %s read failure as a missing file', async mode => {
    const request = vi.fn<FilesTransport>().mockResolvedValueOnce(file()).mockRejectedValueOnce(new Error('Disconnected'));
    if (mode === 'network') request.mockRejectedValueOnce(new Error('Offline'));
    else request.mockResolvedValueOnce({ success: true });
    const client = new WorkspaceFilesClient('session', request); await client.open('src/app.ts'); client.edit('keep'); await client.save(); await client.reconcile();
    expect(client.selected).toMatchObject({ content: 'keep', baseline: 'base', version, isNew: false, uncertain: true, reviewed: false });
    client.resolveLatest(true); await client.save(); expect(request).toHaveBeenCalledTimes(3); expect(client.state.error).toContain('preserved'); client.dispose();
  });
  it('can explicitly replace a draft with the current machine file after review', async () => {
    const request = vi.fn<FilesTransport>().mockResolvedValueOnce(file()).mockResolvedValueOnce(file('latest', 'src/app.ts', nextVersion));
    const client = new WorkspaceFilesClient('session', request); await client.open('src/app.ts'); client.edit('mine'); await client.reconcile(); client.resolveLatest(false);
    expect(client.selected).toMatchObject({ content: 'latest', baseline: 'latest', version: nextVersion, reviewed: false }); expect(client.dirty).toBe(false); client.dispose();
  });
  it.each([413, 415, 400])('preserves content on definite rejected save HTTP%s', async status => {
    const request = vi.fn<FilesTransport>().mockRejectedValue(new FileRequestError('Rejected', status));
    const client = new WorkspaceFilesClient('session', request); client.create('new.txt'); client.edit('draft'); await client.save();
    expect(client.selected).toMatchObject({ content: 'draft', uncertain: false, conflict: false }); expect(client.state.error).toContain('preserved'); client.dispose();
  });
  it('times out a save, aborts its signal, preserves the draft and fences late success', async () => {
    vi.useFakeTimers(); const late = deferred<unknown>(); const request = vi.fn<FilesTransport>().mockImplementation(() => late.promise);
    const client = new WorkspaceFilesClient('session', request, 10); client.create('new.txt'); client.edit('draft'); const pending = client.save();
    await vi.advanceTimersByTimeAsync(11); await pending; expect(request.mock.calls[0][2].aborted).toBe(true); expect(client.selected?.uncertain).toBe(true);
    late.resolve(file('draft', 'new.txt')); await Promise.resolve(); expect(client.selected?.version).toBeNull(); expect(client.selected?.uncertain).toBe(true); client.dispose();
  });
  it('suspends aborted reads and never exposes their late response in another selection or disposed account', async () => {
    const late = deferred<unknown>(); const request = vi.fn<FilesTransport>().mockImplementationOnce(() => late.promise).mockResolvedValueOnce(file('other', 'other.txt'));
    const client = new WorkspaceFilesClient('session', request); const pending = client.open('src/app.ts'); client.suspend(); await pending;
    await client.open('other.txt'); late.resolve(file()); await Promise.resolve(); expect(client.selected?.path).toBe('other.txt'); expect(client.state.drafts.has('src/app.ts')).toBe(false);
    client.dispose(); expect(request.mock.calls[0][2].aborted).toBe(true);
  });
  it('marks a save interrupted by navigation as unconfirmed and blocks writes after session ends', async () => {
    const late = deferred<unknown>(); const request = vi.fn<FilesTransport>().mockImplementation(() => late.promise);
    const client = new WorkspaceFilesClient('session', request); client.create('new.txt'); client.edit('keep'); const pending = client.save(); client.setAvailable(false); await pending;
    expect(client.selected).toMatchObject({ uncertain: true, content: 'keep' }); client.setAvailable(true); await client.save(); expect(request).toHaveBeenCalledTimes(1);
    late.resolve(file('keep', 'new.txt')); await Promise.resolve(); expect(draftDirty(client.selected!)).toBe(true); client.dispose();
  });
});
