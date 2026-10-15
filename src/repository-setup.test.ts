import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestSetup, setupOutputNotice, setupDraft, setupDraftMatches, setupRunActive, setupRunBlocked, setupRunGuidance, setupRunSummary, SetupLoader, validateSetupDraft, type SetupAction, type SetupState } from './repository-setup';

const recipe = { version: 'recipe-v1', label: 'Install dependencies', command: 'npm ci', timeoutSeconds: 120, updatedAt: '2026-10-14T14:00:00Z' };
const state: SetupState = { recipe, run: null, mode: 'live' };
function deferred() { let resolve!: (value: SetupState) => void; const promise = new Promise<SetupState>(r => { resolve = r; }); return { promise, resolve }; }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('setup recipe and recorded outcomes', () => {
  it('requires a valid saved draft before running and preserves multiline shell commands', () => {
    expect(setupDraftMatches(setupDraft(recipe), recipe)).toBe(true);
    expect(setupDraftMatches({ ...setupDraft(recipe), command: 'npm install' }, recipe)).toBe(false);
    expect(setupDraftMatches(setupDraft(null), null)).toBe(false);
    expect(validateSetupDraft({ ...setupDraft(recipe), command: 'npm ci\nnpm run build' })).toBeNull();
    for (const timeoutSeconds of ['', '4', '601', '5.5', 'Infinity', '1e2']) expect(validateSetupDraft({ ...setupDraft(recipe), timeoutSeconds })).toContain('whole number');
    expect(validateSetupDraft({ ...setupDraft(recipe), command: ' '.repeat(4) })).toContain('command');
    expect(validateSetupDraft({ ...setupDraft(recipe), command: 'x'.repeat(8193) })).toContain('command');
    expect(validateSetupDraft({ ...setupDraft(recipe), command: 'npm ci\0' })).toContain('null character');
  });
  it('keeps timeouts, cancellation and interrupted outcomes distinct from success', () => {
    const run = { id: 'run', sessionId: 'session', recipe, output: '', truncated: false, exitCode: null, startedAt: null, finishedAt: null, error: null, blockedUntil: '2026-10-14T14:02:00Z' };
    expect(setupRunSummary({ ...run, status: 'failed', exitCode: 7 })).toBe('Failed · exit code 7');
    expect(setupRunSummary({ ...run, status: 'timed_out' })).toBe('Timed out');
    expect(setupRunSummary({ ...run, status: 'cancelled' })).toBe('Cancelled');
    expect(setupRunSummary({ ...run, status: 'interrupted' })).toBe('Interrupted');
    expect(setupRunActive({ ...run, status: 'running' })).toBe(true);
    expect(setupRunActive({ ...run, status: 'interrupted' })).toBe(false);
    expect(setupRunBlocked({ ...run, status: 'interrupted' }, Date.parse('2026-10-14T14:01:00Z'))).toBe(true);
    expect(setupRunBlocked({ ...run, status: 'interrupted' }, Date.parse('2026-10-14T14:02:00Z'))).toBe(false);
  });
  it('describes head and tail retention only for records that used that format', () => {
    const run = { id: 'run', sessionId: 'session', recipe, status: 'succeeded' as const, output: 'retained', truncated: true, exitCode: 0,
      startedAt: null, finishedAt: null, error: null, blockedUntil: null };
    expect(setupOutputNotice(run)).toBe('Saved output exceeded its limit and was truncated.');
    expect(setupOutputNotice({ ...run, outputRetention: 'head_tail' })).toContain('beginning and end');
    expect(setupOutputNotice({ ...run, outputRetention: 'head_tail' })).toContain('final tail');
    expect(setupOutputNotice({ ...run, truncated: false })).toBeNull();
  });
  it('explains retryable failures before execution without suggesting the command ran', () => {
    const run = { id: 'run', sessionId: 'session', recipe, status: 'failed' as const, output: '', truncated: false, exitCode: null, startedAt: null,
      finishedAt: '2026-10-14T14:00:00Z', error: 'Untrusted provider text', blockedUntil: null, invocationStarted: false };
    for (const reason of ['authorization_failed', 'persistence_failed', 'server_shutdown', 'timeout', 'provider_unavailable'] as const) {
      const result = { ...run, reason };
      expect(setupRunSummary(result)).toMatch(/^Did not start/);
      expect(setupRunGuidance(result)).toMatch(/before|explicitly|retry/i);
      expect(setupRunGuidance(result)).not.toMatch(/command may have run|Untrusted/);
      expect(setupRunBlocked(result, Date.now())).toBe(false);
    }
    expect(setupRunGuidance({ ...run, reason: 'session_ended' })).toContain('available machine');
  });
  it('distinguishes user cancellation, lifecycle stops, and uncertain completion while keeping legacy rows readable', () => {
    const run = { id: 'run', sessionId: 'session', recipe, output: '', truncated: false, exitCode: null, startedAt: '2026-10-14T14:00:00Z', finishedAt: '2026-10-14T14:00:01Z', error: null, blockedUntil: null };
    const cancelled = { ...run, status: 'cancelled' as const, invocationStarted: true };
    expect(setupRunSummary({ ...cancelled, reason: 'user_cancelled' })).toContain('cancelled by you');
    for (const reason of ['session_ended', 'authorization_failed', 'persistence_failed', 'server_shutdown'] as const) {
      expect(setupRunSummary({ ...cancelled, reason })).not.toContain('by you');
      expect(setupRunGuidance({ ...cancelled, reason })).not.toContain('You requested cancellation');
    }
    const uncertain = { ...cancelled, status: 'interrupted' as const, reason: 'timeout' as const, blockedUntil: '2026-10-14T14:02:00Z' };
    expect(setupRunGuidance(uncertain)).toContain('completion could not be confirmed');
    expect(setupRunGuidance(uncertain)).toContain('never replayed automatically');
    expect(setupRunSummary({ ...run, status: 'cancelled' })).toBe('Cancelled');
    expect(setupRunGuidance({ ...run, status: 'cancelled' })).toBeNull();
    expect(setupRunGuidance({ ...run, status: 'interrupted' })).toContain('may have run');
    expect(setupRunGuidance({ ...run, status: 'running', reason: 'user_cancelled' })).toBeNull();
  });

});

