import { generationViewerOrigin, previewBaseOrigin, PREVIEW_GENERATION } from '../shared/preview-origin';
import { api, type Session } from './api';
import { sessionDeadline } from './workspace-navigation';
import { requestApplicationPreviewCheck, validateApplicationPreviewCheck, validPreviewPort, type ApplicationPreviewCheck } from './preview-readiness';
export { validPreviewPort } from './preview-readiness';

export interface PreviewMetadata {
  mode: 'live' | 'preview';
  state: 'enabled' | 'disabled' | 'unavailable';
  port: number | null;
  generation: string | null;
  updatedAt: string | null;
  reason: string | null;
  viewerOrigin: string | null;
}
export interface PreviewHandoff { action: string; token: string; expiresAt: string; port: number; generation: string }
const verificationError = 'The private preview response could not be verified. Refresh access to try again.';
const requestError = 'The private preview request failed. Refresh access to check its saved state.';
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const timestamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
const generation = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function parsePreviewPort(value: string): number | null {
  if (!/^\d{4,5}$/.test(value)) return null;
  const port = Number(value);
  return validPreviewPort(port) ? port : null;
}
/** Only authenticated metadata with an exact generation hostname can receive a handoff. */
export function validateViewerOrigin(value: unknown, workspaceOrigin: string, expectedGeneration?: string | null): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error(verificationError);
  try {
    const viewer = new URL(value), workspace = new URL(workspaceOrigin);
    if (viewer.origin !== value || viewer.username || viewer.password || viewer.hostname === workspace.hostname) throw new Error();
    const firstLabel = viewer.hostname.split('.')[0];
    if (expectedGeneration !== undefined && expectedGeneration !== null && firstLabel !== expectedGeneration) throw new Error();
    if (PREVIEW_GENERATION.test(firstLabel)) {
      const base = new URL(viewer.origin); base.hostname = viewer.hostname.slice(firstLabel.length + 1);
      previewBaseOrigin(base.origin);
      if (workspace.hostname === base.hostname || workspace.hostname.endsWith(`.${base.hostname}`) || generationViewerOrigin(base.origin, firstLabel) !== value) throw new Error();
    } else {
      if (expectedGeneration) throw new Error();
      const base = previewBaseOrigin(value);
      if (workspace.hostname === base.hostname || workspace.hostname.endsWith(`.${base.hostname}`)) throw new Error();
    }
    return viewer.origin;
  } catch { throw new Error(verificationError); }
}
export function validatePreviewMetadata(value: unknown, workspaceOrigin: string): PreviewMetadata {
  if (!object(value) || !['live', 'preview'].includes(value.mode as string) || !['enabled', 'disabled', 'unavailable'].includes(value.state as string) || !(value.port === null || validPreviewPort(value.port)) || !(value.generation === null || generation(value.generation)) || !(value.updatedAt === null || timestamp(value.updatedAt)) || !(value.reason === null || (typeof value.reason === 'string' && value.reason.length <= 1000)) || !(value.viewerOrigin === null || typeof value.viewerOrigin === 'string')) throw new Error(verificationError);
  if (value.viewerOrigin !== null) validateViewerOrigin(value.viewerOrigin, workspaceOrigin, value.generation as string | null);
  if (value.state === 'enabled' && (value.mode !== 'live' || value.port === null || value.generation === null || value.viewerOrigin === null || value.updatedAt === null)) throw new Error(verificationError);
  if ((value.port === null) !== (value.generation === null) || (value.port !== null && value.updatedAt === null)) throw new Error(verificationError);
  if (value.mode === 'preview' && value.state !== 'unavailable') throw new Error(verificationError);
  // Return only declared fields. Untrusted extras never reach the component.
  return { mode: value.mode as PreviewMetadata['mode'], state: value.state as PreviewMetadata['state'], port: value.port as number | null, generation: value.generation as string | null, updatedAt: value.updatedAt as string | null, reason: value.reason as string | null, viewerOrigin: value.viewerOrigin as string | null };
}
export function validatePreviewHandoff(value: unknown, metadata: PreviewMetadata, workspaceOrigin: string, now: number): PreviewHandoff {
  if (!object(value) || metadata.state !== 'enabled' || !metadata.viewerOrigin || value.action !== `${validateViewerOrigin(metadata.viewerOrigin, workspaceOrigin, metadata.generation)}/__ephemeral/open` || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || !timestamp(value.expiresAt) || !(Date.parse(value.expiresAt) > now && Date.parse(value.expiresAt) <= now + 60_000) || value.port !== metadata.port || value.generation !== metadata.generation) throw new Error(verificationError);
  return { action: value.action as string, token: value.token, expiresAt: value.expiresAt, port: value.port as number, generation: value.generation as string };
}
export function previewUnavailableReason(session: Pick<Session, 'state' | 'expiresAt' | 'maxExpiresAt'>, preview: boolean, now: number): string | null {
  if (preview) return 'Preview simulation: private application access is unavailable. Use a running live machine.';
  if (session.state === 'provisioning') return 'The machine is still being prepared. Private application access becomes available when it is running.';
  if (session.state !== 'running') return 'This machine has stopped. Private application access is unavailable.';
  const deadline = sessionDeadline(session);
  if (deadline === null) return 'This machine’s deadline could not be confirmed. Private application access is unavailable until its lifetime is confirmed.';
  if (deadline <= now) return 'This machine’s lifetime has expired. Private application access is unavailable.';
  return null;
}

