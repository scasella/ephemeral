import type { EnvironmentProfile } from '../shared/environments.js';
import { sameEnvironment } from './launch-environment.js';
import { z } from 'zod';
import type { Database, HandoffNote, HandoffNotesResponse, InheritedHandoffNote, SaveHandoffNotesInput, SessionRepository } from './contracts.js';

export class HandoffNotesError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
const textField = z.string().transform(value => value.replace(/\r\n/g, '\n'))
  .refine(value => !/[\x00-\x08\x0b-\x1f\x7f]/.test(value), 'Notes cannot contain control characters')
  .transform(value => value.trim()).pipe(z.string().max(2000));
export const handoffNotesInput = z.object({ expectedRevision: z.number().int().min(0).max(2147483646),
  nextStep: textField, unresolvedIssues: textField, verification: textField }).strict();
interface TextRow { next_step: string; unresolved_issues: string; verification: string }
interface NoteRow extends TextRow { revision: number; updated_at: Date | string | null }
interface SnapshotRow extends TextRow { user_id: string; source_session_id: string; source_branch: string;
  source_note_revision: number; source_note_updated_at: Date | string | null; captured_at: Date | string; source_commit_sha: string | null }
export interface CaptureHandoffInput {
  userId: string; sourceSessionId: string; targetSessionId: string; sourceBranch: string;
  commitSha?: string; expectedNoteRevision?: number;
}
export interface ReserveHandoffInput {
  userId: string; sourceSessionId: string; requestId: string; targetSessionId: string; expectedHeadSha: string;
  repository: string; repositoryId: number; installationId: number; sourceBranch: string; baseBranch: string; expectedNoteRevision?: number; environment?: EnvironmentProfile;
}
const emptyNote = (): HandoffNote => ({ revision: 0, updatedAt: null, nextStep: '', unresolvedIssues: '', verification: '' });
function note(row?: NoteRow): HandoffNote { return row ? { revision: Number(row.revision), updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  nextStep: row.next_step, unresolvedIssues: row.unresolved_issues, verification: row.verification } : emptyNote(); }
function snapshot(row: SnapshotRow): InheritedHandoffNote { return { sourceSessionId: row.source_session_id, sourceBranch: row.source_branch,
  sourceNoteRevision: Number(row.source_note_revision), sourceNoteUpdatedAt: row.source_note_updated_at ? new Date(row.source_note_updated_at).toISOString() : null,
  capturedAt: new Date(row.captured_at).toISOString(), nextStep: row.next_step, unresolvedIssues: row.unresolved_issues, verification: row.verification,
  ...(row.source_commit_sha ? { sourceCommitSha: row.source_commit_sha } : {}) }; }
const conflict = () => new HandoffNotesError(409, 'These notes changed. Reload before saving again.', 'note_revision_conflict');

