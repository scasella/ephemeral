import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from './api';
import { ActiveWorkspaceContext, SelectedWorkspaceContext } from './WorkspaceContext';
import { activeOwnedSessions, canRestoreFocus, deferWorkspaceFocusRestore, focusWorkspaceTarget, remainingSessionSeconds, restoreWorkspaceFocus, sessionDeadline, WorkspaceNavigationIntent, workspaceSnapshotFresh } from './workspace-navigation';

const now = Date.parse('2026-10-14T12:00:00Z');
const session: Session = { id: '95cfd762-c498-4860-9c85-64527670028b', userId: 'owner', label: 'API work', repository: 'owner/api', repositoryId: 1, installationId: 1, baseBranch: 'main', branch: 'ephemeral/api', state: 'running', createdAt: new Date(now - 3_000_000).toISOString(), expiresAt: new Date(now + 600_000).toISOString(), maxExpiresAt: new Date(now + 120_000).toISOString(), sandboxId: 'sandbox', endedAt: null, error: null, cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified' };

function focusable(overrides: Record<string, unknown> = {}): HTMLElement {
  return { isConnected: true, matches: () => false, closest: () => null, ownerDocument: { defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) } }, getClientRects: () => [{ width: 1 }], focus: vi.fn(), scrollIntoView: vi.fn(), ...overrides } as unknown as HTMLElement;
}
function buttons(node: ReactNode): (() => void)[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return [];
  return node.type === 'button' ? [node.props.onClick!] : buttons(node.props.children);
}
describe('owned active workspace navigation', () => {
  it('uses the earlier deadline, clamps expiry and does not invent a deadline for invalid data', () => {
    expect(sessionDeadline(session)).toBe(now + 120_000);
    expect(remainingSessionSeconds(session, now)).toBe(120);
    expect(remainingSessionSeconds(session, now + 120_001)).toBe(0);
    expect(sessionDeadline({ ...session, expiresAt: 'invalid' })).toBeNull();
    expect(remainingSessionSeconds({ ...session, maxExpiresAt: 'invalid' }, now)).toBeNull();
  });
  it('exposes exact owned lifecycle states including running past deadline, without including another owner or ended sessions', () => {
    const pending = { ...session, id: 'pending', state: 'cleanup_pending' as const };
    const provisioning = { ...session, id: 'preparing', state: 'provisioning' as const };
    const foreign = { ...session, id: 'foreign', userId: 'other' };
    const ended = { ...session, id: 'ended', state: 'ended' as const };
    expect(activeOwnedSessions([session, foreign, ended, pending, provisioning], 'owner')).toEqual([session, pending, provisioning]);
    expect(activeOwnedSessions([session], undefined)).toEqual([]);
    expect(activeOwnedSessions([{ ...session, expiresAt: new Date(now - 1).toISOString() }], 'owner')[0].state).toBe('running');
  });
  it('marks unavailable, old and future snapshots unconfirmed', () => {
    expect(workspaceSnapshotFresh(null, now)).toBe(false);
    expect(workspaceSnapshotFresh(now - 15_001, now)).toBe(false);
    expect(workspaceSnapshotFresh(now + 1, now)).toBe(false);
    expect(workspaceSnapshotFresh(now - 15_000, now)).toBe(true);
  });
  it('consolidates the selected identity with its bounded deadline and reachable actions', () => {
    const onStop = vi.fn();
    const tree = SelectedWorkspaceContext({ session, now, confirmedAt: now, detailTab: 'terminal', actions: createElement('button', { onClick: onStop }, 'Stop machine') });
    const html = renderToStaticMarkup(tree);
    expect(html.match(/API work/g)).toHaveLength(1);
    expect(html.match(/owner\/api/g)).toHaveLength(1);
    expect(html.match(/ephemeral\/api/g)).toHaveLength(1);
    expect(html).toContain('id="machine-detail-heading" tabindex="-1"');
    expect(html).toContain('00:02:00 remaining');
    expect(html.toLowerCase()).toContain('datetime="2026-10-14t12:02:00.000z"');
    expect(html).toContain('href="#tab-terminal"');
    buttons(tree)[0](); expect(onStop).toHaveBeenCalledOnce();
    expect(html).not.toContain('Status check unavailable');
  });
  it('keeps selected stale and lifetime uncertainty visible without inventing an ended countdown', () => {
    const expired = renderToStaticMarkup(createElement(SelectedWorkspaceContext, { session, now: now + 120_001, confirmedAt: null, detailTab: 'access' }));
    expect(expired).toContain('Lifetime expired; awaiting server confirmation');
    expect(expired).toContain('last known state and deadline');
    const invalid = renderToStaticMarkup(createElement(SelectedWorkspaceContext, { session: { ...session, expiresAt: 'invalid' }, now, confirmedAt: now, detailTab: 'terminal' }));
    expect(invalid).toContain('Deadline unavailable'); expect(invalid).not.toContain('<time');
    const ended = renderToStaticMarkup(createElement(SelectedWorkspaceContext, { session: { ...session, state: 'ended' }, now, confirmedAt: now, detailTab: 'notes' }));
    expect(ended).toContain('Session ended'); expect(ended).not.toContain('00:00:00'); expect(ended).not.toContain('Deadline:');
    const failed = renderToStaticMarkup(createElement(SelectedWorkspaceContext, { session: { ...session, state: 'failed' }, now, confirmedAt: now, detailTab: 'access' }));
    expect(failed).toContain('Session failed'); expect(failed).not.toContain('Session ended');
  });
  it('keeps the active identity and exact return target while another selected session is ended', () => {
    const onOpen = vi.fn();
    const tree = ActiveWorkspaceContext({ sessions: [session], selectedId: 'ended', inMachines: true, now, confirmedAt: null, openingId: null, onOpen });
    const html = renderToStaticMarkup(tree);
    buttons(tree)[0](); expect(onOpen).toHaveBeenCalledExactlyOnceWith(session.id);
    expect(html).toContain('API work'); expect(html).toContain('running');
    expect(html).toContain('00:02:00 remaining'); expect(html).toContain('Return to active work');
    expect(html).toContain('last known state and deadline'); expect(html).not.toContain('aria-live="polite"');
    const selected = renderToStaticMarkup(createElement(SelectedWorkspaceContext, { session: { ...session, state: 'ended' }, now, confirmedAt: now, detailTab: 'notes' }));
    expect(selected).toContain('Session ended'); expect(selected).toContain('href="#tab-notes"'); expect(selected).not.toContain('remaining');
  });
});