export interface PreviewViewState { snapshot: PreviewMetadata | null; handoff: PreviewHandoff | null; loading: boolean; sending: 'enable' | 'close' | 'open' | null; confirmed: boolean; error: string; notice: string; readiness: ApplicationPreviewCheck | null; checking: boolean }
export const emptyPreviewView: PreviewViewState = { snapshot: null, handoff: null, loading: false, sending: null, confirmed: false, error: '', notice: '', readiness: null, checking: false };
type Transport = (path: string, body: unknown | undefined, signal: AbortSignal) => Promise<unknown>;
const transport: Transport = (path, body, signal) => path.endsWith('/preview/check') ? requestApplicationPreviewCheck(path, signal) : api<unknown>(path, body, { signal });

/** Credentials stay in component memory and are discarded on every scope change. */
export class ApplicationPreviewClient {
  state: PreviewViewState = { ...emptyPreviewView };
  private disposed = false;
  private revision = 0;
  private active: { controller: AbortController; cancel: () => void; pending: Promise<void> } | null = null;
  private handoffTimer: ReturnType<typeof setTimeout> | null = null;
  private checkRevision = 0;
  private checkActive: { controller: AbortController; cancel: () => void; pending: Promise<void> } | null = null;
  constructor(private sessionId: string, private workspaceOrigin: string, private publish: (state: PreviewViewState) => void, private accepts: () => boolean = () => true, private request: Transport = transport, private timeoutMs = 20_000, private now: () => number = Date.now) {}
  private update(change: Partial<PreviewViewState>, notify = true) { this.state = { ...this.state, ...change }; if (notify && !this.disposed && this.accepts()) this.publish(this.state); }
  private clearHandoff(notify = true) { if (this.handoffTimer) clearTimeout(this.handoffTimer); this.handoffTimer = null; this.update({ handoff: null }, notify); }
  clearPrepared() {
    this.clearReadiness();
    if (this.state.sending === 'open') { this.cancel(); this.update({ sending: null }); }
    this.clearHandoff();
  }
  clearReadiness(notify = true) {
    this.checkRevision++;
    if (this.checkActive) { this.checkActive.controller.abort(); this.checkActive.cancel(); }
    this.checkActive = null;
    this.update({ readiness: null, checking: false }, notify);
  }
  /** Only a user gesture checks the saved application root; it never changes access. */
  check(): Promise<void> {
    const snapshot = this.state.snapshot;
    if (this.disposed || !this.accepts() || !this.state.confirmed || this.state.loading || this.state.sending || snapshot?.state !== 'enabled' || snapshot.port === null) return Promise.resolve();
    if (this.checkActive) return this.checkActive.pending;
    this.clearReadiness(false);
    const revision = this.checkRevision, controller = new AbortController(), startedAt = this.now(), port = snapshot.port;
    const current = () => !this.disposed && this.accepts() && revision === this.checkRevision && this.state.confirmed && this.state.snapshot?.port === port && this.state.snapshot?.generation === snapshot.generation;
    this.update({ checking: true });
    let cancel = () => {};
    const run = async () => {
      if (!current()) return;
      try {
        const raw = await this.bounded(`/sessions/${encodeURIComponent(this.sessionId)}/preview/check`, {}, controller, fn => { cancel = fn; });
        if (current()) this.update({ readiness: validateApplicationPreviewCheck(raw, port, startedAt, this.now()) });
      } catch {
        if (current()) this.update({ readiness: { state: 'unknown', checkedAt: new Date(this.now()).toISOString(), port, httpStatus: null, reason: 'The application check could not be confirmed.', remedy: 'Refresh saved access, then check the application again.' } });
      } finally { if (current()) { this.checkActive = null; this.update({ checking: false }); } }
    };
    const pending = Promise.resolve().then(run);
    this.checkActive = { controller, cancel: () => cancel(), pending };
    return pending;
  }
  private async bounded(path: string, body: unknown | undefined, controller: AbortController, setCancel: (cancel: () => void) => void): Promise<unknown> {
    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { setCancel(() => reject(new Error(requestError))); timer = setTimeout(() => { controller.abort(); reject(new Error(requestError)); }, this.timeoutMs); });
    try { return await Promise.race([Promise.resolve().then(() => this.request(path, body, controller.signal)), timeout]); } finally { clearTimeout(timer); }
  }
  private cancel() { this.revision++; if (this.active) { this.active.controller.abort(); this.active.cancel(); } this.active = null; }
  refresh(): Promise<void> {
    if (this.disposed || !this.accepts() || this.state.sending) return Promise.resolve();
    if (this.active) return this.active.pending;
    return this.perform('refresh');
  }
  enable(port: number): Promise<void> { if (!validPreviewPort(port)) { this.update({ error: 'Enter a whole-number port from 1024 to 49151.' }); return Promise.resolve(); } return this.perform('enable', port); }
  close(): Promise<void> { return this.perform('close'); }
  prepare(): Promise<void> { if (!this.state.confirmed || this.state.snapshot?.state !== 'enabled') return Promise.resolve(); return this.perform('open'); }
  private perform(operation: 'refresh' | 'enable' | 'close' | 'open', port?: number): Promise<void> {
    if (this.disposed || !this.accepts() || this.state.sending) return Promise.resolve();
    if (operation !== 'refresh' && (!this.state.confirmed || !this.state.snapshot?.viewerOrigin || this.state.snapshot.mode !== 'live' || this.state.snapshot.state === 'unavailable')) return Promise.resolve();
    if (operation !== 'open') this.clearReadiness(false);
    else if (this.checkActive) this.clearReadiness(false);
    this.cancel(); this.clearHandoff(false);
    const revision = this.revision, controller = new AbortController(), snapshot = this.state.snapshot;
    const current = () => !this.disposed && revision === this.revision && this.accepts();
    this.update({ loading: operation === 'refresh', sending: operation === 'refresh' ? null : operation, confirmed: operation === 'open' && this.state.confirmed, error: '', notice: '' });
    const path = `/sessions/${encodeURIComponent(this.sessionId)}/preview`;
    let cancel = () => {};
    const run = async () => {
      try {
        const raw = await this.bounded(operation === 'close' ? `${path}/close` : operation === 'open' ? `${path}/open` : path, operation === 'refresh' ? undefined : operation === 'enable' ? { port } : {}, controller, fn => { cancel = fn; });
        if (!current()) return;
        if (operation === 'open') {
          const handoff = validatePreviewHandoff(raw, snapshot!, this.workspaceOrigin, this.now());
          this.update({ handoff, confirmed: true });
          this.handoffTimer = setTimeout(() => { if (current()) { this.clearHandoff(false); this.update({ notice: 'The prepared opening expired. Prepare a fresh private preview.' }); } }, Math.max(0, Date.parse(handoff.expiresAt) - this.now()));
        } else {
          const saved = validatePreviewMetadata(raw, this.workspaceOrigin);
          if ((operation === 'enable' && (saved.state !== 'enabled' || saved.port !== port || (snapshot?.generation !== null && saved.generation === snapshot?.generation))) || (operation === 'close' && saved.state !== 'disabled')) throw new Error(verificationError);
          this.update({ snapshot: saved, confirmed: true });
        }
      } catch {
        if (!current()) return;
        this.clearReadiness(false);
        this.clearHandoff(false);
        this.update({ confirmed: false, error: operation === 'refresh' ? 'Saved preview access could not be checked. Refresh access to try again.' : 'The request outcome is unknown. Checking saved preview access…' });
        if (operation !== 'refresh') {
          const recovery = new AbortController();
          // Do not retry a mutation: a lost reply may already have changed access.
          this.active!.controller = recovery;
          try {
            const raw = await this.bounded(path, undefined, recovery, fn => { cancel = fn; });
            if (!current()) return;
            const saved = validatePreviewMetadata(raw, this.workspaceOrigin);
            this.update({ snapshot: saved, confirmed: true, error: 'The request reply was not confirmed. Saved access has been refreshed; review its state before trying again.' });
          } catch { if (current()) this.update({ confirmed: false, error: 'The request outcome is unknown and saved access could not be checked. Refresh access before making another change.' }); }
        }
      } finally { if (current()) { this.active = null; this.update({ loading: false, sending: null }); } }
    };
    const pending = Promise.resolve().then(run);
    this.active = { controller, cancel: () => cancel(), pending };
    return pending;
  }
  /** Clear memory immediately; notify after the native form has collected its POST fields. */
  consumeHandoff(): boolean {
    if (this.disposed || !this.accepts() || !this.state.confirmed || !this.state.handoff || Date.parse(this.state.handoff.expiresAt) <= this.now()) return false;
    this.clearHandoff(false);
    this.state = { ...this.state, notice: 'Opening requested in a new tab. Prepare again to open or renew access.' };
    setTimeout(() => { if (!this.disposed && this.accepts()) this.publish(this.state); }, 0);
    return true;
  }
  dispose() { this.disposed = true; this.cancel(); this.clearReadiness(false); this.clearHandoff(false); this.state = { ...emptyPreviewView }; }
}
