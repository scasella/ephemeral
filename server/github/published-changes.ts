import type { Session } from '../contracts.js';
import { GitHubError, safeRepository } from './security.js';

export interface PublishedChangeFile {
  path: string;
  previousPath: string | null;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
}
export interface PublishedSelectedPatch {
  path: string;
  state: 'patch' | 'unavailable' | 'too_large';
  text: string | null;
  reason: string | null;
  truncated: boolean;
}
export interface PublishedChanges {
  state: 'known' | 'unknown' | 'unavailable' | 'unpublished' | 'no_changes';
  checkedAt: string;
  reason: string | null;
  repository: string;
  headBranch: string;
  baseBranch: string;
  headSha: string | null;
  baseSha: string | null;
  mergeBaseSha: string | null;
  aheadCommits: number | null;
  behindCommits: number | null;
  comparisonUrl: string | null;
  listTruncated: boolean;
  files: PublishedChangeFile[];
  selected: PublishedSelectedPatch | null;
}
export interface PublishedChangesQuery { path?: string; expectedHeadSha?: string; expectedBaseSha?: string }
export class PublishedChangesError extends Error {
  constructor(message: string, public status = 502, public code = 'published_review_unavailable') { super(message); }
}

export const PUBLISHED_MAX_FILES = 200;
export const PUBLISHED_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const PUBLISHED_MAX_PATCH_BYTES = 65_536;
const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const statuses = new Set(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']);
const changed = () => new PublishedChangesError('The published head or base changed during this review. Refresh to review the current commits.', 409, 'published_review_changed');

export function isPublishedChangePath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && Buffer.byteLength(path, 'utf8') <= 4096 &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(path) && !path.startsWith('/') && !/^[A-Za-z]:/.test(path) &&
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..') &&
    Buffer.from(path, 'utf8').toString('utf8') === path;
}

export function validatePublishedChangesQuery(query: PublishedChangesQuery): PublishedChangesQuery {
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => !['path', 'expectedHeadSha', 'expectedBaseSha'].includes(key)) ||
    (query.path !== undefined && !isPublishedChangePath(query.path)) ||
    (query.expectedHeadSha !== undefined && (typeof query.expectedHeadSha !== 'string' || !shaPattern.test(query.expectedHeadSha))) ||
    (query.expectedBaseSha !== undefined && (typeof query.expectedBaseSha !== 'string' || !shaPattern.test(query.expectedBaseSha))) ||
    ((query.expectedHeadSha === undefined) !== (query.expectedBaseSha === undefined)) ||
    (query.path !== undefined && query.expectedHeadSha === undefined)) {
    throw new PublishedChangesError('Invalid published review query. File selection requires both reviewed commit IDs.', 400, 'invalid_published_query');
  }
  return { ...(query.path !== undefined ? { path: query.path } : {}),
    ...(query.expectedHeadSha !== undefined ? { expectedHeadSha: query.expectedHeadSha.toLowerCase(), expectedBaseSha: query.expectedBaseSha!.toLowerCase() } : {}) };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid GitHub metadata');
  return value as Record<string, unknown>;
}
function sha(value: unknown): string {
  if (typeof value !== 'string' || !shaPattern.test(value)) throw new Error('Invalid GitHub commit');
  return value.toLowerCase();
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid GitHub count');
  return value;
}
function ref(value: unknown, branch: string): string {
  const remote = record(value), object = record(remote.object);
  if (remote.ref !== `refs/heads/${branch}` || object.type !== 'commit') throw new Error('Invalid GitHub ref');
  return sha(object.sha);
}

class ReadFailure extends Error { constructor(public upstreamStatus: number) { super('GitHub read failed'); } }
class ResponseLimit extends Error {}

/** This reader never follows returned URLs and never requests file/blob contents.
 * One deadline and byte budget cover repository metadata, refs, and comparison.
 */
