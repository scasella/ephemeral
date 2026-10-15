import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE, MIN_TERMINAL_FONT_SIZE, TERMINAL_FONT_STORAGE_KEY, TerminalViewport, isTerminalFindShortcut, readTerminalFontSize, saveTerminalFontSize, searchResultLabel, terminalFontSize } from './terminal-controls';

describe('terminal view continuity', () => {
  it('discards hidden input and geometry changes, then fits the same live view when shown', () => {
    const disabled = vi.fn();
    const input = vi.fn();
    let dimensions = { cols: 100, rows: 30 };
    const measure = vi.fn(() => dimensions);
    const resize = vi.fn();
    const viewport = new TerminalViewport(true, disabled, input, measure, resize);
    viewport.setConnected(true);
    viewport.input('visible command');
    viewport.resize();
    expect(input).toHaveBeenCalledExactlyOnceWith('visible command');
    expect(resize).toHaveBeenCalledExactlyOnceWith(100, 30);
    viewport.setVisible(false);
    dimensions = { cols: 10, rows: 2 };
    viewport.input('hidden command');
    viewport.resize();
    expect(disabled).toHaveBeenLastCalledWith(true);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledTimes(1);
    // A ready event arriving while hidden must not enable typing.
    viewport.setConnected(true);
    expect(disabled).toHaveBeenLastCalledWith(true);
    dimensions = { cols: 120, rows: 40 };
    viewport.setVisible(true);
    viewport.resize();
    viewport.input('new command');
    expect(disabled).toHaveBeenLastCalledWith(false);
    expect(resize).toHaveBeenLastCalledWith(120, 40);
    expect(input.mock.calls).toEqual([['visible command'], ['new command']]);
  });

  it('does not restore input readiness merely because a disconnected view becomes visible', () => {
    const disabled = vi.fn(); const input = vi.fn();
    const viewport = new TerminalViewport(false, disabled, input, () => undefined, vi.fn());
    viewport.setConnected(true);
    viewport.setConnected(false);
    viewport.setVisible(true);
    viewport.input('discarded command');
    expect(disabled).toHaveBeenLastCalledWith(true);
    expect(input).not.toHaveBeenCalled();
    viewport.setConnected(true);
    viewport.input('fresh command');
    expect(input).toHaveBeenCalledExactlyOnceWith('fresh command');
  });

  it('skips unmeasurable views and bounds provider dimensions', () => {
    const resize = vi.fn();
    const measure = vi.fn<() => { cols: number; rows: number } | undefined>();
    const viewport = new TerminalViewport(true, vi.fn(), vi.fn(), measure, resize);
    measure.mockReturnValue(undefined); viewport.resize();
    measure.mockReturnValue({ cols: NaN, rows: 30 }); viewport.resize();
    expect(resize).not.toHaveBeenCalled();
    measure.mockReturnValue({ cols: 1500, rows: 500 }); viewport.resize();
    expect(resize).toHaveBeenLastCalledWith(400, 200);
    measure.mockReturnValue({ cols: 1, rows: 0 }); viewport.resize();
    expect(resize).toHaveBeenLastCalledWith(10, 2);
  });
});

describe('terminal local controls', () => {
  it('restores only a bounded font preference and tolerates blocked storage', () => {
    expect(readTerminalFontSize({ getItem: () => '18' })).toBe(18);
    expect(readTerminalFontSize({ getItem: () => '999' })).toBe(MAX_TERMINAL_FONT_SIZE);
    expect(readTerminalFontSize({ getItem: () => '2' })).toBe(MIN_TERMINAL_FONT_SIZE);
    for (const stored of [null, '', 'hello', 'Infinity']) expect(readTerminalFontSize({ getItem: () => stored })).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(readTerminalFontSize({ getItem: () => { throw new Error('blocked'); } })).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    const setItem = vi.fn();
    saveTerminalFontSize({ setItem }, 18);
    expect(setItem).toHaveBeenCalledExactlyOnceWith(TERMINAL_FONT_STORAGE_KEY, '18');
    expect(() => saveTerminalFontSize({ setItem: () => { throw new Error('blocked'); } }, 18)).not.toThrow();
    expect(terminalFontSize(12.8)).toBe(13);
  });

  it('recognizes only the intended Find shortcut so shell control keys remain available', () => {
    const key = { key: 'f', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
    expect(isTerminalFindShortcut({ ...key, ctrlKey: true })).toBe(true);
    expect(isTerminalFindShortcut({ ...key, key: 'F', metaKey: true })).toBe(true);
    expect(isTerminalFindShortcut(key)).toBe(false);
    expect(isTerminalFindShortcut({ ...key, key: 'c', ctrlKey: true })).toBe(false);
    expect(isTerminalFindShortcut({ ...key, ctrlKey: true, altKey: true })).toBe(false);
    expect(isTerminalFindShortcut({ ...key, metaKey: true, shiftKey: true })).toBe(false);
  });

  it('distinguishes absent text, no matches, navigation, and truncated highlight totals', () => {
    expect(searchResultLabel('', { resultIndex: -1, resultCount: 0 })).toBe('Enter text to search');
    expect(searchResultLabel('missing', { resultIndex: -1, resultCount: 0 })).toBe('No matches');
    expect(searchResultLabel('match', { resultIndex: 1, resultCount: 3 })).toBe('2 of 3 matches');
    expect(searchResultLabel('match', { resultIndex: -1, resultCount: 1000 })).toBe('1000+ matches');
  });
});
