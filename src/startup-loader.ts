import type { StartupProgress } from '../server/startup';

export type StartupAction = 'load' | 'confirm';

/** Coalesces requests and prevents a departed session view from publishing results. */
export class StartupLoader {
  private disposed = false;
  private pending: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private request: (action: StartupAction, signal: AbortSignal) => Promise<StartupProgress>,
    private onProgress: (progress: StartupProgress) => void,
    private onBusy: (action: StartupAction | null) => void,
    private onError: (message: string, action: StartupAction) => void,
  ) {}
  run(action: StartupAction = 'load'): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pending) return this.pending;
    const controller = this.controller = new AbortController();
    this.onBusy(action);
    const timeout = new Promise<StartupProgress>((_, reject) => {
      this.timer = setTimeout(() => {
        reject(new Error(action === 'confirm' ? 'Confirmation timed out. Retry to check or save the same confirmation.' : 'Startup status timed out. Retry to check again.'));
        controller.abort();
      }, 15_000);
    });
    const request = Promise.resolve().then(() => this.request(action, controller.signal));
    this.pending = Promise.race([request, timeout]).then(progress => {
      if (!this.disposed) this.onProgress(progress);
    }).catch(error => {
      if (!this.disposed) this.onError(error instanceof Error ? error.message : 'Startup status is unavailable. Retry to check again.', action);
    }).finally(() => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null; this.controller = null; this.pending = null;
      if (!this.disposed) this.onBusy(null);
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
