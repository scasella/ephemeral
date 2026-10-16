import { describe, expect, it } from 'vitest';
import { E2B_RESOURCE_PRICING, estimateResourceCost, parseSessionResourceSnapshot, resourcePricingIsStale,
  resourceTimestampMs, unavailableResourceSnapshot, type SessionResourceSnapshot } from '../shared/resource-visibility.js';
import { latestProviderResourceMetrics } from '../server/resource-visibility.js';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const stamp = (offset = 0) => new Date(NOW + offset).toISOString();
const snapshot = (): SessionResourceSnapshot => ({ state: 'known', checkedAt: stamp(), reason: null,
  allocation: { cpuCount: 2, memoryMiB: 4096, diskMiB: 10240 }, startedAt: stamp(-30 * 60_000), providerEndAt: stamp(30 * 60_000),
  metrics: { sampledAt: stamp(-5_000), cpuUsedPercent: 25, memoryUsedBytes: 1024 ** 3, memoryTotalBytes: Math.floor(3.8 * 1024 ** 3),
    diskUsedBytes: 1024 ** 3, diskTotalBytes: 10 * 1024 ** 3 } });
const sample = () => ({ timestamp: stamp(-5_000), timestampUnix: (NOW - 5_000) / 1000, cpuCount: 2,
  cpuUsedPct: 25, memUsed: 1024 ** 3, memTotal: 4 * 1024 ** 3, diskUsed: 1024 ** 3, diskTotal: 10 * 1024 ** 3 });

