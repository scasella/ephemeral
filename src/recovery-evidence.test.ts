import { describe, expect, it, vi } from 'vitest';
import { HandoffNotesClient, NoteRequestError, type HandoffNotesResponse, type NoteEditorState } from './handoff-notes';
import { emptyPublishedView, publishedReviewReady, type PublishedChanges, type PublishedViewState } from './published-changes';
import { confirmedNotesResponse, confirmedSavedNote, retainPublishedObservation } from './recovery-evidence';

const note = (revision: number, nextStep: string): HandoffNotesResponse => ({ sessionId: 'source', inherited: null, note: { revision, updatedAt: revision ? '2026-10-14T12:00:00.000Z' : null, nextStep, unresolvedIssues: '', verification: '' } });
const state = (changes: Partial<NoteEditorState> = {}): NoteEditorState => ({ saved: note(1, 'Saved text'), current: null, draft: { nextStep: 'Unsaved text', unresolvedIssues: '', verification: '' }, busy: false, error: '', message: '', blocked: false, ...changes });

describe('retained published observations within one scope', () => {
  const checkedAt = '2026-10-14T12:00:00Z';
  const snapshot: PublishedChanges = { state: 'known', checkedAt, reason: null, repository: 'owner/repo', headBranch: 'work', baseBranch: 'main', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), mergeBaseSha: 'c'.repeat(40), aheadCommits: 1, behindCommits: 0, comparisonUrl: null, listTruncated: false, files: [{ path: 'file.ts', previousPath: null, status: 'added', additions: 1, deletions: 0, changes: 1 }], selected: { path: 'file.ts', state: 'patch', text: '+saved', truncated: false, reason: null } };
  const prior: PublishedViewState = { ...emptyPublishedView, snapshot, latest: snapshot, selectedPath: 'file.ts' };

  it.each([
    ['mount', emptyPublishedView],
    ['loading', { ...emptyPublishedView, loading: true }],
    ['error', { ...emptyPublishedView, error: 'Check failed' }],
    ['unavailable result', { ...emptyPublishedView, latest: { ...snapshot, state: 'unavailable', reason: 'No access', selected: null, files: [] }, error: 'No access' }],
  ] as Array<[string, PublishedViewState]>)('keeps dated facts unconfirmed after %s, preserving the new check state', (_, incoming) => {
    const retained = retainPublishedObservation(prior, incoming);
    expect(retained).toEqual({ ...incoming, snapshot: { ...snapshot, selected: null }, stale: true });
    expect(retained.latest).toBe(incoming.latest);
    expect(publishedReviewReady(retained, Date.parse(checkedAt))).toBe(false);
    expect(prior.snapshot?.selected?.text).toBe('+saved');
  });

  it('accepts new confirmed snapshots including no_changes without retaining the old patch', () => {
    const noChanges: PublishedChanges = { ...snapshot, state: 'no_changes', checkedAt: '2026-10-14T12:01:00Z', files: [], selected: null, aheadCommits: 0 };
    const incoming = { ...emptyPublishedView, snapshot: noChanges, latest: noChanges };
    expect(retainPublishedObservation(prior, incoming)).toBe(incoming);
    expect(retainPublishedObservation(prior, prior)).toBe(prior);
  });

  it('does not invent an observation when no prior snapshot exists', () => {
    const incoming = { ...emptyPublishedView, loading: true };
    expect(retainPublishedObservation(null, incoming)).toBe(incoming);
    expect(retainPublishedObservation(undefined, incoming)).toBe(incoming);
    expect(retainPublishedObservation(emptyPublishedView, incoming)).toBe(incoming);
  });
});

