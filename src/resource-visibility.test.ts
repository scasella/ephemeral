import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from './api';
import type { SessionResourceSnapshot } from '../shared/resource-visibility';
import { LaunchResourceCard, ResourceReadout } from './ResourceVisibility';
import { emptyResourceRead, resourceObservationStale, resourceReadAllowed, resourceReadScope, ResourceVisibilityClient } from './resource-visibility';

const now = Date.parse('2026-10-16T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const snapshot: SessionResourceSnapshot = { state: 'known', checkedAt: iso(now), reason: null, allocation: { cpuCount: 2, memoryMiB: 4096, diskMiB: 10240 }, startedAt: iso(now - 600_000), providerEndAt: iso(now + 3_000_000), metrics: null };
const session = { state: 'running', endedAt: null, expiresAt: iso(now + 3_000_000), maxExpiresAt: iso(now + 6_000_000) } as Session;
const deferred = () => { let resolve!: (value: unknown) => void; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const markup = (changes: Partial<Parameters<typeof ResourceReadout>[0]> = {}) => renderToStaticMarkup(createElement(ResourceReadout, { session, now, previewMode: false, read: { snapshot, busy: false, error: '' }, allowed: true, onRefresh() {}, ...changes }));

describe('resource observations remain scoped to their selected machine', () => {
  it('makes no request until refreshed, deduplicates and clears old estimates while checking', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const late = deferred(), request = vi.fn().mockReturnValue(late.promise), publish = vi.fn();
    const client = new ResourceVisibilityClient(request, publish, false);
    expect(request).not.toHaveBeenCalled(); const first = client.refresh(); expect(client.refresh()).toBe(first);
    expect(publish).toHaveBeenLastCalledWith({ snapshot: null, busy: true, error: '' });
    late.resolve(snapshot); await first;
    expect(publish).toHaveBeenLastCalledWith({ snapshot, busy: false, error: '' }); client.dispose(); vi.restoreAllMocks();
  });
  it('fences late results after account/session disposal and aborts the request', async () => {
    const late = deferred(), request = vi.fn().mockReturnValue(late.promise), publish = vi.fn();
    const client = new ResourceVisibilityClient(request, publish, false); const pending = client.refresh(); await Promise.resolve();
    client.dispose(); publish.mockClear(); await pending; late.resolve(snapshot); await Promise.resolve();
    expect(publish).not.toHaveBeenCalled(); expect(request.mock.calls[0][0].aborted).toBe(true);
    await client.refresh(); expect(request).toHaveBeenCalledTimes(1);
  });
  it('bounds a hung request and ignores a late success', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const late = deferred(), publish = vi.fn(), request = vi.fn().mockReturnValue(late.promise), client = new ResourceVisibilityClient(request, publish, false);
    const pending = client.refresh(); await vi.advanceTimersByTimeAsync(15_000); await pending;
    expect(publish).toHaveBeenLastCalledWith({ snapshot: null, busy: false, error: expect.stringContaining('timed out') });
    late.resolve(snapshot); await Promise.resolve(); expect(publish.mock.calls.some(call => call[0].snapshot)).toBe(false); client.dispose();
  });
  it('rejects malformed, future, stale and mismatched mode data', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    for (const response of [null, { ...snapshot, allocation: { ...snapshot.allocation, cpuCount: Infinity } }, { ...snapshot, checkedAt: iso(now + 5001) }, { ...snapshot, checkedAt: iso(now - 60_001) }, { ...snapshot, state: 'simulation' }]) {
      const publish = vi.fn(), client = new ResourceVisibilityClient(async () => response, publish, false); await client.refresh();
      expect(publish).toHaveBeenLastCalledWith({ snapshot: null, busy: false, error: expect.any(String) }); client.dispose();
    }
    const publish = vi.fn(), client = new ResourceVisibilityClient(async () => snapshot, publish, true); await client.refresh();
    expect(publish.mock.calls.at(-1)?.[0].snapshot).toBeNull(); client.dispose();
  });
  it('tolerates up to five seconds of browser clock lag while preserving the old-age limit', async () => {
    vi.useFakeTimers();
    for (const browserNow of [now, now - 1, now - 5000]) {
      vi.setSystemTime(browserNow);
      const publish = vi.fn(), client = new ResourceVisibilityClient(async () => snapshot, publish, false);
      await client.refresh(); expect(publish).toHaveBeenLastCalledWith({ snapshot, busy: false, error: '' }); client.dispose();
    }
    for (const browserNow of [now - 5001, now + 60_001]) {
      vi.setSystemTime(browserNow);
      const publish = vi.fn(), client = new ResourceVisibilityClient(async () => snapshot, publish, false);
      await client.refresh(); expect(publish).toHaveBeenLastCalledWith({ snapshot: null, busy: false, error: expect.any(String) }); client.dispose();
    }
  });
  it('an unknown result replaces a successful snapshot, without retaining dollars', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const publish = vi.fn(), request = vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValueOnce({ state: 'unknown', checkedAt: iso(now), reason: null, allocation: null, startedAt: null, providerEndAt: null, metrics: null });
    const client = new ResourceVisibilityClient(request, publish, false); await client.refresh(); await client.refresh();
    expect(publish.mock.calls.at(-1)?.[0].snapshot.state).toBe('unknown');
    expect(markup({ read: publish.mock.calls.at(-1)![0] })).not.toContain('USD 0.1656'); client.dispose();
  });
});

