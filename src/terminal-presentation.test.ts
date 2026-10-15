import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// xterm mounts only in an effect. Keep the presentation test independent of its browser runtime.
vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));
import Terminal, { TerminalConnectionControls } from './Terminal';
import { ShellWorkspace } from './ShellWorkspace';

const terminalMarkup = (visible = true) => renderToStaticMarkup(createElement(Terminal, {
  sessionId: 'machine', preview: false, visible, repository: 'owner/repo', branch: 'machine-branch', expiresAt: '2026-10-14T16:00:00Z',
}));

describe('compact terminal presentation', () => {
  it('puts one Focus control with Find and font controls in the first toolbar before terminal input', () => {
    const html = terminalMarkup();
    const toolbar = html.slice(html.indexOf('class="terminal-toolbar"'), html.indexOf('class="terminal-find"'));
    expect(toolbar).toContain('>Focus mode</button>');
    expect(toolbar).toContain('Find in current terminal buffer');
    expect(toolbar).toContain('aria-label="Terminal font size"');
    expect(html.match(/>Focus mode<\/button>/g)).toHaveLength(1);
    expect(html.indexOf('>Focus mode</button>')).toBeLessThan(html.indexOf('class="terminal-host"'));
    expect(html).toContain('Current browser buffer only');
    expect(html).toContain('Wait for Connected before typing. Input while disconnected is discarded.');
  });

  it('avoids repeating the surrounding workspace identity outside Focus and leaves inactive shells hidden', () => {
    const html = terminalMarkup(false);
    expect(html).toContain('<div hidden="" class="terminal-shell terminal-enhanced"');
    expect(html).not.toContain('owner/repo');
    expect(html).not.toContain('machine-branch');
    expect(html).not.toContain('aria-modal');
    expect(html).toContain('aria-label="Codex terminal"');
  });

  it('keeps refresh and loading visible above the terminal and puts optional shell help after it', () => {
    const html = renderToStaticMarkup(createElement(ShellWorkspace, { sessionId: 'machine', preview: true }));
    expect(html.indexOf('Refresh saved shells')).toBeLessThan(html.indexOf('role="tabpanel"'));
    expect(html.indexOf('Reading saved shells…')).toBeLessThan(html.indexOf('role="tabpanel"'));
    expect(html.indexOf('role="tabpanel"')).toBeLessThan(html.indexOf('<details class="shell-details"'));
    expect(html).toContain('<summary>About workspace shells</summary>');
    expect(html).toContain('Protected primary Codex terminal');
    expect(html).not.toContain('>Close shell</button>');
    expect(html).toContain('Preview shells are simulated. No commands are executed.');
  });
});


it('offers recovery for disconnected primary shells, shows pending recovery, and protects living or supplemental shells', () => {
  const render = (phase: 'connected' | 'disconnected' | 'error', recovering = false, primary = true) => renderToStaticMarkup(createElement(TerminalConnectionControls, {
    status: { phase }, recovering, primary, onReconnect: () => {}, onRecover: () => {},
  }));
  const disconnected = render('disconnected');
  expect(disconnected).toContain('>Recover shell</button>');
  expect(disconnected).not.toContain('disabled');
  expect(render('error')).not.toContain('disabled');
  const pending = render('error', true);
  expect(pending).toContain('>recovering</span>');
  expect(pending).toContain('>Recovering shell…</button>');
  expect(pending.match(/disabled=""/g)).toHaveLength(2);
  expect(render('connected')).toContain('disabled=""');
  expect(render('disconnected', false, false)).not.toContain('Recover shell');
});