function reader(token: string, signal: AbortSignal, abort: () => void) {
  let remaining = PUBLISHED_MAX_RESPONSE_BYTES;
  return async (path: string): Promise<unknown> => {
    signal.throwIfAborted();
    const response = await fetch(`https://api.github.com${path}`, { method: 'GET', redirect: 'error', signal,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Ephemeral' } });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) throw new PublishedChangesError('GitHub access is no longer available to this account.', 403, 'published_review_forbidden');
      throw new ReadFailure(response.status);
    }
    const length = response.headers.get('content-length');
    if (length !== null && /^\d+$/.test(length) && Number(length) > remaining) {
      void response.body?.cancel().catch(() => {}); abort(); throw new ResponseLimit();
    }
    if (!response.body) throw new Error('Missing GitHub response');
    const stream = response.body.getReader(), chunks: Uint8Array[] = [];
    const cancel = () => { void stream.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      while (true) {
        signal.throwIfAborted();
        const next = await stream.read();
        if (next.done) break;
        remaining -= next.value.byteLength;
        if (remaining < 0) { cancel(); abort(); throw new ResponseLimit(); }
        chunks.push(next.value);
      }
    } finally { signal.removeEventListener('abort', cancel); stream.releaseLock(); }
    signal.throwIfAborted();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  };
}

function selectedPatch(path: string, files: PublishedChangeFile[], remote: Record<string, unknown>[], listTruncated: boolean): PublishedSelectedPatch {
  const index = files.findIndex(file => file.path === path);
  if (index < 0) return { path, state: 'unavailable', text: null, truncated: listTruncated,
    reason: listTruncated ? 'This file is outside the bounded file list. Open the commit-pinned GitHub comparison.' : 'This file is not in the published comparison.' };
  const patch = remote[index].patch;
  if (patch === undefined || patch === null || patch === '' || (typeof patch === 'string' && patch.includes('\0'))) {
    return { path, state: 'unavailable', text: null, truncated: true,
      reason: 'GitHub did not provide a displayable patch. The file may be binary or its patch may have been omitted.' };
  }
  if (typeof patch !== 'string' || Buffer.from(patch, 'utf8').toString('utf8') !== patch) throw new Error('Invalid GitHub patch');
  if (Buffer.byteLength(patch, 'utf8') > PUBLISHED_MAX_PATCH_BYTES) return { path, state: 'too_large', text: null, truncated: true,
    reason: 'The patch exceeds the 64 KiB display limit. Open the commit-pinned GitHub comparison.' };
  let additions = 0, deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+')) additions++;
    if (line.startsWith('-')) deletions++;
  }
  const truncated = additions !== files[index].additions || deletions !== files[index].deletions;
  return { path, state: 'patch', text: patch, truncated,
    reason: truncated ? 'GitHub returned a partial patch. Open the commit-pinned GitHub comparison for further review.' : null };
}

