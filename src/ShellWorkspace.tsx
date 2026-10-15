import { lazy, Suspense, useEffect, useLayoutEffect, useId, useRef, useState } from 'react';
import type { TerminalProps } from './Terminal';
import { ShellWorkspaceClient, SHELL_NAME_ERROR, mountedShells, parsePendingShellOperation, reconcileShellSelection, shellNameValue, type ShellOperation, type ShellWorkspaceState, type WorkspaceShell } from './shell-workspace';
import { focusWorkspaceTarget, restoreWorkspaceFocus } from './workspace-navigation';
import { previewShellDestination, type PreviewShellNavigationRequest } from './preview-shell-navigation';
import './shell-workspace.css';
const Terminal = lazy(() => import('./Terminal'));
const INITIAL: ShellWorkspaceState = { snapshot: null, pending: null, loading: true, sending: false, error: '' };

export function ShellWorkspace(props: TerminalProps & { navigationRequest?: PreviewShellNavigationRequest | null }) {
  const { sessionId, visible = true } = props;
  const [state, setState] = useState(INITIAL);
  const [selected, setSelected] = useState('codex');
  const [editor, setEditor] = useState<'create' | 'rename' | 'close' | null>(null);
  const [draft, setDraft] = useState('Shell');
  const [draftError, setDraftError] = useState('');
  const client = useRef<ShellWorkspaceClient | null>(null);
  const selectedTab = useRef<HTMLButtonElement | null>(null);
  const dialog = useRef<HTMLDialogElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const attachedShells = useRef(new Set(['codex']));
  const consumedNavigation = useRef<PreviewShellNavigationRequest | null>(null);
  const scope = useId();
  useEffect(() => {
    const key = `ephemeral-shell-operation:${sessionId}`;
    let pending: ShellOperation | null = null;
    try { pending = parsePendingShellOperation(sessionStorage.getItem(key)); } catch { /* Storage is optional. */ }
    const controller = new ShellWorkspaceClient(sessionId, setState, undefined, pending, operation => {
      try { if (operation) sessionStorage.setItem(key, JSON.stringify(operation)); else sessionStorage.removeItem(key); } catch { /* In-memory recovery remains available. */ }
    });
    client.current = controller;
    attachedShells.current = new Set(['codex']);
    setState(controller.state); setSelected('codex');
    void controller.refresh();
    return () => { controller.dispose(); if (client.current === controller) client.current = null; };
  }, [sessionId]);
  useEffect(() => {
    if (!state.snapshot) return;
    const next = reconcileShellSelection(selected, state.snapshot);
    if (next === selected) return;
    setSelected(next);
    const frame = requestAnimationFrame(() => { if (visible && !document.querySelector('dialog[open]')) focusWorkspaceTarget(`${scope}-tab-${next}`); });
    return () => cancelAnimationFrame(frame);
  }, [state.snapshot, selected, visible, scope]);
  useLayoutEffect(() => {
    if (visible) void client.current?.refresh();
  }, [visible, sessionId]);
  const recovering = Boolean(state.pending || state.snapshot?.shells.some(shell => ['creating', 'closing', 'uncertain'].includes(shell.state)));
  const hasOpenShell = Boolean(state.snapshot?.shells.some(shell => shell.kind === 'supplemental' && shell.state === 'open'));
  useEffect(() => {
    if (state.sending || !(recovering || (visible && hasOpenShell))) return;
    // Reading metadata discovers a shell that exited or was closed elsewhere.
    // Refresh never starts or stops a shell; the client coalesces overlapping GETs.
    const interval = setInterval(() => { void client.current?.refresh(); }, recovering ? 4000 : 10_000);
    return () => clearInterval(interval);
  }, [recovering, hasOpenShell, state.sending, visible]);
  useLayoutEffect(() => {
    if (!editor || !visible) return;
    const element = dialog.current;
    const opener = previousFocus.current;
    element?.showModal();
    return () => { element?.close(); requestAnimationFrame(() => restoreWorkspaceFocus(opener)); };
  }, [editor, visible]);
  useEffect(() => { if (!visible) setEditor(null); }, [visible]);
  const supplemental = mountedShells(state.snapshot);
  for (const shell of supplemental) if (shell.state === 'open') attachedShells.current.add(shell.id);
  const shells: Pick<WorkspaceShell, 'id' | 'name' | 'state'>[] = [{ id: 'codex', name: 'Codex', state: 'open' }, ...supplemental];
  const current = supplemental.find(shell => shell.id === selected);
  const blocked = state.sending || Boolean(state.pending) || state.loading;
  useLayoutEffect(() => {
    const request = props.navigationRequest;
    if (!request || consumedNavigation.current === request || request.sessionId !== sessionId || !request.isCurrent() || !visible || state.loading || client.current?.state.loading || editor) return;
    const shellId = previewShellDestination(state.snapshot, selected);
    if (shellId && selected !== shellId) { setSelected(shellId); return; }
    consumedNavigation.current = request;
    // Focus a saved shell tab, never its command input or the protected Codex terminal.
    const target = shellId ? `${scope}-tab-${shellId}` : `${scope}-open-shell`;
    if (!focusWorkspaceTarget(target)) focusWorkspaceTarget(`${scope}-refresh-shells`);
  }, [props.navigationRequest, sessionId, visible, state.loading, state.snapshot, selected, editor, scope]);
  const canClose = Boolean(current && !state.sending && !state.loading && (!state.pending || (state.pending.kind === 'create' && current.requestId === state.pending.requestId)));
  const begin = (kind: 'create' | 'rename' | 'close', opener: HTMLButtonElement) => { previousFocus.current = opener; setDraftError(''); setDraft(kind === 'create' ? 'Shell' : current?.name || 'Shell'); setEditor(kind); };
  const submit = async () => {
    if (!editor || (editor === 'close' ? !canClose : blocked) || (editor !== 'close' && !draft.trim())) return;
    if (editor !== 'close' && !shellNameValue(draft)) { setDraftError(SHELL_NAME_ERROR); return; }
    const operation: ShellOperation = { requestId: crypto.randomUUID(), kind: editor, ...(editor === 'create' ? {} : { shellId: selected }), ...(editor === 'close' ? {} : { name: draft.trim() }) };
    setEditor(null);
    const controller = client.current;
    await controller?.perform(operation);
    if (!controller || client.current !== controller) return;
    if (operation.kind === 'create') {
      const created = controller.state.snapshot?.shells.find(shell => shell.requestId === operation.requestId && shell.state !== 'closed');
      if (created) {
        setSelected(created.id);
        requestAnimationFrame(() => { if (client.current === controller && !document.querySelector('dialog[open]')) focusWorkspaceTarget(`${scope}-tab-${created.id}`); });
        return;
      }
    }
    if (selectedTab.current && !document.querySelector('dialog[open]')) focusWorkspaceTarget(selectedTab.current.id);
  };
  return <section className="shell-workspace" aria-label="Persistent workspace shells">
    <div className="shell-tabs-toolbar">
      <div role="tablist" aria-label="Shells" className="shell-tabs" onKeyDown={event => {
        const index = shells.findIndex(shell => shell.id === selected);
        const next = event.key === 'ArrowRight' ? shells[(index + 1) % shells.length] : event.key === 'ArrowLeft' ? shells[(index + shells.length - 1) % shells.length] : event.key === 'Home' ? shells[0] : event.key === 'End' ? shells.at(-1) : undefined;
        if (next) { event.preventDefault(); setSelected(next.id); document.getElementById(`${scope}-tab-${next.id}`)?.focus(); }
      }}>
        {shells.map(shell => <button key={shell.id} ref={shell.id === selected ? selectedTab : undefined} id={`${scope}-tab-${shell.id}`} type="button" role="tab" aria-selected={selected === shell.id} aria-controls={`${scope}-panel-${shell.id}`} tabIndex={selected === shell.id ? 0 : -1} className={selected === shell.id ? 'active' : ''} onClick={() => setSelected(shell.id)} title={shell.id === 'codex' ? 'Protected primary Codex terminal' : shell.name}>{shell.name}{shell.id !== 'codex' && shell.state !== 'open' && <span> · {shell.state}</span>}</button>)}
      </div>
      <div className="shell-actions">
        <button id={`${scope}-refresh-shells`} type="button" disabled={state.sending || state.loading} onClick={() => { void client.current?.refresh(); }}>Refresh saved shells</button>
        {current && <><button type="button" disabled={blocked || current.state !== 'open'} onClick={event => begin('rename', event.currentTarget)}>Rename</button><button type="button" disabled={!canClose} onClick={event => begin('close', event.currentTarget)}>Close shell</button></>}
        <button id={`${scope}-open-shell`} type="button" disabled={blocked || !state.snapshot?.canCreate} onClick={event => begin('create', event.currentTarget)}>+ Open shell</button>
      </div>
    </div>
    {state.snapshot?.reason && <p className="shell-description">{state.snapshot.reason}</p>}
    {state.loading && <p role="status" className="shell-message">Reading saved shells…</p>}
    {state.error && <p role="alert" className="shell-error">{state.error}</p>}
    {state.pending && <p role="status" className="shell-message">{state.sending ? state.pending.kind === 'close' ? 'Closing shell…' : state.pending.kind === 'create' ? 'Opening shell…' : 'Saving shell name…' : 'The shell request has not been confirmed. Saved shell state will be checked before another operation.'}</p>}
    {state.pending && !state.sending && <div className="shell-recovery"><button type="button" disabled={state.loading} onClick={() => { if (state.pending && (state.pending.kind !== 'close' || window.confirm('Retry closing this shell? Commands running in it will stop. Codex stays open. The machine and its expiration stay the same.'))) void client.current?.perform(state.pending); }}>Retry same request</button></div>}
    {shells.map(shell => <div key={shell.id} role="tabpanel" id={`${scope}-panel-${shell.id}`} aria-labelledby={`${scope}-tab-${shell.id}`} hidden={selected !== shell.id}>
      {attachedShells.current.has(shell.id) && <Suspense fallback={<div className="terminal-placeholder"><p>Connecting {shell.name} terminal…</p></div>}><Terminal {...props} shellId={shell.id} label={shell.name} visible={visible && selected === shell.id && shell.state === 'open'} onStatusChange={shell.id === 'codex' ? props.onStatusChange : undefined}/></Suspense>}
      {shell.id !== 'codex' && shell.state !== 'open' && <p className="shell-message" role="status">{shell.name} is {shell.state}. {supplemental.find(item => item.id === shell.id)?.error || 'Refresh saved shells to confirm its state before typing.'}</p>}
    </div>)}
    <details className="shell-details">
      <summary>About workspace shells</summary>
      <p className="shell-description">{props.preview ? 'Preview shells are simulated. No commands are executed.' : 'Open one additional persistent bash shell on this machine.'} Shells share the repository and expiration. Codex stays open. Reconnecting keeps the same shell.</p>
    </details>
    {editor && <dialog ref={dialog} className="modal shell-dialog" aria-labelledby={`${scope}-dialog-title`} aria-describedby={`${scope}-dialog-help`} onCancel={event => { event.preventDefault(); setEditor(null); }}>
      <h2 id={`${scope}-dialog-title`}>{editor === 'close' ? `Close ${current?.name || 'shell'}?` : editor === 'create' ? 'Open a shell' : 'Rename shell'}</h2>
      <p id={`${scope}-dialog-help`}>{editor === 'close' ? 'Closing this shell stops commands running in it. Codex stays open. The machine and its expiration stay the same.' : editor === 'create' ? props.preview ? 'Simulate an additional shell. No compute or commands are started.' : 'Start a persistent bash shell on this machine. Its expiration stays the same.' : 'Give this shell an ordinary name. Do not include credentials.'}</p>
      <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        {editor !== 'close' && <><label htmlFor={`${scope}-name`}>Shell name</label><input id={`${scope}-name`} value={draft} maxLength={80} autoFocus required onChange={event => { setDraftError(''); setDraft(event.target.value); }} aria-invalid={Boolean(draftError)} aria-describedby={`${scope}-name-help${draftError ? ` ${scope}-name-error` : ''}`}/><p id={`${scope}-name-help`} className="form-help">Up to 80 characters. Use an ordinary name; do not include credentials.</p>{draftError && <p id={`${scope}-name-error`} className="form-error" role="alert">{draftError}</p>}</>}
        <div className="modal-actions"><button type="button" className="button subtle" autoFocus={editor === 'close'} onClick={() => setEditor(null)}>Cancel</button><button className="button primary" disabled={(editor === 'close' ? !canClose : blocked) || (editor !== 'close' && !draft.trim())}>{editor === 'close' ? 'Close shell and stop commands' : editor === 'create' ? props.preview ? 'Open preview shell' : 'Open shell' : 'Save name'}</button></div>
      </form>
    </dialog>}
  </section>;
}
