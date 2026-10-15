import { useEffect, useRef, useState } from 'react';
import { api, type Session } from './api';
import { HandoffNotesClient, maxExpectedNoteRevision, requestHandoffNotes, type NoteEditorState } from './handoff-notes';
import { NoteVersion, SavedNoteText } from './HandoffNotes';
import { continuationBlockedReason, ContinuationPreviewLoader, ContinuationRequestError, previewBlockedReason, readContinuationIntent, submitContinuation, type ContinuationIntent, type ContinuationPreview } from './continuation-state';

export function ContinuationLineage({ session, onSelectSource }: { session: Session; onSelectSource: (id: string) => void }) {
  if (!session.continuation) return null;
  const lineage = session.continuation;
  return <div className="continuation-lineage"><strong>Continued from saved work</strong><p>Published commit <code>{lineage.commitSha}</code> on <code>{lineage.sourceBranch}</code>, verified {new Date(lineage.verifiedAt).toLocaleString()}. This machine uses a new work branch; the source pull request receives no updates from it.</p><button className="text-button" onClick={() => onSelectSource(lineage.sourceSessionId)}>View source machine</button></div>;
}

export function ContinuationForm({ source, sessions, now, previewMode, canLaunch, refreshSessions, onBusyChange, onCreated, onClose, onSelectSession }: {
  source: Session; sessions: Session[]; now: number; previewMode: boolean; canLaunch: boolean;
  refreshSessions: () => Promise<void>; onBusyChange: (value: boolean) => void;
  onCreated: (session: Session) => void; onClose: () => void; onSelectSession: (id: string) => void;
}) {
  const storageKey = `ephemeral:continuation:${source.userId}:${source.id}`;
  const legacyStorageKey = `ephemeral:continuation:${source.id}`;
  const [review, setReview] = useState<ContinuationPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [notes, setNotes] = useState<NoteEditorState | null>(null);
  const noteLoader = useRef<HandoffNotesClient | null>(null);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');
  const [intent, setIntent] = useState<ContinuationIntent | null>(() => { try { return readContinuationIntent(sessionStorage.getItem(storageKey), source.id) || readContinuationIntent(sessionStorage.getItem(legacyStorageKey), source.id); } catch { return null; } });
  const loader = useRef<ContinuationPreviewLoader | null>(null);
  const postingRef = useRef(false);
  const mounted = useRef(true);
  const completed = useRef(false);
  const activeCount = sessions.filter(session => ['provisioning', 'running', 'cleanup_pending'].includes(session.state)).length;
  const children = sessions.filter(session => session.continuation?.sourceSessionId === source.id);
  const blocked = previewMode ? 'Preview cannot verify real published work or create a continuation machine.' : previewBlockedReason(review, source, now) || (!notes?.saved ? 'Load and review the saved note before continuing.' : notes.saved.note.revision > maxExpectedNoteRevision ? 'This saved note has reached its continuation review revision limit.' : null) || (!canLaunch ? 'Workspace configuration is incomplete.' : activeCount > 0 ? 'Stop the active machine and finish cleanup before launching another machine.' : null);

  useEffect(() => {
    mounted.current = true;
    const current = new ContinuationPreviewLoader(source, signal => api<ContinuationPreview>(`/sessions/${encodeURIComponent(source.id)}/continuation-preview`, undefined, { signal }), setReview, setChecking);
    loader.current = current; void current.refresh();
    const savedNotes = new HandoffNotesClient(signal => requestHandoffNotes(source.id, signal, undefined, source.continuation ?? null), setNotes);
    noteLoader.current = savedNotes; void savedNotes.load();
    return () => { mounted.current = false; current.dispose(); loader.current = null; savedNotes.dispose(); noteLoader.current = null; };
  }, [source.id, source.userId]);
  function remember(next: ContinuationIntent | null) {
    if (next) sessionStorage.setItem(storageKey, JSON.stringify(next)); else sessionStorage.removeItem(storageKey);
    sessionStorage.removeItem(legacyStorageKey);
    setIntent(next);
  }
  function finish(session: Session) {
    if (completed.current || !mounted.current) return;
    completed.current = true;
    try { remember(null); } catch { /* The completed machine remains in the server's machine list. */ }
    onBusyChange(false);
    onCreated(session);
  }
  async function confirm() {
    if (postingRef.current || completed.current || (!intent && (checking || notes?.busy || blocked))) return;
    let next = intent;
    if (!next) {
      if (!review?.commitSha || !notes?.saved) return;
      next = { sourceSessionId: source.id, expectedHeadSha: review.commitSha.toLowerCase(), requestId: crypto.randomUUID(), createdAt: new Date().toISOString(), expectedNoteRevision: notes.saved.note.revision, reviewedNote: notes.saved.note };
      try { remember(next); } catch { setError('The browser could not save the request for safe recovery. Enable session storage and try again.'); return; }
    }
    postingRef.current = true; setPosting(true); onBusyChange(true); setError('');
    try { finish(await submitContinuation(source, next)); }
    catch (error) {
      if (!mounted.current) return;
      if (error instanceof ContinuationRequestError && error.definite) {
        try { remember(null); } catch { setIntent(null); }
        setReview(null);
        setError(`${error.message} Refresh and review published work before trying again.`);
      } else setError(`${(error as Error).message} The outcome may be uncertain. Check the machine list, or retry using the same reviewed commit and request.`);
      void refreshSessions().catch(() => { /* The explicit recovery action remains available. */ });
    } finally {
      postingRef.current = false;
      if (mounted.current) { setPosting(false); onBusyChange(false); }
    }
  }
  async function checkMachines() {
    if (postingRef.current) return;
    setError('');
    try { await refreshSessions(); } catch (error) { setError((error as Error).message); }
  }
  const reviewedSha = intent?.expectedHeadSha || review?.commitSha;
  const reviewedNote = intent ? intent.reviewedNote : notes?.saved?.note;
  return <div className="continuation-review">
    <dl className="pr-preflight-details"><div><dt>Repository</dt><dd>{source.repository}</dd></div><div><dt>Source branch</dt><dd><code>{source.branch}</code></dd></div><div><dt>PR target base</dt><dd><code>{source.baseBranch}</code></dd></div><div><dt>Published commit</dt><dd><code>{reviewedSha || 'Not verified'}</code></dd></div><div><dt>GitHub check</dt><dd>{review ? new Date(review.checkedAt).toLocaleString() : 'Not checked'}</dd></div></dl>
    <section className="continuation-note" aria-labelledby="continuation-note-heading"><h3 id="continuation-note-heading">Saved next-session note</h3><p>Only the saved version is copied. Unsaved source edits are excluded. These are private user notes, not verified code or a transcript, and they are never sent automatically to a model. Keep secrets out.</p>{reviewedNote ? <><NoteVersion note={reviewedNote}/><SavedNoteText note={reviewedNote}/></> : <p role="status">{intent ? 'This older saved request has no note review snapshot. Its server-side copy is retained on retry.' : notes?.busy ? 'Loading saved note…' : 'Saved note unavailable. Refresh the review before launching.'}</p>}{notes?.error && <p className="form-error" role="alert">{notes.error}</p>}{intent?.expectedNoteRevision !== undefined && notes?.saved && notes.saved.note.revision !== intent.expectedNoteRevision && <p role="status">The current source note is revision {notes.saved.note.revision}. This saved request retains the note captured when it was first accepted.</p>}</section>
    <div className="continuation-expectations"><p>Restore only the committed work pushed to GitHub. Uncommitted files, unpushed commits, terminal history, and Codex conversations are unavailable.</p><p>Launch a fresh VM and a new work branch at the reviewed commit. Sign in to Codex again. The original pull request is not updated, and a new pull request is not created automatically.</p><p>Your saved setup recipe remains available in the Setup tab. Run it explicitly when needed.</p></div>
    {intent ? <div className="continuation-warning" role="status"><strong>A continuation request is already saved.</strong><p>Its outcome may be uncertain. Retrying keeps the same request and published commit, even if the source branch has since changed. Check the machine list for the resulting machine before starting another request.</p>{review && review.state !== 'ready' && <p>Current GitHub check: {review.reason || 'Published work could not be verified.'}</p>}{review?.commitSha && review.commitSha !== intent.expectedHeadSha && <p>The branch now points to <code>{review.commitSha}</code>. The saved request still refers to <code>{intent.expectedHeadSha}</code>.</p>}</div> : <p className="workflow-message" role="status">{checking ? 'Checking the source branch on GitHub…' : blocked || 'The published commit is ready to continue. The server will verify it again before launching.'}</p>}
    {children.length > 0 && <div className="continuation-children"><span className="eyebrow">MACHINES CONTINUED FROM THIS SOURCE</span>{children.map(child => <button className="text-button" disabled={posting} key={child.id} onClick={() => onSelectSession(child.id)}>{child.branch} · {child.state.replace('_', ' ')} · {child.continuation!.commitSha.slice(0, 12)}</button>)}</div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="continuation-tools"><button type="button" className="button subtle small" disabled={checking || Boolean(notes?.busy) || posting} onClick={() => { void loader.current?.refresh(); void noteLoader.current?.load(true); }}>{checking ? 'Checking…' : 'Refresh published-work review'}</button>{intent && <button type="button" className="button subtle small" disabled={posting} onClick={() => void checkMachines()}>Check machine list</button>}</div>
    <div className="modal-actions"><button className="button subtle" disabled={posting} onClick={onClose}>{intent ? 'Close review' : 'Cancel'}</button><button className="button primary" disabled={posting || previewMode || (!intent && (checking || Boolean(notes?.busy) || Boolean(blocked)))} onClick={() => void confirm()}>{posting ? 'Launching…' : intent ? 'Check or retry saved request' : 'Launch from published commit'}</button></div>
  </div>;
}

export { continuationBlockedReason };
