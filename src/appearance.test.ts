import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AppearanceControl } from './AppearanceControl';
import type { AppearanceSnapshot } from './appearance';
import { applyTerminalTheme, refreshTerminalSearch, terminalSearchOptions, terminalTheme } from './terminal-theme';

const bootstrap = readFileSync(new URL('../public/appearance.js', import.meta.url), 'utf8');
function browser({ stored = null, dark = false, denied = false, mediaDenied = false }:
  { stored?: string | null; dark?: boolean; denied?: boolean; mediaDenied?: boolean } = {}) {
  const storage = new Map(stored === null ? [] : [['ephemeral.appearance', stored]]);
  const mediaListeners = new Set<() => void>();
  const storageListeners = new Set<(event: object) => void>();
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  const meta = { setAttribute: vi.fn() };
  const localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) };
  const media = { matches: dark, addEventListener: (_: string, listener: () => void) => mediaListeners.add(listener), removeEventListener: (_: string, listener: () => void) => mediaListeners.delete(listener) };
  const window = {
    get localStorage() { if (denied) throw new Error('denied'); return localStorage; },
    matchMedia: () => { if (mediaDenied) throw new Error('unavailable'); return media; },
    addEventListener: (_: string, listener: (event: object) => void) => storageListeners.add(listener),
    removeEventListener: (_: string, listener: (event: object) => void) => storageListeners.delete(listener),
    ephemeralAppearance: undefined as unknown as Window['ephemeralAppearance'],
  };
  runInNewContext(bootstrap, { window, document: { documentElement: root, querySelector: () => meta } });
  return {
    controller: window.ephemeralAppearance, root, meta, storage, mediaListeners, storageListeners,
    system(value: boolean) { media.matches = value; mediaListeners.forEach(listener => listener()); },
    event(key: string | null, newValue: string | null, storageArea: object = localStorage) { storageListeners.forEach(listener => listener({ key, newValue, storageArea })); },
  };
}

describe('appearance before paint and across tabs', () => {
  it('defaults to the system before mounting React and sets browser/native-control colors', () => {
    for (const dark of [false, true]) {
      const { controller, root, meta } = browser({ dark });
      expect(controller.getSnapshot()).toEqual({ preference: 'system', resolved: dark ? 'dark' : 'light' });
      expect(root.dataset.theme).toBe(dark ? 'dark' : 'light');
      expect(root.style.colorScheme).toBe(root.dataset.theme);
      expect(meta.setAttribute).toHaveBeenLastCalledWith('content', dark ? '#151719' : '#f8f8f8');
    }
    expect(browser({ mediaDenied: true }).controller.getSnapshot().resolved).toBe('light');
  });
  it('honors stored overrides and treats invalid values as System', () => {
    for (const stored of ['light', 'dark', 'system', 'invalid', '<script>']) {
      const { controller } = browser({ stored, dark: true });
      expect(controller.getSnapshot()).toEqual({ preference: stored === 'light' || stored === 'dark' ? stored : 'system', resolved: stored === 'light' ? 'light' : 'dark' });
    }
  });
  it('persists changes and provides stable immutable snapshots until something changes', () => {
    const b = browser(); const first = b.controller.getSnapshot(); const listener = vi.fn();
    const dispose = b.controller.subscribe(listener);
    b.controller.setPreference('dark');
    expect(b.storage.get('ephemeral.appearance')).toBe('dark');
    expect(b.controller.getSnapshot()).toEqual({ preference: 'dark', resolved: 'dark' });
    expect(b.controller.getSnapshot()).not.toBe(first);
    expect(Object.isFrozen(b.controller.getSnapshot())).toBe(true);
    const current = b.controller.getSnapshot(); b.controller.setPreference('dark');
    expect(b.controller.getSnapshot()).toBe(current); expect(listener).toHaveBeenCalledOnce();
    dispose();
  });
  it('responds to system changes only in System and removes every listener after the last subscriber', () => {
    const b = browser(); const first = vi.fn(), second = vi.fn();
    const offFirst = b.controller.subscribe(first), offSecond = b.controller.subscribe(second);
    expect(b.mediaListeners.size).toBe(1); expect(b.storageListeners.size).toBe(1);
    b.system(true); expect(b.controller.getSnapshot().resolved).toBe('dark');
    b.controller.setPreference('light'); b.system(false); b.system(true);
    expect(b.controller.getSnapshot().resolved).toBe('light');
    b.controller.setPreference('system'); expect(b.controller.getSnapshot().resolved).toBe('dark');
    offFirst(); expect(b.mediaListeners.size).toBe(1);
    offSecond(); expect(b.mediaListeners.size).toBe(0); expect(b.storageListeners.size).toBe(0);
    b.system(false); const off = b.controller.subscribe(first);
    expect(b.controller.getSnapshot().resolved).toBe('light'); off();
  });
  it('synchronizes remote choices, removal and clear without writing back or accepting unrelated storage', () => {
    const b = browser({ stored: 'light', dark: true }); const off = b.controller.subscribe(() => {});
    b.event('unrelated', 'dark'); expect(b.controller.getSnapshot().preference).toBe('light');
    b.event('ephemeral.appearance', 'dark', {}); expect(b.controller.getSnapshot().preference).toBe('light');
    b.event('ephemeral.appearance', 'dark'); expect(b.controller.getSnapshot()).toEqual({ preference: 'dark', resolved: 'dark' });
    expect(b.storage.get('ephemeral.appearance')).toBe('light'); // No echo writes from events.
    b.event('ephemeral.appearance', null); expect(b.controller.getSnapshot().preference).toBe('system');
    b.event('ephemeral.appearance', 'invalid'); expect(b.controller.getSnapshot().preference).toBe('system');
    b.event('ephemeral.appearance', 'light'); b.event(null, null);
    expect(b.controller.getSnapshot()).toEqual({ preference: 'system', resolved: 'dark' }); off();
  });
  it('keeps overrides usable when localStorage cannot be read or written', () => {
    const b = browser({ denied: true, dark: true }); const off = b.controller.subscribe(() => {});
    expect(b.controller.getSnapshot().preference).toBe('system');
    b.controller.setPreference('light'); b.system(true);
    expect(b.controller.getSnapshot()).toEqual({ preference: 'light', resolved: 'light' }); off();
  });
  it('renders a labeled native selector with the three supported choices before sign-in', () => {
    const html = renderToStaticMarkup(createElement(AppearanceControl));
    expect(html).toContain('<label'); expect(html).toContain('Appearance');
    for (const choice of ['System', 'Light', 'Dark']) expect(html).toContain(`>${choice}</option>`);
  });
});

