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
  return `${labels[run.status]}${run.exitCode === null ? '' : ` · exit code ${run.exitCode}`}`;
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
