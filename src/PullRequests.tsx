import { useEffect, useRef, useState } from 'react';
import { api, type Session } from './api';
import { prDescriptionTemplate, type SavedPullRequest } from './workflow';
import { PublishedComparisonPreview, usePublishedComparison } from './PublishedChanges';
import { publishedReviewReady } from './published-changes';

export function PullRequestLinks({ session, revision, onRecordsChange }: { session: Session; revision: number; onRecordsChange?: (records: SavedPullRequest[] | null) => void }) {
  const [records, setRecords] = useState<SavedPullRequest[]>([]);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const observer = useRef(onRecordsChange); observer.current = onRecordsChange;
  const scope = `${session.userId}:${session.id}:${session.repository}:${session.branch}:${session.baseBranch}:${revision}:${retry}`;
  const latestScope = useRef(scope); latestScope.current = scope;
  useEffect(() => {
    let active = true;
    observer.current?.(null);
    setRecords([]); setError('');
    api<SavedPullRequest[]>(`/sessions/${encodeURIComponent(session.id)}/pull-requests`).then(data => { if (active && latestScope.current === scope) { setRecords(data); setError(''); observer.current?.(data); } }).catch(e => { if (active && latestScope.current === scope) { setError((e as Error).message); observer.current?.(null); } });
    return () => { active = false; };
  }, [session.id, session.userId, session.repository, session.branch, session.baseBranch, revision, retry]);
  if (!records.length && !error) return null;
  return <section className="saved-pull-requests" aria-label="Saved pull requests"><span className="eyebrow">REVIEW HANDOFF</span>{records.map(record => <a href={record.url} key={record.url} target="_blank" rel="noreferrer"><strong>Pull request #{record.number}</strong><span>{record.headBranch} → {record.baseBranch}</span><span className="recorded-head">Head recorded when linked: <code title={record.headSha}>{record.headSha?.slice(0, 12)}</code></span><span>Open ↗</span></a>)}{error && <p className="workflow-message" role="status">Could not load saved pull requests: {error} <button className="text-button" onClick={() => setRetry(value => value + 1)}>Retry</button></p>}</section>;
}
interface PullRequestFormProps { session: Session; previewMode: boolean; accountKey?: string; onClose: () => void; onCreated: () => void; onBusyChange: (value: boolean) => void }
export function PullRequestForm(props: PullRequestFormProps) {
  return <PullRequestFormSession key={`${props.accountKey || props.session.userId}:${props.session.userId}:${props.session.id}`} {...props}/>;
}
function PullRequestFormSession({ session, previewMode, accountKey = session.userId, onClose, onCreated, onBusyChange }: PullRequestFormProps) {
  const comparison = usePublishedComparison(session, previewMode, accountKey);
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState(prDescriptionTemplate);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<SavedPullRequest | null>(null);
  const [createdDiffers, setCreatedDiffers] = useState(false);
  const active = useRef(true);
  const scope = `${accountKey}:${session.id}`;
  const latestScope = useRef(scope); latestScope.current = scope;
  useEffect(() => { active.current = true; const timer = setInterval(() => setNow(Date.now()), 1000); return () => { active.current = false; clearInterval(timer); }; }, [scope]);
  const ready = !previewMode && publishedReviewReady(comparison.state, now);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const reviewed = comparison.state.snapshot;
    if (busy || previewMode || !publishedReviewReady(comparison.state, Date.now()) || !reviewed?.headSha || !reviewed.baseSha || !title.trim()) return;
    setBusy(true); onBusyChange(true); setError('');
    try {
      const result = await api<SavedPullRequest>(`/sessions/${encodeURIComponent(session.id)}/pull-request`, { title, body, expectedHeadSha: reviewed.headSha, expectedBaseSha: reviewed.baseSha });
      if (active.current && latestScope.current === scope) { setCreatedDiffers(result.headSha !== reviewed.headSha || result.baseSha !== reviewed.baseSha); setCreated(result); onCreated(); }
    } catch (e) {
      if (active.current && latestScope.current === scope) {
        setError((e as Error).message);
        comparison.invalidate('The handoff could not confirm the reviewed commits. Refresh review before creating a pull request. Your title and description are kept.');
      }
    } finally { onBusyChange(false); if (active.current && latestScope.current === scope) setBusy(false); }
  }
  if (created) return <><p className="workflow-message">Pull request #{created.number} is saved with this session and remains available after the machine ends.</p>{createdDiffers && <p className="published-warning" role="alert">PR created or linked, but its commit snapshot differs from the reviewed comparison. Review it on GitHub.</p>}<dl className="published-facts"><div><dt>Recorded PR head</dt><dd><code>{created.headSha}</code></dd></div><div><dt>Recorded PR base</dt><dd><code>{created.baseSha}</code></dd></div></dl><a className="button primary pr-link" href={created.url} target="_blank" rel="noreferrer">Open pull request ↗</a><div className="modal-actions"><button className="button subtle" onClick={onClose}>Done</button></div></>;
  return <form onSubmit={submit}>
    <section className="pr-published-review" aria-label="Review published work before handoff">
      <button type="button" className="button subtle small" disabled={busy || comparison.unavailable || comparison.state.loading} onClick={() => { setError(''); comparison.refresh(); }}>{comparison.state.loading ? 'Checking…' : 'Refresh review'}</button>
      <PublishedComparisonPreview state={comparison.state} now={now} unavailable={comparison.unavailable || busy} onSelect={comparison.select}/>
      <p className="form-help">{ready ? 'Creating the pull request checks that both branches still match the exact head and base commits shown above.' : 'A current published comparison with changes is required before handoff.'} File lists and patches are bounded; a partial review does not establish that all changes have been reviewed.</p>
    </section>
    <label htmlFor="pr-title">Title</label><input id="pr-title" value={title} onChange={e => setTitle(e.target.value)} placeholder="Describe the resulting behavior" required maxLength={240} disabled={busy}/>
    <label htmlFor="pr-body">Description</label><textarea id="pr-body" rows={9} maxLength={20000} value={body} onChange={e => setBody(e.target.value)} disabled={busy}/><p className="form-help">Tests and results are developer-reported. Replace the template notes with the objective, behavior, checks, and unresolved concerns.</p>
    {previewMode && <p className="form-help">Preview mode cannot confirm GitHub branches or create a real pull request.</p>}{error && <p className="form-error" role="alert">{error}</p>}
    <div className="modal-actions"><button type="button" className="button subtle" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" disabled={busy || !ready || !title.trim()}>{busy ? 'Creating…' : 'Create pull request'} →</button></div>
  </form>;
}
