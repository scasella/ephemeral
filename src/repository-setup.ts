import type { SetupRecipe, SetupRun } from '../server/setup';
export type { SetupRecipe, SetupRun };
export interface SetupState { recipe: SetupRecipe | null; run: SetupRun | null; mode: 'live' | 'preview' }
export interface SetupDraft { label: string; command: string; timeoutSeconds: string }
export type SetupAction = { type: 'load' } | { type: 'save'; recipe: Omit<SetupRecipe, 'version' | 'updatedAt'> } | { type: 'run'; recipeVersion: string } | { type: 'cancel'; runId: string };
export function setupDraft(recipe: SetupRecipe | null): SetupDraft {
  return recipe ? { label: recipe.label, command: recipe.command, timeoutSeconds: String(recipe.timeoutSeconds) } : { label: 'Repository setup', command: '', timeoutSeconds: '120' };
}
export function validateSetupDraft(draft: SetupDraft): string | null {
  if (!draft.label.trim() || draft.label.trim().length > 80) return 'Enter a label of 1–80 characters.';
  if (!draft.command.trim() || draft.command.trim().length > 8192) return 'Enter a command of 1–8,192 characters.';
  if (draft.command.includes('\0')) return 'The command cannot contain a null character.';
  if (!/^\d+$/.test(draft.timeoutSeconds) || Number(draft.timeoutSeconds) < 5 || Number(draft.timeoutSeconds) > 600) return 'Timeout must be a whole number from 5 to 600 seconds.';
  return null;
}
export function setupDraftMatches(draft: SetupDraft, recipe: SetupRecipe | null): boolean {
  return Boolean(recipe && !validateSetupDraft(draft) && draft.label.trim() === recipe.label && draft.command.trim() === recipe.command && Number(draft.timeoutSeconds) === recipe.timeoutSeconds);
}
export function setupRunActive(run: SetupRun | null): boolean { return run?.status === 'queued' || run?.status === 'running'; }
export function setupRunBlocked(run: SetupRun | null, now: number): boolean { return Boolean(run?.blockedUntil && Date.parse(run.blockedUntil) > now); }
export function setupRunSummary(run: SetupRun): string {
  const labels: Record<SetupRun['status'], string> = { queued: 'Queued', running: 'Running', succeeded: 'Succeeded', failed: 'Failed', timed_out: 'Timed out', cancelled: 'Cancelled', interrupted: 'Interrupted' };
  const reasons: Record<NonNullable<SetupRun['reason']>, string> = {
    user_cancelled: 'cancelled by you', session_ended: 'machine ended or expired', authorization_failed: 'repository access unavailable',
    persistence_failed: 'saving setup failed', server_shutdown: 'server stopped', timeout: 'timeout reached',
    provider_unavailable: 'setup execution unavailable', completion_unconfirmed: 'completion unconfirmed',
  };
  const label = run.invocationStarted === false && !setupRunActive(run) ? 'Did not start' : labels[run.status];
  return `${label}${run.reason ? ` · ${reasons[run.reason]}` : ''}${run.exitCode === null ? '' : ` · exit code ${run.exitCode}`}`;
}
export function setupRunGuidance(run: SetupRun): string | null {
  if (setupRunActive(run)) return null;
  if (run.invocationStarted === false) {
    const beforeExecution: Record<NonNullable<SetupRun['reason']>, string> = {
      user_cancelled: 'You cancelled before execution. Run again only when you are ready.',
      session_ended: 'The machine ended or expired before execution. Run the saved recipe explicitly on an available machine.',
      authorization_failed: 'Repository access could not be verified before execution. Restore access, check saved setup, then explicitly run again.',
      persistence_failed: 'Setup could not save its execution record. Check saved setup after storage recovers, then explicitly run again.',
      server_shutdown: 'The server stopped before execution. Reconnect, check saved setup, then explicitly run again.',
      timeout: 'The setup deadline passed before execution. Check the machine lifetime and saved timeout before running again.',
      provider_unavailable: 'Setup execution is unavailable. Check saved setup and retry explicitly when the service is restored.',
      completion_unconfirmed: 'Execution did not start. Check saved setup before explicitly running again.',
    };
    return run.reason ? beforeExecution[run.reason] : 'Execution did not start. Check saved setup before explicitly running again.';
  }
  if (run.status === 'interrupted' && (run.blockedUntil || !run.reason || run.reason === 'completion_unconfirmed')) return 'The command may have run. Its completion could not be confirmed. Review retained output and wait for any execution hold to clear before deciding whether to run again. Setup is never replayed automatically.';
  switch (run.reason) {
    case 'user_cancelled': return 'You requested cancellation. Review the recorded output before deciding whether to run again.';
    case 'session_ended': return 'Setup stopped because the machine ended or expired. Review the output before running on another machine.';
    case 'authorization_failed': return 'Setup stopped because repository access could not be verified. Restore access and review the output before another run.';
    case 'persistence_failed': return 'Setup stopped because progress could not be saved. Check saved setup after storage recovers and review the output before another run.';
    case 'server_shutdown': return 'The server stopped this setup run. Reconnect and check its recorded outcome. Setup is never replayed automatically.';
    case 'timeout': return 'Setup reached its timeout. Review the output or increase the saved timeout before retrying.';
    default: return null;
  }
}

