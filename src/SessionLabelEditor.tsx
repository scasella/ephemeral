import { useEffect, useRef, useState } from 'react';
import type { Session } from './api';
import { reconcileLabelDraft, saveSessionLabel } from './session-history';

export function SessionLabelEditor({ session, onSaved }: { session: Session; onSaved: (session: Session) => void }) {
  const [draft, setDraft] = useState(session.label || '');
  const editing = useRef(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const active = useRef(true);
  const request = useRef<AbortController | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; request.current?.abort(); }; }, []);
  useEffect(() => { setDraft(current => reconcileLabelDraft(current, editing.current, session.label || '')); }, [session.label]);
  return <form className="session-label-form" onSubmit={async event => {
    event.preventDefault(); if (saving) return;
    setSaving(true); setMessage(''); setError('');
    request.current = new AbortController();
    try { const updated = await saveSessionLabel(session.id, draft, request.current.signal); if (!active.current) return; editing.current = false; setDraft(updated.label || ''); onSaved(updated); setMessage(updated.label ? 'Task name saved.' : 'Task name cleared. The generated machine name is shown.'); }
    catch (failure) { if (active.current) setError((failure as Error).message); }
    finally { if (active.current) setSaving(false); }
  }}>
    <label htmlFor="session-task-name">Task name <span aria-hidden="true">{draft.length}/80</span></label>
    <div className="session-label-input"><input id="session-task-name" value={draft} maxLength={80} disabled={saving} placeholder="Give this work a useful name" aria-describedby="session-task-name-help" onChange={event => { editing.current = true; setDraft(event.target.value); setMessage(''); setError(''); }}/><button className="button primary small" disabled={saving || draft === (session.label || '')}>{saving ? 'Saving…' : 'Save name'}</button></div>
    <p id="session-task-name-help">An optional name for this task. Save an empty name to use the generated machine name.</p>
    {message && <p role="status">{message}</p>}{error && <p className="form-error" role="alert">{error}</p>}
  </form>;
}
