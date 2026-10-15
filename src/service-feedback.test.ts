import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Bootstrap } from './api';
import { WorkspaceServiceFeedback } from './ServiceFeedback';
import { ServiceCheckGate, configurationFeedback, configurationSidebarLabel, connectionFeedback, emptyServiceObservation, integrationGuidance, observationTime, repositoryListFeedback, type ServiceObservation } from './service-feedback';

const now = Date.parse('2026-10-14T12:00:00Z');
const boot: Bootstrap = { mode: 'live', user: { id: 'owner', login: 'owner', avatarUrl: '' }, configured: true, missing: [], sessionMaxHours: 1, githubInstallUrl: null };
const accepted: ServiceObservation = { checking: false, observedAt: now - 3000, error: '' };

describe('bounded service observation times', () => {
  it('keeps exact time semantics and readable seconds, minutes and hours', () => {
    expect(observationTime(now - 1000, now)).toEqual({ iso: '2026-10-14T11:59:59.000Z', age: '1 second ago' });
    expect(observationTime(now - 120_000, now)?.age).toBe('2 minutes ago');
    expect(observationTime(now - 3_600_000, now)?.age).toBe('1 hour ago');
  });
  it('rejects absent, invalid, future and out-of-range dates', () => {
    for (const time of [null, NaN, Infinity, -1, now + 1]) expect(observationTime(time, now)).toBeNull();
    expect(observationTime(1e20, 1e21)).toBeNull();
    expect(observationTime(now, NaN)).toBeNull();
  });
});

describe('configuration evidence stays separate from connection evidence', () => {
  it('describes configured settings without asserting readiness or provider health', () => {
    const feedback = configurationFeedback(boot, accepted, now);
    expect(feedback.title).toBe('Server configuration recorded');
    expect(feedback.detail).toContain('Service health is not checked.');
    expect(configurationSidebarLabel(boot, accepted)).toBe('Settings recorded');
    expect(integrationGuidance(boot)).toEqual({ heading: 'Launch from Machines', detail: expect.stringContaining('choose a repository and base branch'), launchRoute: true });
    expect(integrationGuidance(boot).detail).not.toContain('Configure');
  });
  it('gives setup instructions only from accepted incomplete configuration', () => {
    const incomplete = { ...boot, configured: false, missing: ['E2B_API_KEY'] };
    expect(configurationSidebarLabel(incomplete, accepted)).toBe('Setup required');
    expect(configurationFeedback(incomplete, accepted, now).title).toBe('Server setup required');
    expect(integrationGuidance(incomplete)).toEqual({ heading: 'Finish connecting your services', detail: expect.stringContaining('missing service credentials'), launchRoute: false });
  });
  it('never turns an absent or failed initial bootstrap into setup required', () => {
    expect(configurationSidebarLabel(null, emptyServiceObservation)).toBe('Configuration unavailable');
    const failed = { ...emptyServiceObservation, error: 'Server returned 403' };
    expect(configurationSidebarLabel(null, failed)).toBe('Configuration unconfirmed');
    expect(configurationFeedback(null, failed, now).detail).not.toContain('Last recorded');
    expect(configurationFeedback(null, failed, now).title).toBe('Configuration check unavailable');
    expect(configurationFeedback(null, { ...failed, checking: true }, now).title).toBe('Retrying configuration check');
    expect(configurationFeedback(null, { ...emptyServiceObservation, checking: true }, now).title).toBe('Checking server configuration');
  });
  it('retains the recorded configuration date and failure during a recheck', () => {
    const failed = { ...accepted, error: 'Bootstrap read failed' };
    const feedback = configurationFeedback(boot, failed, now);
    expect(feedback.title).toBe('Configuration recheck unavailable');
    expect(integrationGuidance(boot, failed).detail).toContain('Based on the last recorded settings');
    expect(integrationGuidance(boot, failed).launchRoute).toBe(true);
    expect(feedback.detail).toContain('Last recorded: required settings present. Bootstrap read failed');
    expect(feedback.time?.iso).toBe(new Date(accepted.observedAt!).toISOString());
    expect(configurationFeedback(boot, { ...failed, checking: true }, now).detail).toContain('Bootstrap read failed');
    expect(configurationFeedback(boot, { ...accepted, observedAt: now + 1 }, now).detail).toContain('Observation time unavailable');
  });
});

