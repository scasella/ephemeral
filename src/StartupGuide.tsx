import { useEffect, useRef, useState } from 'react';
import { api, type Session } from './api';
import type { StartupProgress } from '../server/startup';
import { StartupLoader, type StartupAction } from './startup-loader';
import { canConfirmUsefulResponse, startupDuration } from './startup';

export function StartupGuide({ session, preview, terminalStatus, now }: { session: Session; preview: boolean; terminalStatus: string; now: number }) {
  const [progress, setProgress] = useState<StartupProgress | null>(null);
  const [busy, setBusy] = useState<StartupAction | null>('load');
  const [error, setError] = useState<{ message: string; action: StartupAction } | null>(null);
  const loader = useRef<StartupLoader | null>(null);
  const latest = useRef({ progress, error });
  latest.current = { progress, error };
  const liveRunning = !preview && session.state === 'running' && Date.parse(session.expiresAt) > now;

  useEffect(() => {
    const current = new StartupLoader(
      (action, signal) => api<StartupProgress>(`/sessions/${encodeURIComponent(session.id)}/${action === 'confirm' ? 'first-useful-response' : 'startup'}`, action === 'confirm' ? {} : undefined, { signal }),
      value => { setProgress(value); setError(null); }, setBusy,
      (message, action) => setError({ message, action }),
    );
    loader.current = current;
    setProgress(null); setError(null);
    void current.run();
    return () => { current.dispose(); if (loader.current === current) loader.current = null; };
  }, [session.id]);

  useEffect(() => {
    if (!liveRunning) return;
    // Read the persisted attachment marker after connection; stop polling once it is recorded.
    if (terminalStatus === 'connected') void loader.current?.run();
    const interval = setInterval(() => {
      if (!document.hidden && !latest.current.progress?.firstTerminalAttachedAt && !latest.current.error) void loader.current?.run();
    }, 5000);
    return () => clearInterval(interval);
  }, [liveRunning, terminalStatus]);

  const confirmed = progress?.firstUsefulResponseAt;
  const eligible = canConfirmUsefulResponse(session, progress, terminalStatus, now);
  const ended = !['running', 'provisioning'].includes(session.state);
  return <section className="startup-guide" aria-label="Codex startup guidance">
    <div className="startup-statuses" aria-label="Startup stages">
      <span>Machine: <strong>{preview ? `simulated ${session.state.replace('_', ' ')}` : session.state === 'running' && !liveRunning ? 'lifetime expired' : session.state.replace('_', ' ')}</strong></span>
      <span>Terminal: <strong>{preview ? 'simulation' : liveRunning ? terminalStatus : 'not connected'}</strong></span>
      <span>{confirmed ? 'First useful response' : 'Codex readiness'}: <strong>{preview ? 'not running in preview' : confirmed ? 'user-confirmed' : 'unconfirmed'}</strong></span>
    </div>
    {preview ? <p>This preview executes no commands or Codex sign-in. Startup response timing is available on a live machine.</p> : confirmed ? <p className="startup-confirmed" role="status"><strong>User-confirmed launch-to-confirmation: {startupDuration(progress.timeToFirstUsefulResponseMs!)}</strong><br/>Confirmed {new Date(confirmed).toLocaleString()}. Includes provisioning, sign-in, and waiting through your click; this is not automatic model latency. This measurement stores no response text.</p> : ended ? <p>This machine has ended. {progress ? <>{progress.firstTerminalAttachedAt ? 'First terminal attachment was recorded. ' : ''}No useful response has been user-confirmed.</> : error ? 'Startup confirmation is unavailable.' : 'Checking its saved startup confirmation…'}</p> : <>
      <p><strong>Start in the terminal.</strong> Complete a fresh ChatGPT/Codex device sign-in on the OpenAI page shown there. Finish Codex’s folder, trust, and onboarding prompts before typing a task. Never paste credentials into this app.</p>
      <div className="startup-confirm-action"><p>Try a small task, such as “Explain this repository in three sentences.” After you see a useful response, confirm it here.</p><button className="button subtle small" disabled={!eligible || Boolean(busy)} onClick={() => void loader.current?.run('confirm')}>{busy === 'confirm' ? 'Saving confirmation…' : 'I received a useful response'}</button></div>
      <p className="startup-measurement">User-confirmed timing includes sign-in and waiting, from launch until your click. It does not detect login or model output. This measurement stores no response text.{progress?.firstTerminalAttachedAt ? ' First terminal attachment recorded.' : busy === 'load' ? ' Checking first terminal attachment…' : ' Connect the terminal before confirming.'}</p>
    </>}
    {!preview && !ended && <details className="startup-help"><summary>Sign-in and recovery help</summary><ol>
      <li>If Codex is waiting or a task is queued, read and complete visible prompts first, then allow the current response to finish.</li>
      <li>Reconnect attaches to the same VM and shell. It does not restart Codex or reset the machine’s expiry deadline.</li>
      <li>Press <kbd>Esc</kbd> to cancel the current generation, or wait for it to finish. Once Codex is responsive and idle, type <code>/quit</code> and press Enter to return to the shell. If needed, <kbd>Ctrl+C</kbd> can interrupt current work; it may need repeating and does not guarantee exit. Do not kill tmux or launch another Codex while work is still active. Only after you see the shell prompt, run <code>codex</code> to start again.</li>
      <li>If sign-in has expired, return to the shell prompt, run <code>codex login --device-auth</code>, complete a fresh device sign-in, then run <code>codex</code>. Finish any onboarding prompts before your task.</li>
    </ol><p><a href="https://learn.chatgpt.com/docs/auth" target="_blank" rel="noreferrer">OpenAI device sign-in instructions ↗</a></p></details>}
    {error && <div className="startup-error" role="alert"><span>{error.message}</span><button className="text-button" disabled={Boolean(busy) || (error.action === 'confirm' && !eligible)} onClick={() => void loader.current?.run(error.action)}>Retry {error.action === 'confirm' ? 'confirmation' : 'startup status'}</button>{error.action === 'confirm' && <button className="text-button" disabled={Boolean(busy)} onClick={() => void loader.current?.run()}>Check saved confirmation</button>}</div>}
  </section>;
}
