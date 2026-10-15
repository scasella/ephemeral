import { useEffect, useRef, useState } from 'react';
import type { Session } from './api';
import { requestSetup, setupOutputNotice, setupDraft, setupDraftMatches, setupRunActive, setupRunBlocked, setupRunGuidance, setupRunSummary, SetupLoader, validateSetupDraft, type SetupAction, type SetupDraft, type SetupState } from './repository-setup';

export function RepositorySetup({ session, preview, now }: { session: Session; preview: boolean; now: number }) {
  const [state, setState] = useState<SetupState | null>(null);
  const [draft, setDraft] = useState<SetupDraft>(() => setupDraft(null));
  const [busy, setBusy] = useState<SetupAction['type'] | null>('load');
  const [error, setError] = useState('');
  const [validation, setValidation] = useState('');
  const [message, setMessage] = useState('');
  const loader = useRef<SetupLoader | null>(null);
  const edited = useRef(false);
  const latest = useRef({ state, error }); latest.current = { state, error };

  useEffect(() => {
    const current = new SetupLoader(
      (action, signal) => requestSetup(session.id, action, signal),
      (value, action) => {
        setState(value); setError('');
        if (action.type === 'save' || !edited.current) { edited.current = false; setDraft(setupDraft(value.recipe)); }
        if (action.type === 'save') setMessage('Recipe saved. Run it explicitly when you are ready.');
        if (action.type === 'run') setMessage(value.mode === 'preview' ? 'Simulation requested. No command executes in preview.' : 'Run requested. Read the result below.');
        if (action.type === 'cancel') setMessage('Cancellation requested. The recorded status below confirms the outcome.');
      }, setBusy, message => { setError(message); setMessage(''); },
    );
    loader.current = current; edited.current = false;
    setState(null); setDraft(setupDraft(null)); setError(''); setValidation(''); setMessage('');
    void current.run();
    const interval = setInterval(() => { if (!document.hidden && setupRunActive(latest.current.state?.run ?? null) && !latest.current.error) void current.run(); }, 3000);
    return () => { current.dispose(); clearInterval(interval); if (loader.current === current) loader.current = null; };
  }, [session.id]);

  const recipe = state?.recipe ?? null;
  const run = state?.run ?? null;
  const running = setupRunActive(run);
  const cancellationPending = busy === 'cancel';
  const guidance = run ? setupRunGuidance(run) : null;
  const outputNotice = run ? setupOutputNotice(run) : null;
  const blocked = setupRunBlocked(run, now);
  const editable = session.state === 'running' && Date.parse(session.expiresAt) > now;
  const matches = setupDraftMatches(draft, recipe);
  const disabled = Boolean(busy || error || !state);
  const simulation = preview || state?.mode === 'preview';
  function edit(field: keyof SetupDraft, value: string) { edited.current = true; setDraft(current => ({ ...current, [field]: value })); setValidation(''); setMessage(''); }
  function save(event: React.FormEvent) {
    event.preventDefault();
    const invalid = validateSetupDraft(draft); if (invalid) { setValidation(invalid); return; }
    void loader.current?.run({ type: 'save', recipe: { label: draft.label.trim(), command: draft.command.trim(), timeoutSeconds: Number(draft.timeoutSeconds) } });
  }
  return <section className="detail-panel repository-setup" aria-label="Repository setup">
    <div className="detail-heading"><div><span className="eyebrow">REPEATABLE REPOSITORY SETUP</span><h3>Setup recipe</h3><p>Save a command for {session.repository} and reuse it on fresh machines. Each run requires your explicit click.</p></div><button className="button subtle small" disabled={Boolean(busy)} onClick={() => void loader.current?.run()}>Check saved setup</button></div>
    <p className="setup-execution-note">{simulation ? <><strong>Preview simulation.</strong> Saving and running here executes no commands or compute.</> : <>The command runs in the repository workspace and can change files. The recipe and bounded output are saved by Ephemeral. Do not enter secrets or commands that print credentials.</>}</p>
    {!editable && <p className="workflow-message">{session.state === 'provisioning' ? 'Wait until this machine is running to save or run a recipe.' : 'This machine is no longer available for setup. Its saved recipe and latest run remain visible.'}</p>}
    {busy === 'load' && !state && <p className="workflow-message" role="status">Loading saved setup…</p>}
    <form onSubmit={save} className="setup-form">
      <label htmlFor="setup-label">Recipe label</label><input id="setup-label" value={draft.label} maxLength={80} disabled={!editable || disabled} onChange={event => edit('label', event.target.value)}/>
      <label htmlFor="setup-command">Command</label><textarea id="setup-command" value={draft.command} rows={6} maxLength={8192} spellCheck={false} placeholder="npm ci" disabled={!editable || disabled} onChange={event => edit('command', event.target.value)} aria-describedby="setup-command-help"/>
      <p id="setup-command-help" className="workflow-message">Use the shell command you intend to run. Nothing runs when you save, reload, reconnect, or launch a new machine. The remaining machine lifetime can shorten the saved timeout.</p>
      <label htmlFor="setup-timeout">Timeout in seconds</label><input id="setup-timeout" className="setup-timeout" type="number" min={5} max={600} step={1} value={draft.timeoutSeconds} disabled={!editable || disabled} onChange={event => edit('timeoutSeconds', event.target.value)}/>
      <div className="setup-actions"><button className="button subtle small" type="submit" disabled={!editable || disabled || matches}>{busy === 'save' ? 'Saving recipe…' : 'Save recipe'}</button><button className="button primary small" type="button" disabled={!editable || disabled || !matches || running || blocked} onClick={() => { setMessage(''); void loader.current?.run({ type: 'run', recipeVersion: recipe!.version }); }}>{busy === 'run' ? 'Requesting run…' : simulation ? 'Simulate saved recipe' : 'Run saved recipe'}</button></div>
      {recipe && <p className="workflow-message">Saved {new Date(recipe.updatedAt).toLocaleString()}.{!matches && editable ? ' Save your changes before running.' : ''}</p>}
      {!recipe && state && <p className="workflow-message">No recipe saved for your account and this repository.</p>}
    </form>
    {validation && <p className="form-error" role="alert">{validation}</p>}
    {error && <p className="setup-error" role="alert">{error} Use Check saved setup to confirm the current recipe and run before another action.</p>}
    {message && <p className="workflow-message" role="status">{message}</p>}
    {run && <div className="setup-run" aria-label="Latest setup run">
      <div className="setup-run-heading"><div><span className="eyebrow">{simulation ? 'LATEST SIMULATED RUN' : 'LATEST RUN'}</span><h4>{run.recipe.label}</h4><p role="status">{simulation ? 'Simulated: ' : ''}{setupRunSummary(run)}</p></div>{(running || cancellationPending) && <button className="button subtle small" aria-disabled={!editable || disabled} aria-busy={cancellationPending} onClick={() => { if (!editable || disabled) return; setMessage('Requesting cancellation. Waiting for the recorded outcome…'); void loader.current?.run({ type: 'cancel', runId: run.id }); }}>{cancellationPending ? 'Requesting cancellation…' : 'Cancel run'}</button>}</div>
      <p className="workflow-message">{run.invocationStarted === false ? (running ? 'Waiting to start. ' : 'Execution did not start. ') : run.startedAt ? `Started ${new Date(run.startedAt).toLocaleString()}. ` : running ? 'Waiting to start. ' : 'Start time not recorded. '}{run.finishedAt ? `Finished ${new Date(run.finishedAt).toLocaleString()}. ` : ''}Timeout: {run.recipe.timeoutSeconds}s.</p>
      <details className="setup-run-command"><summary>Command recorded for this run</summary><pre><code>{run.recipe.command}</code></pre></details>
      {guidance ? <p className="setup-error">{guidance}</p> : run.error && <p className="setup-error">{run.error}</p>}
      {blocked && !running && <p className="setup-error">A previous process may still be active. Another run is blocked until {new Date(run!.blockedUntil!).toLocaleString()}.</p>}
      <pre className="setup-output" aria-label={simulation ? 'Simulated setup output' : 'Saved setup output'} tabIndex={0}><code>{run.output || (running ? 'Waiting for output…' : 'No output recorded.')}</code></pre>
      {outputNotice && <p className="workflow-message">{outputNotice}</p>}
      {running && <p className="workflow-message">Status updates every 3 seconds while this tab is visible. The run continues when you leave this tab.</p>}
    </div>}
  </section>;
}