describe('scoped app connection presentation', () => {
  it('scopes a successful read and independently renders a configuration failure', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceServiceFeedback, { bootstrap: boot, configuration: { ...accepted, error: 'Bootstrap read failed' }, connection: accepted, now }));
    expect(html).toContain('Bootstrap read failed');
    expect(html).toContain('App connection: machine status read');
    expect(html).toContain('Provider, GitHub and terminal health are not checked.');
    expect(html).toContain('dateTime="2026-10-14T11:59:57.000Z"');
    expect(html).not.toMatch(/aria-live|role="status"|System ready/);
  });
  it('does not announce success for absent, future or stale snapshots', () => {
    for (const observedAt of [null, now + 1, NaN]) expect(connectionFeedback(boot, { ...accepted, observedAt }, now).title).toBe('App connection: machine status unconfirmed');
    expect(connectionFeedback(boot, accepted, now + 20_000).title).toBe('App connection: machine status may be stale');
  });
  it('describes waiting and failure while retaining the last accepted date', () => {
    const checking = connectionFeedback(boot, { ...accepted, checking: true }, now);
    expect(checking.title).toBe('App connection: checking machine status');
    expect(checking.detail).toContain('last accepted snapshot');
    expect(connectionFeedback(boot, { ...emptyServiceObservation, checking: true }, now).detail).toContain('first accepted session snapshot');
    const failed = connectionFeedback(boot, { ...accepted, error: 'Machine read failed' }, now);
    expect(failed.title).toBe('App connection: machine status unavailable');
    expect(failed.detail).toContain('Showing last known machine status. Machine read failed');
    expect(failed.time).toEqual(checking.time);
    expect(connectionFeedback(boot, { ...accepted, checking: true, error: 'Machine read failed' }, now).detail).toContain('Machine read failed');
    expect(connectionFeedback(boot, accepted, now).detail).not.toContain('Machine read failed');
  });
  it('labels initial access and signed-out views without assuming machine checks', () => {
    expect(connectionFeedback(null, emptyServiceObservation, now).detail).toBe('Waiting for workspace access.');
    expect(connectionFeedback({ ...boot, user: null }, accepted, now)).toMatchObject({ title: 'App connection: machine status not checked', time: null });
  });
  it('labels preview simulation while retaining actual app read dates and failures', () => {
    const preview = { ...boot, mode: 'preview' as const };
    expect(configurationFeedback(preview, accepted, now)).toMatchObject({ title: 'Preview configuration recorded', time: { iso: new Date(accepted.observedAt!).toISOString() }, detail: expect.stringContaining('Simulation only') });
    expect(connectionFeedback(preview, accepted, now)).toMatchObject({ title: 'App connection: simulated machine status read', time: { iso: new Date(accepted.observedAt!).toISOString() }, detail: expect.stringContaining('simulated') });
    for (const present of [configurationFeedback, connectionFeedback]) {
      expect(present(preview, { ...accepted, error: 'Local HTTP read failed' }, now)).toMatchObject({ tone: 'warning', detail: expect.stringContaining('Local HTTP read failed') });
      expect(present(preview, { ...accepted, checking: true }, now).title.toLowerCase()).toContain('checking');
    }
    expect(connectionFeedback(preview, accepted, now + 20_000).title).toContain('stale');
    expect(connectionFeedback(preview, emptyServiceObservation, now).title).toContain('unconfirmed');
    expect(configurationSidebarLabel(preview, { ...accepted, error: 'Local HTTP read failed' })).toBe('Configuration unconfirmed');
    expect(integrationGuidance(preview).launchRoute).toBe(true);
  });
});

