import { describe, expect, it } from 'vitest';
import { machineTabKey, machineTabs, navigateSessionRoute, readSessionRoute, resolveSessionRoute, sessionRouteUrl } from './session-route';

const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
describe('Changes navigation', () => {
  it('bookmarks and restores Changes while keeping unrelated route parameters', () => {
    const before = new URL(`https://example.test/?session=${sessionId}&tab=terminal&flag=keep#notes`);
    const next = sessionRouteUrl(before, navigateSessionRoute(readSessionRoute(before), { tab: 'changes' }));
    expect(next.searchParams.get('flag')).toBe('keep'); expect(next.hash).toBe('#notes');
    const restored = readSessionRoute(next); expect(restored.tab).toBe('changes'); expect(resolveSessionRoute(restored, [{ id: sessionId }]).selectedId).toBe(sessionId);
    expect(readSessionRoute(before).tab).toBe('terminal');
  });
  it('keeps Changes beside Terminal and Setup and reachable by keyboard', () => {
    expect(machineTabs.slice(0, 5)).toEqual(['terminal', 'files', 'changes', 'published', 'setup']);
    expect(machineTabKey('ArrowRight', 'terminal')).toBe('files'); expect(machineTabKey('ArrowLeft', 'setup')).toBe('published');
    expect(machineTabKey('Home', 'changes')).toBe('terminal'); expect(machineTabKey('End', 'changes')).toBe('settings');
    expect(machineTabKey('ArrowLeft', 'terminal')).toBe('settings'); expect(machineTabKey('ArrowRight', 'settings')).toBe('terminal'); expect(machineTabKey('Enter', 'changes')).toBeNull();
  });
  it('rejects duplicated tab parameters and unavailable bookmarked machines', () => {
    expect(readSessionRoute(new URL('https://example.test/?tab=changes&tab=terminal')).tab).toBe('terminal');
    expect(resolveSessionRoute(readSessionRoute(new URL(`https://example.test/?session=${sessionId}&tab=changes`)), []).selectedId).toBeNull();
  });
});

describe('private application preview navigation', () => {
  it('bookmarks Preview and restores its exact owned machine without losing unrelated flags', () => {
    const url = new URL(`https://workspace.test/?session=${sessionId}&tab=terminal&flag=keep#notes`);
    const next = sessionRouteUrl(url, navigateSessionRoute(readSessionRoute(url), { tab: 'preview' }));
    expect(readSessionRoute(next).tab).toBe('preview');
    expect(resolveSessionRoute(readSessionRoute(next), [{ id: sessionId }]).selectedId).toBe(sessionId);
    expect(next.searchParams.get('flag')).toBe('keep'); expect(next.hash).toBe('#notes');
    expect(resolveSessionRoute(readSessionRoute(next), []).selectedId).toBeNull();
    expect(readSessionRoute(url).tab).toBe('terminal');
  });
  it('reaches Preview with keyboard and keeps the existing Terminal/Changes/Setup order', () => {
    expect(machineTabKey('ArrowRight', 'setup')).toBe('preview');
    expect(machineTabKey('ArrowLeft', 'access')).toBe('preview');
    expect(machineTabKey('ArrowLeft', 'preview')).toBe('setup');
    expect(machineTabKey('ArrowRight', 'preview')).toBe('access');
    expect(machineTabKey('Home', 'preview')).toBe('terminal');
    expect(readSessionRoute(new URL(`https://workspace.test/?session=${sessionId}&tab=preview&tab=terminal`)).tab).toBe('terminal');
  });
});


describe('next-session Notes navigation', () => {
  it('bookmarks Notes in every lifecycle state and restores its owned machine', () => {
    const url = new URL(`https://workspace.test/?session=${sessionId}&tab=terminal&flag=keep#notes`);
    const next = sessionRouteUrl(url, navigateSessionRoute(readSessionRoute(url), { tab: 'notes' }));
    expect(readSessionRoute(next).tab).toBe('notes');
    expect(resolveSessionRoute(readSessionRoute(next), [{ id: sessionId }]).selectedId).toBe(sessionId);
    expect(next.searchParams.get('flag')).toBe('keep'); expect(next.hash).toBe('#notes');
    expect(machineTabKey('ArrowRight', 'activity')).toBe('notes'); expect(machineTabKey('ArrowLeft', 'settings')).toBe('notes');
    expect(readSessionRoute(new URL(`https://workspace.test/?session=${sessionId}&tab=notes&tab=notes`)).tab).toBe('terminal');
  });
});

describe('Published navigation', () => {
  it('bookmarks the exact machine, preserves unrelated flags, and restores Published', () => {
    const before = new URL(`https://workspace.test/?session=${sessionId}&tab=changes&flag=keep#notes`);
    const next = sessionRouteUrl(before, navigateSessionRoute(readSessionRoute(before), { tab: 'published' }));
    expect(next.searchParams.get('flag')).toBe('keep'); expect(next.hash).toBe('#notes');
    expect(readSessionRoute(next).tab).toBe('published');
    expect(resolveSessionRoute(readSessionRoute(next), [{ id: sessionId }]).selectedId).toBe(sessionId);
    expect(machineTabKey('ArrowRight', 'changes')).toBe('published');
    expect(machineTabKey('ArrowLeft', 'published')).toBe('changes');
    expect(machineTabKey('ArrowRight', 'published')).toBe('setup');
    expect(readSessionRoute(new URL('https://workspace.test/?tab=published&tab=published')).tab).toBe('terminal');
  });
});


describe('Files navigation', () => {
  it('bookmarks the same machine and retains flags when returning from other views', () => {
    const before = new URL(`https://workspace.test/?session=${sessionId}&tab=terminal&view=repositories&flag=keep#work`);
    const next = sessionRouteUrl(before, navigateSessionRoute(readSessionRoute(before), { tab: 'files', view: 'machines' }));
    expect(readSessionRoute(next)).toMatchObject({ sessionId, tab: 'files', view: 'machines' });
    expect(next.searchParams.get('flag')).toBe('keep'); expect(next.hash).toBe('#work');
    expect(machineTabKey('ArrowRight', 'terminal')).toBe('files');
    expect(machineTabKey('ArrowLeft', 'changes')).toBe('files');
    expect(machineTabKey('ArrowLeft', 'files')).toBe('terminal');
    expect(machineTabKey('ArrowRight', 'files')).toBe('changes');
    expect(readSessionRoute(new URL(`https://workspace.test/?session=${sessionId}&tab=files&tab=files`)).tab).toBe('terminal');
  });
});
