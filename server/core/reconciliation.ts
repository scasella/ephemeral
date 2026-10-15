import type { RetryState } from '../contracts.js';

/** Server-only retry metadata; never contains provider error text. */
export type ReconciliationRetry = RetryState;
const INITIAL_DELAY_MS = 5_000;
const MAX_DELAY_MS = 300_000;
const MAX_ATTEMPTS = 32;

export function nextRetry(previous: ReconciliationRetry | null, state: ReconciliationRetry['state'], now: number): ReconciliationRetry {
  const attempts = Math.min((previous?.state === state ? previous.attempts : 0) + 1, MAX_ATTEMPTS);
  const delay = Math.min(INITIAL_DELAY_MS * 2 ** (attempts - 1), MAX_DELAY_MS);
  return { state, attempts, nextAt: new Date(now + delay).toISOString() };
}

export function retryDue(retry: ReconciliationRetry | null, state: ReconciliationRetry['state'], now: number): boolean {
  return retry?.state !== state || Date.parse(retry.nextAt) <= now;
}
