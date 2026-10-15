import type { PublishedChanges } from '../server/github/published-changes';
export type { PublishedChanges };

export interface PublishedPair { headSha: string; baseSha: string }
const bytes = (value: string) => new TextEncoder().encode(value).length;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(value);
const text = (value: unknown, max: number) => typeof value === 'string' && bytes(value) <= max && new TextDecoder().decode(new TextEncoder().encode(value)) === value;
const nullableText = (value: unknown, max: number) => value === null || text(value, max);
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const path = (value: unknown): value is string => text(value, 4096) && (value as string).length > 0 && !/[\u0000-\u001f\u007f-\u009f]/.test(value as string) && !(value as string).startsWith('/') && !/^[a-z]:/i.test(value as string) && !(value as string).split('/').some(part => !part || part === '.' || part === '..');
const repository = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && value.length <= 512 && !value.split('/').some(part => part === '.' || part === '..');

/** Construct this link from verified repository and exact commits, never from arbitrary response URLs. */
export function publishedComparisonUrl(value: Pick<PublishedChanges, 'repository' | 'headSha' | 'baseSha'>): string | null {
  return repository(value.repository) && sha(value.headSha) && sha(value.baseSha) ? `https://github.com/${value.repository}/compare/${value.baseSha}...${value.headSha}` : null;
}
export function validatePublishedChanges(value: unknown, requestedPath: string | null, expected: PublishedPair | null = null): PublishedChanges {
  const invalid = (): never => { throw new Error('The published comparison could not be verified. Refresh review to try again.'); };
  if (!object(value) || !['known', 'unknown', 'unavailable', 'unpublished', 'no_changes'].includes(value.state as string) || !text(value.checkedAt, 64) || !Number.isFinite(Date.parse(value.checkedAt as string)) || !nullableText(value.reason, 4096) || !repository(value.repository) || !text(value.headBranch, 4096) || !text(value.baseBranch, 4096) || !(value.headBranch as string).length || !(value.baseBranch as string).length || typeof value.listTruncated !== 'boolean' || !Array.isArray(value.files) || value.files.length > 200) return invalid();
  for (const key of ['headSha', 'baseSha', 'mergeBaseSha']) if (!(value[key] === null || sha(value[key]))) return invalid();
  for (const key of ['aheadCommits', 'behindCommits']) if (!(value[key] === null || count(value[key]))) return invalid();
  const verified = value as unknown as PublishedChanges;
  if (!(value.comparisonUrl === null || value.comparisonUrl === publishedComparisonUrl(verified))) return invalid();
  const paths = new Set<string>();
  for (const file of value.files) {
    if (!object(file) || !path(file.path) || !(file.previousPath === null || path(file.previousPath)) || (file.status === 'renamed' && file.previousPath === null) || paths.has(file.path) || !['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged'].includes(file.status as string) || !count(file.additions) || !count(file.deletions) || !count(file.changes) || !count((file.additions as number) + (file.deletions as number)) || file.changes !== (file.additions as number) + (file.deletions as number)) return invalid();
    paths.add(file.path);
  }
  if (value.state === 'known') {
    if (!sha(value.headSha) || !sha(value.baseSha) || !sha(value.mergeBaseSha) || !count(value.aheadCommits) || !count(value.behindCommits)) return invalid();
  } else if (value.files.length || value.selected !== null || value.listTruncated) return invalid();
  if (expected && (value.state === 'known' || value.state === 'no_changes') && (value.headSha !== expected.headSha || value.baseSha !== expected.baseSha)) return invalid();
  if (value.selected !== null) {
    const selected = value.selected;
    if (!object(selected) || value.state !== 'known' || !path(selected.path) || selected.path !== requestedPath || !['patch', 'unavailable', 'too_large'].includes(selected.state as string) || !nullableText(selected.reason, 4096) || typeof selected.truncated !== 'boolean') return invalid();
    if (selected.state === 'patch') { if (!text(selected.text, 65536) || !paths.has(selected.path)) return invalid(); }
    else if (selected.text !== null) return invalid();
    if (!paths.has(selected.path) && selected.state !== 'unavailable') return invalid();
  }
  if (!requestedPath && value.selected !== null) return invalid();
  if (requestedPath && value.state === 'known' && value.selected === null && (paths.has(requestedPath) || value.listTruncated)) return invalid();
  return verified;
}
export function publishedChangesRequestUrl(sessionId: string, selectedPath: string | null, expected: PublishedPair | null = null): string {
  if (selectedPath && !expected) throw new Error('Refresh review before selecting a published file.');
  const query = new URLSearchParams();
  if (selectedPath !== null) query.set('path', selectedPath);
  if (expected) { query.set('expectedHeadSha', expected.headSha); query.set('expectedBaseSha', expected.baseSha); }
  return `/sessions/${encodeURIComponent(sessionId)}/published-changes${query.size ? `?${query}` : ''}`;
}
export async function requestPublishedChanges(sessionId: string, selectedPath: string | null, expected: PublishedPair | null, signal: AbortSignal): Promise<PublishedChanges> {
  const response = await fetch(`/api${publishedChangesRequestUrl(sessionId, selectedPath, expected)}`, { credentials: 'same-origin', signal });
  const limit = 2 * 1024 * 1024;
  const length = response.headers.get('content-length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > limit) { await response.body?.cancel(); throw new Error('The published comparison exceeded the response limit. Refresh review or review it on GitHub.'); }
  if (!response.body) throw new Error('The published comparison response is unavailable. Refresh review to try again.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('The published comparison exceeded the response limit. Refresh review or review it on GitHub.'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  signal.throwIfAborted();
  const buffer = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  let data: unknown;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); }
  catch { throw new Error('The published comparison could not be verified. Refresh review to try again.'); }
  if (!response.ok) throw new Error(object(data) && text(data.error, 4096) ? data.error as string : `Published comparison failed (${response.status}). Refresh review to try again.`);
  return validatePublishedChanges(data, selectedPath, expected);
}
export interface PublishedViewState { snapshot: PublishedChanges | null; latest: PublishedChanges | null; selectedPath: string | null; loading: boolean; stale: boolean; error: string; selectionNotice: string }
export const emptyPublishedView: PublishedViewState = { snapshot: null, latest: null, selectedPath: null, loading: false, stale: false, error: '', selectionNotice: '' };
export type PublishedAction = { type: 'start'; path: string | null } | { type: 'result'; path: string | null; value: PublishedChanges } | { type: 'failure'; message: string } | { type: 'invalidate'; message: string };
export function reducePublished(state: PublishedViewState, action: PublishedAction): PublishedViewState {
  const hidden = state.snapshot ? { ...state.snapshot, selected: null } : null;
  if (action.type === 'start') return { ...state, snapshot: hidden, latest: null, selectedPath: action.path, loading: true, stale: Boolean(hidden), error: '', selectionNotice: state.selectedPath && !action.path ? 'Select a file again after refreshing to review the current comparison.' : '' };
  if (action.type === 'failure' || action.type === 'invalidate') return { ...state, snapshot: hidden, latest: null, loading: false, stale: Boolean(hidden), error: action.message };
  if (action.path !== state.selectedPath) return state;
  if (action.value.state !== 'known' && action.value.state !== 'no_changes') return { ...state, snapshot: hidden, latest: action.value, loading: false, stale: Boolean(hidden), error: action.value.reason || 'Published work could not be confirmed. Refresh review to try again.' };
  const removed = action.path !== null && !action.value.listTruncated && !action.value.files.some(file => file.path === action.path);
  return { snapshot: removed ? { ...action.value, selected: null } : action.value, latest: action.value, selectedPath: removed ? null : action.path, loading: false, stale: false, error: '', selectionNotice: removed ? 'The selected file is no longer in the published comparison. Choose another file.' : state.selectionNotice };
}
export function publishedReviewReady(state: PublishedViewState, now: number): boolean {
  const value = state.snapshot;
  return Boolean(value && !state.loading && !state.stale && value.state === 'known' && value.headSha && value.baseSha && value.mergeBaseSha && (value.aheadCommits ?? 0) > 0 && value.files.length > 0 && now - Date.parse(value.checkedAt) <= 60_000 && Date.parse(value.checkedAt) <= now + 5_000);
}
/** Transport cancellation and a revision fence also cover transports that ignore AbortSignal. */
export class PublishedChangesLoader {
  private disposed = false;
  private revision = 0;
  private active: { key: string; controller: AbortController; timer: ReturnType<typeof setTimeout>; pending: Promise<void>; cancel: () => void } | null = null;
  constructor(private request: (path: string | null, expected: PublishedPair | null, signal: AbortSignal) => Promise<PublishedChanges>, private publish: (action: PublishedAction) => void, private accepts: () => boolean = () => true) {}
  refresh(path: string | null, expected: PublishedPair | null = null): Promise<void> {
    if (this.disposed || !this.accepts()) return Promise.resolve();
    const key = JSON.stringify([path, expected?.headSha, expected?.baseSha]);
    if (this.active?.key === key) return this.active.pending;
    this.cancel();
    const revision = ++this.revision, controller = new AbortController();
    const current = () => !this.disposed && revision === this.revision && this.accepts();
    this.publish({ type: 'start', path });
    let timer!: ReturnType<typeof setTimeout>, cancel = () => {};
    const timeout = new Promise<never>((_, reject) => { cancel = () => reject(new Error('Published comparison cancelled.')); timer = setTimeout(() => { controller.abort(); reject(new Error('Published comparison timed out. Refresh review to try again.')); }, 60_000); });
    const request = Promise.resolve().then(() => { if (!current()) throw new Error('Published comparison cancelled.'); return this.request(path, expected, controller.signal); });
    const pending = Promise.race([request, timeout]).then(value => { if (current()) this.publish({ type: 'result', path, value }); }).catch(error => { if (current()) this.publish({ type: 'failure', message: error instanceof Error ? error.message : 'Published comparison failed. Refresh review to try again.' }); }).finally(() => { clearTimeout(timer); if (revision === this.revision) this.active = null; });
    this.active = { key, controller, timer, pending, cancel }; return pending;
  }
  private cancel() { this.revision++; if (this.active) { this.active.controller.abort(); clearTimeout(this.active.timer); this.active.cancel(); } this.active = null; }
  invalidate(message: string) { this.cancel(); if (!this.disposed) this.publish({ type: 'invalidate', message }); }
  dispose() { this.disposed = true; this.cancel(); }
}
