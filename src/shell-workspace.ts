import { SHELL_NAME_ERROR, shellNameValue } from '../shared/shell-name';
export { SHELL_NAME_ERROR, shellNameValue } from '../shared/shell-name';

export type WorkspaceShell = {
  id: string;
  requestId: string | null;
  name: string;
  kind: 'primary' | 'supplemental';
  state: 'creating' | 'open' | 'closing' | 'closed' | 'uncertain';
  createdAt: string;
  updatedAt: string;
  error: string | null;
};
export type ShellSnapshot = { mode: 'live' | 'preview'; shells: WorkspaceShell[]; canCreate: boolean; reason: string | null };
export type ShellOperation = { requestId: string; kind: 'create' | 'close' | 'rename'; shellId?: string; name?: string };
export type ShellWorkspaceState = { snapshot: ShellSnapshot | null; pending: ShellOperation | null; loading: boolean; sending: boolean; recoveringPrimary?: boolean; error: string };
export type ShellTransport = (path: string, body: unknown | undefined, signal: AbortSignal) => Promise<ShellSnapshot>;

class ShellRequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function parseShellSnapshot(value: unknown): ShellSnapshot {
  const invalid = () => { throw new Error('Unable to read the saved shell list. Refresh shells to try again.'); };
  if (!value || typeof value !== 'object') return invalid();
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.shells) || typeof data.mode !== 'string' || !['live', 'preview'].includes(data.mode) || typeof data.canCreate !== 'boolean' || !(data.reason === null || typeof data.reason === 'string')) return invalid();
  const ids = new Set<string>();
  const requests = new Set<string>();
  const shells = data.shells.map((item: unknown): WorkspaceShell => {
    if (!item || typeof item !== 'object') return invalid();
    const shell = item as Record<string, unknown>;
    if (typeof shell.id !== 'string' || typeof shell.state !== 'string' || !['creating', 'open', 'closing', 'closed', 'uncertain'].includes(shell.state) || typeof shell.name !== 'string' || shellNameValue(shell.name) !== shell.name || typeof shell.createdAt !== 'string' || typeof shell.updatedAt !== 'string' || !(shell.error === null || typeof shell.error === 'string')) return invalid();
    const id = shell.id.toLowerCase();
    if (ids.has(id)) return invalid();
    ids.add(id);
    let requestId: string | null = null;
    if (shell.kind === 'primary') {
      if (shell.id !== 'codex' || shell.name !== 'Codex' || shell.requestId !== null) return invalid();
    } else if (shell.kind === 'supplemental') {
      if (!UUID.test(id) || typeof shell.requestId !== 'string' || !UUID.test(shell.requestId)) return invalid();
      requestId = shell.requestId.toLowerCase();
      if (requests.has(requestId)) return invalid();
      requests.add(requestId);
    } else return invalid();
    return { ...(shell as unknown as WorkspaceShell), id, requestId };
  });
  if (!shells.some(shell => shell.id === 'codex' && shell.kind === 'primary') || shells.filter(shell => shell.kind === 'supplemental' && shell.state !== 'closed').length > 1) return invalid();
  return { mode: data.mode as ShellSnapshot['mode'], shells, canCreate: data.canCreate, reason: data.reason as string | null };
}

export async function shellRequest(path: string, body: unknown | undefined, signal: AbortSignal): Promise<ShellSnapshot> {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1' }, body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new ShellRequestError(typeof data?.error === 'string' ? data.error : `Shell request failed (${response.status}).`, response.status);
  return parseShellSnapshot(data);
}

export function operationCompleted(operation: ShellOperation, snapshot: ShellSnapshot) {
  const shell = operation.kind === 'create' ? snapshot.shells.find(item => item.requestId === operation.requestId) : snapshot.shells.find(item => item.id === operation.shellId);
  if (!shell) return false;
  return operation.kind === 'close' ? shell.state === 'closed' : operation.kind === 'rename' ? shell.name === operation.name || shell.state === 'closed' : ['open', 'closed'].includes(shell.state);
}
export function mountedShells(snapshot: ShellSnapshot | null) { return snapshot?.shells.filter(shell => shell.id !== 'codex' && shell.state !== 'closed') || []; }
export function reconcileShellSelection(selected: string, snapshot: ShellSnapshot) {
  return selected === 'codex' || mountedShells(snapshot).some(shell => shell.id === selected) ? selected : 'codex';
}
export function parsePendingShellOperation(value: string | null): ShellOperation | null {
  try {
    const operation = JSON.parse(value || 'null');
    if (!operation || typeof operation.requestId !== 'string' || !UUID.test(operation.requestId)) return null;
    const requestId = operation.requestId.toLowerCase();
    const validName = shellNameValue(operation.name);
    const shellId = typeof operation.shellId === 'string' && UUID.test(operation.shellId) ? operation.shellId.toLowerCase() : undefined;
    if (operation.kind === 'create' && validName) return { kind: 'create', requestId, name: operation.name.trim() };
    if (operation.kind === 'close' && shellId) return { kind: 'close', requestId, shellId };
    if (operation.kind === 'rename' && shellId && validName) return { kind: 'rename', requestId, shellId, name: operation.name.trim() };
  } catch { /* Invalid storage is discarded. */ }
  return null;
}

