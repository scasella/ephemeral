import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SessionEvent, SessionEventPage } from './api';
import { SessionActivity } from './SessionActivity';
import { ACTIVITY_PAGE_SIZE, activityRequestUrl, emptyActivity, SessionActivityLoader, type ActivityState } from './session-activity';

function event(id: string): SessionEvent { return { id, sessionId: 'session', at: '2026-10-14T10:00:00.000000Z', kind: 'session_created', message: id }; }
function page(id: string, nextCursor: string | null = null): SessionEventPage { return { events: [event(id)], nextCursor }; }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(request: (before: string | null, signal: AbortSignal) => Promise<SessionEventPage>, accepts?: () => boolean) {
  let state: ActivityState = emptyActivity;
  const publish = vi.fn((next: ActivityState) => { state = next; });
  const loader = new SessionActivityLoader(request, publish, accepts);
  return { loader, publish, state: () => state };
}
const tick = () => Promise.resolve();

describe('bounded chronological Activity pages', () => {
  it('requests a bounded newest page and safely encodes cursors and session IDs', () => {
    expect(activityRequestUrl('session/a', null)).toBe('/sessions/session%2Fa/events?limit=50');
    expect(activityRequestUrl('session', 'opaque+cursor/&')).toBe('/sessions/session/events?limit=50&before=opaque%2Bcursor%2F%26');
  });
  it('loads older pages without accumulating history and returns explicitly to newest', async () => {
    const request = vi.fn(async (before: string | null) => ({ events: Array.from({ length: ACTIVITY_PAGE_SIZE }, (_, index) => event(`${before ?? 'newest'}-${index}`)), nextCursor: `${before ?? 'newest'}-older` }));
    const h = harness(request);
    await h.loader.newest();
    for (let index = 0; index < 12; index++) {
      const cursor = h.state().nextCursor;
      await h.loader.older();
      expect(request.mock.calls.at(-1)?.[0]).toBe(cursor);
      expect(h.state().events).toHaveLength(ACTIVITY_PAGE_SIZE);
      expect(h.state().before).toBe(cursor);
    }
    await h.loader.newest();
    expect(h.state()).toMatchObject({ before: null, events: [expect.objectContaining({ id: 'newest-0' }), ...Array.from({ length: 49 }, () => expect.anything())] });
    h.loader.dispose();
  });
  it('prevents overlapping polls, updates newest activity, and pauses all polls on older pages', async () => {
    const slow = deferred<SessionEventPage>();
    const request = vi.fn<(before: string | null, signal: AbortSignal) => Promise<SessionEventPage>>().mockResolvedValueOnce(page('latest', 'older')).mockImplementationOnce(() => slow.promise).mockResolvedValueOnce(page('historical', 'oldest'));
    const h = harness(request);
    await h.loader.newest();
    const poll = h.loader.poll(); await tick();
    await h.loader.poll(); expect(request).toHaveBeenCalledTimes(2);
    slow.resolve(page('new event', 'older')); await poll;
    expect(h.state().events[0].id).toBe('new event');
    await h.loader.older();
    for (let index = 0; index < 10; index++) await h.loader.poll();
    expect(request).toHaveBeenCalledTimes(3); expect(h.state().events[0].id).toBe('historical');
    h.loader.dispose();
  });
  it('does not start another older request while one is pending or after the final page', async () => {
    const slow = deferred<SessionEventPage>();
    const request = vi.fn().mockResolvedValueOnce(page('latest', 'older')).mockImplementationOnce(() => slow.promise);
    const h = harness(request); await h.loader.newest();
    const older = h.loader.older(); await tick();
    await h.loader.older(); await h.loader.poll();
    expect(request).toHaveBeenCalledTimes(2);
    slow.resolve(page('oldest')); await older; await h.loader.older();
    expect(request).toHaveBeenCalledTimes(2); expect(h.state().nextCursor).toBeNull();
    h.loader.dispose();
  });
});

