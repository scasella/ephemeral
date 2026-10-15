import { afterEach, describe, expect, it, vi } from 'vitest';
import { StartupLoader } from './startup-loader';
import type { StartupProgress } from '../server/startup';

const progress: StartupProgress = { startedAt: '2026-10-14T11:00:00Z', firstTerminalAttachedAt: '2026-10-14T11:01:00Z', firstUsefulResponseAt: null, timeToFirstUsefulResponseMs: null, measurement: 'user_reported', mode: 'live' };
function deferred() { let resolve!: (value: StartupProgress) => void; const promise = new Promise<StartupProgress>(r => { resolve = r; }); return { promise, resolve }; }
afterEach(() => vi.useRealTimers());

describe('bounded startup requests', () => {
  it('coalesces requests without overlapping status reads and confirmation writes', async () => {
    const pending = deferred(); const request = vi.fn(() => pending.promise); const publish = vi.fn();
    const loader = new StartupLoader(request, publish, vi.fn(), vi.fn());
    const first = loader.run(); expect(loader.run()).toBe(first); expect(loader.run('confirm')).toBe(first);
    await Promise.resolve(); expect(request).toHaveBeenCalledTimes(1);
    pending.resolve(progress); await first; expect(publish).toHaveBeenCalledWith(progress); loader.dispose();
  });
  it('cannot publish the previous session after disposal', async () => {
    const pending = deferred(); const publish = vi.fn(); const oldLoader = new StartupLoader(() => pending.promise, publish, vi.fn(), vi.fn());
    const first = oldLoader.run(); await Promise.resolve(); oldLoader.dispose();
    const newer = { ...progress, startedAt: '2026-10-14T12:00:00Z' };
    const nextLoader = new StartupLoader(async () => newer, publish, vi.fn(), vi.fn()); await nextLoader.run();
    pending.resolve(progress); await first; expect(publish).toHaveBeenCalledTimes(1); expect(publish).toHaveBeenCalledWith(newer); nextLoader.dispose();
  });
  it('times out hung confirmations without claiming success and allows an idempotent retry', async () => {
    vi.useFakeTimers(); const pending = deferred(); const publish = vi.fn(); const fail = vi.fn(); const busy = vi.fn(); let signal!: AbortSignal;
    const confirmed = { ...progress, firstUsefulResponseAt: '2026-10-14T11:02:00Z', timeToFirstUsefulResponseMs: 120000 };
    const request = vi.fn().mockImplementationOnce((_action, value) => { signal = value; return pending.promise; }).mockResolvedValueOnce(confirmed);
    const loader = new StartupLoader(request, publish, busy, fail);
    const first = loader.run('confirm'); await vi.advanceTimersByTimeAsync(15000); await first;
    expect(signal.aborted).toBe(true); expect(publish).not.toHaveBeenCalled(); expect(fail).toHaveBeenCalledWith(expect.stringContaining('timed out'), 'confirm'); expect(busy).toHaveBeenLastCalledWith(null);
    await loader.run('confirm'); expect(publish).toHaveBeenCalledWith(confirmed);
    pending.resolve(progress); await Promise.resolve(); expect(publish).toHaveBeenCalledTimes(1); loader.dispose();
  });
  it('keeps loaded progress when a confirmation fails and only publishes successful server responses', async () => {
    const publish = vi.fn(); const fail = vi.fn();
    const request = vi.fn().mockResolvedValueOnce(progress).mockRejectedValueOnce(new Error('Machine expired'));
    const loader = new StartupLoader(request, publish, vi.fn(), fail);
    await loader.run(); await loader.run('confirm');
    expect(publish).toHaveBeenCalledTimes(1); expect(fail).toHaveBeenCalledWith('Machine expired', 'confirm'); loader.dispose();
  });
});
