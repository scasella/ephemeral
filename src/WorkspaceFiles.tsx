import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Session } from './api';
import { draftDirty, FileSelectionFocusIntent, filesUnavailableReason, isFileSaveShortcut, textBytes, workspaceLineEndings, validWorkspacePath, type WorkspaceFilesClient } from './workspace-files';
import { WORKSPACE_FILE_MAX_BYTES } from '../shared/workspace-files';
import { deferWorkspaceFocusRestore } from './workspace-navigation';
import './workspace-files.css';

function FileChoice({ title, children, onCancel }: { title: string; children: ReactNode; onCancel: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => { const opener = document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => { dialog.current?.close(); deferWorkspaceFocusRestore(opener); }; }, []);
  return <dialog className="modal files-choice" ref={dialog} onCancel={event => { event.preventDefault(); onCancel(); }} aria-labelledby="files-choice-title"><span className="eyebrow">BROWSER DRAFT</span><h2 id="files-choice-title">{title}</h2>{children}</dialog>;
}
export function WorkspaceFiles({ session, client, now, preview = false }: { session: Session; client: WorkspaceFilesClient | null; now: number; preview?: boolean }) {
  const reason = filesUnavailableReason(session, now);
  if (!client) return <section className="detail-panel workspace-files"><h3>Files</h3><p>Browser draft capacity reached. Return to another machine’s Files tab to save or discard its drafts before opening another workspace.</p></section>;
  return <WorkspaceFilesEditor key={session.id} client={client} reason={reason} preview={preview}/>;
}
function WorkspaceFilesEditor({ client, reason, preview }: { client: WorkspaceFilesClient; reason: string; preview: boolean }) {
  const state = useSyncExternalStore(client.subscribe, client.snapshot, client.snapshot);
  const draft = client.selected;
  const simulation = preview || state.simulation;
  const [choice, setChoice] = useState<{ title: string; run: () => void } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [inputError, setInputError] = useState('');
  const editor = useRef<HTMLTextAreaElement>(null);
  const focusIntent = useRef(new FileSelectionFocusIntent());
  const busy = Boolean(state.busy);
  const dirty = Boolean(draft && draftDirty(draft));
  const enabled = !reason && !busy;
  useEffect(() => { client.setAvailable(!reason); if (!reason && !client.state.directory && !client.state.busy) void client.directory(); }, [client, reason]);
  useEffect(() => () => client.suspend(), [client]);
  useEffect(() => {
    const interrupt = () => focusIntent.current.interrupt();
    document.addEventListener('pointerdown', interrupt, true);
    document.addEventListener('keydown', interrupt, true);
    document.addEventListener('focusin', interrupt, true);
    return () => { interrupt(); document.removeEventListener('pointerdown', interrupt, true); document.removeEventListener('keydown', interrupt, true); document.removeEventListener('focusin', interrupt, true); };
  }, []);
  useLayoutEffect(() => {
    if (focusIntent.current.consume(state.selectedPath) && !reason && !document.querySelector('dialog[open]')) editor.current?.focus({ preventScroll: true });
  }, [state.selectedPath, reason]);
  function requestAction(title: string, run: () => void) {
    if (dirty) setChoice({ title, run }); else run();
  }
  function open(path: string) { if (draft?.path === path) return; requestAction('Keep this draft before opening another file?', () => { focusIntent.current.request(path); void client.open(path); }); }
  function createFile() {
    const path = (state.directoryPath ? `${state.directoryPath}/` : '') + newName;
    if (!validWorkspacePath(path)) { setInputError('Use a relative file path without .git, empty segments, or traversal.'); return; }
    requestAction('Keep this draft before creating a file?', () => { focusIntent.current.request(path); if (client.create(path)) { setCreating(false); setNewName(''); setInputError(''); } });
  }
  return <section className="detail-panel workspace-files" aria-label="Workspace files" onKeyDown={event => { if (isFileSaveShortcut(event.nativeEvent)) { event.preventDefault(); if (enabled && !draft?.uncertain && !draft?.conflict) void client.save(); } }}>
    <div className="detail-heading"><div><span className="eyebrow">SMALL CHANGES, EXPLICIT SAVES</span><h3>Files {client.dirty && <span className="files-draft-badge">Unsaved drafts</span>}</h3><p>Browse your repository and edit text files in the browser.</p></div><button className="button subtle small" type="button" disabled={!enabled} onClick={() => requestAction('Refresh the folder with an unsaved draft?', () => { void client.directory(); })}>Refresh folder</button></div>
    <p className="files-scope">{simulation ? <><strong>Local simulation.</strong> Files are sample data held in server memory. Saves never reach a real machine or GitHub. </> : <>Saves write to this disposable machine. </>}Commit and push work you want to keep before the machine ends. The editor issues no terminal commands or Git commits. Text files up to 128 KiB.</p>
    {reason && <div className="files-unavailable" role="status"><strong>Files unavailable</strong><p>{reason}</p>{client.dirty && <p>Your browser drafts are still held in memory. You can select and copy their text below. They will be lost if this page closes.</p>}</div>}
    {state.error && <p className="files-error" role="alert">{state.error}</p>}
    <p className="files-status" role="status">{state.busy === 'save' ? 'Saving file… You can continue editing; later edits remain unsaved.' : state.busy === 'read' ? 'Opening file…' : state.busy === 'directory' ? 'Reading folder…' : state.busy === 'reconcile' ? 'Reading the current machine version…' : state.notice}</p>
    <div className="files-layout">
      <aside className="files-browser" aria-label="Repository file browser"><div className="files-folder-bar"><span title={state.directoryPath || 'Repository root'}>{state.directoryPath || 'Repository root'}</span><button className="text-button" disabled={!enabled || !state.directoryPath} onClick={() => { void client.directory(state.directoryPath.split('/').slice(0, -1).join('/')); }}>Up</button></div>
        <button className="button subtle small files-new" disabled={!enabled} onClick={() => { setCreating(true); setInputError(''); }}>＋ New file</button>
        {creating && <form className="files-create" onSubmit={event => { event.preventDefault(); createFile(); }}><label htmlFor="workspace-new-file">New text file path</label><input id="workspace-new-file" autoFocus value={newName} onChange={event => setNewName(event.target.value)} placeholder="e.g. notes.txt" aria-describedby="workspace-new-file-help" disabled={!enabled}/><p id="workspace-new-file-help">Relative to this folder. Parent folders must exist.</p>{inputError && <p role="alert">{inputError}</p>}<div><button className="button primary small" disabled={!enabled || !newName}>Create draft</button><button type="button" className="text-button" onClick={() => setCreating(false)}>Cancel</button></div></form>}
        <ul className="files-entries">{state.directory?.entries.map(entry => <li key={entry.path}><button type="button" title={entry.kind === 'unavailable' ? 'Unsupported file or symbolic link' : entry.path} disabled={!enabled || entry.kind === 'unavailable'} aria-pressed={entry.kind === 'file' ? state.selectedPath === entry.path : undefined} onClick={() => entry.kind === 'directory' ? void client.directory(entry.path) : open(entry.path)}><span className="files-entry-symbol" aria-hidden="true">{entry.kind === 'directory' ? '▸' : entry.kind === 'unavailable' ? '—' : '≡'}</span><span>{entry.name}</span>{state.drafts.has(entry.path) && draftDirty(state.drafts.get(entry.path)!) && <span className="files-unsaved-dot" aria-label="Unsaved draft">●</span>}</button></li>)}</ul>
        {state.directory && !state.directory.entries.length && <p className="files-browser-hint">This folder is empty.</p>}{state.directory?.truncated && <p className="files-browser-hint">Showing the first 200 entries. Use the terminal for larger folders.</p>}
        {state.drafts.size > 0 && <div className="files-drafts"><h4>Open in this browser</h4>{[...state.drafts.values()].map(item => <button type="button" className="text-button" key={item.path} disabled={busy} aria-pressed={state.selectedPath === item.path} onClick={() => { if (reason) client.selectRetained(item.path); else open(item.path); }}><span>{item.path}</span>{draftDirty(item) && <span aria-label="Unsaved draft">●</span>}</button>)}</div>}
      </aside>
      <div className="files-editor-pane">{draft ? <>
        <div className="files-editor-toolbar"><div><label htmlFor="workspace-file-editor">{draft.path}</label><span className="files-save-state">{draft.uncertain ? 'Save unconfirmed' : draft.conflict ? 'Review required' : dirty ? 'Unsaved' : simulation ? 'Saved in simulation' : 'Saved in machine'}{draft.isNew ? ' · New file' : ''}</span></div><button className="button primary small" disabled={!enabled || !dirty || draft.uncertain || draft.conflict} onClick={() => void client.save()}>Save file</button></div>
        <textarea id="workspace-file-editor" className="files-editor" ref={editor} value={draft.content} spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-describedby="workspace-file-editor-help" readOnly={Boolean(reason)} onChange={event => { if (!client.edit(event.target.value)) setInputError('The edit exceeds 128 KiB or contains unsupported control characters. The previous draft is preserved.'); else setInputError(''); }}/>
        <div className="files-editor-footer"><span>{textBytes(draft.content).toLocaleString()} / {WORKSPACE_FILE_MAX_BYTES.toLocaleString()} bytes</span><span>Plain text · {draft.isNew ? 'LF' : workspaceLineEndings(draft.baseline) === 'mixed' ? 'Mixed endings · saves normalize to LF' : workspaceLineEndings(draft.baseline) === 'none' ? 'LF' : `${workspaceLineEndings(draft.baseline)} preserved`} · Ctrl / ⌘ S to save</span></div><p id="workspace-file-editor-help" className="files-browser-hint">Drafts stay in memory while you navigate this workspace. Closing or reloading the page loses unsaved drafts.</p>{inputError && !creating && <p className="files-error" role="alert">{inputError}</p>}
        <div className="files-editor-actions"><button className="button subtle small" disabled={!enabled} onClick={() => requestAction('Read the current file with an unsaved draft?', () => { void client.reconcile(); })}>Read current file</button><button className="text-button" disabled={busy} onClick={() => setChoice({ title: 'Discard this browser draft?', run: () => client.discard(draft.path) })}>Discard draft</button></div>
        {draft.reviewed && <div className="files-reconcile"><h4>Review current machine version</h4><p>{draft.latest ? 'Your browser draft is preserved above. Compare the current content before choosing what to keep.' : `This file was absent at the last check. ${draft.isNew ? 'Prepare another create attempt' : 'Choose Recreate deleted file'} to keep your draft and prepare its creation. Select Save file separately to write it. If a file appears meanwhile, creation will be blocked.`}</p>{draft.latest && <pre tabIndex={0} aria-label="Current machine file content">{draft.latest.content || '(empty file)'}</pre>}<div><button className="button subtle small" disabled={!enabled} onClick={() => client.resolveLatest(true)}>{draft.latest ? 'Keep draft against this version' : draft.isNew ? 'Prepare create again' : 'Recreate deleted file'}</button>{draft.latest && <button className="button subtle small" disabled={!enabled} onClick={() => setChoice({ title: 'Replace your draft with the current machine version?', run: () => client.resolveLatest(false) })}>Use current file</button>}</div><p>Keeping your draft enables an explicit Save against this reviewed version. A newer change will still block the save.</p></div>}
      </> : <div className="files-editor-empty"><span aria-hidden="true">[ / ]</span><h4>A small edit starts here.</h4><p>Select a text file, or create a new one.<br/>Your terminal keeps running while you edit.</p></div>}</div>
    </div>
    {choice && <FileChoice title={choice.title} onCancel={() => setChoice(null)}><p>{draft?.path && <><strong>{draft.path}</strong><br/></>}Your draft is held only in this browser. Choose explicitly before continuing.</p><div className="files-choice-actions"><button className="button subtle small" onClick={() => setChoice(null)}>Cancel</button>{!choice.title.startsWith('Discard') && !choice.title.startsWith('Replace') && <button className="button primary small" onClick={() => { const run = choice.run; setChoice(null); run(); }}>Keep draft and continue</button>}<button className="button subtle small" onClick={() => { const run = choice.run; if (!choice.title.startsWith('Replace') && draft) client.discard(draft.path); setChoice(null); run(); }}>{choice.title.startsWith('Replace') ? 'Replace draft' : 'Discard draft and continue'}</button></div></FileChoice>}
  </section>;
}