describe('Activity request identity and navigation fences', () => {
  it('ignores a slow older response after an explicit newest request even when abort is ignored', async () => {
    const slow = deferred<SessionEventPage>(); let oldSignal!: AbortSignal;
    const request = vi.fn().mockResolvedValueOnce(page('latest', 'older')).mockImplementationOnce((_before: string | null, signal: AbortSignal) => { oldSignal = signal; return slow.promise; }).mockResolvedValueOnce(page('fresh newest', 'older'));
    const h = harness(request); await h.loader.newest();
    const older = h.loader.older(); await tick();
    await h.loader.newest(); expect(oldSignal.aborted).toBe(true);
    slow.resolve(page('stale history')); await older; await tick();
    expect(h.state()).toMatchObject({ before: null, pending: null, error: '', events: [event('fresh newest')] });
    h.loader.dispose();
  });
  it('ignores stale failures after a newer successful navigation', async () => {
    const slow = deferred<SessionEventPage>();
    const h = harness(vi.fn().mockResolvedValueOnce(page('latest', 'older')).mockImplementationOnce(() => slow.promise).mockResolvedValueOnce(page('newest')));
    await h.loader.newest(); const older = h.loader.older(); await tick(); await h.loader.newest();
    slow.reject(new Error('Old failure')); await older; await tick();
    expect(h.state().error).toBe(''); expect(h.state().events).toEqual([event('newest')]); h.loader.dispose();
  });
  it('clears scope by disposal and ignores both previous-session and previous-account results', async () => {
    for (const nextScope of ['live:owner:session-b', 'live:other:session-a']) {
      let scope = 'live:owner:session-a'; const slow = deferred<SessionEventPage>();
      const first = harness(() => slow.promise, () => scope === 'live:owner:session-a');
      const pending = first.loader.newest(); await tick();
      scope = nextScope;
      const next = harness(async () => page(nextScope)); await next.loader.newest();
      first.loader.dispose(); scope = 'live:owner:session-a'; // Even a later return cannot reaccept an old generation.
      slow.resolve(page('previous private history')); await pending; await tick();
      expect(first.publish).toHaveBeenCalledTimes(1);
      expect(next.state().events).toEqual([event(nextScope)]);
      next.loader.dispose();
    }
  });
  it('rejects a scope change before effect cleanup and does not start new reads for it', async () => {
    let current = true; const slow = deferred<SessionEventPage>(); const request = vi.fn(() => slow.promise);
    const h = harness(request, () => current); const pending = h.loader.newest(); await tick(); current = false;
    slow.resolve(page('wrong scope')); await pending; await h.loader.newest();
    expect(h.publish).toHaveBeenCalledTimes(1); expect(request).toHaveBeenCalledTimes(1); h.loader.dispose();
  });
});