describe('resource presentation', () => {
  it('presents explicit reference pricing and no charged resources in simulation', () => {
    const live = renderToStaticMarkup(createElement(LaunchResourceCard, { previewMode: false, now, extensionsAvailable: true }));
    for (const text of ['2 vCPU', '4 GiB', 'USD 0.1656/h', 'USD 0.0828', 'custom template is unverified', 'confirmed after launch', '2026-10-16', 'not a budget cap', 'https://e2b.dev/pricing', 'https://console.e2b.dev']) expect(live).toContain(text);
    expect(renderToStaticMarkup(createElement(LaunchResourceCard, { previewMode: true, now }))).toContain('no charged resources');
    expect(renderToStaticMarkup(createElement(LaunchResourceCard, { previewMode: false, now }))).not.toContain('30-minute extension');
    expect(renderToStaticMarkup(createElement(LaunchResourceCard, { previewMode: false, now: now + 31 * 86400_000 }))).toContain('Pricing reference is stale');
  });
  it('separates allocated values, pending utilization and snapshot estimates', () => {
    const html = markup(); for (const text of ['2 vCPU', '4 GiB', '10 GiB', 'Pending metrics', 'Snapshot', 'Values stay fixed until refresh', 'Elapsed compute estimate', 'Estimate through deadline']) expect(html).toContain(text);
    expect(markup({ now: now + 60_001 })).toContain('Stale observation');
    expect(resourceObservationStale(snapshot.checkedAt, now + 60_001)).toBe(true);
  });
  it('shows a fresh snapshot estimate before the parent clock tick, with only five seconds of grace', () => {
    for (const renderNow of [now - 1000, now - 5000]) {
      const html = markup({ now: renderNow });
      expect(html).toContain('USD 0.1656/h'); expect(html).toContain('Elapsed compute estimate');
      expect(html).not.toContain('Estimate unavailable');
    }
    expect(markup({ now: now - 5001 })).not.toContain('USD 0.1656');
    expect(markup({ now: now - 5001 })).toContain('Estimate unavailable');
  });
  it('suppresses estimates and refresh for expired, ended, provisioning and cleanup machines', () => {
    for (const state of ['ended', 'failed', 'cleanup_pending', 'provisioning']) {
      expect(resourceReadAllowed({ ...session, state } as Session, true, now)).toBe(false);
      const html = markup({ session: { ...session, state } as Session, allowed: false });
      expect(html).not.toContain('USD 0.1656'); expect(html).toContain('disabled=""'); expect(html).toContain('No final charge');
    }
    expect(markup({ now: Date.parse(session.expiresAt) })).not.toContain('USD 0.1656');
    expect(markup({ session: { ...session, expiresAt: iso(now + 4_000_000) }, now: Date.parse(snapshot.providerEndAt!) })).not.toContain('USD 0.1656');
    expect(resourceReadAllowed(session, false, now)).toBe(false);
    expect(resourceReadAllowed({ ...session, endedAt: iso(now) }, true, now)).toBe(false);
    expect(resourceReadAllowed({ ...session, maxExpiresAt: 'invalid' }, true, now)).toBe(false);
    expect(resourceReadAllowed({ ...session, maxExpiresAt: iso(now) }, true, now)).toBe(false);
    for (const change of [{ sandboxId: 'another' }, { expiresAt: iso(now + 3600_000) }, { maxExpiresAt: iso(now + 7200_000) }, { repository: 'different/repo' }, { branch: 'another' }]) expect(resourceReadScope('account', { ...session, ...change }, false)).not.toBe(resourceReadScope('account', session, false));
  });
  it('renders unknown, failure and loading without invented zero resources', () => {
    expect(markup({ read: { snapshot: { ...snapshot, state: 'simulation' }, busy: false, error: '' } })).not.toContain('USD 0.1656');
    expect(markup({ previewMode: true })).not.toContain('USD 0.1656');
    expect(markup({ read: emptyResourceRead() })).toContain('CPU unknown');
    expect(markup({ read: { snapshot: null, busy: true, error: '' } })).toContain('aria-busy="true"');
    expect(markup({ read: { snapshot: null, busy: false, error: 'Check failed' } })).toContain('Check failed');
    expect(markup({ read: { snapshot: null, busy: false, error: '' } })).not.toContain('0 vCPU');
  });
});
