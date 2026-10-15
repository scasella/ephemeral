import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Session } from './api';
import { WorkStatusLoader } from './work-status-loader';
import { saveCommands, workCheckTimeUnconfirmed, workNeedsAcknowledgement, type WorkStatus } from './workflow';
import { compactWorkStatus, workspacePanelMemory } from './panel-state';
import { EndedOutcome, type RecoveryEvidenceProps } from './EndedOutcome';
import { compactEndedOutcome, needsRecoverySummary } from './ended-outcome';

export function useWorkStatus(session: Session, poll = false) {
  const [status, setStatus] = useState<WorkStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const loader = useRef<WorkStatusLoader | null>(null);
  const refresh = useCallback(() => loader.current?.refresh() ?? Promise.resolve(), []);
  useEffect(() => {
    const current = new WorkStatusLoader(
      signal => api<WorkStatus>(`/sessions/${encodeURIComponent(session.id)}/work-status`, undefined, { signal }),
      setStatus, setLoading,
    );
    loader.current = current;
    setStatus(null);
    void current.refresh();
    const interval = poll && session.state === 'running' ? setInterval(() => { if (!document.hidden) void current.refresh(); }, 25_000) : null;
    return () => { current.dispose(); if (loader.current === current) loader.current = null; if (interval) clearInterval(interval); };
  }, [poll, session.id, session.state]);
  return { status, loading, refresh };
}
function date(value: string) { return new Date(value).toLocaleString(); }
export function WorkStatusSummary({ status, loading, now }: { status: WorkStatus | null; loading: boolean; now: number }) {
  if (loading && !status) return <p className="workflow-message" role="status">Checking workspace and remote branch…</p>;
  if (!status) return null;
  const timeUnconfirmed = workCheckTimeUnconfirmed(status, now);
  const stale = now - Date.parse(status.checkedAt) > 60_000;
  const safe = !workNeedsAcknowledgement(status, now);
  return <div className="work-status-result" aria-busy={loading}>
    <div className="work-status-heading"><strong>{loading ? 'Refreshing work status…' : timeUnconfirmed ? 'Work check time is unconfirmed' : stale ? 'Work status is stale' : status.state === 'unavailable' ? 'Work status is unavailable' : status.state !== 'known' ? 'Work status is unknown' : safe ? 'No unsaved work detected on the assigned branch' : 'Work may be lost on teardown'}</strong><span>{date(status.checkedAt)}</span></div>
    {timeUnconfirmed && <p className="workflow-message">The check time could not be confirmed. Refresh status or acknowledge the uncertainty before stopping.</p>}
    <dl className="work-counts"><div><dt>Changed tracked files</dt><dd>{status.dirtyFiles ?? 'Unknown'}</dd></div><div><dt>Untracked files</dt><dd>{status.untrackedFiles ?? 'Unknown'}</dd></div><div><dt>Unpushed commits on assigned branch</dt><dd>{status.aheadCommits ?? 'Unknown'}</dd></div></dl>
    {status.reason && <p className="workflow-message">{status.reason}</p>}
    {status.branchMatches === false && <p className="workflow-message">Current branch differs from the scoped work branch. Review it before saving.</p>}
    {status.remoteExists === false && <p className="workflow-message">The work branch has not been found on the remote.</p>}
    <p className="remote-confirmation">{status.remoteSha && status.remoteCheckedAt ? <>Last remote-confirmed commit <code title={status.remoteSha}>{status.remoteSha}</code><br/>Observed {date(status.remoteCheckedAt)}. This is a remote check time.</> : 'No remote-confirmed commit is available.'}</p>
    <p className="workflow-message">Pushed commits on the assigned branch survive teardown. Files outside the repository, ignored files, and reflog history are not inspected. They may be lost. Work can change after this check.</p>
  </div>;
}
export function SaveGuidance({ session }: { session: Session }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const commands = saveCommands(session.branch);
  return <details className="save-guidance" id="save-guidance"><summary>How to save your work</summary><p>Review changes in the terminal, choose the files to stage, commit, then push to <code>{session.branch}</code>. Push access is scoped to this branch. A local commit alone will be lost when the sandbox ends.</p><div className="command-toolbar"><span>Run in the repository terminal</span><button className="button subtle small" onClick={async () => { try { await navigator.clipboard.writeText(commands); setCopied(true); setCopyError(''); } catch { setCopyError('Copy unavailable. Select the commands below.'); } }}>{copied ? 'Copied commands' : 'Copy commands'}</button></div><pre><code>{commands}</code></pre><p>The commands require your review. Replace PATH with an intended file before running git add.</p>{copyError && <p role="status">{copyError}</p>}</details>;
}
export function WorkStatusPanel({ session, now, panelScope, forceExpanded = false, ...recoveryEvidence }: { session: Session; now: number; panelScope?: string; forceExpanded?: boolean } & RecoveryEvidenceProps) {
  const { status, loading, refresh } = useWorkStatus(session, true);
  const scope = panelScope ?? session.userId;
  const [disclosure, setDisclosure] = useState(() => ({ scope, sessionId: session.id, expanded: forceExpanded || workspacePanelMemory.expanded('work-status', scope, session.id) }));
  const expanded = disclosure.scope === scope && disclosure.sessionId === session.id ? disclosure.expanded : workspacePanelMemory.expanded('work-status', scope, session.id);
  const recovery = needsRecoverySummary(session);
  useEffect(() => {
    if (forceExpanded) {
      workspacePanelMemory.remember('work-status', scope, session.id, true);
      setDisclosure({ scope, sessionId: session.id, expanded: true });
    }
  }, [forceExpanded, scope, session.id]);
  return <section className="work-status-panel" aria-label="Work survival status">
    <details id="work-status-details" className="panel-disclosure" open={expanded} onToggle={event => {
      const next = event.currentTarget.open;
      workspacePanelMemory.remember('work-status', scope, session.id, next);
      setDisclosure({ scope, sessionId: session.id, expanded: next });
    }}>
      <summary className="panel-disclosure-summary" aria-expanded={expanded} aria-controls="work-status-content">
        <span className="panel-disclosure-copy">
          <span className="panel-disclosure-title" role="heading" aria-level={3}>{recovery ? 'Recovery & cleanup' : 'Save your work'}</span>
          <span className={`panel-disclosure-status${recovery || workNeedsAcknowledgement(status, now) ? ' warning' : ''}`} role="status" aria-live={recovery ? 'off' : undefined}>{recovery ? compactEndedOutcome(session, recoveryEvidence.publishedState, now) : compactWorkStatus(status, loading, now)}</span>
        </span>
        <span className="panel-disclosure-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div id="work-status-content" className="panel-disclosure-content">
        {recovery ? <EndedOutcome session={session} now={now} localStatus={status} {...recoveryEvidence}/> : <><div className="workflow-panel-heading"><span className="eyebrow">WHAT SURVIVES TEARDOWN</span><button className="button subtle small" onClick={() => void refresh()} disabled={loading}>Refresh work status</button></div><WorkStatusSummary status={status} loading={loading} now={now}/></>}
        {session.state === 'running' && <SaveGuidance session={session}/>}
      </div>
    </details>
  </section>;
}
export function StopWorkCheck({ session, now, onReady }: { session: Session; now: number; onReady: (ready: boolean) => void }) {
  const { status, loading, refresh } = useWorkStatus(session);
  const [acknowledged, setAcknowledged] = useState(false);
  const risk = workNeedsAcknowledgement(status, now);
  useEffect(() => { onReady(!loading && (!risk || acknowledged)); }, [loading, risk, acknowledged, onReady]);
  return <><WorkStatusSummary status={status} loading={loading} now={now}/><button className="text-button" disabled={loading} onClick={() => { onReady(false); setAcknowledged(false); void refresh(); }}>Check again</button>{!loading && risk && <label className="stop-acknowledgement"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)}/><span>I understand that unsaved work may be lost, including work whose status could not be confirmed.</span></label>}<p className="workflow-message">Stopping destroys this sandbox and begins credential cleanup. You can stop after acknowledging the risk.</p></>;
}