describe('resource observation validation', () => {
  it('whitelists bounded public fields and keeps measured totals distinct from allocated RAM', () => {
    const input = snapshot(); input.metrics!.memoryTotalBytes = 4 * 1024 ** 3 - 100_000_000;
    const result = parseSessionResourceSnapshot({ ...input, apiKey: 'SECRET', metadata: { secret: 'SECRET' },
      allocation: { ...input.allocation, token: 'SECRET' }, metrics: { ...input.metrics, envdAccessToken: 'SECRET' } }, NOW);
    expect(result).toEqual(input); expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(result.allocation!.memoryMiB).toBe(4096); expect(result.metrics!.memoryTotalBytes).toBeLessThan(4096 * 1024 ** 2);
  });
  it.each([null, {}, [], '2026-10-16', 'tomorrow', '2026-02-30T00:00:00.000Z', '2026-10-16T24:00:00.000Z',
    '2026-10-16T12:60:00.000Z', '2026-10-16T12:00:60.000Z', '2026-10-16T12:00:00+24:00'])('rejects malformed timestamps %s', value => {
    expect(resourceTimestampMs(value)).toBeNull();
  });
  it('accepts real provider RFC3339 precision and normalizes public times', () => {
    expect(resourceTimestampMs('2026-10-16T12:00:00.123456789Z')).toBe(NOW + 123);
    expect(resourceTimestampMs('2026-10-16T08:00:00-04:00')).toBe(NOW);
    expect(parseSessionResourceSnapshot({ ...snapshot(), checkedAt: '2026-10-16T08:00:00-04:00' }, NOW).checkedAt).toBe(stamp());
  });
  it('rejects invalid, stale or future observations and numeric allocation values', () => {
    for (const patch of [{ checkedAt: stamp(1) }, { checkedAt: stamp(-60_001) }, { startedAt: stamp(1) }, { providerEndAt: stamp() },
      { startedAt: 'invalid' }, { reason: 'x'.repeat(241) }, { reason: 'secret\n' }, { state: 'bogus' },
      ...[NaN, Infinity, -1, 0, 1.1, 1025, '2'].map(cpuCount => ({ allocation: { ...snapshot().allocation, cpuCount } })),
      ...[NaN, Infinity, -1, 0, '4096', 1_048_577].map(memoryMiB => ({ allocation: { ...snapshot().allocation, memoryMiB } })),
      ...[NaN, Infinity, -1, 0, '10240'].map(diskMiB => ({ allocation: { ...snapshot().allocation, diskMiB } }))]) {
      expect(() => parseSessionResourceSnapshot({ ...snapshot(), ...patch }, NOW)).toThrow('Resource information is unavailable.');
    }
    expect(parseSessionResourceSnapshot({ ...snapshot(), allocation: { ...snapshot().allocation, diskMiB: null } }, NOW).allocation!.diskMiB).toBeNull();
    expect(() => parseSessionResourceSnapshot(snapshot(), NaN)).toThrow();
  });
  it('enforces unknown states with no observed data and fixed safe text', () => {
    const unknown = unavailableResourceSnapshot('API-SECRET', 'unknown', NOW);
    expect(parseSessionResourceSnapshot(unknown, NOW)).toMatchObject({ state: 'unknown', allocation: null, metrics: null, startedAt: null, providerEndAt: null });
    expect(JSON.stringify(parseSessionResourceSnapshot(unknown, NOW))).not.toContain('API-SECRET');
    for (const patch of [{ allocation: snapshot().allocation }, { metrics: snapshot().metrics }, { startedAt: stamp(-1000) }, { providerEndAt: stamp(1000) }]) {
      expect(() => parseSessionResourceSnapshot({ ...unknown, ...patch }, NOW)).toThrow();
    }
    expect(parseSessionResourceSnapshot({ ...snapshot(), state: 'simulation', metrics: null, reason: 'SECRET' }, NOW).reason).toContain('simulation');
  });
  it('rejects malformed public samples, including old/future values, totals and non-finite CPU', () => {
    const input = snapshot(); input.metrics!.memoryTotalBytes = 4 * 1024 ** 3;
    for (const patch of [{ sampledAt: stamp(1) }, { sampledAt: stamp(-60_001) }, { sampledAt: 'invalid' },
      { cpuUsedPercent: -1 }, { cpuUsedPercent: 101 }, { cpuUsedPercent: Infinity }, { cpuUsedPercent: NaN },
      { memoryUsedBytes: -1 }, { memoryUsedBytes: 8 * 1024 ** 3 }, { memoryTotalBytes: 0 }, { memoryTotalBytes: '4096' },
      { memoryTotalBytes: 2 ** 51 }, { diskUsedBytes: -1 }, { diskUsedBytes: 20 * 1024 ** 3 }, { diskTotalBytes: null }]) {
      expect(() => parseSessionResourceSnapshot({ ...input, metrics: { ...input.metrics, ...patch } }, NOW)).toThrow();
    }
  });
  it('selects the latest valid sample and discards malformed, stale, future, mismatched and unbounded raw series', () => {
    const valid = sample();
    expect(latestProviderResourceMetrics([], 2, NOW, NOW - 120_000)).toBeNull();
    expect(latestProviderResourceMetrics(Array(121).fill(valid), 2, NOW, NOW - 120_000)).toBeNull();
    for (const patch of [{ cpuCount: 8 }, { cpuUsedPct: Infinity }, { memUsed: -1 }, { memTotal: NaN }, { diskTotal: -1 },
      { timestamp: stamp(5000), timestampUnix: (NOW + 5000) / 1000 },
      { timestamp: stamp(-61_000), timestampUnix: (NOW - 61_000) / 1000 },
      { timestamp: 'invalid' }, { timestampUnix: Infinity }, { timestampUnix: 1.5 }, { timestampUnix: (NOW - 10_000) / 1000 }]) {
      expect(latestProviderResourceMetrics([{ ...valid, ...patch }], 2, NOW, NOW - 120_000)).toBeNull();
    }
    const older = { ...valid, timestamp: stamp(-10_000), timestampUnix: (NOW - 10_000) / 1000, cpuUsedPct: 5 };
    expect(latestProviderResourceMetrics([older, valid, { ...valid, cpuUsedPct: Infinity }], 2, NOW, NOW - 120_000))
      .toMatchObject({ sampledAt: stamp(-5000), cpuUsedPercent: 25 });
    expect(latestProviderResourceMetrics([{ ...valid, diskUsed: undefined, diskTotal: undefined }], 2, NOW, NOW - 120_000))
      .toMatchObject({ diskUsedBytes: null, diskTotalBytes: null });
  });
});

