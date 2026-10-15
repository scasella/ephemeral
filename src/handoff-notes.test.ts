import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HandoffNotes, NoteVersion, SavedNoteText } from './HandoffNotes';
import { HandoffNotesClient, NoteRequestError, normalizeNote, requestHandoffNotes, type HandoffNotesResponse } from './handoff-notes';

const empty: HandoffNotesResponse = { sessionId: 'source', note: { revision: 0, updatedAt: null, nextStep: '', unresolvedIssues: '', verification: '' }, inherited: null };
const saved = (revision = 1, nextStep = 'Continue here'): HandoffNotesResponse => ({ ...empty, note: { ...empty.note, revision, updatedAt: '2026-10-14T12:00:00.000Z', nextStep } });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('concise saved note presentation', () => {
  it('renders an empty note briefly and preserves populated plaintext fields', () => {
    const blank = renderToStaticMarkup(createElement(SavedNoteText, { note: empty.note }));
    expect(blank).toContain('No note text.'); expect(blank).not.toContain('<dl'); expect(blank).not.toContain('(empty)');
    const html = renderToStaticMarkup(createElement(SavedNoteText, { note: { ...empty.note, nextStep: 'Continue\non branch', verification: 'Tests passed' } }));
    expect(html).toContain('Next step'); expect(html).toContain('Continue\non branch'); expect(html).toContain('Verification'); expect(html).toContain('Tests passed'); expect(html).not.toContain('Unresolved issues');
    const version = renderToStaticMarkup(createElement(NoteVersion, { note: saved(3).note }));
    expect(version).toContain('Saved revision 3'); expect(version).toContain('dateTime="2026-10-14T12:00:00.000Z"');
    expect(renderToStaticMarkup(createElement(NoteVersion, { note: empty.note }))).toContain('No note saved yet.');
  });
  it('starts in read mode and keeps a hidden Notes panel inert without exposing disabled editors', () => {
    const session = { id: 'source', userId: 'owner' } as Parameters<typeof HandoffNotes>[0]['session'];
    const html = renderToStaticMarkup(createElement(HandoffNotes, { session, visible: false, onSelectSource: () => {} }));
    expect(html).toContain('hidden="" inert=""'); expect(html).toContain('Edit note'); expect(html).toContain('Saved note has not loaded.');
    expect(html).not.toContain('<textarea'); expect(html).not.toContain('Clear draft'); expect(html).not.toContain('Save note</button>');
    expect(html).toContain('Continuations copy the saved version only.'); expect(html).toContain('How saved notes are used');
  });
});
describe('scoped handoff note editor', () => {
  it('guards a focusable Save action against clean drafts and repeated activation during a pending save', async () => {
    let resolve!: (value: HandoffNotesResponse) => void;
    const request = vi.fn().mockResolvedValueOnce(empty).mockImplementationOnce(() => new Promise<HandoffNotesResponse>(done => { resolve = done; }));
    const client = new HandoffNotesClient(request, vi.fn()); await client.load();
    await client.save(); expect(request).toHaveBeenCalledTimes(1);
    client.edit({ ...empty.note, nextStep: 'Continue here' });
    const pending = client.save(); await client.save(); expect(request).toHaveBeenCalledTimes(2);
    resolve(saved()); await pending; await client.save(); expect(request).toHaveBeenCalledTimes(2); client.dispose();
  });
  it('loads separately and retains a dirty draft when saved notes are checked', async () => {
    const request = vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce(saved());
    const client = new HandoffNotesClient(request, vi.fn());
    await client.load(); client.edit({ ...empty.note, nextStep: 'My unsaved draft' });
    await client.load(); expect(client.state.draft.nextStep).toBe('My unsaved draft'); expect(client.state.current?.note.revision).toBe(1); expect(client.state.saved?.note.revision).toBe(0);
    client.dispose();
  });
  it('uses the reviewed revision for writes and keeps a conflict draft until explicit reload', async () => {
    const request = vi.fn().mockResolvedValueOnce(saved(2)).mockRejectedValueOnce(new NoteRequestError('Changed', 'conflict')).mockResolvedValueOnce(saved(3, 'Other editor')).mockResolvedValueOnce(saved(3, 'Other editor'));
    const client = new HandoffNotesClient(request, vi.fn()); await client.load(); client.edit({ ...empty.note, nextStep: 'Mine' }); await client.save();
    expect(request.mock.calls[1][1]).toMatchObject({ expectedRevision: 2, nextStep: 'Mine' }); expect(client.state.blocked).toBe(true); expect(client.state.draft.nextStep).toBe('Mine');
    await client.save(); expect(request).toHaveBeenCalledTimes(2);
    await client.load(); expect(client.state.current?.note.nextStep).toBe('Other editor'); expect(client.state.draft.nextStep).toBe('Mine'); expect(client.state.blocked).toBe(true);
    await client.load(true); expect(client.state.draft.nextStep).toBe('Other editor'); expect(client.state.blocked).toBe(false); client.dispose();
  });
  it('recovers a lost reply by checking the saved revision without retrying the POST', async () => {
    const request = vi.fn().mockResolvedValueOnce(empty).mockRejectedValueOnce(new TypeError('Network lost')).mockResolvedValueOnce(saved());
    const client = new HandoffNotesClient(request, vi.fn()); await client.load(); client.edit({ ...empty.note, nextStep: ' Continue here\r\n' }); await client.save();
    expect(client.state.blocked).toBe(true); expect(client.state.draft.nextStep).toBe(' Continue here\r\n'); await client.save(); expect(request).toHaveBeenCalledTimes(2);
    await client.load(); expect(client.state.blocked).toBe(false); expect(client.state.saved?.note.revision).toBe(1); expect(client.state.draft.nextStep).toBe(' Continue here\r\n'); expect(request.mock.calls[2][1]).toBeUndefined(); client.dispose();
  });
  it('keeps the draft and requires recovery when a successful response does not confirm the submitted text', async () => {
    const request = vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce(saved(1, 'Different text'));
    const client = new HandoffNotesClient(request, vi.fn()); await client.load(); client.edit({ ...empty.note, nextStep: 'My draft' }); await client.save();
    expect(client.state.blocked).toBe(true); expect(client.state.saved?.note.revision).toBe(0); expect(client.state.draft.nextStep).toBe('My draft'); expect(client.state.error).toContain('uncertain'); client.dispose();
  });
  it('keeps later edits if a pending save completes', async () => {
    let resolve!: (value: HandoffNotesResponse) => void;
    const request = vi.fn().mockResolvedValueOnce(empty).mockImplementationOnce(() => new Promise<HandoffNotesResponse>(r => { resolve = r; }));
    const client = new HandoffNotesClient(request, vi.fn()); await client.load(); client.edit({ ...empty.note, nextStep: 'Continue here' }); const pending = client.save(); client.edit({ ...empty.note, nextStep: 'Later draft' }); resolve(saved()); await pending;
    expect(client.state.saved?.note.nextStep).toBe('Continue here'); expect(client.state.draft.nextStep).toBe('Later draft'); expect(client.dirty).toBe(true); client.dispose();
  });
  it('coalesces reads, aborts timed-out writes, and ignores late responses', async () => {
    vi.useFakeTimers(); let resolve!: (value: HandoffNotesResponse) => void; let signal!: AbortSignal;
    const publish = vi.fn(); const request = vi.fn().mockResolvedValueOnce(empty).mockImplementationOnce((value: AbortSignal) => { signal = value; return new Promise<HandoffNotesResponse>(r => { resolve = r; }); });
    const client = new HandoffNotesClient(request, publish, 100); const first = client.load(); expect(client.load()).toBe(first); await first; client.edit({ ...empty.note, nextStep: 'Continue here' }); const pending = client.save(); await vi.advanceTimersByTimeAsync(100); await pending;
    expect(signal.aborted).toBe(true); expect(client.state.blocked).toBe(true); expect(client.state.saved?.note.revision).toBe(0); resolve(saved()); await Promise.resolve(); expect(client.state.saved?.note.revision).toBe(0); client.dispose();
  });
  it('aborts and settles disposed work without publishing across account/session scopes', async () => {
    let resolve!: (value: HandoffNotesResponse) => void; let signal!: AbortSignal; const publish = vi.fn();
    const client = new HandoffNotesClient(value => { signal = value; return new Promise(r => { resolve = r; }); }, publish);
    const pending = client.load(); const count = publish.mock.calls.length; client.dispose(); await pending; resolve(saved()); await Promise.resolve(); expect(signal.aborted).toBe(true); expect(publish).toHaveBeenCalledTimes(count);
    const other = new HandoffNotesClient(async () => empty, vi.fn()); expect(other.state.draft.nextStep).toBe(''); other.dispose();
  });
  it('normalizes accepted plaintext without executing or interpreting it', () => {
    const malicious = '<img src="https://untrusted.invalid/x" onerror="alert(1)">\n[open](https://untrusted.invalid)';
    const markup = renderToStaticMarkup(createElement(SavedNoteText, { note: { nextStep: malicious, unresolvedIssues: '', verification: '' } }));
    expect(markup).toContain('&lt;img'); expect(markup).not.toContain('<img'); expect(markup).not.toContain('<a'); expect(normalizeNote({ nextStep: '  a\r\nb  ', unresolvedIssues: '', verification: '' }).nextStep).toBe('a\nb');
  });
});
describe('isolated handoff note transport', () => {
  it('validates the response scope and distinguishes conflicts from unknown outcomes', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => empty }).mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'changed', code: 'note_revision_conflict' }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ ...empty, sessionId: 'other' }) }); vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal; await expect(requestHandoffNotes('source', signal)).resolves.toEqual(empty);
    expect(fetch.mock.calls[0][0]).toBe('/api/sessions/source/handoff-notes'); await expect(requestHandoffNotes('source', signal, { ...empty.note, expectedRevision: 0 })).rejects.toMatchObject({ kind: 'conflict' }); await expect(requestHandoffNotes('source', signal)).rejects.toMatchObject({ kind: 'unknown' });
  });
});


