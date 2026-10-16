import { RESOURCE_UNAVAILABLE, RESOURCE_METRICS_MAX_AGE_MS, parseSessionResourceSnapshot, parseResourceMetrics, resourceTimestampMs,
  type ResourceMetrics, type SessionResourceSnapshot } from '../shared/resource-visibility.js';
import type { Session } from './contracts.js';
export { parseSessionResourceSnapshot, unavailableResourceSnapshot, RESOURCE_UNAVAILABLE } from '../shared/resource-visibility.js';
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const MAX_SESSION_MS = 4 * 60 * 60 * 1000;
// Provider and control-plane clocks can differ slightly around VM creation.
const PROVIDER_CLOCK_SKEW_MS = 5_000;
// The provider timeout starts after the create request reaches it; request latency
// can put its end beyond our persisted stop time. Estimates use the earlier stop.
const PROVIDER_CREATION_CUSHION_MS = 120_000;

export function assertResourceSession(session: Session, nowMs = Date.now()): void {
  const expiry = resourceTimestampMs(session.expiresAt), maxExpiry = resourceTimestampMs(session.maxExpiresAt);
  const created = resourceTimestampMs(session.createdAt);
  if (session.state !== 'running' || session.endedAt !== null || !session.sandboxId || !/^[a-zA-Z0-9_-]{1,128}$/.test(session.sandboxId) ||
    created === null || created > nowMs || expiry === null || maxExpiry === null || expiry <= created || expiry > maxExpiry ||
    maxExpiry - created > MAX_SESSION_MS || Math.min(expiry, maxExpiry) <= nowMs) throw new Error(RESOURCE_UNAVAILABLE);
}

/** Validate the provider's read-only detail record without exporting credentials or metadata. */
export function resourceSnapshotFromDetail(session: Session, value: unknown, nowMs = Date.now()): SessionResourceSnapshot {
  assertResourceSession(session, nowMs);
  if (!object(value) || !object(value.metadata) || !object(value.lifecycle)) throw new Error(RESOURCE_UNAVAILABLE);
  const metadata = value.metadata;
  const started = resourceTimestampMs(value.startedAt), end = resourceTimestampMs(value.endAt);
  if (value.sandboxID !== session.sandboxId || value.state !== 'running' || value.lifecycle.autoResume !== false ||
    metadata.ephemeral_session_id !== session.id || metadata.ephemeral_user_id !== session.userId ||
    metadata.ephemeral_repository !== session.repository || metadata.ephemeral_repository_id !== String(session.repositoryId) ||
    metadata.ephemeral_branch !== session.branch || started === null || end === null ||
    started < Date.parse(session.createdAt) - PROVIDER_CLOCK_SKEW_MS || end - started > MAX_SESSION_MS + PROVIDER_CREATION_CUSHION_MS ||
    end > Date.parse(session.maxExpiresAt) + PROVIDER_CREATION_CUSHION_MS) throw new Error(RESOURCE_UNAVAILABLE);
  return parseSessionResourceSnapshot({ state: 'known', checkedAt: new Date(nowMs).toISOString(), reason: null,
    allocation: { cpuCount: value.cpuCount, memoryMiB: value.memoryMB, diskMiB: value.diskSizeMB ?? null },
    startedAt: value.startedAt, providerEndAt: value.endAt, metrics: null }, nowMs);
}

/** A one-minute series has about twelve samples. Reject unbounded responses before scanning. */
export function latestProviderResourceMetrics(value: unknown, allocationCpuCount: number, checkedMs: number, startedMs: number): ResourceMetrics | null {
  if (!Array.isArray(value) || value.length > 120) return null;
  let latest: ResourceMetrics | null = null;
  for (const sample of value) {
    if (!object(sample) || sample.cpuCount !== allocationCpuCount) continue;
    const unix = typeof sample.timestampUnix === 'number' && Number.isSafeInteger(sample.timestampUnix) ? sample.timestampUnix * 1000 : null;
    const timestamp = resourceTimestampMs(sample.timestamp);
    if ((sample.timestampUnix !== undefined && unix === null) || (sample.timestamp !== undefined && timestamp === null) ||
      (unix !== null && timestamp !== null && Math.abs(unix - timestamp) >= 1000)) continue;
    const sampled = unix ?? timestamp;
    if (sampled === null || !Number.isFinite(sampled) || sampled < startedMs || sampled > checkedMs || sampled < checkedMs - RESOURCE_METRICS_MAX_AGE_MS) continue;
    const parsed = parseResourceMetrics({ sampledAt: new Date(sampled).toISOString(), cpuUsedPercent: sample.cpuUsedPct,
      memoryUsedBytes: sample.memUsed, memoryTotalBytes: sample.memTotal,
      diskUsedBytes: sample.diskUsed ?? null, diskTotalBytes: sample.diskTotal ?? null }, checkedMs, startedMs);
    if (parsed && (!latest || parsed.sampledAt > latest.sampledAt)) latest = parsed;
  }
  return latest;
}
