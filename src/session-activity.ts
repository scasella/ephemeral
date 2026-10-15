import type { SessionEvent, SessionEventPage } from './api';

export const ACTIVITY_PAGE_SIZE = 50;
export interface ActivityState {
  events: SessionEvent[];
  loaded: boolean;
  before: string | null;
  nextCursor: string | null;
  pending: 'newest' | 'older' | 'poll' | null;
  error: string;
  failedBefore: string | null | undefined;
}
export const emptyActivity: ActivityState = { events: [], loaded: false, before: null, nextCursor: null, pending: null, error: '', failedBefore: undefined };
export function activityRequestUrl(sessionId: string, before: string | null): string {
  const query = new URLSearchParams({ limit: String(ACTIVITY_PAGE_SIZE) });
  if (before !== null) query.set('before', before);
  return `/sessions/${encodeURIComponent(sessionId)}/events?${query}`;
}

/** Retain one chronological page, with cancellation plus a fence for transports that ignore abort. */
export class SessionActivityLoader {
  private state: ActivityState = emptyActivity;
  private disposed = false;
  private revision = 0;
  private active: { controller: AbortController; cancel: () => void; timer: ReturnType<typeof setTimeout> } | null = null;
  constructor(
    private request: (before: string | null, signal: AbortSignal) => Promise<SessionEventPage>,
    private publish: (state: ActivityState) => void,
    private accepts: () => boolean = () => true,
  ) {}
  newest(): Promise<void> { return this.read(null, 'newest'); }
  older(): Promise<void> {
    if (this.state.pending || !this.state.nextCursor) return Promise.resolve();
    return this.read(this.state.nextCursor, 'older');
  }
  poll(): Promise<void> {
    if (this.state.before !== null || this.state.pending || this.state.error) return Promise.resolve();
    return this.read(null, 'poll');
  }
  retry(): Promise<void> {
    if (this.state.pending || this.state.failedBefore === undefined) return Promise.resolve();
    return this.read(this.state.failedBefore, this.state.failedBefore === null ? 'newest' : 'older');
  }
  private update(state: ActivityState) { this.state = state; this.publish(state); }
  private async read(before: string | null, pending: NonNullable<ActivityState['pending']>): Promise<void> {
    if (this.disposed || !this.accepts()) return;
    this.cancel();
    const revision = ++this.revision, controller = new AbortController();
    const current = () => !this.disposed && revision === this.revision && this.accepts();
    this.update({ ...this.state, pending });
    let timer!: ReturnType<typeof setTimeout>, cancel = () => {};
    const deadline = new Promise<never>((_, reject) => {
      cancel = () => reject(new Error('Activity request cancelled.'));
      timer = setTimeout(() => { controller.abort(); reject(new Error('Activity request timed out. Retry to load this page.')); }, 20_000);
    });
    this.active = { controller, cancel, timer };
    try {
      const page = await Promise.race([Promise.resolve().then(() => {
        if (!current()) throw new Error('Activity request cancelled.');
        return this.request(before, controller.signal);
      }), deadline]);
      if (!current()) return;
      if (!page || !Array.isArray(page.events) || page.events.length > ACTIVITY_PAGE_SIZE || !(page.nextCursor === null || typeof page.nextCursor === 'string')) throw new Error('Activity page could not be read. Retry to load this page.');
      this.update({ events: page.events, loaded: true, before, nextCursor: page.nextCursor, pending: null, error: '', failedBefore: undefined });
    } catch (error) {
      if (current()) this.update({ ...this.state, pending: null, error: error instanceof Error ? error.message : 'Activity page unavailable. Retry to load this page.', failedBefore: before });
    } finally {
      clearTimeout(timer);
      if (revision === this.revision) this.active = null;
    }
  }
  private cancel() {
    ++this.revision;
    if (this.active) { this.active.controller.abort(); clearTimeout(this.active.timer); this.active.cancel(); }
    this.active = null;
  }
  dispose() { this.disposed = true; this.cancel(); }
}
