import type { ActivityState } from './session-activity';
import './session-activity.css';

export function SessionActivity({ state, onOlder, onNewest, onRetry }: { state: ActivityState; onOlder: () => void; onNewest: () => void; onRetry: () => void }) {
  const busy = state.pending !== null;
  return <section className="detail-panel session-activity" aria-labelledby="activity-heading">
    <div className="detail-heading"><div><span className="eyebrow">WORKSPACE JOURNAL</span><h3 id="activity-heading">Activity log</h3><p>Lifecycle events from creation through cleanup. Each page shows up to 50 events, oldest first.</p></div></div>
    <div className="activity-navigation" aria-label="Activity pages">
      <button className="button" aria-disabled={busy || !state.nextCursor} onClick={() => { if (!busy && state.nextCursor) onOlder(); }}>Load older page</button>
      <button className="button" aria-disabled={busy} onClick={() => { if (!busy) onNewest(); }}>Refresh newest</button>
      {state.error && <button className="text-button" aria-disabled={busy} onClick={() => { if (!busy) onRetry(); }}>Retry activity</button>}
    </div>
    <div className="activity-observation" role="status" aria-live="polite">
      {busy ? <p>{state.pending === 'older' ? 'Loading older activity…' : state.pending === 'poll' ? 'Checking newest activity…' : 'Loading newest activity…'}</p> : state.loaded ? <p>{state.events.length} events loaded on this {state.before === null ? 'newest' : 'older'} page.</p> : !state.error ? <p>Waiting to load activity.</p> : null}
      {state.loaded && state.events.length > 0 && <p>Loaded range: <time dateTime={state.events[0].at}>{new Date(state.events[0].at).toLocaleString()}</time> – <time dateTime={state.events.at(-1)!.at}>{new Date(state.events.at(-1)!.at).toLocaleString()}</time>.</p>}
      {state.before !== null ? <p>Live updates paused while browsing older activity. Refresh newest to return to current activity.</p> : state.loaded && !state.error ? <p>Newest page updates every 3 seconds.</p> : null}
      {state.loaded && !state.nextCursor && <p>No older events before this page.</p>}
    </div>
    {state.error && <p className="activity-error" role="alert">Activity unavailable: {state.error} {state.loaded ? 'Showing the last loaded page; its current status is unconfirmed.' : 'No activity page has been confirmed.'}</p>}
    <div className="event-list" aria-busy={busy}>
      {state.loaded && state.events.length === 0 ? <p className="muted">{state.error ? 'The last loaded page contained no events. Current activity is unconfirmed.' : state.before === null ? 'No activity recorded yet.' : 'No events on this older page. Refresh newest to return to current activity.'}</p> : state.events.map(event => <div className="event-row" key={event.id}><span className="event-dot"/><time dateTime={event.at}>{new Date(event.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><div><span className="event-kind">{event.kind.replace(/[_\.]/g, ' ')}</span><p>{event.message}</p></div></div>)}
    </div>
  </section>;
}