export async function readPublishedChanges(session: Session, userToken: string, authorize: (signal: AbortSignal) => Promise<void>, input: PublishedChangesQuery = {}, callerSignal?: AbortSignal): Promise<PublishedChanges> {
  const query = validatePublishedChangesQuery(input);
  const initial: PublishedChanges = { state: 'unknown', checkedAt: new Date().toISOString(),
    reason: 'GitHub could not verify the published comparison. Refresh to retry.', repository: session.repository,
    headBranch: session.branch, baseBranch: session.baseBranch, headSha: null, baseSha: null, mergeBaseSha: null,
    aheadCommits: null, behindCommits: null, comparisonUrl: null, listTruncated: false, files: [], selected: null };
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 20_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
  let removeAbort: (() => void) | undefined;
  const checkAccess = async () => {
    signal.throwIfAborted();
    try {
      await Promise.race([authorize(signal), new Promise<never>((_, reject) => {
        const listener = () => reject(new Error('Published read aborted'));
        signal.addEventListener('abort', listener, { once: true });
        removeAbort = () => signal.removeEventListener('abort', listener);
        if (signal.aborted) listener();
      })]);
    } finally { removeAbort?.(); }
    signal.throwIfAborted();
  };
  try {
    const repository = safeRepository(session.repository);
    // Authorization must complete before the first repository/ref/compare read.
    await checkAccess();
    const read = reader(userToken, signal, () => controller.abort());
    const repo = record(await read(`/repos/${repository}`));
    if (repo.id !== session.repositoryId || repo.full_name !== repository) throw new PublishedChangesError('The repository identity is no longer available to this session.', 403, 'published_review_forbidden');
    const basePath = `/repos/${repository}/git/ref/heads/${encodeURIComponent(session.baseBranch)}`;
    const headPath = `/repos/${repository}/git/ref/heads/${encodeURIComponent(session.branch)}`;
    let baseSha: string, headSha: string;
    try { baseSha = ref(await read(basePath), session.baseBranch); }
    catch (error) {
      if (error instanceof ReadFailure && error.upstreamStatus === 404) {
        if (query.expectedBaseSha) throw changed();
        return { ...initial, state: 'unavailable', reason: 'The selected pull request base branch no longer exists on GitHub.' };
      }
      throw error;
    }
    try { headSha = ref(await read(headPath), session.branch); }
    catch (error) {
      if (error instanceof ReadFailure && error.upstreamStatus === 404) {
        if (query.expectedHeadSha) throw changed();
        return { ...initial, state: 'unpublished', baseSha, reason: 'No published session branch is available on GitHub. Push the assigned branch before reviewing published changes.' };
      }
      throw error;
    }
    if (query.expectedHeadSha && (query.expectedHeadSha !== headSha || query.expectedBaseSha !== baseSha)) throw changed();
    const comparison = record(await read(`/repos/${repository}/compare/${baseSha}...${headSha}?per_page=1&page=1`));
    const aheadCommits = count(comparison.ahead_by), behindCommits = count(comparison.behind_by);
    const mergeBaseSha = sha(record(comparison.merge_base_commit).sha);
    if (sha(record(comparison.base_commit).sha) !== baseSha || !['ahead', 'behind', 'identical', 'diverged'].includes(String(comparison.status)) ||
      !Array.isArray(comparison.files) || comparison.files.length > 300) throw new Error('Invalid GitHub comparison');
    const expectedStatus = aheadCommits ? (behindCommits ? 'diverged' : 'ahead') : (behindCommits ? 'behind' : 'identical');
    if (comparison.status !== expectedStatus) throw new Error('Invalid GitHub comparison status');
    const paths = new Set<string>();
    const remote = comparison.files.map(record);
    const allFiles = remote.map(file => {
      if (!isPublishedChangePath(file.filename) || paths.has(file.filename) || !statuses.has(String(file.status)) ||
        (file.previous_filename !== undefined && !isPublishedChangePath(file.previous_filename)) ||
        (file.status === 'renamed' && file.previous_filename === undefined)) throw new Error('Invalid GitHub file metadata');
      paths.add(file.filename);
      const additions = count(file.additions), deletions = count(file.deletions), changes = count(file.changes);
      if (!Number.isSafeInteger(additions + deletions) || changes !== additions + deletions) throw new Error('Invalid GitHub file counts');
      return { path: file.filename, previousPath: (file.previous_filename as string | undefined) ?? null,
        status: file.status as PublishedChangeFile['status'], additions, deletions, changes };
    });
    const files = allFiles.slice(0, PUBLISHED_MAX_FILES);
    // GitHub supplies at most 300 files. Even exactly 300 cannot prove completeness.
    const listTruncated = allFiles.length > PUBLISHED_MAX_FILES || allFiles.length === 300;
    const selected = query.path ? selectedPatch(query.path, files, remote, listTruncated) : null;
    await checkAccess();
    // Never return content observed before a ref move, including branch deletion.
    let currentBase: string, currentHead: string;
    try { currentBase = ref(await read(basePath), session.baseBranch); currentHead = ref(await read(headPath), session.branch); }
    catch (error) { if (error instanceof ReadFailure && error.upstreamStatus === 404) throw changed(); throw error; }
    if (currentBase !== baseSha || currentHead !== headSha) throw changed();
    const noChanges = !aheadCommits || !allFiles.length;
    return { ...initial, state: !aheadCommits || !allFiles.length ? 'no_changes' : 'known',
      reason: !aheadCommits || !allFiles.length ? 'The published branch has no changes to propose against the selected base.' : null,
      headSha, baseSha, mergeBaseSha, aheadCommits, behindCommits,
      comparisonUrl: `https://github.com/${repository}/compare/${baseSha}...${headSha}`, listTruncated,
      files: noChanges ? [] : files, selected: noChanges ? null : selected };
  } catch (error) {
    if (error instanceof PublishedChangesError) throw error;
    if (error instanceof GitHubError && error.status === 403) throw new PublishedChangesError('Repository is no longer accessible to this account and App installation.', 403, 'published_review_forbidden');
    if (error instanceof ResponseLimit) return { ...initial, reason: 'The GitHub comparison exceeded the 2 MiB response limit. Review the published branches on GitHub.' };
    return initial;
  } finally { clearTimeout(deadline); removeAbort?.(); }
}