describe('confirmed persisted recovery notes', () => {
  const inherited = { sourceSessionId: 'ancestor', sourceBranch: 'ancestor-branch', capturedAt: '2026-10-14T12:00:00.000Z', sourceNoteRevision: 2, sourceNoteUpdatedAt: '2026-10-14T12:00:00.000Z', nextStep: 'Inherited text', unresolvedIssues: '', verification: '' };

  it('confirms an inherited saved note independently of an unsaved own note or a changed draft', () => {
    const saved = { ...note(0, ''), inherited };
    const next = state({ saved, draft: { nextStep: 'Unsaved replacement', unresolvedIssues: '', verification: '' } });
    expect(confirmedNotesResponse(next)?.inherited).toBe(inherited);
    expect(confirmedSavedNote(next)?.revision).toBe(0);
    expect(confirmedSavedNote(next)?.nextStep).toBe('');
  });

  it('takes inherited presence and absence from the latest confirmed server response', () => {
    const saved = { ...note(1, 'Own note'), inherited };
    const current = note(2, 'Latest own note');
    expect(confirmedNotesResponse(state({ saved, current }))?.inherited).toBeNull();
    const checked = { ...current, inherited };
    expect(confirmedNotesResponse(state({ saved: note(1, 'Own note'), current: checked, blocked: true }))?.inherited).toBe(inherited);
  });

  it('leaves inherited presence unknown whenever the persisted response is unconfirmed', () => {
    const saved = { ...note(0, ''), inherited };
    for (const changes of [{ busy: true }, { error: 'Check failed' }, { blocked: true }, { saved: null }]) {
      expect(confirmedNotesResponse(state({ saved, ...changes }))).toBeNull();
    }
    expect(confirmedNotesResponse(state({ saved, current: saved, busy: true }))).toBeNull();
    expect(confirmedNotesResponse(state({ saved, current: saved, error: 'Check failed' }))).toBeNull();
  });

  it('reports the saved version while keeping unsaved and inherited drafts out of the evidence', () => {
    const saved = { ...note(1, 'Saved text'), inherited: { sourceSessionId: 'ancestor', sourceBranch: 'ancestor-branch', capturedAt: '2026-10-14T12:00:00.000Z', sourceNoteRevision: 2, sourceNoteUpdatedAt: '2026-10-14T12:00:00.000Z', nextStep: 'Inherited text', unresolvedIssues: '', verification: '' } };
    expect(confirmedSavedNote(state({ saved, draft: saved.inherited }))).toEqual(saved.note);
    expect(confirmedSavedNote(state({ saved: null }))).toBeNull();
    expect(confirmedSavedNote(state({ saved: note(0, '') }))).toEqual(note(0, '').note);
  });

  it('prefers the latest checked server version even when a conflicted draft remains blocked', () => {
    const current = note(3, 'Other editor saved this');
    expect(confirmedSavedNote(state({ current, blocked: true }))).toBe(current.note);
    expect(confirmedSavedNote(state({ blocked: true }))).toBeNull();
  });

  it('invalidates evidence while loading or after an error, including a prior current version', () => {
    const current = note(3, 'Prior server text');
    expect(confirmedSavedNote(state({ current, busy: true }))).toBeNull();
    expect(confirmedSavedNote(state({ current, error: 'Latest check failed' }))).toBeNull();
  });

  it('publishes a checked server note without publishing or replacing the retained draft', async () => {
    const observations: ReturnType<typeof confirmedSavedNote>[] = [];
    const request = vi.fn().mockResolvedValueOnce(note(1, 'Saved text')).mockResolvedValueOnce(note(2, 'Other editor text'));
    const client = new HandoffNotesClient(request, next => observations.push(confirmedSavedNote(next)));
    await client.load();
    client.edit({ nextStep: 'My unsaved text', unresolvedIssues: '', verification: '' });
    const pending = client.load();
    expect(observations.at(-1)).toBeNull();
    await pending;
    expect(observations.at(-1)?.nextStep).toBe('Other editor text');
    expect(client.state.draft.nextStep).toBe('My unsaved text');
    expect(client.state.saved?.note.nextStep).toBe('Saved text');
    expect(observations.every(value => value?.nextStep !== 'My unsaved text')).toBe(true);
    client.dispose();
  });

  it('withholds an uncertain save and restores evidence only after a successful saved-note check', async () => {
    const observations: ReturnType<typeof confirmedSavedNote>[] = [];
    const request = vi.fn().mockResolvedValueOnce(note(1, 'Saved text')).mockRejectedValueOnce(new NoteRequestError('Reply lost', 'unknown')).mockResolvedValueOnce(note(2, 'Submitted text'));
    const client = new HandoffNotesClient(request, next => observations.push(confirmedSavedNote(next)));
    await client.load();
    client.edit({ nextStep: 'Submitted text', unresolvedIssues: '', verification: '' });
    await client.save();
    expect(observations.at(-1)).toBeNull();
    expect(client.state.blocked).toBe(true);
    await client.load();
    expect(observations.at(-1)?.nextStep).toBe('Submitted text');
    expect(observations.at(-1)?.revision).toBe(2);
    expect(request.mock.calls[2][1]).toBeUndefined();
    client.dispose();
  });
});
