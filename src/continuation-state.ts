import type { Session } from './api';
import { maxExpectedNoteRevision, validNote, type HandoffNote } from './handoff-notes';

export interface ContinuationPreview {
  state: 'ready' | 'unpublished' | 'unavailable' | 'unknown';
  checkedAt: string; reason: string | null; sourceSessionId: string;
  repository: string; sourceBranch: string; baseBranch: string; commitSha: string | null;
}
export interface ContinuationIntent {
  sourceSessionId: string; expectedHeadSha: string; requestId: string; createdAt: string; expectedNoteRevision?: number; reviewedNote?: HandoffNote;
}
export const continuationPreviewMaxAge = 60_000;
const shaPattern = /^[a-f0-9]{40}$/i;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function continuationBlockedReason(source: Session): string | null {
  if (!['ended', 'failed'].includes(source.state)) return 'Stop the source machine and complete cleanup before continuing saved work.';
  if (['vm', 'github', 'gateway'].some(key => source.cleanup[key as keyof Session['cleanup']] !== 'confirmed') || !['confirmed', 'not_applicable'].includes(source.cleanup.codex)) return 'Complete the source machine’s credential and sandbox cleanup before continuing saved work.';
  return null;
}
export function previewBlockedReason(value: ContinuationPreview | null, source: Session, now: number): string | null {
  const blocked = continuationBlockedReason(source);
  if (blocked) return blocked;
  if (!value) return 'Check GitHub for published work before continuing.';
  if (value.state !== 'ready') return value.reason || 'Published work could not be verified. Refresh the review to try again.';
  if (value.sourceSessionId !== source.id || value.repository !== source.repository || value.sourceBranch !== source.branch || value.baseBranch !== source.baseBranch || !value.commitSha || !shaPattern.test(value.commitSha)) return 'The published-work review does not match this source machine. Refresh the review.';
  const age = now - Date.parse(value.checkedAt);
  if (!Number.isFinite(age) || age < -5_000 || age > continuationPreviewMaxAge) return 'This review has expired. Refresh and review the published commit again.';
  return null;
}
export function readContinuationIntent(raw: string | null, sourceSessionId: string): ContinuationIntent | null {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== 'object') return null;
    const intent = value as ContinuationIntent;
    return intent.sourceSessionId === sourceSessionId && typeof intent.expectedHeadSha === 'string' && shaPattern.test(intent.expectedHeadSha) && typeof intent.requestId === 'string' && uuidPattern.test(intent.requestId) && Number.isFinite(Date.parse(intent.createdAt)) && (intent.expectedNoteRevision === undefined || Number.isSafeInteger(intent.expectedNoteRevision) && intent.expectedNoteRevision >= 0 && intent.expectedNoteRevision <= maxExpectedNoteRevision) && (intent.reviewedNote === undefined || validNote(intent.reviewedNote) && intent.reviewedNote.revision === intent.expectedNoteRevision) ? intent : null;
  } catch { return null; }
}

export class ContinuationRequestError extends Error {
  constructor(message: string, readonly definite: boolean) { super(message); }
}
/** A timed-out POST may already have created a machine. Its request ID must be reused. */
export async function submitContinuation(source: Session, intent: ContinuationIntent): Promise<Session> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new ContinuationRequestError('The request timed out. Its outcome is uncertain; check the machine list or retry the same request.', false)); }, 45_000);
  });
  const request = async () => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(source.id)}/continue`, { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1' }, body: JSON.stringify({ expectedHeadSha: intent.expectedHeadSha, requestId: intent.requestId, ...(intent.expectedNoteRevision === undefined ? {} : { expectedNoteRevision: intent.expectedNoteRevision }) }) });
    const data = await response.json();
    if (!response.ok) throw new ContinuationRequestError(data.error || `Request failed (${response.status})`, response.status === 409 && data.code === 'CONTINUATION_REJECTED' && data.outcome === 'not_created');
    if (typeof data.id !== 'string' || !data.id || data.id === source.id || data.userId !== source.userId || data.repository !== source.repository || data.repositoryId !== source.repositoryId || data.installationId !== source.installationId || data.baseBranch !== source.baseBranch || typeof data.branch !== 'string' || !data.branch || data.branch === source.branch || data.continuation?.sourceSessionId !== source.id || data.continuation?.sourceBranch !== source.branch || typeof data.continuation?.commitSha !== 'string' || data.continuation.commitSha.toLowerCase() !== intent.expectedHeadSha.toLowerCase() || !Number.isFinite(Date.parse(data.continuation?.verifiedAt))) throw new ContinuationRequestError('The response could not confirm the new machine. Check the machine list or retry the same request.', false);
    return data as Session;
  };
  try { return await Promise.race([request(), timeout]); }
  catch (error) { if (error instanceof ContinuationRequestError) throw error; throw new ContinuationRequestError((error as Error).message || 'The request outcome is uncertain. Retry the same request.', false); }
  finally { clearTimeout(timer); }
}

/** Checks are bounded, coalesced, and cannot update a disposed review. */
export class ContinuationPreviewLoader {
  private disposed = false;
  private pending: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private source: Session, private request: (signal: AbortSignal) => Promise<ContinuationPreview>, private publish: (value: ContinuationPreview) => void, private loading: (value: boolean) => void) {}
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pending) return this.pending;
    const controller = this.controller = new AbortController();
    this.loading(true);
    const unknown = (reason: string): ContinuationPreview => ({ state: 'unknown', checkedAt: new Date().toISOString(), reason, sourceSessionId: this.source.id, repository: this.source.repository, sourceBranch: this.source.branch, baseBranch: this.source.baseBranch, commitSha: null });
    const timeout = new Promise<ContinuationPreview>(resolve => { this.timer = setTimeout(() => { controller.abort(); resolve(unknown('The published-work check timed out. Refresh to try again.')); }, 45_000); });
    const request = Promise.resolve().then(() => this.request(controller.signal)).catch(error => unknown((error as Error).message));
    this.pending = Promise.race([request, timeout]).then(value => { if (!this.disposed) this.publish(value); }).finally(() => { if (this.timer) clearTimeout(this.timer); this.timer = null; this.controller = null; this.pending = null; if (!this.disposed) this.loading(false); });
    return this.pending;
  }
  dispose() { this.disposed = true; this.controller?.abort(); if (this.timer) clearTimeout(this.timer); this.timer = null; }
}