// A lost mutation reply never means a shell was created or closed. The saved
// metadata settles it; an explicit retry uses the same request and shell IDs.
export class ShellWorkspaceClient {
  state: ShellWorkspaceState;
  private active = true;
  private revision = 0;
  private requests = new Set<AbortController>();
  private refreshing?: Promise<void>;
  constructor(private sessionId: string, private notify: (state: ShellWorkspaceState) => void, private transport: ShellTransport = shellRequest, pending: ShellOperation | null = null, private persist: (operation: ShellOperation | null) => void = () => {}, private timeoutMs = 15_000) {
    this.state = { snapshot: null, pending, loading: false, sending: false, error: '' };
  }
  private update(changes: Partial<ShellWorkspaceState>) { if (this.active) { this.state = { ...this.state, ...changes }; this.notify(this.state); } }
  private async request(path: string, body?: unknown) {
    const controller = new AbortController();
    this.requests.add(controller);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // Race as well as abort: even a transport that ignores cancellation is bounded.
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('Shell request timed out or was cancelled. Refresh saved shells before retrying.')), { once: true });
      timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    });
    try { return await Promise.race([this.transport(path, body, controller.signal), cancelled]); }
    finally { clearTimeout(timeout); this.requests.delete(controller); }
  }
  private apply(snapshot: ShellSnapshot) {
    const completed = this.state.pending && operationCompleted(this.state.pending, snapshot);
    if (completed) this.persist(null);
    this.update({ snapshot, ...(completed ? { pending: null } : {}) });
  }
  refresh(): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.state.sending) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    const revision = ++this.revision;
    this.update({ loading: true });
    const promise = (async () => {
      try {
        const snapshot = await this.request(`/sessions/${encodeURIComponent(this.sessionId)}/shells`);
        if (!this.active || revision !== this.revision) return;
        this.apply(snapshot); this.update({ error: '' });
      } catch (failure) {
        if (this.active && revision === this.revision) this.update({ error: (failure as Error).message });
      } finally {
        if (this.active && revision === this.revision) this.update({ loading: false });
      }
    })();
    this.refreshing = promise;
    void promise.finally(() => { if (this.refreshing === promise) this.refreshing = undefined; });
    return promise;
  }
  async recoverPrimary(): Promise<boolean> {
    if (!this.active || this.state.sending || this.state.pending) return false;
    const revision = ++this.revision;
    this.update({ sending: true, recoveringPrimary: true, loading: false, error: '' });
    try {
      const snapshot = await this.request(`/sessions/${encodeURIComponent(this.sessionId)}/shells/codex/recover`, {});
      if (!this.active || revision !== this.revision) return false;
      this.apply(snapshot);
      if (snapshot.shells.find(shell => shell.id === 'codex')?.state !== 'open') {
        this.update({ error: 'The primary shell is not ready. Refresh saved shells before trying recovery again.' });
        return false;
      }
      return true;
    } catch (failure) {
      if (this.active && revision === this.revision) this.update({ error: `${(failure as Error).message} Reconnect to check whether the shell is available before trying recovery again.` });
      return false;
    } finally {
      if (this.active && revision === this.revision) this.update({ sending: false, recoveringPrimary: false });
    }
  }
  async perform(operation: ShellOperation) {
    const replacesCreate = operation.kind === 'close' && this.state.pending?.kind === 'create' && this.state.snapshot?.shells.some(shell => shell.id === operation.shellId && shell.requestId === this.state.pending?.requestId);
    if (!this.active || this.state.sending || (this.state.pending && this.state.pending.requestId !== operation.requestId && !replacesCreate)) return;
    if (operation.kind !== 'create' && (!operation.shellId || operation.shellId === 'codex')) return;
    if (operation.kind !== 'close') {
      const name = shellNameValue(operation.name);
      if (!name) { this.update({ error: SHELL_NAME_ERROR }); return; }
      operation = { ...operation, name };
    }
    const revision = ++this.revision;
    this.persist(operation); this.update({ pending: operation, sending: true, loading: false, error: '' });
    const base = `/sessions/${encodeURIComponent(this.sessionId)}/shells`;
    const path = operation.kind === 'create' ? base : `${base}/${encodeURIComponent(operation.shellId!)}/${operation.kind === 'rename' ? 'name' : 'close'}`;
    const body = operation.kind === 'create' ? { requestId: operation.requestId, name: operation.name } : operation.kind === 'rename' ? { name: operation.name } : { confirm: true };
    try {
      const snapshot = await this.request(path, body);
      if (!this.active || revision !== this.revision) return;
      this.apply(snapshot);
    } catch (failure) {
      if (!this.active || revision !== this.revision) return;
      // An error on a retry can follow a successful original request. Only saved
      // metadata can settle whether that operation took effect.
      this.update({ error: (failure as Error).message });
    } finally {
      if (this.active && revision === this.revision) this.update({ sending: false });
    }
    if (this.active && revision === this.revision && this.state.pending) {
      // Ignore any GET started before this mutation, then fetch a fresh snapshot.
      await this.refreshing;
      await this.refresh();
    }
  }
  dispose() { this.active = false; ++this.revision; for (const request of this.requests) request.abort(); this.requests.clear(); }
}
