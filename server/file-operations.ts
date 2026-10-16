/** No queued file work: keep both active calls and rate bookkeeping bounded. */
export function createFileOperationGate(now = () => Date.now()) {
  const active = new Set<string>();
  const rates = new Map<string, { tokens: number; at: number }>();
  let closed = false;
  return {
    acquire(userId: string, sessionId: string): (() => void) | null {
      if (closed || active.size >= 4 || active.has(sessionId)) return null;
      const time = now();
      for (const [id, rate] of rates) if (time - rate.at >= 60_000) rates.delete(id);
      const previous = rates.get(userId);
      if (!previous && rates.size >= 256) return null;
      const tokens = previous ? Math.min(32, previous.tokens + Math.max(0, time - previous.at) / 500) : 32;
      rates.set(userId, { tokens: Math.max(0, tokens - 1), at: time });
      if (tokens < 1) return null;
      active.add(sessionId);
      return () => { active.delete(sessionId); };
    },
    close() { closed = true; },
  };
}
