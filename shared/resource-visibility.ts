/** Allocated compute, distinct from the guest's measured memory and disk totals. */
export interface ComputeAllocation { cpuCount: number; memoryMiB: number; diskMiB: number | null }
export interface ResourceMetrics {
  sampledAt: string; cpuUsedPercent: number; memoryUsedBytes: number; memoryTotalBytes: number;
  diskUsedBytes: number | null; diskTotalBytes: number | null;
}
export interface SessionResourceSnapshot {
  state: 'known' | 'unknown' | 'unavailable' | 'simulation'; checkedAt: string; reason: string | null;
  allocation: ComputeAllocation | null; startedAt: string | null; providerEndAt: string | null; metrics: ResourceMetrics | null;
}

/** Public list rates, not an invoice, account balance, or allowance calculation. */
export const E2B_RESOURCE_PRICING = Object.freeze({
  checkedAt: '2026-10-16', source: 'https://e2b.dev/pricing',
  cpuUsdPerVcpuSecond: 0.000014, memoryUsdPerGiBSecond: 0.0000045,
});
export const RESOURCE_PRICING_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const RESOURCE_METRICS_MAX_AGE_MS = 60_000;
const MAX_ESTIMATE_SECONDS = 24 * 60 * 60;

/** Reject Date.parse's permissive date-only, rollover-day, and non-ISO inputs. */
export function resourceTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  if (y < 2000 || y > 2199 || m < 1 || m > 12 || d < 1 ||
    d > new Date(Date.UTC(y, m, 0)).getUTCDate() || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
    (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
export function validComputeAllocation(value: unknown): value is ComputeAllocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { cpuCount, memoryMiB, diskMiB } = value as ComputeAllocation;
  return Number.isSafeInteger(cpuCount) && cpuCount >= 1 && cpuCount <= 1024 &&
    Number.isSafeInteger(memoryMiB) && memoryMiB >= 1 && memoryMiB <= 1_048_576 &&
    (diskMiB === null || (Number.isSafeInteger(diskMiB) && diskMiB >= 1 && diskMiB <= 16_777_216));
}
export function resourcePricingIsStale(nowMs = Date.now()): boolean {
  const checked = Date.parse(`${E2B_RESOURCE_PRICING.checkedAt}T00:00:00.000Z`);
  return !Number.isFinite(nowMs) || nowMs < checked || nowMs - checked > RESOURCE_PRICING_MAX_AGE_MS;
}
export interface ResourceCostEstimate {
  usdPerSecond: number; usdPerHour: number; elapsedSeconds: number; elapsedUsd: number;
  scheduledSeconds: number; scheduledUsd: number; scheduledStopAt: string; pricingStale: boolean;
}
/** Uses allocated vCPU/RAM and snapshot time; excludes plan fees, discounts and other services. */
export function estimateResourceCost(snapshot: SessionResourceSnapshot,
  session: { expiresAt: string; maxExpiresAt: string }, nowMs = Date.now()): ResourceCostEstimate | null {
  if (!['known', 'simulation'].includes(snapshot.state) || !validComputeAllocation(snapshot.allocation)) return null;
  const started = resourceTimestampMs(snapshot.startedAt), checked = resourceTimestampMs(snapshot.checkedAt);
  const providerEnd = resourceTimestampMs(snapshot.providerEndAt), expiry = resourceTimestampMs(session.expiresAt);
  const maxExpiry = resourceTimestampMs(session.maxExpiresAt);
  if (started === null || checked === null || providerEnd === null || expiry === null || maxExpiry === null ||
    !Number.isFinite(nowMs) || checked > nowMs) return null;
  const stop = Math.min(providerEnd, expiry, maxExpiry);
  const elapsedSeconds = (checked - started) / 1000, scheduledSeconds = (stop - started) / 1000;
  if (started > checked || stop <= checked || elapsedSeconds > MAX_ESTIMATE_SECONDS ||
    scheduledSeconds <= 0 || scheduledSeconds > MAX_ESTIMATE_SECONDS) return null;
  const usdPerSecond = snapshot.allocation.cpuCount * E2B_RESOURCE_PRICING.cpuUsdPerVcpuSecond +
    snapshot.allocation.memoryMiB / 1024 * E2B_RESOURCE_PRICING.memoryUsdPerGiBSecond;
  return { usdPerSecond, usdPerHour: usdPerSecond * 3600, elapsedSeconds, elapsedUsd: usdPerSecond * elapsedSeconds,
    scheduledSeconds, scheduledUsd: usdPerSecond * scheduledSeconds, scheduledStopAt: new Date(stop).toISOString(),
    pricingStale: resourcePricingIsStale(nowMs) };
}

export const RESOURCE_UNAVAILABLE = 'Resource information is unavailable. Refresh while the session is running.';
export function unavailableResourceSnapshot(reason = RESOURCE_UNAVAILABLE,
  state: 'unknown' | 'unavailable' = 'unavailable', nowMs = Date.now()): SessionResourceSnapshot {
  return { state, checkedAt: new Date(nowMs).toISOString(), reason, allocation: null, startedAt: null, providerEndAt: null, metrics: null };
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const bytes = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2 ** 50;

export function parseResourceMetrics(value: unknown, checkedMs: number, startedMs: number): ResourceMetrics | null {
  if (!object(value) || !Number.isFinite(checkedMs) || !Number.isFinite(startedMs) || startedMs > checkedMs) return null;
  const sampled = resourceTimestampMs(value.sampledAt);
  if (sampled === null || sampled > checkedMs || sampled < checkedMs - RESOURCE_METRICS_MAX_AGE_MS || sampled < startedMs ||
    typeof value.cpuUsedPercent !== 'number' || !Number.isFinite(value.cpuUsedPercent) || value.cpuUsedPercent < 0 || value.cpuUsedPercent > 100 ||
    !bytes(value.memoryUsedBytes) || !bytes(value.memoryTotalBytes) || value.memoryTotalBytes === 0 || value.memoryUsedBytes > value.memoryTotalBytes ||
    !((value.diskUsedBytes === null && value.diskTotalBytes === null) ||
      (bytes(value.diskUsedBytes) && bytes(value.diskTotalBytes) && value.diskTotalBytes > 0 && value.diskUsedBytes <= value.diskTotalBytes))) return null;
  return { sampledAt: new Date(sampled).toISOString(), cpuUsedPercent: value.cpuUsedPercent,
    memoryUsedBytes: value.memoryUsedBytes, memoryTotalBytes: value.memoryTotalBytes,
    diskUsedBytes: value.diskUsedBytes as number | null, diskTotalBytes: value.diskTotalBytes as number | null };
}
/** Rejects malformed provider results and strips all fields outside the public contract. */
export function parseSessionResourceSnapshot(value: unknown, nowMs = Date.now()): SessionResourceSnapshot {
  if (!object(value)) throw new Error(RESOURCE_UNAVAILABLE);
  const checked = resourceTimestampMs(value.checkedAt);
  if (!Number.isFinite(nowMs) || checked === null || checked > nowMs || checked < nowMs - 60_000 ||
    !['known', 'unknown', 'unavailable', 'simulation'].includes(value.state as string) ||
    !(value.reason === null || (typeof value.reason === 'string' && value.reason.length > 0 && value.reason.length <= 240 && !/[\p{Cc}]/u.test(value.reason)))) {
    throw new Error(RESOURCE_UNAVAILABLE);
  }
  const state = value.state as SessionResourceSnapshot['state'];
  if (state === 'unknown' || state === 'unavailable') {
    if (value.allocation !== null || value.startedAt !== null || value.providerEndAt !== null || value.metrics !== null) throw new Error(RESOURCE_UNAVAILABLE);
    // No untrusted provider text is safe to surface in an unavailable result.
    return unavailableResourceSnapshot(RESOURCE_UNAVAILABLE, state, checked);
  }
  const started = resourceTimestampMs(value.startedAt), end = resourceTimestampMs(value.providerEndAt);
  if (!validComputeAllocation(value.allocation) || started === null || end === null || started > checked || end <= checked || end <= started) {
    throw new Error(RESOURCE_UNAVAILABLE);
  }
  const metrics = value.metrics === null ? null : parseResourceMetrics(value.metrics, checked, started);
  if (value.metrics !== null && metrics === null) throw new Error(RESOURCE_UNAVAILABLE);
  const { cpuCount, memoryMiB, diskMiB } = value.allocation;
  return { state, checkedAt: new Date(checked).toISOString(), reason: state === 'simulation' ? 'Local preview simulation. No VM or real resource usage exists.' : null,
    allocation: { cpuCount, memoryMiB, diskMiB }, startedAt: new Date(started).toISOString(), providerEndAt: new Date(end).toISOString(), metrics };
}
