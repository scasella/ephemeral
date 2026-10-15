import type { HandoffNote, HandoffNoteFields, HandoffNotesResponse, InheritedHandoffNote, SessionContinuation } from '../server/contracts';
export type { HandoffNote, HandoffNoteFields, HandoffNotesResponse, InheritedHandoffNote } from '../server/contracts';

export const noteFields = ['nextStep', 'unresolvedIssues', 'verification'] as const;
export const noteLabels: Record<typeof noteFields[number], string> = { nextStep: 'Next step', unresolvedIssues: 'Unresolved issues', verification: 'Verification' };
export const emptyNoteFields = (): HandoffNoteFields => ({ nextStep: '', unresolvedIssues: '', verification: '' });
export const maxExpectedNoteRevision = 2147483646;
const maxNoteRevision = 2147483647;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const shaPattern = /^[a-f0-9]{40}$/i;
function validTime(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
export function normalizeNote(note: HandoffNoteFields): HandoffNoteFields {
  return Object.fromEntries(noteFields.map(field => {
    const text = note[field].replace(/\r\n/g, '\n');
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) throw new Error('Notes cannot contain control characters. Your draft is kept.');
    const normalized = text.trim();
    if (normalized.length > 2000) throw new Error('Each note field must contain at most 2000 characters. Your draft is kept.');
    return [field, normalized];
  })) as unknown as HandoffNoteFields;
}
export function sameNote(a: HandoffNoteFields, b: HandoffNoteFields) { return noteFields.every(field => a[field] === b[field]); }
export function noteText(note: HandoffNoteFields): string { return noteFields.map(field => `${noteLabels[field]}\n${note[field] || '(empty)'}`).join('\n\n'); }
export function validNote(value: unknown): value is HandoffNote {
  if (!value || typeof value !== 'object') return false;
  const note = value as HandoffNote;
  return Number.isInteger(note.revision) && note.revision >= 0 && note.revision <= maxNoteRevision && (note.revision === 0 ? note.updatedAt === null : validTime(note.updatedAt)) && noteFields.every(field => typeof note[field] === 'string' && note[field].length <= 2000 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(note[field]) && (note.revision !== 0 || note[field] === ''));
}
export function validInheritedNote(value: unknown, targetSessionId: string, lineage?: SessionContinuation | null): value is InheritedHandoffNote {
  if (!value || typeof value !== 'object' || lineage === null) return false;
  const inherited = value as InheritedHandoffNote;
  if (!validNote({ ...inherited, revision: inherited.sourceNoteRevision, updatedAt: inherited.sourceNoteUpdatedAt }) ||
    typeof inherited.sourceSessionId !== 'string' || !uuidPattern.test(inherited.sourceSessionId) || inherited.sourceSessionId === targetSessionId ||
    typeof inherited.sourceBranch !== 'string' || !inherited.sourceBranch.trim() || !validTime(inherited.capturedAt) ||
    (inherited.sourceCommitSha !== undefined && (typeof inherited.sourceCommitSha !== 'string' || !shaPattern.test(inherited.sourceCommitSha)))) return false;
  return lineage === undefined || (inherited.sourceSessionId === lineage.sourceSessionId && inherited.sourceBranch === lineage.sourceBranch &&
    (inherited.sourceCommitSha === undefined || inherited.sourceCommitSha.toLowerCase() === lineage.commitSha.toLowerCase()));
}
export class NoteRequestError extends Error {
  constructor(message: string, readonly kind: 'conflict' | 'rejected' | 'unknown') { super(message); }
}
export async function requestHandoffNotes(sessionId: string, signal: AbortSignal, write?: HandoffNoteFields & { expectedRevision: number }, lineage?: SessionContinuation | null): Promise<HandoffNotesResponse> {
  let response: Response;
  try { response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/handoff-notes`, { credentials: 'same-origin', signal, ...(write ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1' }, body: JSON.stringify(write) } : {}) }); }
  catch (error) { throw new NoteRequestError((error as Error).message || 'The request failed.', 'unknown'); }
  const data = await response.json().catch(() => { throw new NoteRequestError('The server response could not be read.', 'unknown'); });
  if (!response.ok) throw new NoteRequestError((typeof data?.error === 'string' ? data.error : null) || `Request failed (${response.status}).`, response.status === 409 && data?.code === 'note_revision_conflict' ? 'conflict' : response.status >= 400 && response.status < 500 ? 'rejected' : 'unknown');
  if (!data || typeof data !== 'object' || data.sessionId !== sessionId || !validNote(data.note) || (data.inherited !== null && !validInheritedNote(data.inherited, sessionId, lineage))) throw new NoteRequestError('The response could not confirm this machine’s saved note.', 'unknown');
  return data;
}
export interface NoteEditorState {
  saved: HandoffNotesResponse | null; draft: HandoffNoteFields; busy: boolean;
  message: string; error: string; blocked: boolean; current: HandoffNotesResponse | null;
}
type NoteTransport = (signal: AbortSignal, write?: HandoffNoteFields & { expectedRevision: number }) => Promise<HandoffNotesResponse>;
/** A scoped editor model: ordinary checks never replace the draft, and uncertain writes require recovery. */
export class HandoffNotesClient {
  state: NoteEditorState = { saved: null, draft: emptyNoteFields(), busy: false, message: '', error: '', blocked: false, current: null };
  private disposed = false;
  private pending: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private release: (() => void) | null = null;
  private attempt: (HandoffNoteFields & { expectedRevision: number }) | null = null;
  constructor(private request: NoteTransport, private publish: (state: NoteEditorState) => void, private timeoutMs = 15_000) {}
  private update(changes: Partial<NoteEditorState>) { if (!this.disposed) { this.state = { ...this.state, ...changes }; this.publish(this.state); } }
  get dirty() { return Boolean(this.state.saved && !sameNote(this.state.draft, this.state.saved.note)); }
  edit(draft: HandoffNoteFields) { this.update({ draft, message: '' }); }
  private run(action: (signal: AbortSignal) => Promise<void>) {
    if (this.disposed) return Promise.resolve();
    if (this.pending) return this.pending;
    const controller = this.controller = new AbortController();
    this.update({ busy: true, error: '', message: '' });
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { this.release = () => reject(new NoteRequestError('The request was cancelled.', 'unknown')); timer = setTimeout(() => { controller.abort(); reject(new NoteRequestError('The note request timed out.', 'unknown')); }, this.timeoutMs); });
    this.pending = Promise.race([action(controller.signal), timeout]).catch(error => { if (!this.disposed) { const failure = error instanceof NoteRequestError ? error : new NoteRequestError((error as Error).message, 'unknown'); const uncertain = Boolean(this.attempt && failure.kind === 'unknown'); this.update({ error: failure.kind === 'conflict' ? 'These notes changed in another editor. Your draft is kept. Check the saved note, then review or reload before saving.' : uncertain ? `${failure.message} The save outcome is uncertain. Your draft is kept. Check saved note to recover before saving again.` : failure.message, blocked: uncertain || failure.kind === 'conflict' || this.state.blocked }); if (failure.kind !== 'unknown') this.attempt = null; } }).finally(() => { clearTimeout(timer!); this.release = null; this.controller = null; this.pending = null; this.update({ busy: false }); });
    return this.pending;
  }
  load(replaceDraft = false) {
    return this.run(async signal => {
      const response = await this.request(signal);
      if (this.disposed || signal.aborted) return;
      if (!this.state.saved || replaceDraft) { this.attempt = null; this.update({ saved: response, draft: { ...response.note }, current: null, blocked: false, message: replaceDraft ? 'Saved note reloaded. The draft now matches it.' : 'Saved note loaded.' }); }
      else if (this.attempt && response.note.revision === this.attempt.expectedRevision + 1 && sameNote(response.note, this.attempt)) { this.attempt = null; this.update({ saved: response, current: null, blocked: false, message: 'The saved note confirms your previous save. Your draft is kept.' }); }
      else this.update({ current: response, message: 'Current saved note checked. Your draft is kept. Reload saved note to replace your draft and use this revision.' });
    });
  }
  save() {
    if (!this.state.saved || this.state.busy || this.state.blocked || !this.dirty) return Promise.resolve();
    if (this.state.saved.note.revision > maxExpectedNoteRevision) { this.update({ error: 'This saved note has reached its revision limit.', blocked: true }); return Promise.resolve(); }
    const submittedDraft = this.state.draft;
    let normalized: HandoffNoteFields;
    try { normalized = normalizeNote(submittedDraft); } catch (error) { this.update({ error: (error as Error).message }); return Promise.resolve(); }
    const write = this.attempt = { ...normalized, expectedRevision: this.state.saved.note.revision };
    return this.run(async signal => {
      const response = await this.request(signal, write);
      if (this.disposed || signal.aborted) return;
      if (response.note.revision !== write.expectedRevision + 1 || !sameNote(response.note, write)) throw new NoteRequestError('The response did not confirm the saved revision.', 'unknown');
      this.attempt = null;
      const unchanged = sameNote(this.state.draft, submittedDraft);
      this.update({ saved: response, ...(unchanged ? { draft: { ...response.note } } : {}), current: null, blocked: false, message: unchanged ? 'Note saved.' : 'Note saved. Your newer edits remain unsaved.' });
    });
  }
  dispose() { this.disposed = true; this.controller?.abort(); this.release?.(); }
}
