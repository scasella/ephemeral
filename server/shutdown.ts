import type { Server } from 'node:http';
import type { Socket } from 'node:net';

export const SHUTDOWN_TIMEOUT_MS = 25_000;
export const PROCESS_EXIT_TIMEOUT_MS = 30_000;
export class ShutdownTimeoutError extends Error {
  constructor() { super('Server shutdown did not complete before its deadline.'); }
}
/** A deadline observes late rejection without abandoning its cleanup handlers. */
export async function beforeDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ShutdownTimeoutError()), Math.max(1, timeoutMs));
    })]);
  } finally { clearTimeout(timer); }
}
/** Track raw TCP connections too: HTTP closeAllConnections excludes upgraded sockets. */
export function trackListener(server: Server) {
  const sockets = new Set<Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  let closePromise: Promise<void> | undefined;
  return {
    close() {
      return closePromise ??= new Promise<void>((resolve, reject) => {
        server.close(error => { if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve(); });
        server.closeIdleConnections();
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
      });
    },
  };
}

/** Tracks actual async completion, including work that survives a TCP disconnect. */
export class WorkTracker {
  private readonly tasks = new Set<Promise<unknown>>();
  track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
    return task;
  }
  async drain(): Promise<void> {
    // Completion callbacks can enqueue a final disconnect or persistence task.
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
  }
}
