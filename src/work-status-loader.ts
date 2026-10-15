import type { WorkStatus } from './workflow';

function unknown(reason: string): WorkStatus {
  return { state: 'unknown', checkedAt: new Date().toISOString(), dirtyFiles: null, untrackedFiles: null, aheadCommits: null, headSha: null, remoteSha: null, remoteCheckedAt: null, branch: null, branchMatches: null, remoteExists: null, reason };
}

/** One request per mounted status view. Disposed views cannot publish results. */
export class WorkStatusLoader {
  private disposed = false;
  private pending: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private request: (signal: AbortSignal) => Promise<WorkStatus>,
    private onStatus: (status: WorkStatus) => void,
    private onLoading: (loading: boolean) => void,
  ) {}
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pending) return this.pending;
    const controller = this.controller = new AbortController();
    this.onLoading(true);
    const timeout = new Promise<WorkStatus>(resolve => {
      this.timer = setTimeout(() => {
        controller.abort();
        resolve(unknown('Work status check timed out. Refresh to try again, or acknowledge the unknown status to stop.'));
      }, 45_000);
    });
    const request = Promise.resolve().then(() => this.request(controller.signal)).catch(e => unknown((e as Error).message || 'Work status could not be checked. Refresh to try again.'));
    this.pending = Promise.race([request, timeout]).then(status => { if (!this.disposed) this.onStatus(status); }).finally(() => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null; this.controller = null; this.pending = null;
      if (!this.disposed) this.onLoading(false);
    });
    return this.pending;
  }
  dispose() {
    this.disposed = true;
    this.controller?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
