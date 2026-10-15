import { randomUUID } from 'node:crypto';
import type { CreateSessionInput, Database, Session, SessionRepository } from './contracts.js';
import type { HandoffNotesService } from './handoff-notes.js';
import { SessionNotCreatedError } from './core/provisioning.js';
import { SESSION_UUID } from './core/continuation.js';

export interface ContinuationPreview {
  state: 'ready' | 'unpublished' | 'unavailable' | 'unknown'; checkedAt: string; reason: string | null;
  sourceSessionId: string; repository: string; sourceBranch: string; baseBranch: string; commitSha: string | null;
}
export class ContinuationError extends Error {
  readonly code?: 'CONTINUATION_REJECTED'; readonly outcome?: 'not_created';
  constructor(public status: number, message: string, rejected = false) {
    super(message);
    if (rejected) { this.code = 'CONTINUATION_REJECTED'; this.outcome = 'not_created'; }
  }
}
export function continuationPreview(source: Session, state: ContinuationPreview['state'], reason: string | null): ContinuationPreview {
  return { state, checkedAt: new Date().toISOString(), reason, sourceSessionId: source.id, repository: source.repository,
    sourceBranch: source.branch, baseBranch: source.baseBranch, commitSha: null };
}
export function canContinueSession(source: Session): boolean {
  return SESSION_UUID.test(source.id) && source.branch === `ephemeral/${source.id}` &&
    (source.state === 'ended' || source.state === 'failed') && source.cleanup.vm === 'confirmed' &&
    source.cleanup.github === 'confirmed' && source.cleanup.gateway === 'confirmed' &&
    ['confirmed', 'not_applicable'].includes(source.cleanup.codex);
}
interface ContinuationGitHub {
  authorizeContinuation(source: Session, accessToken: string): Promise<void>;
  continuationPreview(source: Session, accessToken: string): Promise<ContinuationPreview>;
}
interface Reservation {
  user_id: string; source_id: string; request_id: string; target_id: string; expected_sha: string;
  repository: string; repository_id: number; installation_id: number; source_branch: string; base_branch: string;
  status: 'reserved' | 'creating' | 'rejected'; rejection_reason: string | null;
}
interface SessionCreator { create(input: CreateSessionInput, options?: { id?: string }): Promise<Session> }
export async function createContinuationController(db: Database, repo: SessionRepository, manager: SessionCreator,
  github: ContinuationGitHub | null, published: (id: string) => Promise<unknown[]>, notes?: Pick<HandoffNotesService, 'reserveContinuation'>) {
  // Reserve a unique target before session creation. This survives a lost HTTP response or a server crash.
  await db.query(`CREATE TABLE IF NOT EXISTS ephemeral_continuation_requests (
    user_id text NOT NULL, source_id text NOT NULL, request_id text NOT NULL, target_id text UNIQUE NOT NULL,
    expected_sha text NOT NULL, repository text NOT NULL, repository_id bigint NOT NULL,
    installation_id bigint NOT NULL, source_branch text NOT NULL, base_branch text NOT NULL,
    status text NOT NULL DEFAULT 'reserved', rejection_reason text,
    PRIMARY KEY(user_id,source_id,request_id)
  )`);
  const requests = new Map<string, Promise<void>>();
  const unavailable = (source: Session) => continuationPreview(source, 'unavailable', !github ?
    'Preview cannot verify published GitHub work or continue it in a real workspace.' :
    'End the source session and finish its cleanup before continuing saved work.');
  async function preview(source: Session, accessToken: string): Promise<ContinuationPreview> {
    if (!github || !canContinueSession(source)) return unavailable(source);
    const result = await github.continuationPreview(source, accessToken);
    // A retained PR proves that a missing branch was previously published. Never substitute PR commits.
    if (result.state === 'unpublished' && (await published(source.id)).length) return { ...result, state: 'unavailable', reason: 'The previously published source branch no longer exists on GitHub.' };
    const current = await repo.get(source.id);
    return current && sameSource(current, source) && canContinueSession(current) ? result : unavailable(source);
  }
  function sameSource(left: Session, right: Session): boolean {
    return left.id === right.id && left.userId === right.userId && left.repository === right.repository &&
      left.repositoryId === right.repositoryId && left.installationId === right.installationId &&
      left.branch === right.branch && left.baseBranch === right.baseBranch;
  }
  function matchesReservation(source: Session, row: Reservation): boolean {
    return source.userId === row.user_id && source.id === row.source_id && source.repository === row.repository &&
      source.repositoryId === Number(row.repository_id) && source.installationId === Number(row.installation_id) &&
      source.branch === row.source_branch && source.baseBranch === row.base_branch && row.target_id !== source.id;
  }
  async function existing(row: Reservation, source: Session): Promise<Session | null> {
    if (!matchesReservation(source, row)) throw new ContinuationError(409, 'The saved continuation no longer matches its source.');
    const target = await repo.get(row.target_id);
    if (target && (target.userId !== source.userId || target.repository !== source.repository ||
      target.repositoryId !== source.repositoryId || target.installationId !== source.installationId ||
      target.baseBranch !== source.baseBranch || target.branch !== `ephemeral/${row.target_id}` ||
      target.continuation?.sourceSessionId !== source.id || target.continuation.sourceBranch !== source.branch ||
      target.continuation.commitSha.toLowerCase() !== row.expected_sha)) throw new ContinuationError(409, 'The saved continuation could not be verified.');
    return target;
  }
  async function start(source: Session, accessToken: string, expectedHeadSha: string, requestId: string, expectedNoteRevision?: number): Promise<Session> {
    if (!github || !canContinueSession(source)) throw new ContinuationError(409, unavailable(source).reason!);
    const expected = expectedHeadSha.toLowerCase();
    const params = [source.userId, source.id, requestId.toLowerCase()];
    const readReservation = async () => (await db.query<Reservation>(
      'SELECT * FROM ephemeral_continuation_requests WHERE user_id=$1 AND source_id=$2 AND request_id=$3', params)).rows[0];
    // Authorization precedes copying source content, including recovery of a reserved request.
    await github.authorizeContinuation(source, accessToken);
    if (notes) {
      try {
        // One database statement reserves the target and captures the note. A crash cannot
        // leave an intent that later copies a newer source revision into the same target.
        await notes.reserveContinuation({ userId: source.userId, sourceSessionId: source.id,
          requestId: requestId.toLowerCase(), targetSessionId: randomUUID(), expectedHeadSha: expected,
          repository: source.repository, repositoryId: source.repositoryId, installationId: source.installationId,
          sourceBranch: source.branch, baseBranch: source.baseBranch, expectedNoteRevision });
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'note_revision_conflict') {
          throw new ContinuationError(409, 'The handoff notes changed. Review the current notes before continuing.', true);
        }
        throw error;
      }
    } else {
      await db.query(`INSERT INTO ephemeral_continuation_requests
        (user_id,source_id,request_id,target_id,expected_sha,repository,repository_id,installation_id,source_branch,base_branch)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(user_id,source_id,request_id) DO NOTHING`,
      [...params, randomUUID(), expected, source.repository, source.repositoryId, source.installationId, source.branch, source.baseBranch]);
    }
    const row = await readReservation();
    if (!row || row.expected_sha !== expected) throw new ContinuationError(409, 'This continuation request was already used for a different commit.');
    const target = await existing(row, source);
    if (target) return target;
    if (row.status === 'rejected') throw new ContinuationError(409, row.rejection_reason ?? 'This continuation request was rejected. Review saved work and try again.', true);
    async function reject(message: string): Promise<never> {
      // Only a reserved request can be permanently rejected. Once creation was attempted,
      // absence is uncertain and the client must retain its UUID for recovery.
      const changed = await db.query(`UPDATE ephemeral_continuation_requests SET status='rejected',rejection_reason=$4
        WHERE user_id=$1 AND source_id=$2 AND request_id=$3 AND status='reserved' RETURNING target_id`, [...params, message]);
      throw new ContinuationError(409, message, changed.rows.length > 0);
    }
    const checked = await preview(source, accessToken);
    if (checked.state !== 'ready' || !checked.commitSha) {
      const reason = checked.reason ?? 'GitHub could not verify saved work.';
      if (checked.state === 'unavailable' || checked.state === 'unpublished') return reject(reason);
      throw new ContinuationError(409, reason);
    }
    if (checked.commitSha.toLowerCase() !== expected) return reject('The published source branch changed. Refresh before continuing.');
    const current = await repo.get(source.id);
    if (!current || !sameSource(current, source) || !canContinueSession(current)) return reject('Source session cleanup is not complete.');
    await db.query(`UPDATE ephemeral_continuation_requests SET status='creating'
      WHERE user_id=$1 AND source_id=$2 AND request_id=$3 AND status='reserved'`, params);
    const claimed = await readReservation();
    if (claimed?.status !== 'creating') throw new ContinuationError(409, 'The saved continuation request is no longer available.');
    try {
      return await manager.create({ userId: source.userId, repository: source.repository, repositoryId: source.repositoryId,
        installationId: source.installationId, baseBranch: source.baseBranch,
        continuation: { sourceSessionId: source.id, sourceBranch: source.branch, commitSha: expected, verifiedAt: checked.checkedAt } }, { id: row.target_id });
    } catch (error) {
      // Creation may have persisted the session before a later write failed, or another server created it.
      const recovered = await existing(row, source);
      if (recovered) return recovered;
      if (error instanceof SessionNotCreatedError) {
        // A trusted pre-insert failure permits a retry of this same reserved target.
        // Transport/storage errors remain creating even when a recovery read is empty.
        await db.query(`UPDATE ephemeral_continuation_requests SET status='reserved'
          WHERE user_id=$1 AND source_id=$2 AND request_id=$3 AND status='creating'`, params);
        throw new ContinuationError(409, error.message, true);
      }
      throw error;
    }
  }
  return { preview, continue(source: Session, accessToken: string, expectedHeadSha: string, requestId: string, expectedNoteRevision?: number) {
    // A database is owned by one control plane. Serialize all intents for a key,
    // including requests that attempt to change the reviewed SHA.
    const key = JSON.stringify([source.userId, source.id, requestId.toLowerCase()]);
    const previous = requests.get(key) ?? Promise.resolve();
    const operation = previous.then(() => start(source, accessToken, expectedHeadSha, requestId, expectedNoteRevision));
    const settled = operation.then(() => {}, () => {});
    requests.set(key, settled);
    void settled.then(() => { if (requests.get(key) === settled) requests.delete(key); });
    return operation;
  } };
}
