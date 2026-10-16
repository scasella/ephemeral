import { EnvironmentSelector, SavedEnvironmentReference, selectedEnvironmentRef, type SelectedEnvironment } from './EnvironmentSelection';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { GitHubLaunchReview, GitHubLaunchSource } from '../shared/github-launch';
import { api, type Session } from './api';
import { GitHubLaunchRequestError, GitHubLaunchReviewLoader, githubLaunchReviewBlocked, githubLaunchStorageKey, readGitHubLaunchIntent, submitGitHubLaunch, type GitHubLaunchIntent } from './github-launch-state';
import './github-launch.css';
import { LaunchResourceCard } from './ResourceVisibility';

function savedRequest(accountKey: string) { try { return sessionStorage.getItem(githubLaunchStorageKey(accountKey)); } catch { return null; } }
export function hasSavedGitHubLaunch(accountKey: string) { return Boolean(savedRequest(accountKey)); }

type LaunchProps = { accountKey: string; userId: string; previewMode: boolean; canLaunch: boolean; now: number; extensionsAvailable?: boolean; onBusyChange: (busy: boolean) => void; onCreated: (session: Session) => void; onClose: () => void; refreshSessions: () => Promise<void> };

export function GitHubLaunchChoice({ children, busy = false, ...props }: LaunchProps & { children: ReactNode; busy?: boolean }) {
  const [method, setMethod] = useState<'picker' | 'url'>(() => savedRequest(props.accountKey) ? 'url' : 'picker');
  const [recovering, setRecovering] = useState(() => Boolean(savedRequest(props.accountKey)));
  const [posting, setPosting] = useState(false);
  return <div className="github-launch-choice">
    <div className="launch-methods" role="group" aria-label="Choose a launch source">
      <button type="button" className={`button ${method === 'picker' ? 'primary' : 'subtle'}`} aria-pressed={method === 'picker'} disabled={busy || posting || recovering} onClick={() => setMethod('picker')}>Repository picker</button>
      <button type="button" className={`button ${method === 'url' ? 'primary' : 'subtle'}`} aria-pressed={method === 'url'} disabled={busy || posting} onClick={() => setMethod('url')}>Paste GitHub URL</button>
    </div>
    {method === 'picker' && children}
    <GitHubLaunch {...props} active={method === 'url'} onRecoveryChange={setRecovering} onBusyChange={value => { setPosting(value); props.onBusyChange(value); }}/>
  </div>;
}

