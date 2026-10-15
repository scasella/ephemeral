import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Session } from './api';
import { ApplicationPreviewClient, emptyPreviewView, parsePreviewPort, previewUnavailableReason, validPreviewPort, validateViewerOrigin, type PreviewHandoff } from './application-preview';
import { readinessIsStale, readinessStateLabel, type ApplicationPreviewCheck } from './preview-readiness';
import { previewUnavailablePresentation } from './preview-presentation';
import { sessionDeadline } from './workspace-navigation';
import './application-preview.css';

interface Props {
  session: Session; preview: boolean; now: number; accountKey: string;
  onOpenShell?: () => void;
  onReviewPublished?: () => void;
  onContinueSavedWork?: (opener: HTMLButtonElement) => void;
}
export function ApplicationReadinessResult({ result, now }: { result: ApplicationPreviewCheck; now: number }) {
  const stale = readinessIsStale(result, now);
  return <div className="preview-readiness-result" aria-live="polite">
    <dl className="preview-facts preview-check-facts"><div><dt>Application check</dt><dd>{readinessStateLabel(result.state)}{stale ? ' · Stale' : ''}</dd></div><div><dt>Checked port</dt><dd>{result.port ?? 'None'}</dd></div><div><dt>HTTP status</dt><dd>{result.httpStatus ?? 'No response'}</dd></div><div><dt>Checked at</dt><dd><time dateTime={result.checkedAt}>{new Date(result.checkedAt).toLocaleString()}</time></dd></div></dl>
    {result.reason && <p>{result.reason}</p>}{result.remedy && <p>{result.remedy}</p>}
    {stale && <p>This result is at least one minute old. Check again to confirm the application’s current response.</p>}
    <p>A response to <code>HEAD /</code> confirms only that the selected application port replied at this time. It does not verify the page, HMR, or viewer sign-in.</p>
  </div>;
}
export function ApplicationPreview(props: Props) {
  return <ApplicationPreviewSession key={`${props.accountKey}:${props.session.userId}:${props.session.id}`} {...props}/>;
}

