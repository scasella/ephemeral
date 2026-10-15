import type { ReactNode } from 'react';
import type { Session } from './api';
import type { MachineTab } from './session-route';
import { sessionName } from './session-history';
import { remainingSessionSeconds, sessionDeadline, workspaceSnapshotFresh, focusWorkspaceTarget } from './workspace-navigation';

function remainingText(session: Session, now: number): string {
  if (!['running', 'provisioning'].includes(session.state)) return session.state === 'cleanup_pending' ? 'Cleanup pending' : session.state === 'failed' ? 'Session failed' : 'Session ended';
  const remaining = remainingSessionSeconds(session, now);
  if (remaining === null) return 'Deadline unavailable';
  if (remaining === 0) return 'Lifetime expired; awaiting server confirmation';
  const seconds = Math.floor(remaining);
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')} remaining`;
}
function ContextIdentity({ session, now }: { session: Session; now: number }) {
  return <><strong>{sessionName(session)}</strong><span className="workspace-context-state">{session.state.replaceAll('_', ' ')}</span><span className="workspace-context-time" aria-live="off">{remainingText(session, now)}</span><p className="workspace-context-copy">{session.repository} · {session.branch}</p></>;
}
export function SelectedWorkspaceContext({ session, now, confirmedAt, detailTab, actions }: { session: Session; now: number; confirmedAt: number | null; detailTab: MachineTab; actions?: ReactNode }) {
  const active = ['running', 'provisioning'].includes(session.state);
  const deadline = sessionDeadline(session);
  return <section className="selected-machine-header" aria-label="Selected machine">
    <div className="selected-machine-identity">
      <div className="selected-machine-title"><h2 id="machine-detail-heading" tabIndex={-1}>{sessionName(session)}</h2><span className={`badge state-${session.state}`}><span className="status-dot"/>{session.state.replaceAll('_', ' ')}</span></div>
      <p className="selected-machine-branches"><span>{session.repository}</span><span>Work: <code>{session.branch}</code></span><span>Base: <code>{session.baseBranch}</code></span></p>
    </div>
    <div className="selected-machine-lifetime"><strong aria-live="off">{remainingText(session, now)}</strong>{active && deadline !== null && <span>Deadline: <time dateTime={new Date(deadline).toISOString()}>{new Date(deadline).toLocaleString()}</time></span>}</div>
    {!workspaceSnapshotFresh(confirmedAt, now) && <p className="workspace-context-stale">Status check unavailable. Showing the last known state and deadline.</p>}
    <div className="selected-machine-controls"><a className="workspace-main-link" href={`#tab-${detailTab}`} onClick={event => { event.preventDefault(); focusWorkspaceTarget(`tab-${detailTab}`); }}>Go to machine details</a><div className="selected-machine-actions">{actions}</div></div>
  </section>;
}
export function ActiveWorkspaceContext({ sessions, selectedId, inMachines, now, confirmedAt, openingId, onOpen }: { sessions: readonly Session[]; selectedId: string | null; inMachines: boolean; now: number; confirmedAt: number | null; openingId: string | null; onOpen: (id: string) => void }) {
  if (!sessions.length) return null;
  return <section className="workspace-context active-workspace-context" id="active-work-context" tabIndex={-1} aria-label="Active work">
    <div><span className="workspace-context-heading">Active work</span>{sessions.map((session, index) => <div className="workspace-context-machine" key={session.id}><ContextIdentity session={session} now={now}/><div className="workspace-context-actions"><button id={index === 0 ? 'active-work-control' : undefined} className="button subtle small" type="button" disabled={openingId !== null} onClick={() => onOpen(session.id)}>{openingId === session.id ? 'Checking machine…' : selectedId === session.id && inMachines ? 'Open active work' : 'Return to active work'}</button></div></div>)}{!workspaceSnapshotFresh(confirmedAt, now) && <p className="workspace-context-stale">Status check unavailable. Showing the last known state and deadline. Opening active work checks its current status first.</p>}</div>
  </section>;
}
