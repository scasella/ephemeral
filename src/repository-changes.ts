import { api } from './api';
import type { Session } from './api';
import type { WorkspaceChanges } from '../server/workspace-changes';

export type { WorkspaceChanges };
// Keep the browser's validation independent of server implementation/runtime imports.
const maxFiles = 200, maxPathBytes = 4096, maxTextBytes = 65536;
const bytes = (value: string) => new TextEncoder().encode(value).length;
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function path(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxPathBytes && bytes(value) <= maxPathBytes && new TextDecoder().decode(new TextEncoder().encode(value)) === value && !value.includes('\0') && !value.startsWith('/') && !/^[a-z]:/i.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..');
}
function nullableString(value: unknown, max: number): boolean { return value === null || (typeof value === 'string' && value.length <= max); }

/** Fail closed before repository-controlled strings reach the preview. */
export function validateChanges(value: unknown, requestedPath: string | null): WorkspaceChanges {
  const invalid = () => { throw new Error('The changes response could not be verified. Refresh to try again.'); };
  if (!object(value)) return invalid();
  if (!['known', 'unknown', 'unavailable'].includes(value.state as string) || typeof value.checkedAt !== 'string' || value.checkedAt.length > 64 || !Number.isFinite(Date.parse(value.checkedAt)) || !nullableString(value.reason, 4096) || !(value.headSha === null || (typeof value.headSha === 'string' && /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(value.headSha))) || typeof value.listTruncated !== 'boolean' || !Array.isArray(value.files) || value.files.length > maxFiles) return invalid();
  const paths = new Set<string>();
  for (const file of value.files) {
    if (!object(file) || !path(file.path) || !(file.oldPath === null || path(file.oldPath)) || !['tracked', 'untracked'].includes(file.kind as string) || typeof file.status !== 'string' || !(file.kind === 'untracked' ? file.status === '??' : /^[ MADRCUT]{2}$/.test(file.status) && file.status !== '  ') || paths.has(file.path)) return invalid();
    paths.add(file.path);
  }
  if (value.state !== 'known' && (value.files.length || value.selected !== null || value.listTruncated)) return invalid();
  if (value.selected !== null) {
    const selected = value.selected;
    if (!object(selected) || !path(selected.path) || selected.path !== requestedPath || value.state !== 'known' || !['text', 'binary', 'too_large', 'symlink', 'unavailable'].includes(selected.state as string) || !nullableString(selected.reason, 4096) || typeof selected.truncated !== 'boolean') return invalid();
    if (selected.state === 'text') {
      if (typeof selected.text !== 'string' || selected.text.length > maxTextBytes || bytes(selected.text) > maxTextBytes || !paths.has(selected.path)) return invalid();
    } else if (selected.text !== null || selected.truncated) return invalid();
    if (!paths.has(selected.path) && selected.state !== 'unavailable') return invalid();
  }
  if (!requestedPath && value.selected !== null) return invalid();
  if (requestedPath && value.state === 'known' && value.selected === null && (paths.has(requestedPath) || value.listTruncated)) return invalid();
  return value as unknown as WorkspaceChanges;
}

export function changesRequestUrl(sessionId: string, selectedPath: string | null): string {
  const query = new URLSearchParams();
  if (selectedPath !== null) query.set('path', selectedPath);
  return `/sessions/${encodeURIComponent(sessionId)}/changes${query.size ? `?${query}` : ''}`;
}
export async function requestChanges(sessionId: string, selectedPath: string | null, signal: AbortSignal): Promise<WorkspaceChanges> {
  return validateChanges(await api<unknown>(changesRequestUrl(sessionId, selectedPath), undefined, { signal }), selectedPath);
}

export function changesUnavailableReason(session: Pick<Session, 'state' | 'expiresAt'>, preview: boolean, now: number): string | null {
  if (preview) return 'Preview simulation: no repository inspection occurs here. Open a running live machine to review its files.';
  if (session.state === 'provisioning') return 'The workspace is still being prepared. Inspect changes after the machine is running.';
  if (session.state !== 'running') return 'This machine is no longer available for repository inspection. Its uncommitted files cannot be reviewed here.';
  if (!(Date.parse(session.expiresAt) > now)) return 'This machine’s lifetime has expired. Repository inspection is unavailable.';
  return null;
}

