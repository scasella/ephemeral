import { ApiClient, CommandExitError, ConnectionConfig, NotFoundError, Sandbox, SandboxNotFoundError } from 'e2b';
import { randomUUID } from 'node:crypto';
import type { PreviewTarget, SandboxProvider, Session, SetupCommand, SetupCommandResult, TerminalConnection, TerminalShellState } from '../contracts.js';
import { inspectGitWorkspace, unavailableWorkStatus, type GitInspectionResult, type WorkStatus } from '../workspace-status.js';
import { SETUP_CLEANUP_MS, SetupOutputDecoder, setupRunnerSource } from './setup-runner.js';
import { ContinuationSourceChangedError } from '../core/continuation.js';
import { prepareGitCommand, shellQuote, SOURCE_CHANGED_EXIT } from './git-prepare.js';
import { shellCommand, shellTarget, SHELL_FRAME } from './terminal-shell.js';
import { changeInspectionCommand, CHANGES_FRAME } from './change-inspection.js';
import { isChangePath, parseWorkspaceChanges, unavailableWorkspaceChanges, type WorkspaceChanges } from '../workspace-changes.js';
import { APPLICATION_PREVIEW_UNAVAILABLE, assertApplicationPreviewSession, privateApplicationPreviewTarget, type PreviewTokenStore } from './application-preview.js';
import { PREVIEW_GATEWAY_PORT, PREVIEW_GATEWAY_SOURCE, PREVIEW_GATEWAY_VERSION, previewGatewayInstallCommand,
  previewGatewaySource, previewGatewayStartCommand } from './preview-gateway.js';

export { shellQuote } from './git-prepare.js';
const REQUEST_MS = 30_000;
const WORKSPACE = '/home/user/workspace';
const HELPER = '/home/user/.ephemeral-git-credential';

