import { useAppearance } from './appearance';
import { applyTerminalTheme, refreshTerminalSearch, terminalTheme, terminalSearchOptions } from './terminal-theme';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon, type ISearchResultChangeEvent } from '@xterm/addon-search';
import { TerminalAttachment, terminalSocketPath, type TerminalState } from './terminal-connection';
import { DEFAULT_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE, MIN_TERMINAL_FONT_SIZE, SEARCH_HIGHLIGHT_LIMIT, TerminalViewport, TerminalRecoveryFocus, isTerminalFindShortcut, readTerminalFontSize, saveTerminalFontSize, searchResultLabel, terminalFontSize } from './terminal-controls';
import '@xterm/xterm/css/xterm.css';
import './terminal.css';

export type TerminalProps = {
  sessionId: string;
  shellId?: string;
  label?: string;
  preview: boolean;
  visible?: boolean;
  repository?: string;
  branch?: string;
  expiresAt?: string;
  onStatusChange?: (status: string) => void;
  onRecoverShell?: () => Promise<boolean>;
  recoveringShell?: boolean;
  unavailableReason?: string;
};

const EMPTY_RESULTS: ISearchResultChangeEvent = { resultIndex: -1, resultCount: 0 };

export function TerminalConnectionControls({ status, recovering, primary, onReconnect, onRecover }: {
  status: TerminalState; recovering: boolean; primary: boolean; onReconnect: () => void; onRecover?: () => void;
}) {
  return <span className="terminal-connection"><span role="status" aria-live="polite">{recovering ? 'recovering' : status.phase}</span> · <button type="button" className="text-button" disabled={recovering} onClick={onReconnect} aria-label="Reconnect terminal" title="Reconnect to the same shell. The machine and its expiration stay the same.">Reconnect</button>{primary && onRecover && <button type="button" className="text-button" disabled={recovering || !['error', 'disconnected'].includes(status.phase)} onClick={onRecover} title="Recover a stopped primary shell on this machine. A living Codex shell is preserved.">{recovering ? 'Recovering shell…' : 'Recover shell'}</button>}</span>;
}