export function setupOutputNotice(run: SetupRun): string | null {
  if (!run.truncated) return null;
  return run.outputRetention === 'head_tail'
    ? 'Saved output is limited to 64 KiB. The beginning and end are retained; a marker identifies the omitted middle. The final tail is saved when the run finishes.'
    : 'Saved output exceeded its limit and was truncated.';
}

export async function requestSetup(sessionId: string, action: SetupAction, signal: AbortSignal): Promise<SetupState> {
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/setup${action.type === 'run' ? '/runs' : action.type === 'cancel' ? `/runs/${encodeURIComponent(action.runId)}/cancel` : ''}`;
  const method = action.type === 'load' ? 'GET' : action.type === 'save' ? 'PUT' : 'POST';
  const body = action.type === 'save' ? action.recipe : action.type === 'run' ? { recipeVersion: action.recipeVersion } : {};
  const response = await fetch(path, { credentials: 'same-origin', signal, method, ...(method === 'GET' ? {} : { headers: { 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1' }, body: JSON.stringify(body) }) });
  const data = await response.json().catch(error => { if (signal.aborted) throw error; return { error: `Server returned ${response.status}` }; });
  if (!response.ok) throw new Error(data.error || `Setup request failed (${response.status})`);
  return data as SetupState;
}

/** Serializes status and mutations, bounds hung requests, and ignores departed views. */
export class SetupLoader {
  private disposed = false;
  private pending: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private request: (action: SetupAction, signal: AbortSignal) => Promise<SetupState>,
    private publish: (state: SetupState, action: SetupAction) => void,
    private busy: (action: SetupAction['type'] | null) => void,
    private fail: (message: string, action: SetupAction) => void,
  ) {}
  run(action: SetupAction = { type: 'load' }): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pending) return this.pending;
    const controller = this.controller = new AbortController();
    this.busy(action.type);
    const timeout = new Promise<SetupState>((_, reject) => {
      this.timer = setTimeout(() => {
        reject(new Error(action.type === 'load' ? 'Setup status timed out. Check again.' : 'Setup request timed out. Its result is unconfirmed. Check saved setup before another action.'));
        controller.abort();
      }, 15_000);
    });
    this.pending = Promise.race([Promise.resolve().then(() => this.request(action, controller.signal)), timeout]).then(state => {
      if (!this.disposed) this.publish(state, action);
    }).catch(error => {
      if (!this.disposed) this.fail(error instanceof Error ? error.message : 'Setup is unavailable. Check again.', action);
    }).finally(() => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null; this.controller = null; this.pending = null;
      if (!this.disposed) this.busy(null);
    });
    return this.pending;
  }
  dispose() { this.disposed = true; this.controller?.abort(); if (this.timer) clearTimeout(this.timer); this.timer = null; }
}
