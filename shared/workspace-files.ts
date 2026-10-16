/** Repository-relative UTF-8 text editing limits, shared by browser and server. */
export const WORKSPACE_FILE_MAX_BYTES = 128 * 1024;
export const WORKSPACE_DIRECTORY_MAX_ENTRIES = 200;
export const WORKSPACE_PATH_MAX_BYTES = 1024;
export const WORKSPACE_PATH_MAX_DEPTH = 32;
export interface WorkspaceFileEntry { name: string; path: string; kind: 'file' | 'directory' | 'unavailable' }
export interface WorkspaceDirectory { path: string; entries: WorkspaceFileEntry[]; truncated: boolean; simulation: boolean }
export interface WorkspaceFile { path: string; content: string; version: string; simulation: boolean }
export interface WriteWorkspaceFileInput { path: string; content: string; expectedVersion: string | null }