describe('malformed saved and inherited note responses', () => {
  const targetId = '11111111-1111-4111-8111-111111111111';
  const sourceId = '22222222-2222-4222-8222-222222222222';
  const lineage = { sourceSessionId: sourceId, sourceBranch: 'ephemeral/source', commitSha: 'a'.repeat(40), verifiedAt: '2026-10-14T12:00:00.000Z' };
  const inherited = { sourceSessionId: sourceId, sourceBranch: lineage.sourceBranch, sourceNoteRevision: 1, sourceNoteUpdatedAt: '2026-10-14T12:00:00.000Z', capturedAt: '2026-10-14T12:01:00.000Z', sourceCommitSha: lineage.commitSha, nextStep: 'Exact source text', unresolvedIssues: '', verification: 'Checked' };
  const response = { ...empty, sessionId: targetId, inherited };
  it('accepts only an inherited snapshot matching the target continuation', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => response }); vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    await expect(requestHandoffNotes(targetId, signal, undefined, lineage)).resolves.toEqual(response);
    await expect(requestHandoffNotes(targetId, signal, undefined, null)).rejects.toMatchObject({ kind: 'unknown' });
    const zeroSnapshot = { ...inherited, sourceNoteRevision: 0, sourceNoteUpdatedAt: null, nextStep: '', verification: '' };
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ...response, inherited: zeroSnapshot }) });
    await expect(requestHandoffNotes(targetId, signal, undefined, lineage)).resolves.toMatchObject({ inherited: zeroSnapshot });
  });
  it('rejects malformed text, revisions, times and source provenance as an uncertain response', async () => {
    const malformed = [
      undefined, [], 'text', { ...inherited, nextStep: { html: 'crash' } }, { ...inherited, unresolvedIssues: null },
      { ...inherited, verification: 'x'.repeat(2001) }, { ...inherited, nextStep: '\u0000' },
      { ...inherited, sourceSessionId: 'bad' }, { ...inherited, sourceSessionId: targetId },
      { ...inherited, sourceSessionId: '33333333-3333-4333-8333-333333333333' },
      { ...inherited, sourceBranch: '' }, { ...inherited, sourceBranch: 'another-branch' },
      { ...inherited, sourceNoteRevision: -1 }, { ...inherited, sourceNoteRevision: 2147483648 },
      { ...inherited, sourceNoteRevision: 0 }, { ...inherited, sourceNoteUpdatedAt: null },
      { ...inherited, sourceNoteUpdatedAt: 'invalid' }, { ...inherited, capturedAt: null },
      { ...inherited, capturedAt: 'invalid' }, { ...inherited, sourceCommitSha: 4 },
      { ...inherited, sourceCommitSha: 'bad' }, { ...inherited, sourceCommitSha: 'b'.repeat(40) },
    ];
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const signal = new AbortController().signal;
    for (const value of malformed) {
      fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ...response, inherited: value }) });
      await expect(requestHandoffNotes(targetId, signal, undefined, lineage)).rejects.toMatchObject({ kind: 'unknown' });
    }
  });
  it('requires the zero revision and null timestamp together and rejects out-of-int32 revisions', async () => {
    const malformed = [null, { ...empty.note, updatedAt: '2026-10-14T12:00:00.000Z' }, { ...empty.note, nextStep: 'No stored version' }, { ...saved().note, updatedAt: null }, { ...saved().note, revision: 2147483648 }];
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const signal = new AbortController().signal;
    for (const note of malformed) { fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ...empty, note }) }); await expect(requestHandoffNotes('source', signal)).rejects.toMatchObject({ kind: 'unknown' }); }
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ...empty, note: { ...saved().note, revision: 2147483647 } }) });
    await expect(requestHandoffNotes('source', signal)).resolves.toMatchObject({ note: { revision: 2147483647 } });
  });
  it('rejects bare CR and controls before trimming exactly like the server, without losing the draft', async () => {
    const request = vi.fn().mockResolvedValue(empty); const client = new HandoffNotesClient(request, vi.fn()); await client.load();
    const draft = { nextStep: 'Good text\r', unresolvedIssues: '', verification: '' }; client.edit(draft); await client.save();
    expect(request).toHaveBeenCalledTimes(1); expect(client.state.draft).toEqual(draft); expect(client.state.error).toContain('control characters');
    expect(() => normalizeNote({ ...draft, nextStep: 'trim\u000b' })).toThrow('control characters'); client.dispose();
  });
});