describe('repository access evidence', () => {
  it('does not treat unread, pending or initially failed access as an empty connected list', () => {
    for (const observation of [emptyServiceObservation, { ...emptyServiceObservation, checking: true }, { ...emptyServiceObservation, error: 'Server returned 503' }]) {
      const feedback = repositoryListFeedback(observation, 0, now);
      expect(feedback.showConnect).toBe(false);
      expect(feedback.title).not.toBe('No repositories connected');
      expect(feedback.detail).not.toContain('Install the GitHub App');
      expect(feedback.time).toBeNull();
    }
    expect(repositoryListFeedback({ ...emptyServiceObservation, error: 'Server returned 503' }, 0, now).detail).toContain('No connected-repository count is confirmed.');
  });
  it('shows installation guidance only after an accepted empty response', () => {
    expect(repositoryListFeedback(accepted, 0, now)).toMatchObject({ title: 'No repositories connected', showConnect: true, detail: expect.stringContaining('Install the GitHub App') });
    expect(repositoryListFeedback(accepted, 2, now)).toMatchObject({ title: 'Repository list received', showConnect: false });
    expect(repositoryListFeedback({ ...accepted, observedAt: now + 1 }, 0, now).showConnect).toBe(false);
  });
  it('keeps a dated last known list on failure and while retrying', () => {
    const failed = { ...accepted, error: 'Repository read failed' };
    expect(repositoryListFeedback(failed, 2, now)).toMatchObject({ title: 'Repository list unavailable', time: { iso: new Date(accepted.observedAt!).toISOString() }, detail: 'Showing last known repository access. Repository read failed', showConnect: false });
    expect(repositoryListFeedback({ ...failed, checking: true }, 2, now)).toMatchObject({ title: 'Checking repository access', detail: expect.stringContaining('last known repository list'), showConnect: false });
    // A failed recheck of a formerly empty list also suppresses the setup inference.
    expect(repositoryListFeedback(failed, 0, now).showConnect).toBe(false);
    expect(repositoryListFeedback({ ...accepted, checking: true }, 0, now).showConnect).toBe(false);
  });
  it('recovers only from a repository read and never infers provider health from access', () => {
    const recovered = repositoryListFeedback({ checking: false, observedAt: now, error: '' }, 2, now);
    expect(recovered.detail).not.toContain('failed');
    expect(recovered.time?.age).toBe('0 seconds ago');
    expect(recovered.detail).not.toMatch(/healthy|ready/);
  });
});

describe('service feedback request fences', () => {
  it('accepts completed slow reads while newer polls remain pending', async () => {
    vi.useFakeTimers();
    try {
      const gate = new ServiceCheckGate();
      const completions: { accepted: boolean; checking: boolean }[] = [];
      const read = () => {
        const check = gate.begin('live:owner');
        setTimeout(() => { completions.push({ accepted: gate.commit(check, 'live:owner'), checking: gate.checking() }); }, 4500);
      };
      read();
      await vi.advanceTimersByTimeAsync(3000); read();
      await vi.advanceTimersByTimeAsync(1500);
      expect(completions).toEqual([{ accepted: true, checking: true }]);
      await vi.advanceTimersByTimeAsync(1500); read();
      await vi.advanceTimersByTimeAsync(1500);
      expect(completions).toEqual([{ accepted: true, checking: true }, { accepted: true, checking: true }]);
      await vi.advanceTimersByTimeAsync(3000);
      expect(completions.at(-1)).toEqual({ accepted: true, checking: false });
    } finally { vi.useRealTimers(); }
  });
  it('rejects older success after a newer completed failure and permits subsequent recovery', () => {
    const gate = new ServiceCheckGate();
    const olderSuccess = gate.begin('live:owner');
    const newerFailure = gate.begin('live:owner');
    expect(gate.commit(newerFailure, 'live:owner')).toBe(true);
    expect(gate.checking()).toBe(false);
    expect(gate.commit(olderSuccess, 'live:owner')).toBe(false);
    const recovery = gate.begin('live:owner');
    expect(gate.checking()).toBe(true);
    expect(gate.commit(recovery, 'live:owner')).toBe(true);
    expect(gate.checking()).toBe(false);
  });
  it('rejects older failure after a newer completed success', () => {
    const gate = new ServiceCheckGate();
    const olderFailure = gate.begin('live:owner');
    const newerSuccess = gate.begin('live:owner');
    expect(gate.commit(newerSuccess, 'live:owner')).toBe(true);
    expect(gate.commit(olderFailure, 'live:owner')).toBe(false);
    expect(gate.checking()).toBe(false);
    expect(gate.commit(newerSuccess, 'live:owner')).toBe(false);
  });
  it('retains checking when an older failure completes before the newest pending request', () => {
    const gate = new ServiceCheckGate();
    const olderFailure = gate.begin('live:owner');
    const pending = gate.begin('live:owner');
    expect(gate.commit(olderFailure, 'live:owner')).toBe(true);
    expect(gate.checking()).toBe(true);
    expect(gate.commit(pending, 'live:owner')).toBe(true);
    expect(gate.checking()).toBe(false);
  });
  it('fences account/mode changes and generations, including returning to the same account', () => {
    const gate = new ServiceCheckGate();
    const check = gate.begin('live:owner');
    expect(gate.commit(check, 'live:other')).toBe(false);
    expect(gate.commit(check, 'preview:owner')).toBe(false);
    expect(gate.checking()).toBe(true);
    gate.invalidate();
    expect(gate.checking()).toBe(false);
    expect(gate.commit(check, 'live:owner')).toBe(false);
    const current = gate.begin('live:owner');
    expect(gate.commit(check, 'live:owner')).toBe(false);
    expect(gate.commit(current, 'live:owner')).toBe(true);
  });
});
