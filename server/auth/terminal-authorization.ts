import type { Session } from '../contracts.js';

/** Only repository permission is cached. Callers must fence browser and lifecycle state every time. */
export function createTerminalAuthorization(authorize: (session: Session) => Promise<void>, ttlMs = 5000, now = () => Date.now()) {
  const entries = new Map<string, { sessionId: string; until: number; pending: boolean; promise: Promise<void> }>();
  let closed = false;
  const ttl = Number.isFinite(ttlMs) ? Math.max(0, Math.min(ttlMs, 5000)) : 5000;
  return {
    authorize(session: Session, browserHash: string) {
      if (closed) return Promise.reject(new Error('Repository access could not be verified.'));
      const key = JSON.stringify([browserHash, session.id, session.userId, session.repository, session.repositoryId, session.installationId, session.sandboxId, session.createdAt, session.branch, session.baseBranch]);
      const cached = entries.get(key);
      if (cached && (cached.pending || cached.until > now())) return cached.promise;
      for (const [key, entry] of entries) if (!entry.pending && entry.until <= now()) entries.delete(key);
      // Never evict pending work and accidentally create duplicate upstream checks.
      if (entries.size >= 256) return Promise.reject(new Error('Repository access could not be verified.'));
      const entry = { sessionId: session.id, until: 0, pending: true, promise: Promise.resolve() };
      entry.promise = Promise.resolve().then(() => {
        if (closed || entries.get(key) !== entry) throw new Error('Repository access could not be verified.');
        return authorize(session);
      }).then(() => {
        if (closed || entries.get(key) !== entry) throw new Error('Repository access could not be verified.');
        entry.pending = false; entry.until = now() + ttl;
      }, () => {
        if (entries.get(key) === entry) entries.delete(key);
        throw new Error('Repository access could not be verified.');
      });
      entries.set(key, entry);
      return entry.promise;
    },
    revoke(sessionId: string) { for (const [key, entry] of entries) if (entry.sessionId === sessionId) entries.delete(key); },
    close() { closed = true; entries.clear(); },
  };
}
