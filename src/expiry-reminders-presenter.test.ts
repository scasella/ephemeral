import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ExpiryReminders, ExpiryNotificationSettings, revealSaveGuidance } from './ExpiryReminders';
import type { Session } from './api';
import type { ExpiryReminder } from './expiry-reminders';

const now = Date.parse('2026-10-14T12:00:00Z');
const session: Session = { id: '95cfd762-c498-4860-9c85-64527670028b', userId: 'owner', label: 'API work', repository: 'owner/api', repositoryId: 1, installationId: 1, baseBranch: 'main', branch: 'ephemeral/api', state: 'running', createdAt: new Date(now - 3_000_000).toISOString(), expiresAt: new Date(now + 600_000).toISOString(), maxExpiresAt: new Date(now + 600_000).toISOString(), sandboxId: 'sandbox', endedAt: null, error: null, cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified' };
const reminder: ExpiryReminder = { key: 'owner:machine:deadline:10', sessionId: session.id, sessionName: 'API work', repository: 'owner/api', deadline: now + 600_000, thresholdMinutes: 10, remainingMs: 600_000 };
const props = { reminders: [reminder], sessions: [session], now, preview: false, confirmedAt: now, onOpenSession: () => {} };
const markup = (overrides = {}) => renderToStaticMarkup(createElement(ExpiryReminders, { ...props, ...overrides }));
function buttons(node: ReactNode): { onClick: () => void; children: ReactNode }[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return [];
  if (node.type === 'button') return [{ onClick: node.props.onClick!, children: node.props.children }];
  return buttons(node.props.children);
}

describe('workspace reminder presentation', () => {
  it('renders one visible warning with machine identity and a save action', () => {
    const html = markup();
    expect(html.match(/class="workspace-expiry-warning/g)).toHaveLength(1);
    expect(html).toContain('API work: 10 minutes or less remain.');
    expect(html).toContain('owner/api');
    expect(html).toContain('Review save commands');
    expect(html).not.toContain('hidden=""');
    expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"');
  });
  it('announces stable threshold text instead of each countdown tick', () => {
    expect(markup({ now: now + 1000, reminders: [{ ...reminder, remainingMs: 599_000 }] })).toBe(markup());
    const urgent = markup({ reminders: [{ ...reminder, key: 'deadline:2', thresholdMinutes: 2, remainingMs: 120_000 }] });
    expect(urgent).toContain('workspace-expiry-warning critical');
    expect(urgent).toContain('2 minutes or less remain.');
  });
  it('targets an unselected machine and has no action that saves or extends work', () => {
    const onOpenSession = vi.fn();
    const tree = ExpiryReminders({ ...props, onOpenSession });
    const actions = buttons(tree);
    expect(actions).toHaveLength(1);
    actions[0].onClick();
    expect(onOpenSession).toHaveBeenCalledExactlyOnceWith(session.id);
  });
  it('replaces the threshold warning with a single waiting-for-shutdown warning at expiry', () => {
    const html = markup({ now: now + 600_000 });
    expect(html.match(/class="workspace-expiry-warning/g)).toHaveLength(1);
    expect(html).toContain('Lifetime expired.');
    expect(html).toContain('Waiting for the server to confirm shutdown and cleanup.');
    expect(html).not.toContain('minutes or less remain.');
    expect(markup({ reminders: [], sessions: [{ ...session, state: 'ended' }] })).toBe('');
  });
  it('explains preview simulation and unconfirmed last-known deadlines', () => {
    const html = markup({ preview: true, confirmedAt: null });
    expect(html).toContain('No operating system notifications are sent.');
    expect(html).toContain('last known deadline');
    expect(markup({ now: now + 16_000 })).toContain('Background checks may be delayed.');
  });
  it('uses the hard maximum deadline for expired status and excludes ended machines', () => {
    const html = markup({ sessions: [{ ...session, maxExpiresAt: new Date(now).toISOString() }], reminders: [] });
    expect(html).toContain('Lifetime expired.');
    expect(markup({ sessions: [{ ...session, expiresAt: new Date(now).toISOString(), endedAt: new Date(now).toISOString() }], reminders: [] })).toBe('');
  });
});

describe('explicit notification settings', () => {
  it('does not invoke enable until its button is clicked', () => {
    const onEnable = vi.fn().mockResolvedValue(undefined);
    const options = { desktop: { enabled: false, status: 'default' as const, message: 'Choose Enable to ask your browser for permission.' }, preview: false, onEnable, onDisable: vi.fn() };
    const tree = ExpiryNotificationSettings(options);
    expect(onEnable).not.toHaveBeenCalled();
    buttons(tree)[0].onClick();
    expect(onEnable).toHaveBeenCalledOnce();
    expect(renderToStaticMarkup(createElement(ExpiryNotificationSettings, options))).toContain('Browsers can delay background checks.');
  });
  it('shows unavailable browser states and keeps disabling available', () => {
    for (const status of ['denied', 'unsupported', 'insecure', 'storage-failure', 'coordination-unavailable', 'requesting'] as const) {
      const html = renderToStaticMarkup(createElement(ExpiryNotificationSettings, { desktop: { enabled: false, status, message: `${status} explanation` }, preview: false, onEnable: async () => {}, onDisable: () => {} }));
      expect(html).toContain('disabled=""');
      expect(html).toContain(`${status} explanation`);
    }
    const onDisable = vi.fn();
    const tree = ExpiryNotificationSettings({ desktop: { enabled: true, status: 'granted', message: 'Enabled' }, preview: false, onEnable: async () => {}, onDisable });
    buttons(tree)[0].onClick();
    expect(onDisable).toHaveBeenCalledOnce();
  });
});

describe('save guidance focus', () => {
  it('opens the destination guidance, focuses its summary, then reveals it', () => {
    const operations: string[] = [];
    const summary = { focus: vi.fn(() => operations.push('focus')) };
    const details = { tagName: 'DETAILS', open: false, querySelector: vi.fn(() => summary), scrollIntoView: vi.fn(() => operations.push('scroll')) };
    const getElementById = vi.fn(() => details as unknown as HTMLElement);
    expect(revealSaveGuidance({ getElementById })).toBe(true);
    expect(getElementById).toHaveBeenCalledWith('save-guidance');
    expect(details.open).toBe(true);
    expect(details.querySelector).toHaveBeenCalledWith('summary');
    expect(operations).toEqual(['focus', 'scroll']);
  });
  it('waits until the correct machine guidance exists', () => {
    expect(revealSaveGuidance({ getElementById: () => null })).toBe(false);
    expect(revealSaveGuidance({ getElementById: () => ({ tagName: 'DIV' } as HTMLElement) })).toBe(false);
  });
});

it('opens a collapsed work-status ancestor before focusing save guidance', () => {
  const operations: string[] = [];
  let ancestorOpen = false;
  const ancestor = { get open() { return ancestorOpen; }, set open(value: boolean) { ancestorOpen = value; operations.push('ancestor'); } };
  const summary = { focus: () => { expect(ancestorOpen).toBe(true); operations.push('focus'); } };
  const details = { tagName: 'DETAILS', open: false, closest: vi.fn(() => ancestor), querySelector: () => summary, scrollIntoView: () => operations.push('scroll') };
  expect(revealSaveGuidance({ getElementById: () => details as unknown as HTMLElement })).toBe(true);
  expect(details.closest).toHaveBeenCalledWith('details#work-status-details');
  expect(details.open).toBe(true);
  expect(operations).toEqual(['ancestor', 'focus', 'scroll']);
});
