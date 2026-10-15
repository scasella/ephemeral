import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkStatusLoader } from './work-status-loader';
import type { WorkStatus } from './workflow';
const status: WorkStatus = { state: 'unknown', checkedAt: '2026-10-14T00:00:00Z', dirtyFiles: null, untrackedFiles: null, aheadCommits: null, headSha: null, remoteSha: null, remoteCheckedAt: null, branch: null, branchMatches: null, remoteExists: null, reason: 'test' };
function deferred() { let resolve!: (value: WorkStatus) => void; const promise = new Promise<WorkStatus>(r => { resolve = r; }); return { promise, resolve }; }
afterEach(() => { vi.useRealTimers(); });
describe('bounded work-status checks', () => {
  it('coalesces slow polling requests and displays their result', async () => {
    vi.useFakeTimers(); const pending = deferred(); const request = vi.fn(() => pending.promise); const publish = vi.fn(); const loading = vi.fn(); const loader = new WorkStatusLoader(request, publish, loading);
    const first = loader.refresh(); await vi.advanceTimersByTimeAsync(25_000); const second = loader.refresh();
    expect(second).toBe(first); expect(request).toHaveBeenCalledTimes(1);
    pending.resolve(status); await first;
    expect(publish).toHaveBeenCalledWith(status); expect(loading).toHaveBeenLastCalledWith(false);
    loader.dispose();
  });
  it('times out a hung request to unknown, aborts transport, and allows retry', async () => {
    vi.useFakeTimers(); const pending = deferred(); const publish = vi.fn(); const loading = vi.fn(); let signal!: AbortSignal;
    const request = vi.fn((value: AbortSignal) => { signal = value; return pending.promise; }); const loader = new WorkStatusLoader(request, publish, loading);
    const first = loader.refresh(); await vi.advanceTimersByTimeAsync(45_000); await first;
    expect(signal.aborted).toBe(true); expect(publish).toHaveBeenCalledWith(expect.objectContaining({ state: 'unknown', aheadCommits: null, reason: expect.stringContaining('timed out') })); expect(loading).toHaveBeenLastCalledWith(false);
    const second = loader.refresh(); pending.resolve(status); await second;
    expect(request).toHaveBeenCalledTimes(2); loader.dispose();
  });
  it('cannot publish an old session/state result after its loader is disposed', async () => {
    const pending = deferred(); const publish = vi.fn(); const oldLoader = new WorkStatusLoader(() => pending.promise, publish, vi.fn()); const first = oldLoader.refresh(); await Promise.resolve(); oldLoader.dispose();
    const next = { ...status, reason: 'new session' }; const newLoader = new WorkStatusLoader(async () => next, publish, vi.fn()); await newLoader.refresh();
    pending.resolve(status); await first; expect(publish).toHaveBeenCalledTimes(1); expect(publish).toHaveBeenCalledWith(next); newLoader.dispose();
  });
  it('reports failed inspections as unknown and releases loading', async () => {
    const publish = vi.fn(); const loading = vi.fn(); const loader = new WorkStatusLoader(async () => { throw new Error('Connection unavailable'); }, publish, loading);
    await loader.refresh(); expect(publish).toHaveBeenCalledWith(expect.objectContaining({ state: 'unknown', reason: 'Connection unavailable' })); expect(loading).toHaveBeenLastCalledWith(false); loader.dispose();
  });
});