describe('setup API requests', () => {
  it('saves with PUT and starts only the explicitly selected saved version', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => state }); vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    await requestSetup('session/id', { type: 'save', recipe: { label: recipe.label, command: recipe.command, timeoutSeconds: recipe.timeoutSeconds } }, signal);
    expect(fetch).toHaveBeenLastCalledWith('/api/sessions/session%2Fid/setup', expect.objectContaining({ method: 'PUT', headers: expect.objectContaining({ 'X-Ephemeral-Request': '1' }), signal }));
    await requestSetup('session/id', { type: 'run', recipeVersion: 'recipe-v1' }, signal);
    expect(fetch).toHaveBeenLastCalledWith('/api/sessions/session%2Fid/setup/runs', expect.objectContaining({ method: 'POST', body: '{"recipeVersion":"recipe-v1"}' }));
    await requestSetup('session/id', { type: 'load' }, signal);
    expect(fetch).toHaveBeenLastCalledWith('/api/sessions/session%2Fid/setup', expect.objectContaining({ method: 'GET' }));
    expect(fetch.mock.calls[2][1].body).toBeUndefined();
    await requestSetup('session/id', { type: 'cancel', runId: 'run/id' }, signal);
    expect(fetch).toHaveBeenLastCalledWith('/api/sessions/session%2Fid/setup/runs/run%2Fid/cancel', expect.objectContaining({ method: 'POST' }));
  });
});

describe('bounded setup requests', () => {
  it('coalesces status requests and never queues an execution behind a pending read', async () => {
    const pending = deferred(); const request = vi.fn((_action: SetupAction, _signal: AbortSignal) => pending.promise); const publish = vi.fn();
    const loader = new SetupLoader(request, publish, vi.fn(), vi.fn());
    const first = loader.run(); expect(loader.run({ type: 'run', recipeVersion: 'recipe-v1' })).toBe(first);
    await Promise.resolve(); expect(request).toHaveBeenCalledTimes(1); expect(request.mock.calls[0]?.[0]).toEqual({ type: 'load' });
    pending.resolve(state); await first; expect(publish).toHaveBeenCalledTimes(1); loader.dispose();
  });
  it('suppresses departed session responses and aborts its outstanding request', async () => {
    const pending = deferred(); const publish = vi.fn(); let signal!: AbortSignal;
    const loader = new SetupLoader((_action, value) => { signal = value; return pending.promise; }, publish, vi.fn(), vi.fn());
    const first = loader.run(); await Promise.resolve(); loader.dispose(); expect(signal.aborted).toBe(true);
    pending.resolve(state); await first; expect(publish).not.toHaveBeenCalled();
  });
  it('bounds hung mutations without claiming success or retrying execution automatically', async () => {
    vi.useFakeTimers(); const pending = deferred(); const publish = vi.fn(); const fail = vi.fn(); const busy = vi.fn(); let signal!: AbortSignal;
    const request = vi.fn().mockImplementationOnce((_action, value) => { signal = value; return pending.promise; }).mockResolvedValueOnce(state);
    const loader = new SetupLoader(request, publish, busy, fail);
    const action = { type: 'run' as const, recipeVersion: 'recipe-v1' };
    const first = loader.run(action); await vi.advanceTimersByTimeAsync(15000); await first;
    expect(signal.aborted).toBe(true); expect(publish).not.toHaveBeenCalled(); expect(fail).toHaveBeenCalledWith(expect.stringContaining('result is unconfirmed'), action); expect(busy).toHaveBeenLastCalledWith(null);
    await loader.run(); expect(request.mock.calls[1]?.[0]).toEqual({ type: 'load' }); expect(publish).toHaveBeenCalledTimes(1);
    pending.resolve({ ...state, mode: 'preview' }); await Promise.resolve(); expect(publish).toHaveBeenCalledTimes(1); loader.dispose();
  });
});
