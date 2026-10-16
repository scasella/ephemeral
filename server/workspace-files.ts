import { WORKSPACE_DIRECTORY_MAX_ENTRIES, WORKSPACE_FILE_MAX_BYTES, WORKSPACE_PATH_MAX_BYTES, WORKSPACE_PATH_MAX_DEPTH,
  type WorkspaceDirectory, type WorkspaceFile, type WriteWorkspaceFileInput } from '../shared/workspace-files.js';
const messages: Record<string, string> = {
  invalid_path: 'Choose a valid repository-relative path.', invalid_request: 'The file request is invalid.',
  not_found: 'The requested file or directory does not exist.', conflict: 'The file changed. Reload it before saving.',
  too_large: 'The file exceeds the 128 KiB text limit.', unsupported: 'This entry is not an editable UTF-8 text file or directory.',
  unavailable: 'The running workspace is unavailable. Refresh and try again.',
  busy: 'Too many file requests. Retry shortly.',
  access_denied: 'Repository access could not be verified. Check access and retry.',
  session_unavailable: 'The session ended or its workspace changed. Refresh to retry.',
  outcome_unknown: 'The save result could not be confirmed. Reload the file before retrying.',
};
export class FileOperationError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(messages[code] ?? messages.unavailable); this.name = 'FileOperationError'; }
}
export function validateWorkspacePath(value: unknown, allowRoot = false): string {
  if (typeof value !== 'string' || (!allowRoot && !value) || Buffer.byteLength(value, 'utf8') > WORKSPACE_PATH_MAX_BYTES ||
      /[\p{Cc}\\]/u.test(value) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value) ||
      /^[A-Za-z]:/.test(value) || (value !== '' && (value.split('/').length > WORKSPACE_PATH_MAX_DEPTH ||
        value.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')))) {
    throw new FileOperationError(400, 'invalid_path');
  }
  return value;
}
export function validateWorkspaceWrite(value: unknown): WriteWorkspaceFileInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FileOperationError(400, 'invalid_request');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['path', 'content', 'expectedVersion'].includes(key))) throw new FileOperationError(400, 'invalid_request');
  const path = validateWorkspacePath(input.path);
  if (typeof input.content !== 'string' || (input.expectedVersion !== null &&
      (typeof input.expectedVersion !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedVersion))) ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input.content)) throw new FileOperationError(400, 'invalid_request');
  if (Buffer.byteLength(input.content, 'utf8') > WORKSPACE_FILE_MAX_BYTES) throw new FileOperationError(413, 'too_large');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(input.content)) throw new FileOperationError(415, 'unsupported');
  return { path, content: input.content, expectedVersion: input.expectedVersion as string | null };
}
export function parseWorkspaceFile(value: unknown): WorkspaceFile {
  if (!value || typeof value !== 'object') throw new FileOperationError(503, 'unavailable');
  const file = value as WorkspaceFile;
  try {
    validateWorkspaceWrite({ path: file.path, content: file.content, expectedVersion: file.version });
    if (typeof file.version !== 'string' || !/^[a-f0-9]{64}$/.test(file.version) || typeof file.simulation !== 'boolean') throw new Error();
  } catch { throw new FileOperationError(503, 'unavailable'); }
  return { path: file.path, content: file.content, version: file.version, simulation: file.simulation };
}
export function parseWorkspaceDirectory(value: unknown): WorkspaceDirectory {
  if (!value || typeof value !== 'object') throw new FileOperationError(503, 'unavailable');
  const directory = value as WorkspaceDirectory;
  try {
    validateWorkspacePath(directory.path, true);
    if (!Array.isArray(directory.entries) || directory.entries.length > WORKSPACE_DIRECTORY_MAX_ENTRIES ||
        typeof directory.truncated !== 'boolean' || typeof directory.simulation !== 'boolean') throw new Error();
    const seen = new Set<string>();
    for (const entry of directory.entries) {
      validateWorkspacePath(entry.path);
      if (entry.path !== `${directory.path ? `${directory.path}/` : ''}${entry.name}` || entry.name.includes('/') ||
          seen.has(entry.name) || !['file', 'directory', 'unavailable'].includes(entry.kind)) throw new Error();
      seen.add(entry.name);
    }
  } catch { throw new FileOperationError(503, 'unavailable'); }
  return { path: directory.path, entries: directory.entries.map(({ name, path, kind }) => ({ name, path, kind })),
    truncated: directory.truncated, simulation: directory.simulation };
}
