import type { Session } from './api';
import type { HandoffNote } from './handoff-notes';
import type { PublishedViewState } from './published-changes';
import type { SavedPullRequest, WorkStatus } from './workflow';
import { Cleanup } from './Cleanup';
import { computeOutcome, evidenceAge, publishedOutcome } from './ended-outcome';
import './ended-outcome.css';

export interface RecoveryEvidenceProps {
  publishedState?: PublishedViewState | null;
  savedNote?: HandoffNote | null;
  inheritedNotePresent?: boolean | null;
  pullRequests?: SavedPullRequest[] | null;
  onReviewPublished?: () => void;
  onReviewNotes?: () => void;
  onReviewCleanup?: () => void;
}

function CheckTime({ checkedAt, age, local = false }: { checkedAt: string | null; age: string | null; local?: boolean }) {
  return age ? <p className="recovery-check-time">{checkedAt ? <>{local ? 'Local status reported' : 'Checked'} <time dateTime={checkedAt}>{new Date(checkedAt).toLocaleString()}</time> · </> : null}{age}. {local ? 'This is a status response time.' : 'This is a check time.'}</p> : null;
}

function LastLocalResponse({ status, now }: { status: WorkStatus; now: number }) {
  return <details className="recovery-local-response"><summary>Last local status response</summary>
    <CheckTime local checkedAt={Number.isFinite(Date.parse(status.checkedAt)) ? status.checkedAt : null} age={evidenceAge(status.checkedAt, now)}/>
    <p>Last reported local status: {status.state}. This does not establish that all local work was preserved. These are diagnostics from a dated response, not final shutdown evidence.</p>
    {status.reason && <p>Reason reported in that response: {status.reason}</p>}
    <dl className="recovery-local-facts">
      <div><dt>Changed tracked files reported</dt><dd>{status.dirtyFiles ?? 'Unknown'}</dd></div>
      <div><dt>Untracked files reported</dt><dd>{status.untrackedFiles ?? 'Unknown'}</dd></div>
      <div><dt>Unpushed commits reported on assigned branch</dt><dd>{status.aheadCommits ?? 'Unknown'}</dd></div>
      <div><dt>Current branch reported</dt><dd>{status.branch ?? 'Unknown'}</dd></div>
      <div><dt>Assigned branch match reported</dt><dd>{status.branchMatches === null ? 'Unknown' : status.branchMatches ? 'Matched' : 'Different branch'}</dd></div>
      <div><dt>Remote branch reported</dt><dd>{status.remoteExists === null ? 'Unknown' : status.remoteExists ? 'Found' : 'Not found'}</dd></div>
    </dl>
    {status.remoteSha && <p>Remote commit observed in that response: <code>{status.remoteSha}</code>{status.remoteCheckedAt && <> · {Number.isFinite(Date.parse(status.remoteCheckedAt)) ? <time dateTime={status.remoteCheckedAt}>{new Date(status.remoteCheckedAt).toLocaleString()}</time> : 'Check time unconfirmed'}. This is a remote observation time.</>}</p>}
  </details>;
}

export function EndedOutcome({ session, now, localStatus, publishedState, savedNote, inheritedNotePresent, pullRequests, onReviewPublished, onReviewNotes, onReviewCleanup }: RecoveryEvidenceProps & { session: Session; now: number; localStatus: WorkStatus | null }) {
  const compute = computeOutcome(session);
  const published = publishedOutcome(session, publishedState, now);
  const noteHasContent = savedNote && [savedNote.nextStep, savedNote.unresolvedIssues, savedNote.verification].some(value => value.trim());
  return <div className="ended-outcome" aria-label="Recovery evidence">
    <p className="recovery-compute"><strong>{compute.title}.</strong> {compute.detail}</p>
    <div className="recovery-evidence-grid">
      <section className="recovery-evidence" aria-label="Former local inspection"><h4>Former local inspection</h4><strong>Local work survival unconfirmed</strong><p>Uncommitted files, local-only commits, ignored files and files outside the repository cannot be recovered from a pushed comparison. No current local check proves that no work was lost.</p>{localStatus && <LastLocalResponse status={localStatus} now={now}/>}</section>
      <section className={`recovery-evidence${published.confirmed ? ' recovery-confirmed' : ''}`} aria-label="Independent published evidence"><h4>Published evidence</h4><strong>{published.title}</strong><CheckTime checkedAt={published.checkedAt} age={published.age}/>{published.headSha && <p>Pushed head observed: <code>{published.headSha}</code></p>}<p>{published.detail}</p>{onReviewPublished && <button type="button" className="text-button" onClick={onReviewPublished}>Review published work</button>}</section>
      <section className="recovery-evidence" aria-label="Saved handoff presence"><h4>Saved handoff</h4><p><strong>Notes: </strong>{!savedNote ? 'Saved-note presence unconfirmed.' : noteHasContent ? 'Saved note present.' : savedNote.revision === 0 ? 'No note saved yet.' : 'Saved note is empty.'}{savedNote && savedNote.revision > 0 && <> Revision {savedNote.revision}{savedNote.updatedAt && <> · <time dateTime={savedNote.updatedAt}>{new Date(savedNote.updatedAt).toLocaleString()}</time></>}.</>}</p><p><strong>Inherited note: </strong>{inheritedNotePresent === true ? 'Present.' : inheritedNotePresent === false ? 'None.' : 'Unconfirmed.'}</p><p><strong>Pull requests: </strong>{!pullRequests ? 'Linked-PR presence unconfirmed.' : pullRequests.length ? `${pullRequests.length} saved ${pullRequests.length === 1 ? 'PR link' : 'PR links'} present.` : 'No saved PR links.'}</p><p>Saved notes and links do not verify current code or continuation readiness.</p>{onReviewNotes && <button type="button" className="text-button" onClick={onReviewNotes}>Review Notes</button>}</section>
    </div>
    <section className="recovery-cleanup" aria-label="Independent recovery cleanup"><h4>Access & cleanup</h4><p>Each result covers its own resource.</p><Cleanup session={session}/>{onReviewCleanup && <button type="button" className="text-button" onClick={onReviewCleanup}>Review Access</button>}</section>
  </div>;
}
