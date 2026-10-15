export interface AdmissionPolicy {
  windowMs: number;
  perClientLimit: number;
  globalLimit: number;
  maxClients: number;
  maxConcurrent: number;
  maxConcurrentPerClient: number;
}

// Single control-plane pilot limits. Callbacks have a separate budget so a
// browser can complete an issued login even after exhausting the start budget.
export const oauthStartPolicy: Readonly<AdmissionPolicy> = Object.freeze({
  windowMs: 10 * 60_000, perClientLimit: 10, globalLimit: 100,
  maxClients: 256, maxConcurrent: 4, maxConcurrentPerClient: 2,
});
export const oauthCallbackPolicy: Readonly<AdmissionPolicy> = Object.freeze({
  windowMs: 60_000, perClientLimit: 30, globalLimit: 120,
  maxClients: 256, maxConcurrent: 8, maxConcurrentPerClient: 2,
});

interface Client { expiresAt: number; count: number; active: number }
type Admission = { release(): void } | { retryAfter: number };

/** Reject immediately: neither the client registry nor pending work can grow without a bound. */
export function createAdmission(policy: Readonly<AdmissionPolicy>, now = () => performance.now()) {
  for (const value of Object.values(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid OAuth admission policy');
  }
  const clients = new Map<string, Client>();
  let globalExpiresAt = 0, globalCount = 0, active = 0;
  return {
    acquire(clientId: string): Admission {
      const time = now();
      // At most maxClients entries are visited. Active entries remain until the
      // underlying operation settles, even when its HTTP connection closes.
      for (const [id, client] of clients) if (client.expiresAt <= time && !client.active) clients.delete(id);
      if (globalExpiresAt <= time) { globalExpiresAt = time + policy.windowMs; globalCount = 0; }
      let client = clients.get(clientId);
      if (client && client.expiresAt <= time) { client.expiresAt = time + policy.windowMs; client.count = 0; }
      const waits: number[] = [];
      if (globalCount >= policy.globalLimit) waits.push(globalExpiresAt - time);
      if (client && client.count >= policy.perClientLimit) waits.push(client.expiresAt - time);
      if (active >= policy.maxConcurrent || (client && client.active >= policy.maxConcurrentPerClient)) waits.push(1000);
      if (!client && clients.size >= policy.maxClients) {
        let earliest = Infinity;
        for (const value of clients.values()) earliest = Math.min(earliest, value.expiresAt);
        waits.push(Math.max(1000, earliest - time));
      }
      if (waits.length) return { retryAfter: Math.max(1, Math.ceil(Math.max(...waits) / 1000)) };
      if (!client) { client = { expiresAt: time + policy.windowMs, count: 0, active: 0 }; clients.set(clientId, client); }
      client.count++; client.active++; globalCount++; active++;
      let released = false;
      return { release() { if (!released) { released = true; client.active--; active--; } } };
    },
  };
}

export interface AuthAdmissionOptions {
  now?: () => number;
  startPolicy?: Readonly<AdmissionPolicy>;
  callbackPolicy?: Readonly<AdmissionPolicy>;
}
