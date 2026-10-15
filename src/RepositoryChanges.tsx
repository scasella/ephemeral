import { useEffect, useReducer, useRef } from 'react';
import type { Session } from './api';
import { changeStatusLabel, ChangesLoader, changesUnavailableReason, emptyChangesView, reduceChanges, requestChanges, type ChangesViewState } from './repository-changes';
import './repository-changes.css';
import { ReviewText } from './review-text';

export function ChangesPreview({ state, now, unavailable, onSelect }: { state: ChangesViewState; now: number; unavailable: boolean; onSelect: (path: string) => void }) {
  const snapshot = state.snapshot;
  const aged = Boolean(snapshot && now - Date.parse(snapshot.checkedAt) > 60_000);
  const prior = state.stale || aged;
  const selected = !state.loading && !state.stale ? snapshot?.selected : null;
  const selectedFile = snapshot?.files.find(file => file.path === state.selectedPath);
  return <>
    <div className="changes-observation" aria-live="polite">
      {state.loading && <p role="status">{state.selectedPath ? 'Checking changed files and loading the selected file…' : 'Checking uncommitted changes…'}</p>}
      {state.error && <p className="changes-error" role="alert">{state.error}</p>}
      {snapshot && <p className={prior ? 'changes-prior' : ''}>{prior ? 'Prior observation' : 'Observation'} checked <time dateTime={snapshot.checkedAt}>{new Date(snapshot.checkedAt).toLocaleString()}</time>.{prior ? ' It may no longer match the workspace. Refresh to inspect again.' : ' Changes made in the terminal appear after you refresh.'}</p>}
      {state.latest && state.latest.state !== 'known' && <p>Latest check: <time dateTime={state.latest.checkedAt}>{new Date(state.latest.checkedAt).toLocaleString()}</time>. Current changes are {state.latest.state}.</p>}
      {snapshot?.headSha && <p>Compared with HEAD <code>{snapshot.headSha.slice(0, 12)}</code>.</p>}
      {state.selectionNotice && <p role="status">{state.selectionNotice}</p>}
    </div>
    {snapshot && <div className="changes-layout">
      <div className="changes-files">
        <h4>Changed files <span>{snapshot.files.length}{snapshot.listTruncated ? '+' : ''}</span></h4>
        {snapshot.files.length === 0 ? <p className="changes-empty">{prior || state.loading ? 'The prior observation listed no changed files. Current changes have not been confirmed.' : snapshot.listTruncated ? 'The changed-file list is incomplete; current files could not be listed.' : 'No uncommitted changes were found at this check.'}</p> : <ul aria-label={prior ? 'Previously observed changed files' : 'Changed files'}>{snapshot.files.map(file => <li key={file.path}>
          <button type="button" aria-pressed={state.selectedPath === file.path} disabled={unavailable || state.loading} onClick={() => onSelect(file.path)}>
            <span className="changes-file-path"><ReviewText text={file.path} mode="identity"/></span><span className="changes-file-status">{changeStatusLabel(file.status)}</span>
            {file.oldPath && <span className="changes-old-path">From: <ReviewText text={file.oldPath} mode="identity"/></span>}
          </button>
        </li>)}</ul>}
        {snapshot.listTruncated && <p className="changes-limit">File list truncated at the inspection limit. Additional changes may exist.</p>}
      </div>
      <div className="changes-detail">
        <h4>{state.selectedPath ? <span className="changes-file-path"><ReviewText text={state.selectedPath} mode="identity"/></span> : 'File preview'}</h4>
        {state.loading ? <p className="changes-empty" role="status">File content is hidden while the inspection is in progress.</p> : state.stale ? <p className="changes-empty">Current file content has not been confirmed. Refresh to inspect it again.</p> : !state.selectedPath ? <p className="changes-empty">Select a changed file to read its diff or untracked text.</p> : !selected ? <p className="changes-empty">No preview was returned for this selection. Refresh the inspection or select another file.</p> : selected.state === 'text' ? <>
          <p className="changes-content-kind">{selectedFile?.kind === 'untracked' ? 'Untracked file text' : 'Combined staged and unstaged diff against HEAD'}</p>
          {selected.reason && <p className="changes-content-kind"><ReviewText text={selected.reason}/></p>}
          <pre className="changes-text" tabIndex={0} aria-label={selectedFile?.kind === 'untracked' ? 'Untracked file text' : 'File diff'}><code><ReviewText text={selected.text || (selectedFile?.kind === 'untracked' ? 'Empty file.' : 'No text differences were returned for this file.')}/></code></pre>
          {selected.truncated && <p className="changes-limit">Text preview truncated at the inspection limit. This is only part of the file or diff.</p>}
        </> : <p className="changes-empty">{selected.state === 'binary' ? 'Binary file: a text preview is unavailable.' : selected.state === 'too_large' ? 'This file exceeds the preview size limit.' : selected.state === 'symlink' ? 'Symbolic link: its target is not opened for preview.' : 'The selected file is unavailable for preview.'}{selected.reason ? ` ${selected.reason}` : ''}</p>}
      </div>
    </div>}
  </>;
}

interface RepositoryChangesProps { session: Session; preview: boolean; now: number; accountKey: string }
// An account or session switch must remove all prior repository-controlled content.
export function RepositoryChanges(props: RepositoryChangesProps) {
  return <RepositoryChangesSession key={`${props.accountKey}:${props.session.userId}:${props.session.id}`} {...props}/>;
}
function RepositoryChangesSession({ session, preview, now, accountKey }: RepositoryChangesProps) {
  const [state, dispatch] = useReducer(reduceChanges, emptyChangesView);
  const loader = useRef<ChangesLoader | null>(null);
  const reason = changesUnavailableReason(session, preview, now);
  const scope = `${accountKey}:${session.userId}:${session.id}:${session.state}:${session.expiresAt}:${preview}`;
  const latest = useRef({ scope, reason, path: state.selectedPath });
  latest.current = { scope, reason, path: state.selectedPath };
  useEffect(() => {
    if (reason) { dispatch({ type: 'invalidate', message: reason }); return; }
    const current = new ChangesLoader((path, signal) => requestChanges(session.id, path, signal), dispatch, () => latest.current.scope === scope && !latest.current.reason);
    loader.current = current;
    void current.refresh(latest.current.path);
    return () => { current.dispose(); if (loader.current === current) loader.current = null; };
  }, [scope, reason, session.id]);
  const visible = reason ? reduceChanges(state, { type: 'invalidate', message: reason }) : state;
  return <section className="detail-panel repository-changes" aria-label="Repository changes">
    <div className="detail-heading"><div><span className="eyebrow">REVIEW WORKSPACE FILES</span><h3>Changes</h3><p>Uncommitted changes compared with HEAD. Staged and unstaged changes are combined; commits are not shown.</p></div><button type="button" className="button subtle small" disabled={Boolean(reason) || state.loading} onClick={() => void loader.current?.refresh(state.selectedPath)}>{state.loading ? 'Checking…' : 'Refresh changes'}</button></div>
    <p className="changes-scope">Read-only inspection. Select a file to view a bounded text preview. Ignored files and submodule contents are excluded. Isolated Git settings skip repository filters and configuration; file status may differ from your Git settings. Nothing is staged, edited, committed, or pushed.</p>
    <ChangesPreview state={visible} now={now} unavailable={Boolean(reason)} onSelect={path => { if (!latest.current.reason) void loader.current?.refresh(path); }}/>
  </section>;
}