describe('allocated compute estimates', () => {
  it('calculates the reference 2 vCPU, 4 GiB hourly example without billing from measured utilization', () => {
    const input = snapshot(); input.metrics = null;
    const estimate = estimateResourceCost(input, { expiresAt: stamp(60 * 60_000), maxExpiresAt: stamp(120 * 60_000) }, NOW)!;
    expect(estimate.usdPerSecond).toBeCloseTo(0.000046, 10); expect(estimate.usdPerHour).toBeCloseTo(0.1656, 10);
    expect(estimate.elapsedSeconds).toBe(1800); expect(estimate.elapsedUsd).toBeCloseTo(0.0828, 10);
    expect(estimate.scheduledSeconds).toBe(3600); expect(estimate.scheduledUsd).toBeCloseTo(0.1656, 10);
    input.metrics = { ...snapshot().metrics!, cpuUsedPercent: 0, memoryUsedBytes: 0, memoryTotalBytes: 1 };
    expect(estimateResourceCost(input, { expiresAt: stamp(60 * 60_000), maxExpiresAt: stamp(120 * 60_000) }, NOW)).toEqual(estimate);
    expect(Object.isFrozen(E2B_RESOURCE_PRICING)).toBe(true);
  });
  it('uses the earliest provider, session or maximum deadline for the total scheduled runtime', () => {
    const input = snapshot();
    for (const [provider, expiry, maximum, expected] of [[30, 20, 10, 10], [10, 30, 20, 10], [20, 10, 30, 10]]) {
      input.providerEndAt = stamp(provider * 60_000);
      const result = estimateResourceCost(input, { expiresAt: stamp(expiry * 60_000), maxExpiresAt: stamp(maximum * 60_000) }, NOW)!;
      expect(result.scheduledStopAt).toBe(stamp(expected * 60_000)); expect(result.scheduledSeconds).toBe(2400);
    }
  });
  it('declines incomplete/invalid snapshots, expired deadlines and excessive spans', () => {
    const session = { expiresAt: stamp(60 * 60_000), maxExpiresAt: stamp(120 * 60_000) };
    for (const patch of [{ state: 'unknown' as const }, { state: 'unavailable' as const }, { allocation: null }, { startedAt: null },
      { checkedAt: 'invalid' }, { startedAt: stamp(1) }, { startedAt: stamp(-25 * 3600_000) }, { providerEndAt: stamp() },
      { providerEndAt: stamp(48 * 3600_000), startedAt: stamp(-24 * 3600_000) }]) {
      expect(estimateResourceCost({ ...snapshot(), ...patch }, session, NOW)).toBeNull();
    }
    expect(estimateResourceCost(snapshot(), { ...session, expiresAt: 'invalid' }, NOW)).toBeNull();
    expect(estimateResourceCost(snapshot(), { ...session, maxExpiresAt: stamp() }, NOW)).toBeNull();
    expect(estimateResourceCost(snapshot(), session, NOW - 1)).toBeNull();
    expect(estimateResourceCost(snapshot(), session, NaN)).toBeNull();
  });
  it('flags rates after thirty days and invalid/backwards clocks', () => {
    const checked = Date.parse('2026-10-16T00:00:00.000Z');
    expect(resourcePricingIsStale(checked)).toBe(false); expect(resourcePricingIsStale(checked + 30 * 86400_000)).toBe(false);
    expect(resourcePricingIsStale(checked + 30 * 86400_000 + 1)).toBe(true);
    expect(resourcePricingIsStale(checked - 1)).toBe(true); expect(resourcePricingIsStale(NaN)).toBe(true);
  });
});
