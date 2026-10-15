import type { HandoffNote, HandoffNotesResponse, NoteEditorState } from './handoff-notes';
import type { PublishedViewState } from './published-changes';

/** Caller must match scopes first. Retained observations never confirm a new check. */
export function retainPublishedObservation(previous: PublishedViewState | null | undefined, incoming: PublishedViewState): PublishedViewState {
  if (incoming.snapshot || !previous?.snapshot) return incoming;
  return { ...incoming, snapshot: { ...previous.snapshot, selected: null }, stale: true };
}

/** Only a confirmed persisted response supports recovery facts; the draft never does. */
export function confirmedNotesResponse(state: NoteEditorState): HandoffNotesResponse | null {
  if (state.busy || state.error) return null;
  // A fresh check can confirm the server version while keeping a conflicted draft blocked.
  if (state.current) return state.current;
  return state.blocked ? null : state.saved;
}

export function confirmedSavedNote(state: NoteEditorState): HandoffNote | null {
  return confirmedNotesResponse(state)?.note ?? null;
}
