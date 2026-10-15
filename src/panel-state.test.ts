import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from './api';
import { SessionHistory, revealSessionHistory } from './SessionHistory';
import { WorkStatusPanel } from './WorkStatus';
import { compactWorkStatus, PanelStateMemory } from './panel-state';
import type { WorkStatus } from './workflow';

const session: Session = { id: 'panel-session', userId: 'owner', repository: 'owner/shop', repositoryId: 1, installationId: 2, baseBranch: 'main', branch: 'ephemeral/panel', state: 'running', createdAt: '2026-10-14T12:00:00Z', expiresAt: '2026-10-14T13:00:00Z', maxExpiresAt: '2026-10-14T13:00:00Z', sandboxId: null, endedAt: null, error: null, cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified' };
const clean: WorkStatus = { state: 'known', checkedAt: '2026-10-14T12:00:00Z', dirtyFiles: 0, untrackedFiles: 0, aheadCommits: 0, headSha: 'a'.repeat(40), remoteSha: 'a'.repeat(40), remoteCheckedAt: '2026-10-14T12:00:00Z', branch: session.branch, branchMatches: true, remoteExists: true, reason: null };
const now = Date.parse(clean.checkedAt);

describe('workspace disclosure preferences', () => {
  it('starts history open without a selection and compact once a machine is selected', () => {
    const memory = new PanelStateMemory();
    expect(memory.expanded('history', 'account', null)).toBe(true);
    expect(memory.expanded('history', 'account', session.id)).toBe(false);
    expect(memory.expanded('work-status', 'account', session.id)).toBe(false);
  });
  it('retains explicit choices per panel, account and machine through selection changes', () => {
    const memory = new PanelStateMemory();
    memory.remember('history', 'account', session.id, true);
    memory.remember('work-status', 'account', session.id, true);
    expect(memory.expanded('history', 'account', 'other')).toBe(false);
    expect(memory.expanded('history', 'other-account', session.id)).toBe(false);
    expect(memory.expanded('history', 'account', session.id)).toBe(true);
    memory.remember('history', 'account', session.id, false);
    expect(memory.expanded('history', 'account', session.id)).toBe(false);
    expect(memory.expanded('work-status', 'account', session.id)).toBe(true);
  });
  it('bounds in-memory preferences while keeping the most recent explicit choice', () => {
    const memory = new PanelStateMemory(2);
    memory.remember('history', 'account', 'one', true);
    memory.remember('history', 'account', 'two', true);
    memory.remember('history', 'account', 'one', true);
    memory.remember('history', 'account', 'three', true);
    expect(memory.expanded('history', 'account', 'one')).toBe(true);
    expect(memory.expanded('history', 'account', 'two')).toBe(false);
    expect(memory.expanded('history', 'account', 'three')).toBe(true);
  });
});

describe('collapsed inspection summary', () => {
  it('shows pending inspection and explicit absence of a result', () => {
    expect(compactWorkStatus(null, true, now)).toContain('Checking workspace');
    expect(compactWorkStatus(null, false, now)).toContain('unavailable');
  });
  it('exposes actual unsaved counts and branch or remote warnings', () => {
    const summary = compactWorkStatus({ ...clean, dirtyFiles: 2, untrackedFiles: 3, aheadCommits: 4, branchMatches: false, remoteExists: false }, false, now);
    expect(summary).toContain('2 changed · 3 untracked · 4 unpushed');
    expect(summary).toContain('Branch differs');
    expect(summary).toContain('Remote branch missing');
    expect(summary).toContain('Review before teardown');
  });
  it.each([
    [{ state: 'unknown' }, now, 'Work status unknown'],
    [{ state: 'unavailable' }, now, 'Work status unavailable'],
    [{ dirtyFiles: null }, now, 'Unknown changed'],
    [{ remoteSha: null }, now, 'Remote commit unconfirmed'],
    [{ checkedAt: 'invalid' }, now, 'Check time unconfirmed'],
    [{}, now + 60_001, 'Check is stale'],
  ] as const)('never reports an uncertain inspection as clean: %j', (change, at, expected) => {
    const summary = compactWorkStatus({ ...clean, ...change }, false, at);
    expect(summary).toContain(expected);
    expect(summary).not.toContain('No unsaved work detected');
  });
  it('labels clean results and distinguishes a refresh from a new confirmation', () => {
    expect(compactWorkStatus(clean, false, now)).toBe('No unsaved work detected on assigned branch');
    expect(compactWorkStatus(clean, true, now)).toContain('Refreshing work status… · Last check:');
  });
});

describe('accessible native workspace disclosures', () => {
  it('keeps history filters and results mounted inside a collapsed native details', () => {
    const html = renderToStaticMarkup(createElement(SessionHistory, { sessions: [session], selectedId: session.id, onSelect: () => {}, panelScope: 'ssr-panels' }));
    expect(html).toContain('id="history-details" class="panel-disclosure"');
    expect(html).not.toContain('open=""');
    expect(html).toContain('aria-expanded="false" aria-controls="history-content"');
    expect(html).toContain('id="history-content"');
    expect(html).toContain('id="history-search"');
    expect(html).toContain('1 of 1 machine');
    expect(html).toContain('Selected:');
    const unselected = renderToStaticMarkup(createElement(SessionHistory, { sessions: [session], selectedId: null, onSelect: () => {}, panelScope: 'ssr-panels' }));
    expect(unselected).toContain('open=""');
  });
  it('preserves save guidance inside the status disclosure and can force it open', () => {
    const html = renderToStaticMarkup(createElement(WorkStatusPanel, { session, now, panelScope: 'ssr-panels' }));
    expect(html).toContain('id="work-status-details"');
    expect(html).not.toContain('open=""');
    expect(html).toContain('aria-expanded="false" aria-controls="work-status-content"');
    expect(html).toContain('Checking workspace and remote branch');
    expect(html).toContain('id="save-guidance"');
    const expanded = renderToStaticMarkup(createElement(WorkStatusPanel, { session, now, forceExpanded: true, panelScope: 'ssr-panels' }));
    expect(expanded).toContain('open=""');
    expect(expanded).toContain('aria-expanded="true"');
  });
  it('opens history before focusing a previously hidden search control', () => {
    const details = { tagName: 'DETAILS', open: false, scrollIntoView: vi.fn() };
    const focus = vi.fn(() => { expect(details.open).toBe(true); });
    const root = { getElementById: (id: string) => (id === 'history-details' ? details : id === 'history-search' ? { focus } : null) as unknown as HTMLElement | null };
    expect(revealSessionHistory(root)).toBe(true);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(details.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(revealSessionHistory({ getElementById: () => null })).toBe(false);
  });
});
