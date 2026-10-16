import type { SearchAddon } from '@xterm/addon-search';
import type { ITheme, Terminal } from '@xterm/xterm';
import type { ResolvedAppearance } from './appearance';

const light: ITheme = {
  background: '#ffffff', foreground: '#252525', cursor: '#252525', cursorAccent: '#ffffff', selectionBackground: '#dcdcd7', selectionInactiveBackground: '#e9e9e4',
  black: '#252525', red: '#a02f36', green: '#3e5b41', yellow: '#765a16', blue: '#315eac', magenta: '#83478f', cyan: '#23676d', white: '#686868',
  brightBlack: '#6d6d65', brightRed: '#b52f3a', brightGreen: '#3e5b41', brightYellow: '#806218', brightBlue: '#315eac', brightMagenta: '#83478f', brightCyan: '#23676d', brightWhite: '#252525',
};
const dark: ITheme = {
  background: '#1b1e21', foreground: '#e8e6e1', cursor: '#d2dfc4', cursorAccent: '#1b1e21', selectionBackground: '#42513b', selectionInactiveBackground: '#343c3f',
  black: '#a5abb1', red: '#ec9c95', green: '#adca9b', yellow: '#e6c181', blue: '#a0bcec', magenta: '#c9a7dc', cyan: '#90c9ca', white: '#e8e6e1',
  brightBlack: '#a5abb1', brightRed: '#ffb1a9', brightGreen: '#c1dfae', brightYellow: '#f1d49f', brightBlue: '#b3cefa', brightMagenta: '#dfbdec', brightCyan: '#a9dedb', brightWhite: '#f4f2ed',
};
const highlights = {
  light: { decorations: { matchBackground: '#eee6be', matchBorder: '#b2a663', matchOverviewRuler: '#b2a663', activeMatchBackground: '#d4dcbf', activeMatchBorder: '#536843', activeMatchColorOverviewRuler: '#536843' } },
  dark: { decorations: { matchBackground: '#5b4b27', matchBorder: '#ad9154', matchOverviewRuler: '#ad9154', activeMatchBackground: '#4d633b', activeMatchBorder: '#c1dfae', activeMatchColorOverviewRuler: '#c1dfae' } },
};
export function terminalTheme(appearance: ResolvedAppearance): ITheme { return { ...(appearance === 'dark' ? dark : light) }; }
export function terminalSearchOptions(appearance: ResolvedAppearance) { return highlights[appearance]; }
// Updating options redraws existing cells; it does not replace the terminal, buffer or attachment.
export function applyTerminalTheme(terminal: Pick<Terminal, 'options'>, appearance: ResolvedAppearance) {
  terminal.options.theme = terminalTheme(appearance);
}

export function refreshTerminalSearch(terminal: Pick<Terminal, 'buffer' | 'scrollToLine'>, search: Pick<SearchAddon, 'clearDecorations' | 'findNext'>, query: string, appearance: ResolvedAppearance) {
  const scrollLine = terminal.buffer.active.viewportY;
  // The add-on caches the query but ignores decoration-color changes. Clearing that
  // cache redraws every match and starts at the existing selection, not the next match.
  search.clearDecorations();
  search.findNext(query, { ...terminalSearchOptions(appearance), incremental: true });
  terminal.scrollToLine(scrollLine);
}
