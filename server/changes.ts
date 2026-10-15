/** Immediate admission bounds authorization calls and sandbox inspections together.
 * Requests never wait in a queue, and rate bookkeeping has a fixed maximum size.
 */
export function createChangeInspectionGate() {
  const active = new Set<string>();
  const rates = new Map<string, { tokens: number; at: number }>();
  const burst = 16;
  return {
    acquire(userId: string, sessionId: string): (() => void) | null {
      if (active.size >= 4 || active.has(sessionId)) return null;
      const now = Date.now();
      for (const [id, rate] of rates) if (now - rate.at >= 60_000) rates.delete(id);
      const previous = rates.get(userId);
      if (!previous && rates.size >= 256) return null;
      const tokens = previous ? Math.min(burst, previous.tokens + Math.max(0, now - previous.at) / 1000) : burst;
      rates.set(userId, { tokens: tokens >= 1 ? tokens - 1 : tokens, at: now });
      if (tokens < 1) return null;
      active.add(sessionId);
      return () => { active.delete(sessionId); };
    },
  };
}
