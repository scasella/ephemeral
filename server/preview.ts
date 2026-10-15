import { randomUUID } from 'node:crypto';
import type { GatewayCredentials, PreviewTarget, SandboxProvider, Session, SetupCommand, SetupCommandResult, TerminalConnection, TerminalShellState } from './contracts.js';
import { unavailableWorkStatus } from './workspace-status.js';
import { unavailableWorkspaceChanges } from './workspace-changes.js';
import { shellTarget } from './infra/terminal-shell.js';

/** Only selected in explicit local preview mode. Never claims to execute code or revoke real credentials. */
export class PreviewProvider implements SandboxProvider {
  async previewTarget(_session: Session, _port: number): Promise<PreviewTarget> {
    throw new Error('Local preview has no application server. Start a live session to preview an application.');
  }
  private readonly shells = new Set<string>();
  private readonly closedShells = new Set<string>();
  private shellKey(session: Session, shellId: string): string {
    shellTarget(shellId);
    const expiresAt = Math.min(Date.parse(session.expiresAt), Date.parse(session.maxExpiresAt));
    if (!session.sandboxId || session.state !== 'running' || this.destroyed.has(session.sandboxId) ||
      !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('Preview session is unavailable.');
    return `${session.sandboxId}:${shellId}`;
  }
  async ensureShell(session: Session, shellId: string): Promise<TerminalShellState> {
    if (shellId === 'codex') throw new Error('The Codex terminal is protected.');
    const key = this.shellKey(session, shellId);
    if (this.closedShells.has(key)) throw new Error('Preview terminal generation is closed.');
    this.shells.add(key);
    return 'open';
  }
  async inspectShell(session: Session, shellId: string): Promise<TerminalShellState> {
    const key = this.shellKey(session, shellId);
    return shellId === 'codex' || this.shells.has(key) ? 'open' : 'closed';
  }
  async closeShell(session: Session, shellId: string): Promise<TerminalShellState> {
    if (shellId === 'codex') throw new Error('The Codex terminal is protected.');
    const key = this.shellKey(session, shellId);
    this.closedShells.add(key); this.shells.delete(key);
    return 'closed';
  }
  async inspectWorkspace(_session: Session) {
    return unavailableWorkStatus('Local preview has no workspace or upstream branch. Start a live session to verify work status.');
  }
  async inspectChanges(_session: Session, _path?: string) {
    return unavailableWorkspaceChanges('Local preview has no workspace changes. Start a live session to review changes.');
  }
  async runSetup(_session: Session, input: SetupCommand, onOutput: (text: string) => void, signal: AbortSignal): Promise<SetupCommandResult> {
    if (signal.aborted) return { status: 'cancelled', exitCode: null };
    const remaining = Math.min(input.timeoutMs, Date.parse(input.deadlineAt) - Date.now());
    if (remaining <= 0) return { status: 'timed_out', exitCode: null };
    onOutput('Local preview: simulating the selected setup recipe. No command executes and no workspace files change.\n');
    return new Promise(resolve => {
      const finish = (status: SetupCommandResult['status']) => {
        clearTimeout(timer); signal.removeEventListener('abort', cancelled);
        if (status === 'succeeded') onOutput('Preview simulation complete. Start a live session to execute this recipe.\n');
        resolve({ status, exitCode: status === 'succeeded' ? 0 : null });
      };
      const cancelled = () => finish('cancelled');
      const timer = setTimeout(() => finish(remaining < 350 ? 'timed_out' : 'succeeded'), Math.min(350, remaining));
      signal.addEventListener('abort', cancelled, { once: true });
      if (signal.aborted) cancelled();
    });
  }
  private destroyed = new Set<string>();
  async create(_session: Session, _token: string) { return `preview-${randomUUID()}`; }
  async prepare(_session: Session) {}
  async setTimeout(_sandboxId: string, _timeoutMs: number) {}
  async kill(sandboxId: string) { this.destroyed.add(sandboxId); for (const key of this.shells) if (key.startsWith(`${sandboxId}:`)) this.shells.delete(key); }
  async exists(sandboxId: string) { return sandboxId.startsWith('preview-') && !this.destroyed.has(sandboxId); }
  async cleanupCodex(_sandboxId: string) { return true; }
  async connectTerminal(sandboxId: string, onData: (data: Uint8Array) => void, _cols: number, _rows: number, shellId = 'codex'): Promise<TerminalConnection> {
    shellTarget(shellId);
    if (this.destroyed.has(sandboxId) || (shellId !== 'codex' && !this.shells.has(`${sandboxId}:${shellId}`))) throw new Error('Preview terminal is closed.');
    let line = '';
    const output = (s: string) => onData(Buffer.from(s));
    const welcome = setTimeout(() => output(`\r\n\x1b[1mEPHEMERAL / LOCAL PREVIEW${shellId === 'codex' ? '' : ' / SHELL SIMULATION'}\x1b[0m\r\n\r\nNo VM, model connection, or GitHub credential exists in this preview.\r\nConfigure the live integrations to run Codex and execute commands.\r\n\r\nTry the session timer, access panel, event log, and Stop control.\r\n\r\npreview › `), 50);
    return {
      async write(data) {
        for (const char of data) {
          if (char === '\r' || char === '\n') { output('\r\nPreview only — commands are not executed.\r\npreview › '); line = ''; }
          else if (char === '\u007f') { if (line) { line = line.slice(0, -1); output('\b \b'); } }
          else if (char >= ' ' && line.length < 1000) { line += char; output(char); }
        }
      },
      async resize() {}, async disconnect() { clearTimeout(welcome); },
    };
  }
}
export const previewCredentials: GatewayCredentials = { async issue() { return 'preview-not-a-credential'; }, async disable() {}, async revokeGitHub() {} };
export const previewRepositories = [
  { id: 101, fullName: 'ephemeral/example-app', defaultBranch: 'main', installationId: 1 },
  { id: 102, fullName: 'ephemeral/design-system', defaultBranch: 'main', installationId: 1 },
];
