import { useEffect, useReducer, useRef } from 'react';
import type { Session } from './api';
import { emptyPublishedView, publishedComparisonUrl, PublishedChangesLoader, publishedReviewReady, reducePublished, requestPublishedChanges, type PublishedViewState } from './published-changes';
import './published-changes.css';
import { ReviewText } from './review-text';

export function usePublishedComparison(session: Session, preview: boolean, accountKey: string) {
  const [state, dispatch] = useReducer(reducePublished, emptyPublishedView);
  const loader = useRef<PublishedChangesLoader | null>(null);
  const reason = preview ? 'Preview simulation: published comparisons are unavailable. No GitHub repository is inspected.' : null;
  // Lifecycle state deliberately does not restrict published reads: ended machines use the user's GitHub access.
  const scope = `${accountKey}:${session.userId}:${session.id}:${session.repository}:${session.branch}:${session.baseBranch}:${preview}`;
  const latest = useRef({ scope, reason, state }); latest.current = { scope, reason, state };
  useEffect(() => {
    if (reason) { dispatch({ type: 'invalidate', message: reason }); return; }
    const current = new PublishedChangesLoader(async (path, expected, signal) => {
      const value = await requestPublishedChanges(session.id, path, expected, signal);
      if (value.repository !== session.repository || value.headBranch !== session.branch || value.baseBranch !== session.baseBranch) throw new Error('The published comparison does not match this machine. Refresh review to try again.');
      return value;
    }, dispatch, () => latest.current.scope === scope && !latest.current.reason);
    loader.current = current; void current.refresh(null);
    return () => { current.dispose(); if (loader.current === current) loader.current = null; };
  }, [scope, reason, session.id, session.repository, session.branch, session.baseBranch]);
  return {
    state: reason ? reducePublished(state, { type: 'invalidate', message: reason }) : state,
    unavailable: Boolean(reason),
    refresh: () => { if (!latest.current.reason) void loader.current?.refresh(null); },
    select: (path: string) => {
      const value = latest.current.state.snapshot;
      if (!latest.current.reason && publishedReviewReady(latest.current.state, Date.now()) && value?.headSha && value.baseSha) void loader.current?.refresh(path, { headSha: value.headSha, baseSha: value.baseSha });
    },
    invalidate: (message: string) => loader.current?.invalidate(message),
  };
}

