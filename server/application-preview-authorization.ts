import type { Session } from './contracts.js';

/** Repository verification is shared for a few seconds; browser/session fences are never cached. */
export function createPreviewAuthorizationCache(authorize: (session: Session) => Promise<void>, ttlMs = 10_000, now = Date.now) {
  const entries = new Map<string, { sessionId: string; expiresAt: number; pending: boolean; promise: Promise<void> }>();
  return {
    async authorize(session: Session, browserHash: string) {
      if (ttlMs <= 0) return authorize(session);
      const key = JSON.stringify([browserHash, session.userId, session.id, session.repository, session.repositoryId, session.installationId, session.sandboxId]);
      const existing = entries.get(key);
      if (existing && (existing.pending || existing.expiresAt > now())) return existing.promise;
      for (const [oldKey, entry] of entries) if (!entry.pending && entry.expiresAt <= now()) entries.delete(oldKey);
      if (entries.size >= 256) entries.delete(entries.keys().next().value!);
      const entry = { sessionId: session.id, expiresAt: 0, pending: true, promise: Promise.resolve() };
      entry.promise = Promise.resolve().then(() => authorize(session)).then(() => { entry.pending = false; entry.expiresAt = now() + Math.min(ttlMs, 10_000); }, error => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
      entries.set(key, entry); return entry.promise;
    },
    revoke(sessionId: string) { for (const [key, entry] of entries) if (entry.sessionId === sessionId) entries.delete(key); },
  };
}