/** E2B API keys and upstream GitHub credentials never enter the sandbox. */
export class E2BProvider implements SandboxProvider {
  private readonly gatewayUrl: string;
  // GET details do not return trafficAccessToken. Production injects an encrypted
  // vault; the memory fallback is only for provider use without that store.
  private readonly previewTokens = new Map<string, { sessionId: string; token: string; expiresAt: number }>();
  constructor(private readonly config: { apiKey: string; templateId: string; gatewayUrl: string; previewTokens?: PreviewTokenStore }) {
    if (!config.apiKey || !config.templateId) throw new Error('E2B_API_KEY and a custom E2B_TEMPLATE_ID are required.');
    const url = new URL(config.gatewayUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('E2B gateway URL must be a public HTTPS URL without credentials.');
    this.gatewayUrl = config.gatewayUrl.replace(/\/$/, '');
  }
  private opts() { return { apiKey: this.config.apiKey, requestTimeoutMs: REQUEST_MS }; }
  private connect(id: string) { return Sandbox.connect(id, this.opts()); }

  async previewTarget(session: Session, port: number, signal?: AbortSignal): Promise<PreviewTarget> {
    try {
      signal?.throwIfAborted();
      assertApplicationPreviewSession(session, port);
      for (const [id, entry] of this.previewTokens) if (entry.expiresAt <= Date.now()) this.previewTokens.delete(id);
      const entry = this.previewTokens.get(session.sandboxId!);
      const token = this.config.previewTokens ? await this.config.previewTokens.read(session, session.sandboxId!) :
        (entry?.sessionId === session.id ? entry.token : null);
      if (!token) throw new Error(APPLICATION_PREVIEW_UNAVAILABLE);
      signal?.throwIfAborted();
      const opts = { ...this.opts(), requestTimeoutMs: 10_000, retries: 0 };
      // Never connect, resume, extend, or start a process while resolving a preview.
      const response = await new ApiClient(new ConnectionConfig(opts)).api.GET('/sandboxes/{sandboxID}', {
        params: { path: { sandboxID: session.sandboxId! } }, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]),
      });
      signal?.throwIfAborted();
      const info = response.data;
      if (response.error || !info || (!this.config.previewTokens && (!entry || entry.expiresAt <= Date.now()))) throw new Error(APPLICATION_PREVIEW_UNAVAILABLE);
      return privateApplicationPreviewTarget(session, port, info, token, () => {
        const sandbox = new Sandbox({ ...opts, sandboxId: info.sandboxID, sandboxDomain: info.domain ?? 'e2b.app',
          envdVersion: info.envdVersion, trafficAccessToken: token });
        return sandbox.getHost(PREVIEW_GATEWAY_PORT);
      });
    } catch { throw new Error(APPLICATION_PREVIEW_UNAVAILABLE); }
  }

  private async runningTerminalSandbox(sandboxId: string, session?: Session): Promise<Sandbox> {
    if (session && (session.state !== 'running' || session.sandboxId !== sandboxId ||
      !Number.isFinite(Date.parse(session.expiresAt)) || !Number.isFinite(Date.parse(session.maxExpiresAt)) ||
      Math.min(Date.parse(session.expiresAt), Date.parse(session.maxExpiresAt)) <= Date.now())) throw new Error('Workspace is unavailable.');
    // Read-only detail lookup; Sandbox.connect can resume or extend a VM.
    const opts = { ...this.opts(), requestTimeoutMs: 10_000, retries: 0 };
    const response = await new ApiClient(new ConnectionConfig(opts)).api.GET('/sandboxes/{sandboxID}', {
      params: { path: { sandboxID: sandboxId } }, signal: AbortSignal.timeout(10_000),
    });
    const info = response.data;
    if (response.error || !info || info.sandboxID !== sandboxId || info.state !== 'running' || info.lifecycle?.autoResume !== false ||
      (info.endAt && (!Number.isFinite(Date.parse(info.endAt)) || Date.parse(info.endAt) <= Date.now()))) throw new Error('Workspace is unavailable.');
    const metadata = info.metadata ?? {};
    if (session && (metadata.ephemeral_session_id !== session.id || metadata.ephemeral_user_id !== session.userId ||
      metadata.ephemeral_repository !== session.repository || metadata.ephemeral_repository_id !== String(session.repositoryId) ||
      metadata.ephemeral_branch !== session.branch)) throw new Error('Workspace identity could not be verified.');
    return new Sandbox({ ...opts, sandboxId: info.sandboxID, sandboxDomain: info.domain ?? undefined,
      envdVersion: info.envdVersion, envdAccessToken: info.envdAccessToken });
  }

  private async shellOperation(sandbox: Sandbox, shellId: string, action: 'ensure' | 'inspect' | 'close'): Promise<TerminalShellState> {
    const result = await sandbox.commands.run(shellCommand(shellId, action), {
      user: 'user', cwd: WORKSPACE, timeoutMs: 10_000, requestTimeoutMs: 12_000, signal: AbortSignal.timeout(12_000),
    });
    if (result.exitCode !== 0 || !result.stdout.endsWith(SHELL_FRAME)) throw new Error('Terminal state unavailable.');
    const body = JSON.parse(result.stdout.slice(0, -SHELL_FRAME.length)) as { state: unknown };
    if (body.state !== 'open' && body.state !== 'closed') throw new Error('Terminal state unavailable.');
    return body.state;
  }

  async ensureShell(session: Session, shellId: string): Promise<TerminalShellState> {
    shellCommand(shellId, 'ensure');
    try {
      if (!session.sandboxId) throw new Error('Missing workspace.');
      return await this.shellOperation(await this.runningTerminalSandbox(session.sandboxId, session), shellId, 'ensure');
    } catch { throw new Error('Unable to open workspace shell.'); }
  }

  async inspectShell(session: Session, shellId: string): Promise<TerminalShellState> {
    shellTarget(shellId);
    try {
      if (!session.sandboxId) return 'unknown';
      return await this.shellOperation(await this.runningTerminalSandbox(session.sandboxId, session), shellId, 'inspect');
    } catch { return 'unknown'; }
  }

  async closeShell(session: Session, shellId: string): Promise<TerminalShellState> {
    shellCommand(shellId, 'close');
    try {
      if (!session.sandboxId) throw new Error('Missing workspace.');
      const state = await this.shellOperation(await this.runningTerminalSandbox(session.sandboxId, session), shellId, 'close');
      if (state !== 'closed') throw new Error('Incomplete cleanup.');
      return 'closed';
    } catch { throw new Error('Workspace shell termination could not be confirmed.'); }
  }

  async runSetup(session: Session, input: SetupCommand, onOutput: (text: string) => void, signal: AbortSignal): Promise<SetupCommandResult> {
    if (signal.aborted) return { status: 'cancelled', exitCode: null };
    const expiry = Math.min(Date.parse(session.expiresAt), Date.parse(session.maxExpiresAt));
    const requestedDeadline = Math.min(Date.parse(input.deadlineAt), Date.now() + input.timeoutMs);
    if (session.state !== 'running' || !session.sandboxId || !Number.isFinite(expiry) || expiry <= Date.now() + SETUP_CLEANUP_MS ||
        !Number.isFinite(requestedDeadline) || requestedDeadline <= Date.now() ||
        !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || !input.command.trim() || input.command.length > 16_384) {
      throw new Error('Setup requires a running workspace with time remaining and a bounded command.');
    }
    let attemptedExecution = false;
    try {
      const lookupSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      const opts = { ...this.opts(), requestTimeoutMs: 10_000, retries: 0 };
      // Read-only lookup: connect() can resume or extend a sandbox's deadline.
      const response = await new ApiClient(new ConnectionConfig(opts)).api.GET('/sandboxes/{sandboxID}', {
        params: { path: { sandboxID: session.sandboxId } }, signal: lookupSignal,
      });
      const info = response.data, metadata = info?.metadata ?? {};
      if (response.error || !info || info.state !== 'running' || info.lifecycle?.autoResume !== false ||
          info.sandboxID !== session.sandboxId || metadata.ephemeral_session_id !== session.id ||
          metadata.ephemeral_user_id !== session.userId || metadata.ephemeral_repository !== session.repository ||
          metadata.ephemeral_repository_id !== String(session.repositoryId) || metadata.ephemeral_branch !== session.branch) {
        throw new Error('Workspace identity could not be verified.');
      }
      if (signal.aborted) return { status: 'cancelled', exitCode: null };
      const providerExpiry = Date.parse(info.endAt);
      const deadlineAt = Math.min(requestedDeadline, expiry - SETUP_CLEANUP_MS,
        Number.isFinite(providerExpiry) ? providerExpiry - SETUP_CLEANUP_MS : Infinity);
      const timeoutMs = deadlineAt - Date.now();
      if (timeoutMs <= 0) throw new Error('Workspace deadline has passed.');
      const sandbox = new Sandbox({ ...opts, sandboxId: info.sandboxID, sandboxDomain: info.domain ?? undefined,
        envdVersion: info.envdVersion, envdAccessToken: info.envdAccessToken });
      const controlDirectory = `/tmp/ephemeral-setup-${randomUUID()}`;
      const decoder = new SetupOutputDecoder(onOutput);
      // An abort stops transport only after giving the independent VM wrapper
      // time to confirm group cleanup. It never removes the VM's hard timer.
      const transport = new AbortController();
      const wallTimer = setTimeout(() => transport.abort(), timeoutMs + SETUP_CLEANUP_MS + 5_000);
      let cancelTimer: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => {
        if (cancelTimer) return;
        cancelTimer = setTimeout(() => transport.abort(), 5_000);
        const script = `const fs=require('node:fs');fs.mkdirSync(${JSON.stringify(controlDirectory)},{recursive:true,mode:0o700});fs.writeFileSync(${JSON.stringify(`${controlDirectory}/cancel`)},'cancel');`;
        void sandbox.commands.run(`node -e ${shellQuote(script)}`, { user: 'user', cwd: WORKSPACE,
          timeoutMs: 2_000, requestTimeoutMs: 2_000, signal: AbortSignal.timeout(2_000) }).catch(() => {});
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      try {
        const script = setupRunnerSource({ command: input.command, cwd: WORKSPACE, deadlineAt, controlDirectory });
        attemptedExecution = true;
        const result = await sandbox.commands.run(`exec node -e ${shellQuote(script)}`, { user: 'user', cwd: WORKSPACE,
          timeoutMs: timeoutMs + SETUP_CLEANUP_MS + 3_000, requestTimeoutMs: 10_000, signal: transport.signal,
          onStdout: data => decoder.write(data) });
        if (result.exitCode !== 0) throw new Error('Incomplete setup execution.');
        return decoder.complete();
      } finally {
        clearTimeout(wallTimer); if (cancelTimer) clearTimeout(cancelTimer);
        signal.removeEventListener('abort', cancel);
      }
    } catch {
      if (signal.aborted && !attemptedExecution) return { status: 'cancelled', exitCode: null };
      // Raw SDK errors may contain credentials or command text. Absence of the
      // completion frame is uncertainty, never an optimistic cancellation.
      throw new Error('Setup termination could not be confirmed. The workspace timer remains active.');
    }
  }

  async inspectWorkspace(session: Session): Promise<WorkStatus> {
    const expiresAt = Date.parse(session.expiresAt);
    if (session.state !== 'running' || !session.sandboxId || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return unavailableWorkStatus('Work status requires an unexpired running session with a workspace.');
    }
    try {
      // Sandbox.connect is a mutation: it can resume a VM and extend its timeout.
      // Use the SDK's read-only detail endpoint, then construct the command client
      // locally with its access token. Neither the response nor token is logged.
      const deadline = AbortSignal.timeout(35_000);
      const opts = { ...this.opts(), requestTimeoutMs: 10_000, retries: 0, signal: deadline };
      const response = await new ApiClient(new ConnectionConfig(opts)).api.GET('/sandboxes/{sandboxID}', {
        params: { path: { sandboxID: session.sandboxId } }, signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
      });
      if (response.error?.code === 404) return unavailableWorkStatus('The session workspace no longer exists. Work status cannot be verified.');
      if (response.error || !response.data) throw new Error('Sandbox lookup failed');
      const info = response.data;
      if (info.state !== 'running' || info.lifecycle?.autoResume !== false) {
        return unavailableWorkStatus('The workspace is paused or its read-only access cannot be confirmed. Status cannot resume a workspace.');
      }
      const metadata = info.metadata ?? {};
      if (info.sandboxID !== session.sandboxId || metadata.ephemeral_session_id !== session.id ||
          metadata.ephemeral_user_id !== session.userId || metadata.ephemeral_repository !== session.repository ||
          metadata.ephemeral_repository_id !== String(session.repositoryId) || metadata.ephemeral_branch !== session.branch) {
        return unavailableWorkStatus('The workspace identity does not match this session. Ask the operator to check its configuration.');
      }
      const sandbox = new Sandbox({ ...opts, sandboxId: info.sandboxID, sandboxDomain: info.domain ?? undefined,
        envdVersion: info.envdVersion, envdAccessToken: info.envdAccessToken });
      return await inspectGitWorkspace({ workspace: WORKSPACE, expectedBranch: session.branch,
        expectedRemoteUrl: new URL(`${this.gatewayUrl}/gateway/git/${session.id}.git`).href,
        run: async (args, timeoutMs): Promise<GitInspectionResult> => {
          deadline.throwIfAborted();
          // Bound Git output and execution inside the VM. JSON framing detects
          // truncated E2B output; base64 preserves NULs and unusual filenames.
          const script = `const {spawnSync}=require('node:child_process');
const result=spawnSync('git',${JSON.stringify(args)},{env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'},timeout:${timeoutMs},maxBuffer:1048576});
if(result.error||result.signal||!Number.isInteger(result.status))process.exit(1);
process.stdout.write(JSON.stringify({exitCode:result.status,stdout:result.stdout.toString('base64')})+'\\nEPHEMERAL_INSPECTION_COMPLETE\\n');`;
          const result = await sandbox.commands.run(`node -e ${shellQuote(script)}`, {
            user: 'user', timeoutMs: timeoutMs + 1_000, requestTimeoutMs: timeoutMs + 5_000, signal: deadline,
          });
          const marker = '\nEPHEMERAL_INSPECTION_COMPLETE\n';
          if (result.exitCode !== 0 || !result.stdout.endsWith(marker)) throw new Error('Incomplete inspection');
          const body = JSON.parse(result.stdout.slice(0, -marker.length)) as { exitCode: unknown; stdout: unknown };
          if (!Number.isInteger(body.exitCode) || typeof body.stdout !== 'string' ||
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.stdout)) throw new Error('Invalid inspection');
          return { exitCode: body.exitCode as number, stdout: Buffer.from(body.stdout, 'base64').toString('utf8') };
        },
      });
    } catch {
      return { ...unavailableWorkStatus('Could not reach the workspace. Check the session connection and refresh status before ending it.'), state: 'unknown' };
    }
  }

  async inspectChanges(session: Session, path?: string): Promise<WorkspaceChanges> {
    if (path !== undefined && !isChangePath(path)) return unavailableWorkspaceChanges('Invalid change path.');
    let sandbox: Sandbox;
    try {
      if (!session.sandboxId) return unavailableWorkspaceChanges('Change review requires a running session workspace.');
      sandbox = await this.runningTerminalSandbox(session.sandboxId, session);
    } catch { return unavailableWorkspaceChanges('The running workspace could not be verified. Refresh while the session is running.'); }
    try {
      const result = await sandbox.commands.run(changeInspectionCommand(WORKSPACE, path), {
        user: 'user', timeoutMs: 10_000, requestTimeoutMs: 12_000, signal: AbortSignal.timeout(12_000),
      });
      if (result.exitCode !== 0 || result.stdout.length > 2_000_000 || !result.stdout.endsWith(CHANGES_FRAME)) throw new Error('Incomplete inspection.');
      const snapshot = parseWorkspaceChanges(JSON.parse(result.stdout.slice(0, -CHANGES_FRAME.length)));
      if ((path === undefined && snapshot.selected !== null) || (snapshot.selected !== null && snapshot.selected.path !== path)) throw new Error('Invalid selected path.');
      if (path !== undefined && snapshot.state === 'known' && snapshot.selected === null) throw new Error('Missing selected preview.');
      return snapshot;
    } catch {
      return { ...unavailableWorkspaceChanges('Could not inspect workspace changes. Refresh while the session is running.'), state: 'unknown' };
    }
  }

  async create(session: Session, gatewayToken: string): Promise<string> {
    const remaining = Date.parse(session.expiresAt) - Date.now();
    if (remaining <= 0) throw new Error('Session deadline passed before creation.');
    const sandbox = await Sandbox.create(this.config.templateId, {
      ...this.opts(), requestTimeoutMs: 60_000, retries: 0, timeoutMs: remaining,
      metadata: { ephemeral_session_id: session.id, ephemeral_user_id: session.userId,
        ephemeral_repository: session.repository, ephemeral_repository_id: String(session.repositoryId), ephemeral_branch: session.branch,
        ephemeral_preview_gateway: PREVIEW_GATEWAY_VERSION },
      envs: { EPHEMERAL_GATEWAY_TOKEN: gatewayToken },
      allowInternetAccess: true, secure: true,
      network: { allowPublicTraffic: false, maskRequestHost: 'localhost:${PORT}' },
      lifecycle: { onTimeout: 'kill', autoResume: false },
    });
    try {
      if (sandbox.trafficAccessToken) {
        if (this.config.previewTokens) await this.config.previewTokens.save(session, sandbox.sandboxId, sandbox.trafficAccessToken);
        else this.previewTokens.set(sandbox.sandboxId, {
          sessionId: session.id, token: sandbox.trafficAccessToken, expiresAt: Math.min(Date.parse(session.expiresAt), Date.parse(session.maxExpiresAt)),
        });
      } else if (this.config.previewTokens) throw new Error('Missing native preview token.');
    } catch {
      await Sandbox.kill(sandbox.sandboxId, this.opts()).catch(() => {});
      throw new Error('Sandbox creation could not be completed.');
    }
    return sandbox.sandboxId;
  }

  async prepare(session: Session): Promise<void> {
    if (!session.sandboxId) throw new Error('Sandbox ID must be persisted before preparation.');
    const sandbox = await this.connect(session.sandboxId);
    try {
      const rootRun = async (command: string) => {
        const result = await sandbox.commands.run(command, { user: 'root', timeoutMs: 10_000, requestTimeoutMs: 12_000 });
        if (result.exitCode !== 0) throw new Error('Gateway preparation failed.');
      };
      // Establish the trusted listener before any user command, checkout, or Codex process.
      await rootRun(previewGatewayInstallCommand());
      await sandbox.files.write(PREVIEW_GATEWAY_SOURCE, previewGatewaySource(), { user: 'root', requestTimeoutMs: REQUEST_MS });
      await rootRun(previewGatewayStartCommand());
    } catch { throw new Error('Sandbox application gateway preparation failed. Check the configured template.'); }
    const run = async (command: string, timeoutMs = 30_000, verifySource = false) => {
      let exitCode: number;
      try {
        const result = await sandbox.commands.run(command, { user: 'user', timeoutMs, requestTimeoutMs: timeoutMs + 5_000 });
        exitCode = result.exitCode;
      } catch (error) {
        if (verifySource && error instanceof CommandExitError && error.exitCode === SOURCE_CHANGED_EXIT) throw new ContinuationSourceChangedError();
        throw new Error('Sandbox preparation command failed. Check the configured template and gateway.');
      }
      if (verifySource && exitCode === SOURCE_CHANGED_EXIT) throw new ContinuationSourceChangedError();
      if (exitCode !== 0) throw new Error('Sandbox preparation command failed. Check the configured template and gateway.');
    };
    await run('set -eu; command -v node; command -v npm; command -v pnpm; command -v git; command -v tmux; command -v codex; test ! -f "$HOME/.codex/auth.json"');
    const gateway = new URL(`${this.gatewayUrl}/gateway/git/${session.id}.git`);
    // Git's credential helper reads the scoped token from its environment. It is
    // never embedded in a command, remote URL, .git/config, or event/log message.
    const helper = `#!/bin/sh
set -eu
[ "$1" = get ] || exit 0
protocol= host= path=
while IFS='=' read -r key value; do
  case "$key" in protocol) protocol=$value;; host) host=$value;; path) path=$value;; esac
done
[ "$protocol" = https ] || exit 0
[ "$host" = ${shellQuote(gateway.host)} ] || exit 0
[ "$path" = ${shellQuote(gateway.pathname.slice(1))} ] || exit 0
printf 'username=x-access-token\\npassword=%s\\n' "$EPHEMERAL_GATEWAY_TOKEN"
`;
    await sandbox.files.write(HELPER, helper, { user: 'user', requestTimeoutMs: REQUEST_MS });
    await run(`set -eu; chmod 700 ${shellQuote(HELPER)}; git config --global credential.helper ${shellQuote(HELPER)}; git config --global credential.useHttpPath true; git config --global user.name 'Ephemeral'; git config --global user.email 'ephemeral@localhost'`);
    await run(prepareGitCommand(session, gateway.href, WORKSPACE), 180_000, Boolean(session.continuation));
    // Every VM starts with an empty Codex auth directory. The device flow is
    // interactive, displayed by tmux when the browser attaches, and uses the
    // user's own subscription. tmux survives a browser or API-server disconnect.
    const startup = "printf '\\nFresh sandbox. Complete the Codex device sign-in below.\\n'; unset OPENAI_API_KEY CODEX_API_KEY; if codex login --device-auth; then codex; fi; exec bash -l";
    await run(`tmux new-session -d -s ephemeral -c ${shellQuote(WORKSPACE)} ${shellQuote(`bash -lc ${shellQuote(startup)}`)}`);
  }

  async discover(sessionId: string): Promise<string[]> {
    const paginator = Sandbox.list({ ...this.opts(), query: { metadata: { ephemeral_session_id: sessionId }, state: ['running', 'paused'] } });
    const ids: string[] = [];
    // Iterate every page, including paused resources. A provider error must not
    // be interpreted as an empty list or successful cleanup.
    while (paginator.hasNext) for (const sandbox of await paginator.nextItems(this.opts())) ids.push(sandbox.sandboxId);
    return ids;
  }
  async setTimeout(sandboxId: string, timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) throw new Error('Session deadline has passed.');
    await Sandbox.setTimeout(sandboxId, timeoutMs, this.opts());
  }
  async kill(sandboxId: string): Promise<void> {
    await Sandbox.kill(sandboxId, this.opts());
    this.previewTokens.delete(sandboxId);
    try { await this.config.previewTokens?.remove(sandboxId); }
    catch { throw new Error('Sandbox preview credentials could not be removed.'); }
  }
  async exists(sandboxId: string): Promise<boolean> {
    try { await Sandbox.getInfo(sandboxId, this.opts()); return true; }
    catch (error) {
      if (error instanceof SandboxNotFoundError || error instanceof NotFoundError) return false;
      throw error;
    }
  }
  async cleanupCodex(sandboxId: string): Promise<boolean> {
    try {
      const sandbox = await this.connect(sandboxId);
      // Stop every process owned by the workspace user before touching auth.
      // This includes Codex, its login/refresh flow, tmux, and detached jobs.
      const stopped = await sandbox.commands.run('pkill -KILL -u user || test "$?" -eq 1',
        { user: 'root', timeoutMs: 10_000, requestTimeoutMs: REQUEST_MS });
      if (stopped.exitCode !== 0) return false;
      const result = await sandbox.commands.run(`codex logout; logout_status=$?; rm -f "$HOME/.codex/auth.json" ${shellQuote(HELPER)}; exit "$logout_status"`,
        { user: 'user', timeoutMs: 20_000, requestTimeoutMs: REQUEST_MS });
      return result.exitCode === 0;
    } catch { return false; }
  }
  async connectTerminal(sandboxId: string, onData: (data: Uint8Array) => void, cols: number, rows: number, shellId = 'codex'): Promise<TerminalConnection> {
    const target = shellTarget(shellId);
    let sandbox: Sandbox;
    let pty: Awaited<ReturnType<Sandbox['pty']['create']>>;
    try {
      sandbox = await this.runningTerminalSandbox(sandboxId);
      // Attachment only inspects an existing session. Explicit Add shell owns creation.
      if (await this.shellOperation(sandbox, shellId, 'inspect') !== 'open') throw new Error('Terminal is closed.');
      pty = await sandbox.pty.create({ user: 'user', cwd: WORKSPACE, cols, rows, onData, timeoutMs: 0, requestTimeoutMs: REQUEST_MS });
    } catch { throw new Error('Unable to attach sandbox terminal.'); }
    try {
      await sandbox.pty.sendInput(pty.pid, new TextEncoder().encode(`exec tmux attach-session -t ${shellQuote(`=${target}`)}\r`), { requestTimeoutMs: REQUEST_MS });
    } catch {
      await pty.disconnect().catch(() => {});
      await sandbox.pty.kill(pty.pid, { requestTimeoutMs: REQUEST_MS }).catch(() => {});
      throw new Error('Unable to attach sandbox terminal.');
    }
    let disconnected = false;
    return {
      async write(data) {
        if (disconnected) throw new Error('Terminal is disconnected.');
        try { await sandbox.pty.sendInput(pty.pid, new TextEncoder().encode(data), { requestTimeoutMs: REQUEST_MS }); }
        catch { throw new Error('Unable to write to sandbox terminal.'); }
      },
      async resize(nextCols, nextRows) {
        try { if (!disconnected) await sandbox.pty.resize(pty.pid, { cols: nextCols, rows: nextRows }, { requestTimeoutMs: REQUEST_MS }); }
        catch { throw new Error('Unable to resize sandbox terminal.'); }
      },
      async disconnect() {
        if (disconnected) return;
        disconnected = true;
        // Kill only this tmux client PTY. The detached tmux server and its Codex
        // session survive, without accumulating abandoned PTYs on reconnect.
        let failed = false;
        try { await pty.disconnect(); } catch { failed = true; }
        try { await sandbox.pty.kill(pty.pid, { requestTimeoutMs: REQUEST_MS }); } catch { failed = true; }
        if (failed) throw new Error('Unable to disconnect sandbox terminal.');
      },
    };
  }
}
