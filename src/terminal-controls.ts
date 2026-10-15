export const DEFAULT_TERMINAL_FONT_SIZE = 12;
export const MIN_TERMINAL_FONT_SIZE = 10;
export const MAX_TERMINAL_FONT_SIZE = 24;
export const TERMINAL_FONT_STORAGE_KEY = 'ephemeral.terminal.font-size';
export const SEARCH_HIGHLIGHT_LIMIT = 1000;

export function terminalFontSize(value: unknown): number {
  const size = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(size) ? Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(size))) : DEFAULT_TERMINAL_FONT_SIZE;
}

export function readTerminalFontSize(storage: Pick<Storage, 'getItem'>): number {
  try { return terminalFontSize(storage.getItem(TERMINAL_FONT_STORAGE_KEY)); }
  catch { return DEFAULT_TERMINAL_FONT_SIZE; }
}

export function saveTerminalFontSize(storage: Pick<Storage, 'setItem'>, size: number): void {
  try { storage.setItem(TERMINAL_FONT_STORAGE_KEY, String(terminalFontSize(size))); }
  catch { /* A blocked preference store does not prevent terminal use. */ }
}

export function searchResultLabel(query: string, result: { resultIndex: number; resultCount: number }): string {
  if (!query) return 'Enter text to search';
  if (!result.resultCount) return 'No matches';
  if (result.resultCount >= SEARCH_HIGHLIGHT_LIMIT) return `${SEARCH_HIGHLIGHT_LIMIT}+ matches`;
  return result.resultIndex < 0 ? `${result.resultCount} matches` : `${result.resultIndex + 1} of ${result.resultCount} matches`;
}

export function isTerminalFindShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f';
}

type Dimensions = { cols: number; rows: number };

// Hiding a view changes input and geometry policy, never the attachment lifecycle.
export class TerminalViewport {
  private connected = false;

  constructor(
    private visible: boolean,
    private readonly setInputDisabled: (disabled: boolean) => void,
    private readonly sendInput: (data: string) => void,
    private readonly measure: () => Dimensions | undefined,
    private readonly applySize: (cols: number, rows: number) => void,
  ) {}

  setVisible(visible: boolean) {
    this.visible = visible;
    this.setInputDisabled(!visible || !this.connected);
  }

  setConnected(connected: boolean) {
    this.connected = connected;
    this.setInputDisabled(!this.visible || !connected);
  }

  input(data: string) {
    if (this.visible && this.connected) this.sendInput(data);
  }

  resize() {
    if (!this.visible) return;
    const dimensions = this.measure();
    if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows)) return;
    this.applySize(Math.min(400, Math.max(10, Math.floor(dimensions.cols))), Math.min(200, Math.max(2, Math.floor(dimensions.rows))));
  }
}