export async function createHandoffNotesService(db: Database, repo: SessionRepository) {
  await db.query(`CREATE TABLE IF NOT EXISTS ephemeral_handoff_notes (
    session_id text PRIMARY KEY REFERENCES ephemeral_sessions(id), user_id text NOT NULL,
    revision integer NOT NULL CHECK(revision>0), updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    next_step text NOT NULL CHECK(length(next_step)<=2000), unresolved_issues text NOT NULL CHECK(length(unresolved_issues)<=2000),
    verification text NOT NULL CHECK(length(verification)<=2000)
  )`);
  // Targets can be reserved before their session is created. Never cascade this durable context with VM cleanup.
  await db.query(`CREATE TABLE IF NOT EXISTS ephemeral_inherited_handoff_notes (
    target_session_id text PRIMARY KEY, user_id text NOT NULL, source_session_id text NOT NULL REFERENCES ephemeral_sessions(id),
    source_branch text NOT NULL, source_commit_sha text, source_note_revision integer NOT NULL CHECK(source_note_revision>=0),
    source_note_updated_at timestamptz, captured_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    next_step text NOT NULL CHECK(length(next_step)<=2000), unresolved_issues text NOT NULL CHECK(length(unresolved_issues)<=2000),
    verification text NOT NULL CHECK(length(verification)<=2000)
  )`);
  async function owned(userId: string, sessionId: string) {
    const session = await repo.get(sessionId);
    if (!session || session.userId !== userId) throw new HandoffNotesError(404, 'Session not found');
    return session;
  }
  async function get(userId: string, sessionId: string): Promise<HandoffNotesResponse> {
    const target = await owned(userId, sessionId);
    const { rows } = await db.query<NoteRow>('SELECT * FROM ephemeral_handoff_notes WHERE session_id=$1 AND user_id=$2', [sessionId, userId]);
    const inherited = await db.query<SnapshotRow>(`SELECT h.* FROM ephemeral_inherited_handoff_notes h
      JOIN ephemeral_sessions source ON source.id=h.source_session_id AND source.user_id=h.user_id
      WHERE h.target_session_id=$1 AND h.user_id=$2`, [sessionId, userId]);
    const row = inherited.rows[0], provenance = target.continuation;
    const matches = row && provenance && provenance.sourceSessionId === row.source_session_id && provenance.sourceBranch === row.source_branch &&
      (!row.source_commit_sha || provenance.commitSha.toLowerCase() === row.source_commit_sha);
    return { sessionId, note: note(rows[0]), inherited: matches ? snapshot(row) : null };
  }
  async function save(userId: string, sessionId: string, raw: SaveHandoffNotesInput): Promise<HandoffNotesResponse> {
    await owned(userId, sessionId);
    const input = handoffNotesInput.parse(raw);
    // The revision check and write are one statement, including the first save of a legacy session.
    const { rows } = await db.query<NoteRow>(`INSERT INTO ephemeral_handoff_notes AS current
      (session_id,user_id,revision,updated_at,next_step,unresolved_issues,verification)
      SELECT id,user_id,1,CURRENT_TIMESTAMP,$4,$5,$6 FROM ephemeral_sessions
      WHERE id=$1 AND user_id=$2 AND ($3=0 OR EXISTS(SELECT 1 FROM ephemeral_handoff_notes WHERE session_id=$1 AND user_id=$2))
      ON CONFLICT(session_id) DO UPDATE SET revision=current.revision+1,updated_at=CURRENT_TIMESTAMP,
        next_step=EXCLUDED.next_step,unresolved_issues=EXCLUDED.unresolved_issues,verification=EXCLUDED.verification
      WHERE current.user_id=$2 AND current.revision=$3 RETURNING *`,
    [sessionId, userId, input.expectedRevision, input.nextStep, input.unresolvedIssues, input.verification]);
    if (!rows.length) throw conflict();
    const result = await get(userId, sessionId);
    return { ...result, note: note(rows[0]) };
  }
  async function existingCapture(input: CaptureHandoffInput): Promise<InheritedHandoffNote | null> {
    const { rows } = await db.query<SnapshotRow>('SELECT * FROM ephemeral_inherited_handoff_notes WHERE target_session_id=$1', [input.targetSessionId]);
    const row = rows[0]; if (!row) return null;
    if (row.user_id !== input.userId || row.source_session_id !== input.sourceSessionId || row.source_branch !== input.sourceBranch ||
      (row.source_commit_sha ?? '') !== (input.commitSha?.toLowerCase() ?? '')) throw new HandoffNotesError(409, 'The saved notes no longer match this continuation.');
    return snapshot(row);
  }
  async function capture(input: CaptureHandoffInput): Promise<InheritedHandoffNote> {
    const source = await owned(input.userId, input.sourceSessionId);
    if (source.branch !== input.sourceBranch || source.id === input.targetSessionId) throw new HandoffNotesError(409, 'The saved notes no longer match this continuation.');
    const target = await repo.get(input.targetSessionId);
    if (target && target.userId !== input.userId) throw new HandoffNotesError(404, 'Session not found');
    const previous = await existingCapture(input); if (previous) return previous;
    const { rows } = await db.query<SnapshotRow>(`INSERT INTO ephemeral_inherited_handoff_notes
      (target_session_id,user_id,source_session_id,source_branch,source_commit_sha,source_note_revision,source_note_updated_at,next_step,unresolved_issues,verification)
      SELECT $3,s.user_id,s.id,$4,$5,COALESCE(n.revision,0),n.updated_at,COALESCE(n.next_step,''),COALESCE(n.unresolved_issues,''),COALESCE(n.verification,'')
      FROM ephemeral_sessions s LEFT JOIN ephemeral_handoff_notes n ON n.session_id=s.id AND n.user_id=s.user_id
      WHERE s.id=$1 AND s.user_id=$2 AND ($6::integer IS NULL OR COALESCE(n.revision,0)=$6)
      ON CONFLICT(target_session_id) DO NOTHING RETURNING *`,
    [input.sourceSessionId, input.userId, input.targetSessionId, input.sourceBranch, input.commitSha?.toLowerCase() ?? null, input.expectedNoteRevision ?? null]);
    if (rows[0]) return snapshot(rows[0]);
    const recovered = await existingCapture(input); if (recovered) return recovered;
    throw conflict();
  }
  async function reserveContinuation(input: ReserveHandoffInput): Promise<{ targetSessionId: string }> {
    const source = await owned(input.userId, input.sourceSessionId);
    if (source.branch !== input.sourceBranch || source.id === input.targetSessionId || source.repository !== input.repository ||
      source.repositoryId !== input.repositoryId || source.installationId !== input.installationId || source.baseBranch !== input.baseBranch) {
      throw new HandoffNotesError(409, 'The saved notes no longer match this continuation.');
    }
    const existing = await db.query<{ target_id: string; expected_sha: string; repository: string; repository_id: number; status: string;
      installation_id: number; source_branch: string; base_branch: string; environment: EnvironmentProfile | null }>(
      'SELECT * FROM ephemeral_continuation_requests WHERE user_id=$1 AND source_id=$2 AND request_id=$3',
      [input.userId, input.sourceSessionId, input.requestId.toLowerCase()]);
    const previous = existing.rows[0];
    if (previous && (previous.expected_sha !== input.expectedHeadSha.toLowerCase() || previous.repository !== input.repository ||
      Number(previous.repository_id) !== input.repositoryId || Number(previous.installation_id) !== input.installationId ||
      previous.source_branch !== input.sourceBranch || previous.base_branch !== input.baseBranch || !sameEnvironment(previous.environment, input.environment))) {
      throw new HandoffNotesError(409, 'The saved continuation no longer matches its source.');
    }
    const target = await repo.get(previous?.target_id ?? input.targetSessionId);
    if (target && target.userId !== input.userId) throw new HandoffNotesError(404, 'Session not found');
    if (previous?.status === 'rejected') return { targetSessionId: previous.target_id };
    // A pre-feature completed continuation has no historical note to reconstruct from today's text.
    if (previous && target && !await existingCapture({ ...input, targetSessionId: previous.target_id, commitSha: input.expectedHeadSha })) {
      return { targetSessionId: previous.target_id };
    }
    // The continuation controller creates the reservation table first. One statement freezes the note
    // with the first reservation; a snapshot failure rolls back both writes without a pooled BEGIN.
    const { rows } = await db.query<{ target_id: string }>(`WITH reviewed AS (
      SELECT s.user_id,s.id,COALESCE(n.revision,0) AS revision,n.updated_at,
        COALESCE(n.next_step,'') AS next_step,COALESCE(n.unresolved_issues,'') AS unresolved_issues,COALESCE(n.verification,'') AS verification
      FROM ephemeral_sessions s LEFT JOIN ephemeral_handoff_notes n ON n.session_id=s.id AND n.user_id=s.user_id
      WHERE s.id=$2 AND s.user_id=$1 AND ($11::integer IS NULL OR COALESCE(n.revision,0)=$11 OR EXISTS (
        SELECT 1 FROM ephemeral_continuation_requests r JOIN ephemeral_inherited_handoff_notes h ON h.target_session_id=r.target_id
        WHERE r.user_id=$1 AND r.source_id=$2 AND r.request_id=$3 AND h.user_id=$1 AND h.source_session_id=$2
      ))
    ), reserved AS (
      INSERT INTO ephemeral_continuation_requests AS previous
        (user_id,source_id,request_id,target_id,expected_sha,repository,repository_id,installation_id,source_branch,base_branch,environment)
      SELECT user_id,id,$3,$4,$5,$6,$7,$8,$9,$10,$12::jsonb FROM reviewed
      ON CONFLICT(user_id,source_id,request_id) DO UPDATE SET request_id=previous.request_id
      WHERE previous.expected_sha=$5 AND previous.repository=$6 AND previous.repository_id=$7 AND previous.installation_id=$8
        AND previous.source_branch=$9 AND previous.base_branch=$10 AND previous.environment IS NOT DISTINCT FROM $12::jsonb RETURNING target_id
    ), captured AS (
      INSERT INTO ephemeral_inherited_handoff_notes
        (target_session_id,user_id,source_session_id,source_branch,source_commit_sha,source_note_revision,source_note_updated_at,next_step,unresolved_issues,verification)
      SELECT reserved.target_id,reviewed.user_id,reviewed.id,$9,$5,reviewed.revision,reviewed.updated_at,
        reviewed.next_step,reviewed.unresolved_issues,reviewed.verification FROM reserved CROSS JOIN reviewed
      ON CONFLICT(target_session_id) DO NOTHING RETURNING target_session_id
    ) SELECT target_id FROM reserved`,
    [input.userId, input.sourceSessionId, input.requestId.toLowerCase(), input.targetSessionId, input.expectedHeadSha.toLowerCase(),
      input.repository, input.repositoryId, input.installationId, input.sourceBranch, input.baseBranch, previous ? null : input.expectedNoteRevision ?? null, input.environment ? JSON.stringify(input.environment) : null]);
    if (!rows[0]) {
      const prior = await db.query<{ expected_sha: string }>('SELECT expected_sha FROM ephemeral_continuation_requests WHERE user_id=$1 AND source_id=$2 AND request_id=$3',
        [input.userId, input.sourceSessionId, input.requestId.toLowerCase()]);
      if (prior.rows[0] && prior.rows[0].expected_sha !== input.expectedHeadSha.toLowerCase()) throw new HandoffNotesError(409, 'This continuation request was already used for a different commit.');
      throw conflict();
    }
    await existingCapture({ ...input, targetSessionId: rows[0].target_id, commitSha: input.expectedHeadSha });
    return { targetSessionId: rows[0].target_id };
  }
  return { get, save, capture, reserveContinuation };
}
export type HandoffNotesService = Awaited<ReturnType<typeof createHandoffNotesService>>;