/** Native POST navigation keeps credentials out of URLs and preserves the user gesture. */
export function PrivatePreviewForm({ handoff, viewerOrigin, workspaceOrigin, now, onSubmit }: { handoff: PreviewHandoff; viewerOrigin: string; workspaceOrigin: string; now: number; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  let action: string;
  try { action = `${validateViewerOrigin(viewerOrigin, workspaceOrigin, handoff.generation)}/__ephemeral/open`; } catch { return null; }
  if (handoff.action !== action || !/^[A-Za-z0-9_-]{43}$/.test(handoff.token) || !validPreviewPort(handoff.port) || !Number.isFinite(Date.parse(handoff.expiresAt)) || Date.parse(handoff.expiresAt) <= now) return null;
  return <form method="POST" action={action} target="_blank" rel="noopener" onSubmit={onSubmit}>
    <input type="hidden" name="token" value={handoff.token}/>
    <button className="button primary small" type="submit">Open private preview <span aria-hidden="true">↗</span></button>
  </form>;
}

function ApplicationPreviewSession({ session, preview, now, accountKey, onOpenShell, onReviewPublished, onContinueSavedWork }: Props) {
  const [state, setState] = useState(emptyPreviewView);
  const [portText, setPortText] = useState('');
  const [portError, setPortError] = useState('');
  const client = useRef<ApplicationPreviewClient | null>(null);
  const clientScope = useRef('');
  const reason = previewUnavailableReason(session, preview, now);
  const unavailablePresentation = previewUnavailablePresentation(session, preview, now);
  const scope = `${accountKey}:${session.userId}:${session.id}:${session.state}:${session.expiresAt}:${session.maxExpiresAt}:${preview}`;
  const latest = useRef({ scope, reason });
  latest.current = { scope, reason };
  const workspaceOrigin = window.location.origin;
  const deadline = sessionDeadline(session);
  useEffect(() => {
    setState(emptyPreviewView); setPortText(''); setPortError('');
    clientScope.current = scope;
    if (reason) return;
    const current = new ApplicationPreviewClient(session.id, workspaceOrigin, setState, () => latest.current.scope === scope && !latest.current.reason);
    client.current = current;
    void current.refresh();
    return () => { current.dispose(); if (client.current === current) client.current = null; };
  }, [scope, reason, session.id, workspaceOrigin]);
  const snapshot = reason || clientScope.current !== scope ? null : state.snapshot;
  const busy = state.loading || Boolean(state.sending);
  const unavailable = reason || (snapshot?.mode === 'preview' ? 'Private application access is unavailable in preview simulation.' : !snapshot?.viewerOrigin && snapshot ? 'The isolated private viewer is not configured. Configure it on the server to enable access.' : snapshot?.state === 'unavailable' ? 'Private application access is currently unavailable. Refresh access to check again.' : null);
  const canChange = !unavailable && state.confirmed && Boolean(snapshot) && !busy;
  const enabled = state.confirmed && snapshot?.state === 'enabled';
  const selectedPort = snapshot?.port;
  const canCheck = canChange && enabled && portText === '';
  const readiness = enabled && snapshot && portText === '' ? state.readiness : null;
  const handoff = !reason && !busy && enabled && state.handoff && Date.parse(state.handoff.expiresAt) > now ? state.handoff : null;
  async function enable(event: FormEvent) {
    event.preventDefault();
    const port = parsePreviewPort(portText);
    if (port === null) { setPortError('Enter a whole-number port from 1024 to 49151.'); return; }
    if (!canChange) return;
    const current = client.current;
    setPortError(''); await current?.enable(port);
    if (current && client.current === current && latest.current.scope === scope && current.state.confirmed && current.state.snapshot?.port === port && !current.state.error) setPortText('');
  }
  return <section className="detail-panel application-preview" aria-label="Private application preview">
    <div className="detail-heading"><div><span className="eyebrow">YOUR APP, PRIVATE TO THIS MACHINE</span><h3>Preview</h3><p>Open one application port through an isolated private viewer.</p></div>{!reason && <button type="button" className="button subtle small" disabled={busy} onClick={() => void client.current?.refresh()}>{state.loading ? 'Checking…' : 'Refresh access'}</button>}</div>
    {!reason && <div className="preview-status" aria-live="polite">
      {state.loading && <p role="status">Checking saved private preview access…</p>}
      {state.sending && <p role="status">{state.sending === 'enable' ? 'Saving private preview access…' : state.sending === 'close' ? 'Closing private preview access…' : 'Preparing a one-use private opening…'}</p>}
      {state.error && <p className="preview-error" role="alert">{state.error}</p>}
      {state.notice && <p role="status">{state.notice}</p>}
    </div>}
    {unavailable ? <div className="preview-unavailable" aria-live="polite">
      <h4>{unavailablePresentation?.title ?? (state.confirmed ? 'Private viewer unavailable' : 'Prior private viewer status')}</h4>
      {!reason && !state.confirmed && <p>Current access has not been confirmed. The saved status below is from the prior check.</p>}
      <p>{unavailablePresentation?.reason ?? (snapshot?.reason || unavailable)}</p>
      {unavailablePresentation && <p>{unavailablePresentation.guidance}</p>}
      {unavailablePresentation?.recovery && <div className="preview-recovery-actions">
        {onReviewPublished && <button type="button" className="button primary small" onClick={onReviewPublished}>Review published work</button>}
        {onContinueSavedWork && <button type="button" className="button subtle small" onClick={event => onContinueSavedWork(event.currentTarget)}>Review continuation</button>}
      </div>}
      {!reason && <p>Refresh access after the viewer configuration or service is available again.</p>}
    </div> : <>
    <p className="preview-overview">Start server → Select port → Check application (optional) → Open private viewer.</p>
    <ol className="preview-sequence">
      <li className="preview-step">
        <span className="preview-step-number" aria-hidden="true">1</span>
        <div className="preview-step-heading"><h4>Start server</h4>{onOpenShell && <button type="button" className="button subtle small" onClick={onOpenShell}>Open supplemental shell</button>}</div>
        <p>Start your app yourself in a terminal shell and listen on <code>127.0.0.1</code> or <code>0.0.0.0</code>. These controls never run a start command.</p>
        <p>Keep server logs in a supplemental shell while Codex continues working.</p>
        <details className="preview-framework-help"><summary>Framework and HMR help</summary><p>For Vite, use the saved port with <code>strictPort: true</code> to prevent a silent port change. Route its HMR WebSocket through the private viewer’s host and port. An application response does not verify HMR; confirm updates in the viewer.</p></details>
      </li>
      <li className="preview-step">
        <span className="preview-step-number" aria-hidden="true">2</span>
        <h4>Select port</h4>
        <p>Save the port your server uses. Saved access does not confirm that the application is running or reachable.</p>
        <form className="preview-port-form" onSubmit={enable}>
          <div><label htmlFor="application-preview-port">Application port</label><input id="application-preview-port" type="text" inputMode="numeric" autoComplete="off" placeholder={selectedPort ? String(selectedPort) : 'e.g. 3000'} value={portText} maxLength={5} disabled={!canChange} aria-describedby="preview-port-help" aria-invalid={Boolean(portError)} onChange={event => { client.current?.clearPrepared(); setPortText(event.target.value); setPortError(''); }}/><p id="preview-port-help">Whole-number port from 1024 to 49151. One port per machine.</p></div>
          <button className="button primary small" type="submit" disabled={!canChange || parsePreviewPort(portText) === null}>{snapshot?.state === 'enabled' ? 'Replace preview access' : 'Enable preview access'}</button>
        </form>
        {portError && <p className="preview-error" role="alert">{portError}</p>}
        {snapshot && <dl className="preview-facts"><div><dt>{state.confirmed ? 'Saved access' : 'Prior saved access'}</dt><dd>{state.confirmed ? snapshot.state === 'enabled' ? 'Enabled' : snapshot.state === 'disabled' ? 'Disabled' : 'Unavailable' : 'Current access has not been confirmed'}</dd></div><div><dt>Selected port</dt><dd>{selectedPort ?? 'None'}</dd></div>{snapshot.updatedAt && <div><dt>Last saved</dt><dd><time dateTime={snapshot.updatedAt}>{new Date(snapshot.updatedAt).toLocaleString()}</time></dd></div>}</dl>}
        {snapshot?.state === 'enabled' && <p className="preview-access-warning">Replacing access, including with the same port, ends access for every existing viewer and prepared opening. Your app server and Codex keep running.</p>}
      </li>
      <li className="preview-step preview-readiness">
        <span className="preview-step-number" aria-hidden="true">3</span>
        <div className="preview-step-heading"><h4>Check application</h4><button type="button" className="button subtle small" disabled={!canCheck || state.checking} onClick={() => void client.current?.check()}>{state.checking ? 'Checking application…' : 'Check application'}</button></div>
        <p>Check the saved application port with an HTTP request. Saved preview access and application reachability are separate. This check is optional; you can prepare and open the viewer without it.</p>
        {!enabled && <p>Enable access for your server’s port before checking it.</p>}
        {enabled && portText !== '' && <p>Save the port change or clear the field before checking the application.</p>}
        {state.checking && enabled && <p role="status">Checking the application root on saved port {selectedPort}…</p>}
        {readiness && <ApplicationReadinessResult result={readiness} now={now}/>}
      </li>
      <li className="preview-step">
        <span className="preview-step-number" aria-hidden="true">4</span>
        <h4>Open private viewer</h4>
        <p>Prepare a one-use opening, then open the private viewer in a new tab.</p>
        <div className="preview-open-actions">
          <button type="button" className="button subtle small" disabled={!canChange || !enabled} onClick={() => void client.current?.prepare()}>Prepare private preview</button>
          {handoff && snapshot?.viewerOrigin && <PrivatePreviewForm handoff={handoff} viewerOrigin={snapshot.viewerOrigin} workspaceOrigin={workspaceOrigin} now={now} onSubmit={event => { if (latest.current.reason || latest.current.scope !== scope || !client.current?.consumeHandoff()) event.preventDefault(); }}/>}
        </div>
        {handoff && <p className="preview-help">Prepared for one opening until <time dateTime={handoff.expiresAt}>{new Date(handoff.expiresAt).toLocaleTimeString()}</time>. Select “Open private preview” to open a new tab.</p>}
        <p className="preview-help">Viewer access lasts up to 10 minutes and ends sooner when the machine expires or access changes. Prepare a fresh preview to open another tab or renew access.</p>
        <div className="preview-close-access"><button type="button" className="button subtle small" disabled={!canChange || !enabled} onClick={() => void client.current?.close()}>Close preview access</button><p>Closing access ends every existing viewer and prepared opening. The app server and Codex keep running; stop your server yourself in the terminal when needed.</p></div>
      </li>
    </ol>
    <p className="preview-help">Machine expires {deadline !== null ? <time dateTime={new Date(deadline).toISOString()}>{new Date(deadline).toLocaleString()}</time> : 'at an unconfirmed time'}.</p>
    </>}
  </section>;
}