export default function Terminal({ sessionId, shellId = 'codex', label = 'Codex', preview, visible = true, repository, branch, expiresAt, onStatusChange, onRecoverShell, recoveringShell = false, unavailableReason }: TerminalProps) {
  const { resolved: appearance } = useAppearance();
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  const searchOptions = terminalSearchOptions(appearance);
  const shell = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const terminalRef = useRef<XTerminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const viewportRef = useRef<TerminalViewport | null>(null);
  const resizeRef = useRef<() => void>(() => {});
  const reconnect = useRef<() => void>(() => {});
  const unavailableRef = useRef(unavailableReason);
  unavailableRef.current = unavailableReason;
  const markUnavailable = useRef<(message: string) => void>(() => {});
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const recoveryFocus = useRef(new TerminalRecoveryFocus());
  const recoveryRequest = useRef(0);
  const recoveryInFlight = useRef(false);
  const notifyStatus = useRef(onStatusChange);
  notifyStatus.current = onStatusChange;
  const [status, setStatus] = useState<TerminalState>({ phase: 'connecting' });
  const [expanded, setExpanded] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(EMPTY_RESULTS);
  const [fontSize, setFontSize] = useState(() => {
    try { return readTerminalFontSize(localStorage); } catch { return DEFAULT_TERMINAL_FONT_SIZE; }
  });
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const titleId = useId();
  const searchId = useId();
  const scopeId = useId();
  const focused = expanded && visible;

  useEffect(() => {
    if (!host.current) return;
    setQuery(''); setResults(EMPTY_RESULTS); setFindOpen(false); setExpanded(false);
    let disposed = false;
    // Search result counts/highlights use xterm's proposed decoration API.
    const terminal = new XTerminal({ allowProposedApi: true, disableStdin: true, screenReaderMode: true, cursorBlink: true, fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace', fontSize: fontSizeRef.current, lineHeight: 1.55, scrollback: 5000, theme: terminalTheme(appearanceRef.current) });
    const fit = new FitAddon();
    const search = new SearchAddon({ highlightLimit: SEARCH_HIGHLIGHT_LIMIT });
    terminal.loadAddon(fit);
    terminal.loadAddon(search);
    terminal.open(host.current);
    terminalRef.current = terminal;
    searchRef.current = search;
    const viewport = new TerminalViewport(
      visibleRef.current,
      disabled => { terminal.options.disableStdin = disabled; },
      data => { attachment.input(data); },
      () => {
        const element = host.current;
        if (disposed || !element || !element.getClientRects().length || element.clientWidth <= 0 || element.clientHeight <= 0 || getComputedStyle(element).visibility === 'hidden') return;
        try { return fit.proposeDimensions(); } catch { return; }
      },
      (cols, rows) => {
        if (terminal.cols !== cols || terminal.rows !== rows) terminal.resize(cols, rows);
        attachment.resize(cols, rows);
      },
    );
    const resize = () => {
      viewport.setVisible(visibleRef.current);
      viewport.resize();
    };
    const attachment = new TerminalAttachment(
      () => new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${terminalSocketPath(sessionId, shellId)}`),
      next => {
        viewport.setVisible(visibleRef.current);
        viewport.setConnected(next.phase === 'connected');
        setStatus(next);
        notifyStatus.current?.(next.phase);
      },
      data => terminal.write(data),
      () => {
        resize();
        if (recoveryFocus.current.ready(document.activeElement, document.body, visibleRef.current, Boolean(document.querySelector('dialog[open]')))) terminal.focus();
      },
    );
    markUnavailable.current = message => attachment.unavailable(message);
    viewportRef.current = viewport;
    resizeRef.current = resize;
    reconnect.current = () => { if (visibleRef.current) attachment.connect(true); };
    const input = terminal.onData(data => {
      viewport.setVisible(visibleRef.current);
      viewport.input(data);
    });
    // Capture-handled UI shortcuts must never turn into PTY input.
    terminal.attachCustomKeyEventHandler(event => !event.defaultPrevented);
    const searchResults = search.onDidChangeResults(setResults);
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    window.addEventListener('resize', resize);
    resize();
    if (unavailableRef.current) attachment.unavailable(unavailableRef.current);
    else attachment.connect();
    return () => {
      disposed = true;
      ++recoveryRequest.current;
      recoveryInFlight.current = false;
      recoveryFocus.current.cancel();
      reconnect.current = () => {};
      markUnavailable.current = () => {};
      resizeRef.current = () => {};
      viewportRef.current = null;
      terminalRef.current = null;
      searchRef.current = null;
      attachment.dispose();
      observer.disconnect();
      window.removeEventListener('resize', resize);
      input.dispose();
      searchResults.dispose();
      terminal.dispose();
      notifyStatus.current?.('disconnected');
    };
  }, [sessionId, shellId]);

  useEffect(() => {
    const moved = (event: Event) => recoveryFocus.current.movedTo(event.target);
    const navigating = (event: KeyboardEvent) => { if (event.key === 'Tab') recoveryFocus.current.cancel(); };
    document.addEventListener('focusin', moved);
    document.addEventListener('pointerdown', moved, true);
    document.addEventListener('keydown', navigating, true);
    return () => {
      recoveryFocus.current.cancel();
      document.removeEventListener('focusin', moved);
      document.removeEventListener('pointerdown', moved, true);
      document.removeEventListener('keydown', navigating, true);
    };
  }, []);

  useEffect(() => {
    if (unavailableReason) markUnavailable.current(unavailableReason);
  }, [unavailableReason]);

  useLayoutEffect(() => {
    viewportRef.current?.setVisible(visible);
    if (!visible) {
      recoveryFocus.current.cancel();
      terminalRef.current?.blur();
      setExpanded(false);
      return;
    }
    const frame = requestAnimationFrame(() => resizeRef.current());
    return () => cancelAnimationFrame(frame);
  }, [visible, focused, findOpen]);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.fontSize = fontSize;
    try { saveTerminalFontSize(localStorage, fontSize); } catch { /* Storage can be unavailable. */ }
    const frame = requestAnimationFrame(() => resizeRef.current());
    return () => cancelAnimationFrame(frame);
  }, [fontSize]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    applyTerminalTheme(terminal, appearance);
    if (findOpen && query && searchRef.current) refreshTerminalSearch(terminal, searchRef.current, query, appearance);
  }, [appearance]);

  useEffect(() => {
    if (!findOpen) return;
    if (!query) {
      searchRef.current?.clearDecorations();
      setResults(EMPTY_RESULTS);
    } else {
      searchRef.current?.findNext(query, { ...searchOptions, incremental: true });
    }
  }, [query, findOpen]);

  useEffect(() => {
    if (findOpen && visible) findInput.current?.focus();
  }, [findOpen, visible]);

  useEffect(() => {
    if (!focused || !shell.current) return;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Make the surrounding app inaccessible while this same DOM node is expanded.
    const siblings: { element: HTMLElement; inert: boolean }[] = [];
    let current: HTMLElement = shell.current;
    while (current.parentElement && current.parentElement !== document.body) {
      for (const sibling of current.parentElement.children) {
        if (sibling !== current && sibling instanceof HTMLElement) {
          siblings.push({ element: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
      }
      current = current.parentElement;
    }
    expandButton.current?.focus();
    return () => {
      document.body.style.overflow = priorOverflow;
      for (const { element, inert } of siblings) element.inert = inert;
    };
  }, [focused]);

  const recoverShell = async () => {
    if (!onRecoverShell || recoveringShell || recoveryInFlight.current) return;
    recoveryInFlight.current = true;
    recoveryFocus.current.begin(document.activeElement);
    const request = ++recoveryRequest.current;
    try {
      const recovered = await onRecoverShell();
      if (request !== recoveryRequest.current) return;
      if (recovered) reconnect.current();
      else recoveryFocus.current.cancel();
    } finally {
      if (request === recoveryRequest.current) recoveryInFlight.current = false;
    }
  };
  const closeFind = () => {
    setFindOpen(false);
    searchRef.current?.clearDecorations();
    if (visible) terminalRef.current?.focus();
  };
  const exitFocus = () => {
    setExpanded(false);
    expandButton.current?.focus();
  };
  const handleKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let handled = false;
    if (isTerminalFindShortcut(event)) {
      setFindOpen(true);
      findInput.current?.focus();
      findInput.current?.select();
      handled = true;
    } else if (event.key === 'Escape' && !host.current?.contains(event.target as Node) && (findOpen || focused)) {
      if (findOpen) closeFind(); else exitFocus();
      handled = true;
    } else if (event.key === 'Enter' && event.target === findInput.current) {
      if (query) {
        if (event.shiftKey) searchRef.current?.findPrevious(query, searchOptions);
        else searchRef.current?.findNext(query, searchOptions);
      }
      handled = true;
    } else if (focused && event.key === 'Tab' && shell.current) {
      const controls = Array.from(shell.current.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, [tabindex="0"]')).filter(element => element.getClientRects().length);
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { last?.focus(); handled = true; }
      else if (!event.shiftKey && document.activeElement === last) { first?.focus(); handled = true; }
    }
    if (handled) { event.preventDefault(); event.stopPropagation(); }
  };
  const expiration = expiresAt && Number.isFinite(Date.parse(expiresAt)) ? new Date(expiresAt).toLocaleString() : undefined;

  return <div ref={shell} hidden={!visible} className={`terminal-shell terminal-enhanced${focused ? ' terminal-expanded' : ''}`} role={focused ? 'dialog' : undefined} aria-modal={focused || undefined} aria-labelledby={focused ? titleId : undefined} onKeyDownCapture={handleKey}>
    <div className="terminal-toolbar">
      <span id={titleId}><span className={`connection-dot ${status.phase === 'connected' ? 'on' : ''}`} />{label}{preview ? ' · Preview terminal' : ' · Persistent shell'}</span>
      <TerminalConnectionControls status={status} recovering={recoveringShell} primary={shellId === 'codex'} onReconnect={() => reconnect.current()} onRecover={onRecoverShell ? () => { void recoverShell(); } : undefined}/>
      <div className="terminal-view-controls">
        <button type="button" ref={expandButton} onClick={() => focused ? exitFocus() : setExpanded(true)} aria-expanded={focused} title={focused ? 'Exit focus mode (Escape while a toolbar control has focus)' : 'Expand terminal to focus mode'}>{focused ? 'Exit focus' : 'Focus mode'}</button>
        <button type="button" onClick={() => { setFindOpen(true); findInput.current?.focus(); }} aria-expanded={findOpen} aria-controls={searchId} title="Find in current terminal buffer (Ctrl/Cmd+F)">Find</button>
      </div>
      <div className="terminal-font-controls" role="group" aria-label="Terminal font size">
        <button type="button" onClick={() => setFontSize(size => terminalFontSize(size - 1))} disabled={fontSize <= MIN_TERMINAL_FONT_SIZE} aria-label="Decrease terminal font size">A−</button>
        <span aria-live="polite">{fontSize}px</span>
        <button type="button" onClick={() => setFontSize(size => terminalFontSize(size + 1))} disabled={fontSize >= MAX_TERMINAL_FONT_SIZE} aria-label="Increase terminal font size">A+</button>
        <button type="button" onClick={() => setFontSize(DEFAULT_TERMINAL_FONT_SIZE)} disabled={fontSize === DEFAULT_TERMINAL_FONT_SIZE} aria-label="Reset terminal font size">Reset</button>
      </div>
    </div>
    {focused && (repository || branch || expiration) && <div className="terminal-context" aria-label="Session context">
      {repository && <span title={repository}>Repository: <strong>{repository}</strong></span>}
      {branch && <span title={branch}>Branch: <strong>{branch}</strong></span>}
      {expiration && <span>Expires: <time dateTime={expiresAt}>{expiration}</time></span>}
    </div>}
    <div id={searchId} className="terminal-find" hidden={!findOpen}>
      <div className="terminal-find-row">
        <label htmlFor={`${searchId}-input`}>Find</label>
        <input id={`${searchId}-input`} ref={findInput} value={query} onChange={event => setQuery(event.target.value)} onBlur={() => searchRef.current?.clearActiveDecoration()} aria-describedby={scopeId} placeholder="Search terminal output" autoComplete="off" spellCheck={false} />
        <button type="button" onClick={() => searchRef.current?.findPrevious(query, searchOptions)} disabled={!query} aria-label="Previous terminal match" title="Previous match (Shift+Enter)">Previous</button>
        <button type="button" onClick={() => searchRef.current?.findNext(query, searchOptions)} disabled={!query} aria-label="Next terminal match" title="Next match (Enter)">Next</button>
        <button type="button" onClick={closeFind} aria-label="Close terminal Find" title="Close Find (Escape)">Close</button>
      </div>
      <div className="terminal-find-info"><span role="status" aria-live="polite">{searchResultLabel(query, results)}</span><span id={scopeId}>Current browser buffer only · tmux history is not searched · Enter / Shift+Enter</span></div>
    </div>
    <div className="terminal-help" aria-live="polite">{recoveringShell && <span>Recovering the primary shell on this machine… </span>}{status.message && <span>{status.message} </span>}{status.phase === 'connected' ? preview ? 'Simulated shell connection. No commands are executed.' : shellId === 'codex' ? 'Shell connection is live. Codex may still be starting or waiting for sign-in.' : 'Persistent bash shell connected on this machine.' : 'Wait for Connected before typing. Input while disconnected is discarded.'}</div>
    <div ref={host} className="terminal-host" role="region" aria-label={`${label} terminal`} />
    <div className="terminal-footer"><span>{preview ? 'SIMULATION / No commands are executed' : 'tmux / Reconnect to the same shell'}</span><span>UTF-8</span></div>
  </div>;
}