describe('safe workspace focus', () => {
  it('aligns explicit detail jumps at the top to leave room for panel content', () => {
    const tab = focusable();
    expect(focusWorkspaceTarget('tab-published', { getElementById: () => tab })).toBe(true);
    expect(tab.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(tab.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'start', inline: 'nearest', behavior: 'instant' });
  });
  it('keeps an open dialog in control of focus even for a visible destination', () => {
    const tab = focusable();
    expect(focusWorkspaceTarget('tab-published', { getElementById: () => tab, querySelector: () => ({}) as Element })).toBe(false);
    expect(tab.focus).not.toHaveBeenCalled();
    expect(tab.scrollIntoView).not.toHaveBeenCalled();
  });
  it('restores to the actual opener and falls back to a safe heading when it is unavailable', () => {
    const opener = focusable(); const heading = focusable();
    const root = { getElementById: vi.fn(() => heading) };
    restoreWorkspaceFocus(opener, root);
    expect(opener.focus).toHaveBeenCalledWith({ preventScroll: true }); expect(root.getElementById).not.toHaveBeenCalled();
    restoreWorkspaceFocus(focusable({ isConnected: false }), root);
    expect(root.getElementById).toHaveBeenCalledWith('machine-detail-heading'); expect(heading.focus).toHaveBeenCalledOnce();
  });
  it('never focuses a hidden, disabled, inert, closed dialog or collapsed disclosure child', () => {
    const hidden = focusable({ closest: (selector: string) => selector.includes('[hidden]') ? {} : null });
    const collapsed = focusable({ closest: (selector: string) => selector === 'details:not([open])' ? { querySelector: () => ({ contains: () => false }) } : null });
    for (const element of [hidden, collapsed, focusable({ matches: () => true }), focusable({ getClientRects: () => [] })]) {
      expect(canRestoreFocus(element)).toBe(false);
      expect(focusWorkspaceTarget('hidden-target', { getElementById: () => element })).toBe(false);
      expect(element.focus).not.toHaveBeenCalled();
    }
  });
  it('falls back to main when machine details are hidden and leaves a newer dialog in control', () => {
    const hiddenHeading = focusable({ getClientRects: () => [] }); const main = focusable(); const opener = focusable();
    const root = { getElementById: (id: string) => id === 'machine-detail-heading' ? hiddenHeading : main };
    restoreWorkspaceFocus(null, root); expect(main.focus).toHaveBeenCalledOnce(); expect(hiddenHeading.focus).not.toHaveBeenCalled();
    restoreWorkspaceFocus(opener, { ...root, querySelector: () => ({}) as Element }); expect(opener.focus).not.toHaveBeenCalled();
  });
  it('restores after closing only when no newer input or focus has occurred', () => {
    for (const interruption of [null, 'pointerdown', 'keydown', 'focusin', 'changed-active-element'] as const) {
      const opener = focusable();
      const listeners = new Map<string, () => void>();
      const root = { activeElement: null, getElementById: () => null, querySelector: () => null, addEventListener: (name: string, callback: () => void) => listeners.set(name, callback), removeEventListener: (name: string) => listeners.delete(name) } as unknown as Document;
      let queued!: FrameRequestCallback;
      deferWorkspaceFocusRestore(opener, root, callback => { queued = callback; return 1; });
      if (interruption === 'changed-active-element') Object.assign(root, { activeElement: focusable() });
      else if (interruption) listeners.get(interruption)!();
      queued(0);
      expect(opener.focus).toHaveBeenCalledTimes(interruption ? 0 : 1);
      expect(listeners.size).toBe(0);
    }
  });
  it('invalidates async or queued navigation for newer user actions, without creating intents from background updates', async () => {
    const intent = new WorkspaceNavigationIntent();
    const initial = intent.capture();
    const firstAction = intent.capture();
    const completion = Promise.resolve().then(() => intent.current(firstAction));
    intent.invalidate(); // A later input/navigation takes precedence over completion.
    expect(await completion).toBe(false);
    expect(intent.current(initial)).toBe(false);
    const latest = intent.capture();
    await Promise.resolve(); // Polling does not create a user focus request or invalidate it.
    expect(intent.current(latest)).toBe(true);
  });
});