describe('terminal palette changes', () => {
  it('updates only theme options, preserving instance, buffer, viewport, font and input options', () => {
    const terminal = { options: { fontSize: 16, disableStdin: false, theme: terminalTheme('light') }, buffer: { active: { viewportY: 25 } }, dispose: vi.fn(), reset: vi.fn(), focus: vi.fn(), clear: vi.fn() };
    const options = terminal.options, buffer = terminal.buffer;
    applyTerminalTheme(terminal, 'dark');
    expect(terminal.options).toBe(options); expect(terminal.buffer).toBe(buffer);
    expect(terminal.options.fontSize).toBe(16); expect(terminal.options.disableStdin).toBe(false);
    expect(terminal.buffer.active.viewportY).toBe(25);
    for (const operation of [terminal.dispose, terminal.reset, terminal.focus, terminal.clear]) expect(operation).not.toHaveBeenCalled();
    expect(terminal.options.theme).toEqual(terminalTheme('dark'));
    expect(terminalTheme('dark')).not.toBe(terminalTheme('dark')); // xterm cannot mutate a shared palette.
  });
  it('refreshes search decorations without advancing the selected match or leaving its scroll position', () => {
    const events: string[] = [];
    const terminal = { buffer: { active: { viewportY: 42 } }, scrollToLine: vi.fn(line => events.push(`scroll:${line}`)) };
    const search = { clearDecorations: vi.fn(() => events.push('clear-cache')), findNext: vi.fn(() => { events.push('redraw'); return true; }) };
    refreshTerminalSearch(terminal as unknown as Parameters<typeof refreshTerminalSearch>[0], search, 'needle', 'dark');
    expect(events).toEqual(['clear-cache', 'redraw', 'scroll:42']);
    expect(search.findNext).toHaveBeenCalledWith('needle', { ...terminalSearchOptions('dark'), incremental: true });
  });
  it('defines all ANSI colors and distinct search highlights for both themes', () => {
    for (const appearance of ['light', 'dark'] as const) {
      const palette = terminalTheme(appearance);
      for (const color of ['black','red','green','yellow','blue','magenta','cyan','white','brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite'] as const) expect(palette[color]).toMatch(/^#[0-9a-f]{6}$/);
      expect(palette.cursor).not.toBe(palette.background);
      expect(terminalSearchOptions(appearance).decorations.activeMatchBackground).not.toBe(palette.background);
    }
  });
});

function luminance(hex: string) {
  const channels = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
}
function contrast(a: string, b: string) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
it('keeps shared text, feedback, action and terminal palettes at AA contrast in both modes', () => {
  const css = readFileSync(new URL('./appearance.css', import.meta.url), 'utf8');
  const blocks = [css.match(/:root\s*\{([^}]+)\}/)![1], css.match(/:root\[data-theme="dark"\]\s*\{([^}]+)\}/)![1]];
  blocks.forEach((block, i) => {
    const tokens = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/g)].map(match => [match[1], match[2]]));
    for (const text of ['text', 'text-strong', 'text-secondary', 'text-muted', 'text-faint']) for (const surface of ['canvas','surface','surface-subtle','surface-muted','surface-hover','surface-selected']) expect(contrast(tokens[text], tokens[surface]), `${i}: ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    for (const state of ['success','warning','danger','accent']) expect(contrast(tokens[`${state}-text`], tokens[`${state}-surface`]), `${state} feedback`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens['primary-text'], tokens['primary-bg'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.focus, tokens.surface)).toBeGreaterThanOrEqual(3);
    const palette = terminalTheme(i ? 'dark' : 'light');
    for (const color of ['foreground','black','red','green','yellow','blue','magenta','cyan','white','brightBlack'] as const) expect(contrast(palette[color]!, palette.background!), `${i}: ANSI ${color}`).toBeGreaterThanOrEqual(4.5);
  });
});
