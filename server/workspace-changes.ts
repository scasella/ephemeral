/** An on-demand observation. File contents are never persisted. */
export interface WorkspaceChanges {
  state: 'known' | 'unknown' | 'unavailable';
  checkedAt: string;
  reason: string | null;
  headSha: string | null;
  files: { path: string; oldPath: string | null; status: string; kind: 'tracked' | 'untracked' }[];
  listTruncated: boolean;
  selected: null | { path: string; state: 'text' | 'binary' | 'too_large' | 'symlink' | 'unavailable';
    text: string | null; reason: string | null; truncated: boolean };
}

export const CHANGE_MAX_FILES = 200;
export const CHANGE_MAX_PATH_BYTES = 4096;
export const CHANGE_MAX_TEXT_BYTES = 65_536;

/** Paths are opaque Git names, never shell expressions or filesystem traversal. */
export function isChangePath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && Buffer.byteLength(path, 'utf8') <= CHANGE_MAX_PATH_BYTES &&
    !path.includes('\0') && !path.startsWith('/') && !/^[A-Za-z]:/.test(path) &&
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..') &&
    Buffer.from(path, 'utf8').toString('utf8') === path;
}

export function unavailableWorkspaceChanges(reason: string): WorkspaceChanges {
  return { state: 'unavailable', checkedAt: new Date().toISOString(), reason, headSha: null,
    files: [], listTruncated: false, selected: null };
}

/** Reject incomplete or excessive provider transport responses before they reach the browser. */
export function parseWorkspaceChanges(value: unknown): WorkspaceChanges {
  if (!value || typeof value !== 'object') throw new Error('Invalid change inspection.');
  const v = value as WorkspaceChanges;
  if (!['known', 'unknown', 'unavailable'].includes(v.state) || typeof v.checkedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.checkedAt) ||
    !Number.isFinite(Date.parse(v.checkedAt)) || (v.reason !== null && (typeof v.reason !== 'string' || v.reason.length > 1000)) ||
    (v.headSha !== null && (typeof v.headSha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v.headSha))) ||
    typeof v.listTruncated !== 'boolean' || !Array.isArray(v.files) || v.files.length > CHANGE_MAX_FILES) throw new Error('Invalid change inspection.');
  const paths = new Set<string>();
  for (const file of v.files) {
    if (!file || !isChangePath(file.path) || (file.oldPath !== null && !isChangePath(file.oldPath)) ||
      !['tracked', 'untracked'].includes(file.kind) || typeof file.status !== 'string' ||
      !(file.kind === 'untracked' ? file.status === '??' : /^[ MADRCUT]{2}$/.test(file.status) && file.status !== '  ') ||
      paths.has(file.path)) throw new Error('Invalid change inspection.');
    paths.add(file.path);
  }
  if (v.selected !== null) {
    const selected = v.selected;
    if (!selected || !isChangePath(selected.path) || !['text', 'binary', 'too_large', 'symlink', 'unavailable'].includes(selected.state) ||
      selected.truncated !== false || (selected.reason !== null && (typeof selected.reason !== 'string' || selected.reason.length > 1000)) ||
      (selected.state === 'text' ? typeof selected.text !== 'string' || Buffer.byteLength(selected.text, 'utf8') > CHANGE_MAX_TEXT_BYTES : selected.text !== null)) {
      throw new Error('Invalid change inspection.');
    }
  }
  if (v.state !== 'known' && (v.headSha !== null || v.files.length !== 0 || v.listTruncated || v.selected !== null)) throw new Error('Invalid change inspection.');
  if (v.state === 'known' && v.headSha === null) throw new Error('Invalid change inspection.');
  if (v.selected !== null && !paths.has(v.selected.path) && v.selected.state !== 'unavailable') throw new Error('Invalid change inspection.');
  return { state: v.state, checkedAt: v.checkedAt, reason: v.reason, headSha: v.headSha,
    files: v.files.map(({ path, oldPath, status, kind }) => ({ path, oldPath, status, kind })),
    listTruncated: v.listTruncated, selected: v.selected === null ? null : {
      path: v.selected.path, state: v.selected.state, text: v.selected.text, reason: v.selected.reason, truncated: v.selected.truncated,
    } };
}