export function GitHubLaunch({ active = true, onRecoveryChange, ...props }: LaunchProps & { active?: boolean; onRecoveryChange?: (recovering: boolean) => void }) {
  const { accountKey, userId, previewMode, canLaunch, now, onCreated, onBusyChange, onClose, refreshSessions } = props;
  const [raw] = useState(() => savedRequest(accountKey));
  const [intent, setIntent] = useState<GitHubLaunchIntent | null>(() => readGitHubLaunchIntent(raw, accountKey, userId, previewMode));
  const [invalidSaved, setInvalidSaved] = useState(Boolean(raw && !intent));
  const [url, setUrl] = useState(intent?.review.url || '');
  const [review, setReview] = useState<GitHubLaunchReview | null>(null);
  const [environment, setEnvironment] = useState<SelectedEnvironment | null>(null);
  const [checking, setChecking] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');
  const [listStatus, setListStatus] = useState('');
  const mounted = useRef(false), postingRef = useRef(false), completed = useRef(false);
  const loader = useRef<GitHubLaunchReviewLoader | null>(null);
  const input = useRef<HTMLInputElement>(null), reviewHeading = useRef<HTMLHeadingElement>(null);
  const recovering = Boolean(intent || invalidSaved);
  const environmentSelection = selectedEnvironmentRef(environment, accountKey, review?.repositoryId || 0);
  const blocked = githubLaunchReviewBlocked(review, previewMode, now) || (!environmentSelection ? 'Choose and review an available environment profile before launching.' : null) || (!canLaunch ? 'Stop the active machine and finish cleanup, or check workspace configuration, before launching.' : null);

  useEffect(() => {
    mounted.current = true;
    const current = new GitHubLaunchReviewLoader((url, signal) => api('/github-launch/preview', { url }, { signal }), (value, busy, failure) => { if (mounted.current) { setEnvironment(null); setReview(value); setChecking(busy); setError(failure); } });
    loader.current = current;
    return () => { mounted.current = false; current.dispose(); loader.current = null; };
  }, [accountKey, userId]);
  useEffect(() => { onRecoveryChange?.(recovering); }, [recovering, onRecoveryChange]);
  useEffect(() => { if (active) input.current?.focus(); else loader.current?.invalidate(); }, [active]);
  useEffect(() => { if (review && active) reviewHeading.current?.focus(); }, [review, active]);

  function remember(next: GitHubLaunchIntent | null) {
    if (next) sessionStorage.setItem(githubLaunchStorageKey(accountKey), JSON.stringify(next));
    else sessionStorage.removeItem(githubLaunchStorageKey(accountKey));
    setIntent(next);
  }
  async function confirm() {
    if (postingRef.current || completed.current || invalidSaved || (!intent && (checking || blocked))) return;
    let next = intent;
    if (!next) {
      if (!review || !environmentSelection) return;
      next = { accountKey, userId, requestId: crypto.randomUUID(), createdAt: new Date().toISOString(), review, environment: environmentSelection };
      try { remember(next); } catch { setError('The browser could not save this request for safe recovery. Enable session storage and try again.'); return; }
    }
    postingRef.current = true; setPosting(true); onBusyChange(true); setError(''); setListStatus('');
    try {
      const session = await submitGitHubLaunch(next);
      if (!mounted.current || completed.current) return;
      completed.current = true;
      try { remember(null); } catch { /* A known successful result remains in the machine list. */ }
      onBusyChange(false); onCreated(session);
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof GitHubLaunchRequestError && failure.definite) {
        try { remember(null); setInvalidSaved(false); } catch { setInvalidSaved(true); }
        loader.current?.invalidate();
        setError(`${failure.message} Review the URL again before launching.`);
      } else setError(`${(failure as Error).message} The outcome may be uncertain. Check the machine list or retry this same saved request; its request ID, reviewed commit, and environment selection will be reused.`);
      void refreshSessions().catch(() => {});
    } finally { postingRef.current = false; if (mounted.current) { setPosting(false); onBusyChange(false); } }
  }
  async function checkMachines() {
    setListStatus('Checking machine list…');
    try { await refreshSessions(); if (mounted.current) setListStatus('Machine list refreshed. Close this review to inspect your machines. Retrying this saved request keeps the same request ID.'); }
    catch { if (mounted.current) setListStatus('The machine list could not be refreshed. The saved request is retained. Try checking again.'); }
  }
  const display = intent?.review || review;
  return <form hidden={!active} className="github-launch-form" onSubmit={event => { event.preventDefault(); if (!intent && !invalidSaved && !postingRef.current) void loader.current?.review(url); }}>
    <label htmlFor="github-launch-url">GitHub URL</label>
    <input ref={input} id="github-launch-url" type="url" inputMode="url" autoComplete="off" spellCheck={false} value={url} placeholder="https://github.com/owner/repository" aria-describedby="github-launch-help" disabled={posting || recovering} onChange={event => { loader.current?.invalidate(); setUrl(event.target.value); setListStatus(''); }}/>
    <p id="github-launch-help" className="form-help">Repository, branch, full 40-character commit, or pull request. Paste a URL, review its source, then confirm the launch.</p>
    {!recovering && <button className="button subtle github-review-button" type="submit" disabled={checking || posting || !url.trim()}>{checking ? 'Reviewing URL…' : 'Review URL'}</button>}
    {display && <GitHubLaunchReviewCard review={display} headingRef={reviewHeading} previewMode={previewMode}/>}
    {intent ? <SavedEnvironmentReference environment={intent.environment}/> : review && <EnvironmentSelector key={`${accountKey}-${review.repositoryId}`} accountKey={accountKey} repositoryId={review.repositoryId} disabled={posting} onChange={setEnvironment}/>}
    {display && <LaunchResourceCard previewMode={previewMode} now={now} extensionsAvailable={props.extensionsAvailable}/>}
    {recovering ? <div className="github-launch-recovery" role="status"><strong>{invalidSaved ? 'A saved launch request needs attention.' : 'A launch request is already saved.'}</strong><p>{invalidSaved ? 'The saved request could not be safely restored. Check the machine list before starting another launch. Close this dialog to inspect your machines.' : 'Its outcome may be uncertain. Retry keeps the same reviewed source, commit, and request ID, including after a reload. Check the machine list for the resulting machine.'}</p></div> : <p className="form-help" role="status">{checking ? 'Resolving this URL and checking repository access…' : blocked || 'Ready to launch a new work branch at this exact commit.'}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {listStatus && <p className="form-help" role="status">{listStatus}</p>}
    {recovering && <button type="button" className="button subtle small github-review-button" disabled={posting} onClick={() => void checkMachines()}>Check machine list</button>}
    <div className="modal-actions"><button type="button" className="button subtle" disabled={posting} onClick={onClose}>{recovering ? 'Close review' : 'Cancel'}</button><button type="button" className="button primary" disabled={posting || invalidSaved || (!intent && (checking || Boolean(blocked)))} onClick={() => void confirm()}>{posting ? 'Launching…' : intent ? 'Retry saved request' : previewMode ? 'Launch preview' : 'Launch machine'}</button></div>
  </form>;
}

export function GitHubLaunchReviewCard({ review, previewMode, headingRef }: { review: GitHubLaunchReview; previewMode: boolean; headingRef?: React.Ref<HTMLHeadingElement> }) {
  return <section className="github-launch-review" aria-labelledby="github-launch-review-heading"><h3 id="github-launch-review-heading" ref={headingRef} tabIndex={-1}>{previewMode ? 'Simulated source review' : 'Review launch source'}</h3><dl><div><dt>Repository</dt><dd>{review.repository}</dd></div><div><dt>Source</dt><dd>{review.kind === 'pull_request' ? `Pull request #${review.pullRequestNumber}` : review.kind === 'repository' ? 'Repository default branch' : review.kind === 'commit' ? 'Commit' : 'Branch'} · <code>{review.ref}</code></dd></div><div><dt>Base branch</dt><dd><code>{review.baseBranch}</code></dd></div><div><dt>Exact commit</dt><dd><code>{review.commitSha}</code></dd></div><div><dt>Initial lifetime</dt><dd>1 hour</dd></div></dl><p>{previewMode ? 'Simulated preview data. No compute or credentials are created.' : 'A fresh machine and new work branch will start at this commit. The server checks the source again before launching.'}</p><p>Commit and push changes you want to keep. A pull request is not created or updated automatically.</p></section>;
}

export function GitHubLaunchSourceDetails({ source }: { source: GitHubLaunchSource }) {
  return <div className="github-launch-source"><h4>Original launch source</h4><p>This source was recorded at launch.</p><dl className="settings-list"><div><dt>GitHub URL</dt><dd><a href={source.url} target="_blank" rel="noreferrer">{source.url}</a></dd></div><div><dt>Source kind</dt><dd>{source.kind.replace('_', ' ')}</dd></div><div><dt>Source ref</dt><dd><code>{source.ref}</code></dd></div><div><dt>Pinned commit</dt><dd><code>{source.commitSha}</code></dd></div></dl></div>;
}