const statusNames: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'unmerged', T: 'type changed' };
export function changeStatusLabel(status: string): string {
  if (status === '??') return 'Untracked';
  if (status.includes('U') || status === 'AA' || status === 'DD') return 'Merge conflict';
  return [status[0] !== ' ' ? `Staged: ${statusNames[status[0]] || 'changed'}` : '', status[1] !== ' ' ? `Unstaged: ${statusNames[status[1]] || 'changed'}` : ''].filter(Boolean).join(' · ');
}

export interface ChangesViewState {
  snapshot: WorkspaceChanges | null;
  latest: WorkspaceChanges | null;
  selectedPath: string | null;
  loading: boolean;
  stale: boolean;
  error: string;
  selectionNotice: string;
}
export const emptyChangesView: ChangesViewState = { snapshot: null, latest: null, selectedPath: null, loading: false, stale: false, error: '', selectionNotice: '' };
export type ChangesAction = { type: 'start'; path: string | null } | { type: 'result'; path: string | null; value: WorkspaceChanges } | { type: 'failure'; message: string } | { type: 'invalidate'; message: string };
export function reduceChanges(state: ChangesViewState, action: ChangesAction): ChangesViewState {
  const hidden = state.snapshot ? { ...state.snapshot, selected: null } : null;
  if (action.type === 'start') return { ...state, snapshot: hidden, latest: null, selectedPath: action.path, loading: true, stale: Boolean(hidden), error: '', selectionNotice: '' };
  if (action.type === 'failure' || action.type === 'invalidate') return { ...state, snapshot: hidden, latest: null, loading: false, stale: Boolean(hidden), error: action.message };
  if (action.path !== state.selectedPath) return state;
  if (action.value.state !== 'known') return { ...state, snapshot: hidden, latest: action.value, loading: false, stale: Boolean(hidden), error: action.value.reason || 'Repository inspection is unavailable. Refresh to try again.' };
  const removed = action.path !== null && !action.value.listTruncated && !action.value.files.some(file => file.path === action.path);
  return { snapshot: removed ? { ...action.value, selected: null } : action.value, latest: action.value, selectedPath: removed ? null : action.path, loading: false, stale: false, error: '', selectionNotice: removed ? 'The selected file is no longer in the changed-file list. Choose another file.' : '' };
}

/** Coalesces refreshes; changing files aborts and invalidates the earlier request. */
export class ChangesLoader {
  private disposed = false;
  private revision = 0;
  private active: { path: string | null; controller: AbortController; timer: ReturnType<typeof setTimeout>; pending: Promise<void>; cancel: () => void } | null = null;
  constructor(private request: (path: string | null, signal: AbortSignal) => Promise<WorkspaceChanges>, private publish: (action: ChangesAction) => void, private accepts: () => boolean = () => true) {}
  refresh(path: string | null): Promise<void> {
    if (this.disposed || !this.accepts()) return Promise.resolve();
    if (this.active?.path === path) return this.active.pending;
    this.cancel();
    const revision = ++this.revision, controller = new AbortController();
    const current = () => !this.disposed && revision === this.revision && this.accepts();
    this.publish({ type: 'start', path });
    let timer!: ReturnType<typeof setTimeout>;
    let cancel = () => {};
    const timeout = new Promise<never>((_, reject) => { cancel = () => reject(new Error('Repository inspection cancelled.')); timer = setTimeout(() => { controller.abort(); reject(new Error('Repository inspection timed out. Refresh to try again.')); }, 60_000); });
    const request = Promise.resolve().then(() => { if (!current()) throw new Error('Repository inspection cancelled.'); return this.request(path, controller.signal); });
    const pending = Promise.race([request, timeout]).then(value => { if (current()) this.publish({ type: 'result', path, value }); }).catch(error => { if (current()) this.publish({ type: 'failure', message: error instanceof Error ? error.message : 'Repository inspection failed. Refresh to try again.' }); }).finally(() => { clearTimeout(timer); if (revision === this.revision) this.active = null; });
    this.active = { path, controller, timer, pending, cancel };
    return pending;
  }
  private cancel() { this.revision++; if (this.active) { this.active.controller.abort(); clearTimeout(this.active.timer); this.active.cancel(); } this.active = null; }
  dispose() { this.disposed = true; this.cancel(); }
}
