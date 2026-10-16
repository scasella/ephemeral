import type { Session } from './api';
import type { SessionResourceSnapshot } from '../shared/resource-visibility';
import { parseSessionResourceSnapshot, resourceTimestampMs } from '../shared/resource-visibility';

export type ResourceReadState = { snapshot: SessionResourceSnapshot | null; busy: boolean; error: string };
export const emptyResourceRead = (): ResourceReadState => ({ snapshot: null, busy: false, error: '' });

/** A mounted account/session scope owns one loader. Dispose fences even non-cooperative requests. */
export class ResourceVisibilityClient {
  private disposed = false;
  private pending: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private cancel: (() => void) | null = null;
  constructor(private request: (signal: AbortSignal) => Promise<unknown>, private publish: (state: ResourceReadState) => void, private previewMode: boolean) {}
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pending) return this.pending;
    const controller = this.controller = new AbortController();
    this.publish({ snapshot: null, busy: true, error: '' });
    let timer: ReturnType<typeof setTimeout>;
    const cancellation = new Promise<never>((_, reject) => {
      this.cancel = () => reject(new Error('Resource check cancelled.'));
      timer = setTimeout(() => { controller.abort(); reject(new Error('Resource check timed out. Refresh resources to try again.')); }, 15_000);
    });
    const request = Promise.resolve().then(() => this.request(controller.signal));
    this.pending = Promise.race([request, cancellation]).then(raw => {
      if (this.disposed) return;
      const browserNow = Date.now();
      const checkedAt = resourceTimestampMs(raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).checkedAt : null);
      // Bound browser/server clock skew without widening the age limit for old observations.
      const validationNow = checkedAt !== null && checkedAt <= browserNow + 5000 ? Math.max(browserNow, checkedAt) : browserNow;
      const snapshot = parseSessionResourceSnapshot(raw, validationNow);
      if (!snapshot || (snapshot.state === 'simulation' && !this.previewMode) || (snapshot.state === 'known' && this.previewMode)) throw new Error('The resource response could not be verified. Refresh resources to try again.');
      this.publish({ snapshot, busy: false, error: '' });
    }).catch(failure => {
      if (!this.disposed) this.publish({ snapshot: null, busy: false, error: failure instanceof Error ? failure.message : 'Resources are unavailable. Refresh resources to try again.' });
    }).finally(() => { clearTimeout(timer); this.controller = null; this.cancel = null; this.pending = null; });
    return this.pending;
  }
  dispose() { this.disposed = true; this.controller?.abort(); this.cancel?.(); }
}

export const resourceObservationStale = (checkedAt: string, now: number) => !Number.isFinite(Date.parse(checkedAt)) || now - Date.parse(checkedAt) > 60_000 || Date.parse(checkedAt) > now + 5000;
export function resourceReadAllowed(session: Pick<Session, 'state' | 'expiresAt' | 'maxExpiresAt' | 'endedAt'>, active: boolean, now: number) {
  const expiry = resourceTimestampMs(session.expiresAt), maxExpiry = resourceTimestampMs(session.maxExpiresAt);
  return active && session.state === 'running' && session.endedAt === null && expiry !== null && maxExpiry !== null && Math.min(expiry, maxExpiry) > now;
}
export function resourceReadScope(accountKey: string, session: Session, previewMode: boolean) {
  return JSON.stringify([accountKey, session.userId, session.id, session.repository, session.repositoryId, session.installationId, session.branch, session.baseBranch, session.createdAt, session.sandboxId, session.expiresAt, session.maxExpiresAt, session.endedAt, previewMode]);
}
