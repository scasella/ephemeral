import { WorkTracker } from './shutdown.js';

export class ResourceObservationError extends Error {
  constructor(public readonly status: 429 | 503, message: string) { super(message); }
}

/** Bound admission and retain each slot until the underlying work really settles. */
export function createResourceObservationController(timeoutMs = 12_000) {
  const active = new Map<string, AbortController>();
  const rates = new Map<string, { tokens: number; at: number }>();
  const work = new WorkTracker();
  let closed = false;
  return {
    async observe<T>(userId: string, sessionId: string, operation: (signal: AbortSignal) => Promise<T>, clientSignal?: AbortSignal): Promise<T> {
      if (closed) throw new ResourceObservationError(503, 'Resource inspection is unavailable.');
      const now = Date.now();
      for (const [id, rate] of rates) if (now - rate.at >= 60_000) rates.delete(id);
      const previous = rates.get(userId);
      const tokens = previous ? Math.min(16, previous.tokens + Math.max(0, now - previous.at) / 1000) : 16;
      if (active.size >= 4 || active.has(sessionId) || (!previous && rates.size >= 256) || tokens < 1) {
        throw new ResourceObservationError(429, 'Too many resource inspections. Retry shortly.');
      }
      rates.set(userId, { tokens: tokens - 1, at: now });
      const controller = new AbortController();
      active.set(sessionId, controller);
      const abort = () => controller.abort();
      clientSignal?.addEventListener('abort', abort, { once: true });
      if (clientSignal?.aborted) abort();
      const timer = setTimeout(abort, timeoutMs);
      let rejectCancellation!: () => void;
      const cancellation = new Promise<never>((_resolve, reject) => {
        rejectCancellation = () => reject(new ResourceObservationError(503, 'Resource inspection did not finish before its deadline.'));
        controller.signal.addEventListener('abort', rejectCancellation, { once: true });
        if (controller.signal.aborted) rejectCancellation();
      });
      const raw = work.track(Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }).finally(() => {
        active.delete(sessionId);
        clearTimeout(timer);
        clientSignal?.removeEventListener('abort', abort);
      }));
      try { return await Promise.race([raw, cancellation]); }
      finally { controller.signal.removeEventListener('abort', rejectCancellation); }
    },
    close() {
      closed = true;
      for (const controller of active.values()) controller.abort();
      return work.drain();
    },
  };
}