export function PublishedComparisonPreview({ state, now, unavailable, onSelect }: { state: PublishedViewState; now: number; unavailable: boolean; onSelect: (path: string) => void }) {
  const value = state.snapshot;
  const prior = state.stale || Boolean(value && (state.loading || now - Date.parse(value.checkedAt) > 60_000 || Date.parse(value.checkedAt) > now + 5_000));
  const selected = !state.loading && !prior ? value?.selected : null;
  const comparisonUrl = value ? publishedComparisonUrl(value) : null;
  const checking = state.selectedPath ? 'Rechecking the reviewed commits and loading this file’s published patch…' : value ? 'Refreshing the published comparison…' : 'Checking published contribution…';
  return <div className="published-comparison">
    <p className="published-scope">Pushed contribution against the selected PR base, using the merge base. Dirty files and local-only commits are excluded. Changes shows uncommitted files only. Available after this machine ends.</p>
    <div className="published-observation" aria-live="polite">
      {state.loading && <p role="status">{checking} Wait for the check to finish. The patch stays hidden until the current comparison is confirmed.</p>}
      {state.error && <p className="published-warning" role="alert">{state.error}</p>}
      {value && <>
        <p className={prior ? 'published-warning' : ''}>{prior ? 'Prior comparison — current published work is unconfirmed.' : 'Published comparison'} Checked <time dateTime={value.checkedAt}>{new Date(value.checkedAt).toLocaleString()}</time>.{prior && !state.loading && ' Refresh review to confirm the current branches.'}</p>
        <details className="published-provenance" open={prior}>
        <summary>Exact commits and comparison details · {value.aheadCommits ?? 'Unconfirmed'} ahead · {value.behindCommits ?? 'Unconfirmed'} behind</summary>
        <dl className="published-facts">
          <div><dt>Repository</dt><dd><ReviewText text={value.repository} mode="identity"/></dd></div>
          <div><dt>Work branch</dt><dd><ReviewText text={value.headBranch} mode="identity"/></dd></div><div><dt>PR base</dt><dd><ReviewText text={value.baseBranch} mode="identity"/></dd></div>
          <div><dt>Pushed head commit</dt><dd><code>{value.headSha || 'Unconfirmed'}</code></dd></div>
          <div><dt>Base commit</dt><dd><code>{value.baseSha || 'Unconfirmed'}</code></dd></div>
          <div><dt>Merge base</dt><dd><code>{value.mergeBaseSha || 'Unconfirmed'}</code></dd></div>
          <div><dt>Commit counts</dt><dd>{value.aheadCommits ?? 'Unconfirmed'} ahead · {value.behindCommits ?? 'Unconfirmed'} behind</dd></div>
        </dl>
        {comparisonUrl && <a className="published-link" href={comparisonUrl} target="_blank" rel="noreferrer">Open this exact commit comparison on GitHub ↗</a>}
        </details>
      </>}
      {state.latest && !['known', 'no_changes'].includes(state.latest.state) && <p>Latest check: <time dateTime={state.latest.checkedAt}>{new Date(state.latest.checkedAt).toLocaleString()}</time>. Published contribution is {state.latest.state.replace('_', ' ')}.</p>}
      {state.selectionNotice && !state.loading && !prior && <p role="status">{state.selectionNotice}</p>}
    </div>
    {value && <div className="published-layout">
      <div className="published-files"><h4>Published files <span>{value.files.length}{value.listTruncated ? '+' : ''}</span></h4>
        {value.files.length ? <ul aria-label={prior ? 'Previously observed published files' : 'Published files'}>{value.files.map(file => <li key={file.path}><button type="button" disabled={unavailable || state.loading || prior} aria-pressed={state.selectedPath === file.path} onClick={() => onSelect(file.path)}>
          <span className="published-path"><ReviewText text={file.path} mode="identity"/></span><span className="published-metadata">{file.status} · +{file.additions} −{file.deletions} · {file.changes} changes</span>{file.previousPath && <span className="published-metadata">From: <ReviewText text={file.previousPath} mode="identity"/></span>}
        </button></li>)}</ul> : <p className="published-empty">{prior ? 'The prior comparison listed no files. Current contribution is unconfirmed.' : 'No published file changes were found at this check.'}</p>}
        {value.listTruncated && <p className="published-warning">Partial review: the file list is truncated at 200 files. Additional published files may exist. Use the exact commit comparison on GitHub for the remaining review.</p>}
      </div>
      <div className="published-detail"><h4>{state.selectedPath ? <span className="published-path"><ReviewText text={state.selectedPath} mode="identity"/></span> : 'Published patch'}</h4>
        {state.loading || prior ? <p className="published-empty">The patch is hidden until the current comparison is confirmed. {state.loading ? 'Wait for the check to finish.' : 'Refresh review to continue.'}</p> : !value.files.length ? <p className="published-empty">No published patch to review at this check.</p> : !state.selectedPath ? <p className="published-empty">Select a published file to review its patch before handing off the work.</p> : selected?.state === 'patch' ? <><pre className="published-patch" tabIndex={0} aria-label="Published file patch"><code><ReviewText text={selected.text || 'No patch text was returned for this file.'}/></code></pre>{selected.truncated && <p className="published-warning">Partial review: GitHub returned a partial patch. {selected.reason} Use the exact commit comparison on GitHub to review the remaining changes.</p>}</> : <p className="published-empty">{selected?.state === 'too_large' ? 'Partial review: this patch exceeds the 64 KiB preview limit.' : 'Partial review: no patch is available for this file.'} {selected?.reason || 'GitHub did not provide a text patch; this does not establish that the file is binary.'} Use the exact commit comparison on GitHub to review it.</p>}
      </div>
    </div>}
  </div>;
}
interface PublishedChangesProps { session: Session; preview: boolean; now: number; accountKey: string; onStateChange?: (state: PublishedViewState) => void }
export function PublishedChanges(props: PublishedChangesProps) { return <PublishedChangesSession key={`${props.accountKey}:${props.session.userId}:${props.session.id}:${props.session.repository}:${props.session.branch}:${props.session.baseBranch}:${props.preview}`} {...props}/>; }
function PublishedChangesSession({ session, preview, now, accountKey, onStateChange }: PublishedChangesProps) {
  const comparison = usePublishedComparison(session, preview, accountKey);
  const observer = useRef(onStateChange); observer.current = onStateChange;
  const state = comparison.state;
  // Report observations without clearing the last one when this review tab unmounts.
  // Field dependencies also keep preview invalidation from reporting on every clock tick.
  useEffect(() => { observer.current?.(state); }, [state.snapshot, state.latest, state.selectedPath, state.loading, state.stale, state.error, state.selectionNotice]);
  return <section className="detail-panel published-changes" aria-label="Published changes"><div className="detail-heading"><h3>Published</h3><button type="button" className="button subtle small" disabled={comparison.unavailable || comparison.state.loading} onClick={comparison.refresh}>{comparison.state.loading ? 'Checking…' : 'Refresh review'}</button></div><PublishedComparisonPreview state={comparison.state} now={now} unavailable={comparison.unavailable} onSelect={comparison.select}/></section>;
}