describe('Activity failures and explicit retries', () => {
  it('keeps initial failure distinct from an accepted empty log, then retries', async () => {
    const h = harness(vi.fn().mockRejectedValueOnce(new Error('Server unavailable')).mockResolvedValueOnce({ events: [], nextCursor: null }));
    await h.loader.newest(); expect(h.state()).toMatchObject({ loaded: false, error: 'Server unavailable', failedBefore: null });
    await h.loader.poll(); expect(h.state().error).toBe('Server unavailable');
    await h.loader.retry(); expect(h.state()).toMatchObject({ loaded: true, error: '', events: [], nextCursor: null }); h.loader.dispose();
  });
  it('retains the last loaded page on older-page failure, preserves the exact retry cursor, and marks retry pending', async () => {
    const recovery = deferred<SessionEventPage>();
    const request = vi.fn().mockResolvedValueOnce(page('newest', 'cursor-1')).mockRejectedValueOnce(new Error('Older page unavailable')).mockImplementationOnce(() => recovery.promise);
    const h = harness(request); await h.loader.newest(); await h.loader.older();
    expect(h.state()).toMatchObject({ loaded: true, before: null, events: [event('newest')], error: 'Older page unavailable', failedBefore: 'cursor-1' });
    await h.loader.poll(); expect(request).toHaveBeenCalledTimes(2);
    const retry = h.loader.retry(); await tick(); expect(h.state()).toMatchObject({ pending: 'older', error: 'Older page unavailable' });
    await h.loader.retry(); expect(request).toHaveBeenCalledTimes(3); expect(request.mock.calls[2][0]).toBe('cursor-1');
    recovery.resolve(page('historical')); await retry;
    expect(h.state()).toMatchObject({ before: 'cursor-1', error: '', failedBefore: undefined, events: [event('historical')] }); h.loader.dispose();
  });
  it('retains a failed newest poll snapshot and recovers on retry', async () => {
    const request = vi.fn().mockResolvedValueOnce(page('known', 'older')).mockRejectedValueOnce(new Error('Read failed')).mockResolvedValueOnce(page('fresh', 'older'));
    const h = harness(request); await h.loader.newest(); await h.loader.poll();
    expect(h.state()).toMatchObject({ loaded: true, events: [event('known')], error: 'Read failed', failedBefore: null });
    await h.loader.retry(); expect(h.state().events).toEqual([event('fresh')]); expect(h.state().error).toBe(''); h.loader.dispose();
  });
  it('times out a stalled read without accepting its later response', async () => {
    vi.useFakeTimers();
    try {
      const slow = deferred<SessionEventPage>(); let signal!: AbortSignal;
      const h = harness((_before, incoming) => { signal = incoming; return slow.promise; });
      const pending = h.loader.newest(); await tick(); await vi.advanceTimersByTimeAsync(20_000); await pending;
      expect(h.state()).toMatchObject({ loaded: false, pending: null, error: expect.stringContaining('timed out') }); expect(signal.aborted).toBe(true);
      slow.resolve(page('late')); await tick(); expect(h.state().loaded).toBe(false); h.loader.dispose();
    } finally { vi.useRealTimers(); }
  });
  it('rejects oversized pages instead of retaining unbounded response history', async () => {
    const h = harness(async () => ({ events: Array.from({ length: 51 }, (_, index) => event(String(index))), nextCursor: null }));
    await h.loader.newest(); expect(h.state()).toMatchObject({ loaded: false, events: [], error: expect.stringContaining('could not be read') }); h.loader.dispose();
  });
});

describe('Activity presentation and keyboard access', () => {
  const render = (state: ActivityState) => renderToStaticMarkup(createElement(SessionActivity, { state, onOlder: () => {}, onNewest: () => {}, onRetry: () => {} }));
  it('announces pending reads and prevents empty-state claims before a confirmed page', () => {
    const pending = render({ ...emptyActivity, pending: 'newest' });
    expect(pending).toContain('role="status"'); expect(pending).toContain('Loading newest activity'); expect(pending).toContain('aria-busy="true"'); expect(pending).not.toContain('No activity recorded yet.');
    const failed = render({ ...emptyActivity, error: 'Read failed', failedBefore: null });
    expect(failed).toContain('role="alert"'); expect(failed).toContain('No activity page has been confirmed.'); expect(failed).toContain('Retry activity'); expect(failed).not.toContain('No activity recorded yet.');
    expect(render({ ...emptyActivity, loaded: true })).toContain('No activity recorded yet.');
    const staleEmpty = render({ ...emptyActivity, loaded: true, error: 'Read failed', failedBefore: null });
    expect(staleEmpty).toContain('The last loaded page contained no events. Current activity is unconfirmed.');
    expect(staleEmpty).not.toContain('No activity recorded yet.');
  });
  it('keeps navigation and retry controls focusable while pending, labels counts as loaded, and explains older navigation', () => {
    const markup = render({ ...emptyActivity, loaded: true, before: 'cursor', nextCursor: 'next', events: [event('known')], pending: 'older', error: 'Read failed', failedBefore: 'next' });
    expect(markup).toContain('Load older page'); expect(markup).toContain('Refresh newest'); expect(markup).toContain('Retry activity');
    expect(markup).toContain('aria-disabled="true"'); expect(markup).not.toMatch(/\sdisabled[= >]/);
    expect(markup).toContain('Live updates paused'); expect(markup).toContain('Showing the last loaded page');
    const loaded = render({ ...emptyActivity, loaded: true, events: [event('known')] });
    expect(loaded).toContain('1 events loaded on this newest page.'); expect(loaded).toContain('No older events before this page.');
  });
});
