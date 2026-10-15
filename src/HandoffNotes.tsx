import { useEffect, useRef, useState } from 'react';
import type { Session } from './api';
import { HandoffNotesClient, noteFields, noteLabels, noteText, requestHandoffNotes, type HandoffNote, type HandoffNoteFields, type NoteEditorState } from './handoff-notes';
import { confirmedNotesResponse } from './recovery-evidence';
import './handoff-notes.css';

export function SavedNoteText({ note }: { note: HandoffNoteFields }) {
  const populated = noteFields.filter(field => note[field]);
  return populated.length ? <dl className="note-text">{populated.map(field => <div key={field}><dt>{noteLabels[field]}</dt><dd>{note[field]}</dd></div>)}</dl> : <p className="note-empty">No note text.</p>;
}
export function NoteVersion({ note }: { note: HandoffNote }) {
  return <p className="form-help">{note.updatedAt ? <>Saved revision {note.revision} · <time dateTime={note.updatedAt}>{new Date(note.updatedAt).toLocaleString()}</time></> : 'No note saved yet.'}</p>;
}
interface HandoffNotesProps { session: Session; visible: boolean; onSelectSource: (id: string) => void; onSavedNoteChange?: (note: HandoffNote | null, inheritedNotePresent: boolean | null) => void }
export function HandoffNotes(props: HandoffNotesProps) {
  return <HandoffNotesSession key={`${props.session.userId}:${props.session.id}`} {...props}/>;
}
function HandoffNotesSession({ session, visible, onSelectSource, onSavedNoteChange }: HandoffNotesProps) {
  const [state, setState] = useState<NoteEditorState>({ saved: null, draft: { nextStep: '', unresolvedIssues: '', verification: '' }, busy: false, message: '', error: '', blocked: false, current: null });
  const client = useRef<HandoffNotesClient | null>(null);
  const observer = useRef(onSavedNoteChange); observer.current = onSavedNoteChange;
  const scope = `${session.userId}:${session.id}`;
  const latestScope = useRef(scope); latestScope.current = scope;
  const [confirmation, setConfirmation] = useState<'reload' | 'inherit' | null>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const [editMode, setEditMode] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const firstField = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const focusReturn = useRef<{ origin: Element; destination: 'draft' | 'read' } | null>(null);
  function returnFocusTo(destination: 'draft' | 'read') {
    const origin = document.activeElement;
    focusReturn.current = origin && panel.current?.contains(origin) ? { origin, destination } : null;
  }
  useEffect(() => {
    // A later interaction owns focus, even while a note request is outstanding.
    const cancel = () => { focusReturn.current = null; };
    const moved = (event: FocusEvent) => {
      if (event.target !== document.body && event.target !== focusReturn.current?.origin) cancel();
    };
    const navigation = (event: KeyboardEvent) => { if (event.key === 'Tab' || event.key === 'Escape') cancel(); };
    document.addEventListener('focusin', moved);
    document.addEventListener('pointerdown', cancel);
    document.addEventListener('keydown', navigation);
    return () => { cancel(); document.removeEventListener('focusin', moved); document.removeEventListener('pointerdown', cancel); document.removeEventListener('keydown', navigation); };
  }, []);
  useEffect(() => {
    observer.current?.(null, null);
    const current = new HandoffNotesClient((signal, write) => requestHandoffNotes(session.id, signal, write, session.continuation ?? null), next => {
      if (latestScope.current !== scope) return;
      setState(next);
      const response = confirmedNotesResponse(next);
      observer.current?.(response?.note ?? null, response ? Boolean(response.inherited) : null);
    });
    client.current = current; void current.load();
    return () => { current.dispose(); client.current = null; };
  }, [session.id, session.userId]);
  const dirty = Boolean(state.saved && noteFields.some(field => state.draft[field] !== state.saved!.note[field]));
  const editing = editMode || dirty || state.blocked;
  useEffect(() => {
    const request = focusReturn.current;
    if (!visible) { focusReturn.current = null; return; }
    if (!request || confirmation || !panel.current) return;
    const active = document.activeElement;
    if (active !== document.body && active !== request.origin) { focusReturn.current = null; return; }
    const target = request.destination === 'read' ? editButton.current : firstField.current?.disabled ? saveButton.current : firstField.current;
    if (!target || target.disabled) return;
    focusReturn.current = null;
    target.focus();
  }, [editing, confirmation, state, visible]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const inherited = state.saved?.inherited;
  function replaceFromInherited() {
    if (!inherited) return;
    returnFocusTo('draft');
    setEditMode(true);
    client.current?.edit(Object.fromEntries(noteFields.map(field => [field, inherited[field]])) as unknown as HandoffNoteFields);
    setConfirmation(null);
  }
  function reload() { returnFocusTo(editing ? 'draft' : 'read'); setConfirmation(null); void client.current?.load(true); }
  async function copy() {
    if (!inherited) return;
    try { await navigator.clipboard.writeText(noteText(inherited)); setCopyStatus('Inherited text copied.'); }
    catch { setCopyStatus('Copy unavailable. Select the inherited text below and copy it manually.'); }
  }
  return <div ref={panel} role="tabpanel" id="panel-notes" aria-labelledby="tab-notes" hidden={!visible} inert={!visible}>
    <section className="detail-panel handoff-notes">
      <div className="detail-heading"><div><h3>Next-session notes</h3><p>Private notes remain after the machine stops. Continuations copy the saved version only. Keep secrets out.</p></div></div>
      <details className="note-guidance"><summary>How saved notes are used</summary><p className="form-help">These notes are your own account of the work, not verified code or a transcript. They are never sent automatically to a model. Unsaved edits stay in this editor.</p></details>
      <form onSubmit={event => { event.preventDefault(); if (dirty && !state.busy && !state.blocked) void client.current?.save(); }}>
        {editing ? noteFields.map(field => <div className="note-field" key={field}><label htmlFor={`note-${field}`}>{noteLabels[field]}</label><textarea ref={field === 'nextStep' ? firstField : undefined} id={`note-${field}`} rows={3} maxLength={2000} disabled={!state.saved || state.busy} value={state.draft[field]} onChange={event => client.current?.edit({ ...state.draft, [field]: event.target.value })} aria-describedby={`note-${field}-limit`}/><span id={`note-${field}-limit`} className="form-help">{state.draft[field].length}/2000 characters</span></div>) : state.saved && <SavedNoteText note={state.saved.note}/>}
        {state.saved && <NoteVersion note={state.saved.note}/>}
        <p className="note-status" role="status">{state.busy ? 'Working with saved notes…' : dirty ? 'Unsaved changes. Save to include them in a continuation.' : state.saved ? editing ? 'Draft matches the saved note.' : '' : 'Saved note has not loaded.'} {state.message}</p>
        {state.error && <p className="form-error" role="alert">{state.error}</p>}
        {state.current && <section className="note-current"><h4>Current saved note for review</h4><NoteVersion note={state.current.note}/><SavedNoteText note={state.current.note}/><p>Your draft has been kept. Reload saved note to replace it with this version.</p></section>}
        {confirmation && <div className="note-confirmation" role="alert"><p>{confirmation === 'reload' ? 'Reload saved note will discard your unsaved draft and replace all three fields with the current server version.' : 'Use inherited as draft will replace your unsaved draft with the inherited text. It will not save automatically.'}</p><button type="button" className="button subtle small" onClick={() => { returnFocusTo('draft'); setConfirmation(null); }}>Keep draft</button><button type="button" className="button subtle small" onClick={confirmation === 'reload' ? reload : replaceFromInherited}>{confirmation === 'reload' ? 'Discard draft and reload' : 'Replace draft'}</button></div>}
        <div className="note-tools">
          {editing ? <><button ref={saveButton} className="button primary small" aria-disabled={!dirty || state.busy || state.blocked}>Save note</button><button type="button" className="button subtle small" disabled={dirty || state.busy || state.blocked} onClick={() => { returnFocusTo('read'); setEditMode(false); }}>Done editing</button></> : <button ref={editButton} type="button" className="button primary small" disabled={!state.saved || state.busy} onClick={() => { returnFocusTo('draft'); setEditMode(true); }}>Edit note</button>}
          <button type="button" className="button subtle small" aria-disabled={state.busy} onClick={() => { if (!state.busy) void client.current?.load(); }}>Check saved note</button>
          {(editing || state.current) && <button type="button" className="button subtle small" disabled={state.busy} onClick={() => dirty ? setConfirmation('reload') : reload()}>Reload saved note</button>}
          {editing && <button type="button" className="button subtle small" disabled={!state.saved || state.busy} onClick={() => client.current?.edit({ nextStep: '', unresolvedIssues: '', verification: '' })}>Clear draft</button>}
        </div>
        {editing && <p className="form-help">Clear draft empties all three fields. Save note explicitly to clear the saved note.</p>}
      </form>
      {inherited && <details className="inherited-note"><summary>Inherited saved note · source revision {inherited.sourceNoteRevision}</summary><p>This read-only copy was captured from source machine <code>{inherited.sourceSessionId}</code>, revision {inherited.sourceNoteRevision}, on <time dateTime={inherited.capturedAt}>{new Date(inherited.capturedAt).toLocaleString()}</time>.</p><p className="form-help">Source branch: <code>{inherited.sourceBranch}</code>{inherited.sourceCommitSha && <> · Published commit: <code>{inherited.sourceCommitSha}</code></>}{inherited.sourceNoteUpdatedAt && <> · Source note saved: <time dateTime={inherited.sourceNoteUpdatedAt}>{new Date(inherited.sourceNoteUpdatedAt).toLocaleString()}</time></>}</p><SavedNoteText note={inherited}/><div className="note-tools"><button type="button" className="button subtle small" onClick={() => void copy()}>Copy text</button><button type="button" className="button subtle small" onClick={() => onSelectSource(inherited.sourceSessionId)}>View source Notes</button><button type="button" className="button subtle small" disabled={state.busy || !state.saved} onClick={() => dirty ? setConfirmation('inherit') : replaceFromInherited()}>Use inherited as draft</button></div>{copyStatus && <p role="status">{copyStatus}</p>}</details>}
    </section>
  </div>;
}
