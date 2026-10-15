import type { WorkStatus } from './workspace-status.js';
import type { WorkspaceChanges } from './workspace-changes.js';

export type SessionState = 'provisioning' | 'running' | 'cleanup_pending' | 'ended' | 'failed';
export type CleanupState = 'pending' | 'confirmed' | 'failed' | 'not_applicable';
export interface SessionContinuation { sourceSessionId: string; sourceBranch: string; commitSha: string; verifiedAt: string }
export interface HandoffNoteFields { nextStep: string; unresolvedIssues: string; verification: string }
export interface HandoffNote extends HandoffNoteFields { revision: number; updatedAt: string | null }
export interface InheritedHandoffNote extends HandoffNoteFields {
  sourceSessionId: string; sourceBranch: string; sourceNoteRevision: number; sourceNoteUpdatedAt: string | null;
  capturedAt: string; sourceCommitSha?: string;
}
export interface HandoffNotesResponse { sessionId: string; note: HandoffNote; inherited: InheritedHandoffNote | null }
export interface SaveHandoffNotesInput extends HandoffNoteFields { expectedRevision: number }
export interface Session {
  id: string; userId: string; repository: string; repositoryId: number; installationId: number;
  baseBranch: string; branch: string; state: SessionState; createdAt: string; expiresAt: string;
  maxExpiresAt: string; sandboxId: string | null; endedAt: string | null; error: string | null;
  cleanup: { vm: CleanupState; github: CleanupState; gateway: CleanupState; codex: CleanupState };
  codexRemoteRevocation: 'unverified';
  continuation?: SessionContinuation;
  label?: string;
}
export interface SessionEvent { id: string; sessionId: string; at: string; kind: string; message: string }
export interface CreateSessionInput { userId: string; repository: string; repositoryId: number; installationId: number; baseBranch: string; continuation?: SessionContinuation }
export interface TerminalConnection { write(data: string): Promise<void>; resize(cols: number, rows: number): Promise<void>; disconnect(): Promise<void> }
export interface SetupCommand { runId: string; command: string; timeoutMs: number; deadlineAt: string }
export interface SetupCommandResult { status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled'; exitCode: number | null }
export type TerminalShellState = 'open' | 'closed' | 'unknown';
/** Server-only transport credentials. Never serialize this target into an API response. */
export interface PreviewTarget { origin: string; headers: Record<string, string> }
export interface SandboxProvider {
  previewTarget?(session: Session, port: number, signal?: AbortSignal): Promise<PreviewTarget>;
  ensureShell?(session: Session, shellId: string): Promise<TerminalShellState>;
  inspectShell?(session: Session, shellId: string): Promise<TerminalShellState>;
  closeShell?(session: Session, shellId: string): Promise<TerminalShellState>;
  inspectWorkspace?(session: Session): Promise<WorkStatus>;
  inspectChanges?(session: Session, path?: string): Promise<WorkspaceChanges>;
  runSetup?(session: Session, input: SetupCommand, onOutput: (text: string) => void, signal: AbortSignal): Promise<SetupCommandResult>;
  create(session: Session, gatewayToken: string): Promise<string>;
  prepare(session: Session): Promise<void>;
  setTimeout(sandboxId: string, timeoutMs: number): Promise<void>;
  kill(sandboxId: string): Promise<void>;
  exists(sandboxId: string): Promise<boolean>;
  cleanupCodex(sandboxId: string): Promise<boolean>;
  connectTerminal(sandboxId: string, onData: (data: Uint8Array) => void, cols: number, rows: number, shellId?: string): Promise<TerminalConnection>;
}
export interface GatewayCredentials {
  issue(session: Session): Promise<string>;
  disable(sessionId: string): Promise<void>;
  revokeGitHub(sessionId: string): Promise<void>;
}
export interface SessionRepository {
  insert(session: Session): Promise<void>;
  get(id: string): Promise<Session | null>;
  list(userId?: string): Promise<Session[]>;
  update(session: Session): Promise<void>;
  event(sessionId: string, kind: string, message: string): Promise<void>;
  events(sessionId: string): Promise<SessionEvent[]>;
}
export interface Database {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}
export interface Identity { id: string; login: string; avatarUrl: string }
