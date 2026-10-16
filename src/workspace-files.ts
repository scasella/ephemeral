import { WORKSPACE_FILE_MAX_BYTES, WORKSPACE_DIRECTORY_MAX_ENTRIES, WORKSPACE_PATH_MAX_BYTES, WORKSPACE_PATH_MAX_DEPTH, type WorkspaceDirectory, type WorkspaceFile } from '../shared/workspace-files';
import type { Session } from './api';
import { sessionDeadline } from './workspace-navigation';
export type { WorkspaceDirectory, WorkspaceFile } from '../shared/workspace-files';
export const MAX_WORKSPACE_DRAFTS = 12;
export function validWorkspacePath(path: string, directory = false): boolean {
  return (directory && path === '') || Boolean(path && new TextEncoder().encode(path).length <= WORKSPACE_PATH_MAX_BYTES && path.split('/').length <= WORKSPACE_PATH_MAX_DEPTH && !/[\\\x00-\x1f\x7f-\x9f]/.test(path) && !/^[a-z]:/i.test(path) && !/[\ud800-\udfff]/u.test(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git'));
}
export function validWorkspaceText(content: string): boolean { return !/[\ud800-\udfff]/u.test(content) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(content); }
export function workspaceLineEndings(content: string): 'CRLF' | 'CR' | 'LF' | 'mixed' | 'none' {
  const endings = new Set(content.match(/\r\n|\r|\n/g) ?? []);
  return endings.size > 1 ? 'mixed' : endings.has('\r\n') ? 'CRLF' : endings.has('\r') ? 'CR' : endings.has('\n') ? 'LF' : 'none';
}
/** Textarea values use LF; keep a uniformly encoded existing file's original style. */
export function normalizeWorkspaceEdit(content: string, baseline: string, isNew = false): string {
  const style = isNew ? 'LF' : workspaceLineEndings(baseline);
  const ending = style === 'CRLF' ? '\r\n' : style === 'CR' ? '\r' : '\n';
  return content.replace(/\r\n|\r|\n/g, ending);
}
export function textBytes(content: string): number { return new TextEncoder().encode(content).length; }
export function filesUnavailableReason(session: Pick<Session, 'state' | 'expiresAt' | 'maxExpiresAt'>, now: number): string {
  if (session.state !== 'running') return session.state === 'provisioning' ? 'Files become available when this machine is running.' : 'This machine has stopped. Its disposable files are unavailable. Review work you committed and pushed before continuing in a new machine.';
  const deadline = sessionDeadline(session);
  return deadline === null || deadline <= now ? 'This machine’s lifetime has expired or could not be confirmed. Files are unavailable.' : '';
}
export function isFileSaveShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing'>): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.isComposing && event.key.toLowerCase() === 's';
}
/** Only an explicit file action may move focus; later input or remount cancels it. */
export class FileSelectionFocusIntent {
  private pendingPath: string | null = null;
  request(path: string) { this.pendingPath = path; }
  interrupt() { this.pendingPath = null; }
  consume(path: string | null): boolean {
    if (!path || this.pendingPath !== path) return false;
    this.pendingPath = null; return true;
  }
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export function validateWorkspaceFile(value: unknown, path: string): WorkspaceFile {
  if (!record(value) || value.path !== path || typeof value.content !== 'string' || textBytes(value.content) > WORKSPACE_FILE_MAX_BYTES || !validWorkspaceText(value.content) || typeof value.version !== 'string' || !/^[a-f0-9]{64}$/.test(value.version) || typeof value.simulation !== 'boolean') throw new Error('The file response could not be verified.');
  return { path, content: value.content, version: value.version, simulation: value.simulation };
}
export function validateWorkspaceDirectory(value: unknown, path: string): WorkspaceDirectory {
  if (!record(value) || value.path !== path || typeof value.truncated !== 'boolean' || typeof value.simulation !== 'boolean' || !Array.isArray(value.entries) || value.entries.length > WORKSPACE_DIRECTORY_MAX_ENTRIES) throw new Error('The directory response could not be verified.');
  const seen = new Set<string>();
  const entries = value.entries.map(entry => {
    if (!record(entry) || typeof entry.name !== 'string' || !entry.name || entry.name.includes('/') || entry.path !== (path ? `${path}/` : '') + entry.name || !validWorkspacePath(entry.path as string) || !['file', 'directory', 'unavailable'].includes(entry.kind as string) || seen.has(entry.path as string)) throw new Error('The directory response could not be verified.');
    seen.add(entry.path as string); return { name: entry.name, path: entry.path as string, kind: entry.kind as 'file' | 'directory' | 'unavailable' };
  });
  return { path, entries, truncated: value.truncated, simulation: value.simulation };
}
export class FileRequestError extends Error {
  constructor(message: string, public status = 0, public code = '', public unknownOutcome = false) { super(message); }
}
export type FilesTransport = (url: string, body: { path: string; content: string; expectedVersion: string | null } | undefined, signal: AbortSignal) => Promise<unknown>;
const transport: FilesTransport = async (url, body, signal) => {
  const response = await fetch(`/api${url}`, { credentials: 'same-origin', signal, ...(body ? { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1' }, body: JSON.stringify(body) } : {}) });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new FileRequestError(record(value) && typeof value.error === 'string' ? value.error : `Request failed (${response.status}).`, response.status, record(value) && typeof value.code === 'string' ? value.code : '', response.status >= 500 || (record(value) && value.outcome === 'unknown'));
  return value;
};
export interface FileDraft { path: string; content: string; baseline: string; version: string | null; isNew: boolean; uncertain: boolean; conflict: boolean; latest: WorkspaceFile | null; reviewed: boolean }
export interface WorkspaceFilesState { directory: WorkspaceDirectory | null; directoryPath: string; selectedPath: string | null; drafts: ReadonlyMap<string, FileDraft>; busy: 'directory' | 'read' | 'save' | 'reconcile' | null; error: string; notice: string; simulation: boolean }
export function draftDirty(draft: FileDraft): boolean { return draft.isNew || draft.content !== draft.baseline || draft.uncertain; }
/** All contents live only in this bounded memory object; no browser storage or automatic writes. */
export class WorkspaceFilesClient {
  state: WorkspaceFilesState = { directory: null, directoryPath: '', selectedPath: null, drafts: new Map(), busy: null, error: '', notice: '', simulation: false };
  private listeners = new Set<() => void>();
  private operation = 0;
  private active: { controller: AbortController; cancel: () => void } | null = null;
  private disposed = false;
  private available = true;
  constructor(readonly sessionId: string, private request: FilesTransport = transport, private timeoutMs = 35_000, private onDirtyChange: () => void = () => {}) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  get selected(): FileDraft | null { return this.state.drafts.get(this.state.selectedPath ?? '') ?? null; }
  get dirty(): boolean { return this.state.busy === 'save' || [...this.state.drafts.values()].some(draftDirty); }
  private update(change: Partial<WorkspaceFilesState>) {
    const wasDirty = this.dirty; this.state = { ...this.state, ...change };
    if (wasDirty !== this.dirty) this.onDirtyChange();
    this.listeners.forEach(listener => listener());
  }
  private setDraft(draft: FileDraft) { const drafts = new Map(this.state.drafts); drafts.set(draft.path, draft); this.update({ drafts }); }
  setAvailable(available: boolean) { if (this.available === available) return; this.available = available; if (!available) this.cancel(); }
  edit(content: string) {
    const draft = this.selected; if (!draft || !this.available) return false;
    const normalized = normalizeWorkspaceEdit(content, draft.baseline, draft.isNew);
    if (textBytes(normalized) > WORKSPACE_FILE_MAX_BYTES || !validWorkspaceText(normalized)) return false;
    this.setDraft({ ...draft, content: normalized }); return true;
  }
  selectRetained(path: string) { if (this.state.drafts.has(path) && !this.state.busy) this.update({ selectedPath: path }); }
  discard(path: string) { if (this.state.busy === 'save') return; const drafts = new Map(this.state.drafts); drafts.delete(path); this.update({ drafts, selectedPath: this.state.selectedPath === path ? null : this.state.selectedPath, error: '', notice: 'Draft discarded from this browser.' }); }
  private reserve(path: string): boolean {
    if (this.state.drafts.has(path) || this.state.drafts.size < MAX_WORKSPACE_DRAFTS) return true;
    const clean = [...this.state.drafts.values()].find(draft => !draftDirty(draft) && draft.path !== this.state.selectedPath);
    if (clean) { const drafts = new Map(this.state.drafts); drafts.delete(clean.path); this.update({ drafts }); return true; }
    this.update({ error: `Keep at most ${MAX_WORKSPACE_DRAFTS} file drafts per machine. Save or explicitly discard a draft before opening another file.` }); return false;
  }
  create(path: string): boolean {
    if (!this.available || this.state.busy || !validWorkspacePath(path)) { this.update({ error: 'Enter a repository-relative file path without .git, traversal, or control characters.' }); return false; }
    if (this.state.drafts.has(path)) { this.update({ selectedPath: path, error: 'This file is already open. Its draft has been preserved.' }); return false; }
    if (!this.reserve(path)) return false;
    this.setDraft({ path, content: '', baseline: '', version: null, isNew: true, uncertain: false, conflict: false, latest: null, reviewed: false });
    this.update({ selectedPath: path, error: '', notice: 'New text file draft. Select Save to create it in the machine.' }); return true;
  }
  private cancel() {
    this.operation++; this.active?.controller.abort(); this.active?.cancel(); this.active = null;
    if (this.state.busy === 'save' && this.selected) {
      this.setDraft({ ...this.selected, uncertain: true });
      this.update({ error: 'Save outcome unconfirmed. Your draft is preserved. Read the current file to reconcile before saving again.' });
    }
    this.update({ busy: null });
  }
  suspend() { this.cancel(); }
  dispose() { this.cancel(); this.disposed = true; this.listeners.clear(); }
  private async run<T>(kind: NonNullable<WorkspaceFilesState['busy']>, work: (signal: AbortSignal) => Promise<T>, accept: (value: T) => void) {
    if (this.disposed || !this.available || this.state.busy) return;
    const revision = ++this.operation, controller = new AbortController();
    let rejectCancel!: (reason: Error) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCancel = reject; });
    const timer = setTimeout(() => { controller.abort(); rejectCancel(new Error('The file request timed out.')); }, this.timeoutMs);
    this.active = { controller, cancel: () => rejectCancel(new Error('File request cancelled.')) };
    this.update({ busy: kind, error: '', notice: '' });
    try { const value = await Promise.race([work(controller.signal), cancelled]); if (this.operation === revision && !this.disposed && this.available) accept(value); }
    catch (failure) {
      if (this.operation !== revision || this.disposed) return;
      const error = failure as Error;
      if (kind === 'save' && this.selected) {
        const unknown = !(error instanceof FileRequestError) || error.unknownOutcome;
        this.setDraft({ ...this.selected, uncertain: unknown, conflict: error instanceof FileRequestError && error.status === 409 });
        this.update({ error: unknown ? 'Save outcome unconfirmed. Your draft is preserved. Read the current file to reconcile before saving again.' : error instanceof FileRequestError && error.status === 409 ? 'The file changed or already exists. Your draft is preserved. Read the current file and review it before saving again.' : `${error.message} Your draft is preserved.` });
      } else this.update({ error: `${error.message} Your draft is preserved.` });
    } finally { clearTimeout(timer); if (this.operation === revision) { this.active = null; this.update({ busy: null }); } }
  }
  directory(path = this.state.directoryPath): Promise<void> {
    if (!validWorkspacePath(path, true)) return Promise.resolve();
    return this.run('directory', signal => this.request(`/sessions/${this.sessionId}/files?path=${encodeURIComponent(path)}`, undefined, signal).then(value => validateWorkspaceDirectory(value, path)), directory => this.update({ directory, directoryPath: path, simulation: directory.simulation }));
  }
  open(path: string): Promise<void> {
    if (!validWorkspacePath(path) || this.state.busy || !this.available) return Promise.resolve();
    if (this.state.drafts.has(path)) { this.update({ selectedPath: path, error: '', notice: 'Restored this browser’s file draft.' }); return Promise.resolve(); }
    if (!this.reserve(path)) return Promise.resolve();
    return this.run('read', signal => this.read(path, signal), file => { this.setDraft({ ...file, baseline: file.content, isNew: false, uncertain: false, conflict: false, latest: null, reviewed: false }); this.update({ selectedPath: path, simulation: file.simulation }); });
  }
  private read(path: string, signal: AbortSignal) { return this.request(`/sessions/${this.sessionId}/file?path=${encodeURIComponent(path)}`, undefined, signal).then(value => validateWorkspaceFile(value, path)); }
  save(): Promise<void> {
    const draft = this.selected;
    if (!draft || !draftDirty(draft) || draft.uncertain || draft.conflict || !validWorkspacePath(draft.path) || textBytes(draft.content) > WORKSPACE_FILE_MAX_BYTES) return Promise.resolve();
    const sent = { ...draft };
    return this.run('save', signal => this.request(`/sessions/${this.sessionId}/file`, { path: sent.path, content: sent.content, expectedVersion: sent.version }, signal).then(value => {
      const file = validateWorkspaceFile(value, sent.path); if (file.content !== sent.content) throw new Error('Saved response did not match the submitted content.'); return file;
    }), file => {
      const current = this.state.drafts.get(sent.path); if (!current) return;
      this.setDraft({ ...current, baseline: sent.content, version: file.version, isNew: false, uncertain: false, conflict: false, latest: null, reviewed: false });
      this.update({ simulation: file.simulation, notice: `${file.simulation ? 'Saved in local simulation memory only.' : 'Saved to this disposable machine. Commit and push to keep this work.'}${current.content !== sent.content ? ' Newer edits remain unsaved.' : ''}` });
    });
  }
  reconcile(): Promise<void> {
    const draft = this.selected; if (!draft) return Promise.resolve();
    return this.run('reconcile', async signal => {
      try { return await this.read(draft.path, signal); }
      catch (error) { if (error instanceof FileRequestError && error.status === 404) return null; throw error; }
    }, latest => {
      const current = this.state.drafts.get(draft.path); if (!current) return;
      this.setDraft({ ...current, latest, conflict: true, reviewed: true });
      this.update({ notice: latest ? 'Current machine content is ready to review below. Your draft has not changed.' : 'The file was absent at this check. Your draft is preserved. Review below to explicitly prepare its creation, then save separately.', error: '' });
    });
  }
  resolveLatest(useDraft: boolean) {
    const draft = this.selected; if (!draft || !draft.reviewed || this.state.busy) return;
    const latest = draft.latest;
    if (!latest && !useDraft) return;
    this.setDraft({ ...draft, content: useDraft ? draft.content : latest?.content ?? '', baseline: latest?.content ?? '', version: latest?.version ?? null, isNew: latest === null, latest: null, reviewed: false, conflict: false, uncertain: false });
    this.update({ notice: useDraft ? 'Reviewed current version. Your draft is ready for an explicit Save.' : 'Loaded the current machine version. Browser draft replaced.', error: '' });
  }
}
/** A bounded account-owned registry preserves drafts across app navigation. */
export class WorkspaceFilesRegistry {
  private clients = new Map<string, WorkspaceFilesClient>();
  constructor(private onDirtyChange: () => void = () => {}) {}
  get dirty(): boolean { return [...this.clients.values()].some(client => client.dirty); }
  dirtyFor(id: string): boolean { return Boolean(this.clients.get(id)?.dirty); }
  peek(id: string): WorkspaceFilesClient | undefined { return this.clients.get(id); }
  get(id: string): WorkspaceFilesClient | null {
    const found = this.clients.get(id); if (found) return found;
    if (this.clients.size >= MAX_WORKSPACE_DRAFTS) {
      const clean = [...this.clients.entries()].find(([, client]) => !client.dirty && !client.state.busy);
      if (!clean) return null;
      clean[1].dispose(); this.clients.delete(clean[0]);
    }
    const client = new WorkspaceFilesClient(id, undefined, undefined, this.onDirtyChange); this.clients.set(id, client); return client;
  }
  updateAvailability(sessions: readonly Session[], now: number) {
    this.clients.forEach((client, id) => { const session = sessions.find(item => item.id === id); client.setAvailable(Boolean(session && !filesUnavailableReason(session, now))); });
  }
  dispose() { this.clients.forEach(client => client.dispose()); this.clients.clear(); this.onDirtyChange(); }
}
