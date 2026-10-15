import { describe, expect, it } from 'vitest';
import { canConfirmUsefulResponse, startupDuration } from './startup';
import type { Session } from './api';
import type { StartupProgress } from '../server/startup';

const now = Date.parse('2026-10-14T12:00:00Z');
const session = { state: 'running', expiresAt: '2026-10-14T13:00:00Z' } as Session;
const progress: StartupProgress = { startedAt: '2026-10-14T11:00:00Z', firstTerminalAttachedAt: '2026-10-14T11:01:00Z', firstUsefulResponseAt: null, timeToFirstUsefulResponseMs: null, measurement: 'user_reported', mode: 'live' };

describe('user confirmation eligibility', () => {
  it('requires a current connection and the server attachment marker', () => {
    expect(canConfirmUsefulResponse(session, progress, 'connected', now)).toBe(true);
    expect(canConfirmUsefulResponse(session, progress, 'reconnecting', now)).toBe(false);
    expect(canConfirmUsefulResponse(session, { ...progress, firstTerminalAttachedAt: null }, 'connected', now)).toBe(false);
    expect(canConfirmUsefulResponse(session, null, 'connected', now)).toBe(false);
  });
  it('rejects simulated, expired, stopped, and already confirmed sessions', () => {
    expect(canConfirmUsefulResponse(session, { ...progress, mode: 'preview' }, 'connected', now)).toBe(false);
    expect(canConfirmUsefulResponse({ ...session, expiresAt: new Date(now).toISOString() }, progress, 'connected', now)).toBe(false);
    expect(canConfirmUsefulResponse({ ...session, state: 'ended' }, progress, 'connected', now)).toBe(false);
    expect(canConfirmUsefulResponse(session, { ...progress, firstUsefulResponseAt: new Date(now).toISOString() }, 'connected', now)).toBe(false);
  });
  it('formats launch-to-confirmation elapsed time', () => {
    expect(startupDuration(3000)).toBe('3s');
    expect(startupDuration(124000)).toBe('2m 4s');
  });
});
