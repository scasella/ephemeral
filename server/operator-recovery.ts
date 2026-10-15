import { randomUUID } from 'node:crypto';
import { lstat, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Database, Session } from './contracts.js';
import type { DurableSessionRepository } from './core/repository.js';
import { SESSION_UUID } from './core/continuation.js';
import type { CredentialStore } from './github/store.js';
import { beforeDeadline } from './shutdown.js';

export const RECOVERY_REASONS = ['configuration_fixed', 'provider_recovered', 'credential_recovery', 'incident_cleanup'] as const;
export type RecoveryReason = typeof RECOVERY_REASONS[number];
export interface RecoveryManager { reconcileOne(id: string): Promise<Session>; shutdown(): Promise<void> }
export interface RecoveryContext {
  db: Database;
  repo: DurableSessionRepository;
  store: Pick<CredentialStore, 'issuanceStatus'>;
  manager?: RecoveryManager;
}
const states = ['provisioning', 'running', 'cleanup_pending', 'ended', 'failed'];
const cleanups = ['pending', 'confirmed', 'failed', 'not_applicable'];
const creationReasons = ['request_started', 'request_not_sent', 'request_rejected', 'request_uncertain', 'resource_record_failed', 'resource_created'];
const issuanceReasons = ['request_uncertain', 'request_rejected', 'request_not_sent', 'invalid_grant', 'token_record_failed', 'token_recorded', 'revocation_pending', 'revoked', 'expired'];
const issuanceStates = ['uncertain', 'not_issued', 'issued', 'revoke_pending', 'revoked', 'expired'];
const outcomes = ['started', 'completed', 'incomplete', 'failed', 'timed_out'];
function choice(value: unknown, allowed: readonly string[]) { return typeof value === 'string' && allowed.includes(value) ? value : 'unknown'; }
function date(value: unknown): string | null {
  if (!(typeof value === 'string' || value instanceof Date)) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function resourceId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) && !/^(?:gh[pousr]_|github_pat_|e2b_|sk-)/i.test(value) ? value : null;
}
function cleanup(session: Session) {
  return Object.fromEntries(['vm', 'github', 'gateway', 'codex'].map(key => [key, choice(session.cleanup[key as keyof Session['cleanup']], cleanups)]));
}
export class RecoveryError extends Error {
  constructor(readonly code: 'invalid_arguments' | 'session_not_found' | 'ineligible_session' | 'operation_failed' | 'ownership_unavailable' | 'configuration_invalid' | 'shutdown_incomplete' | 'database_not_found') {
    super(code);
  }
}
export async function migrateRecoveryAudit(db: Database): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS ephemeral_operator_recovery (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES ephemeral_sessions(id), reason TEXT NOT NULL,
    outcome TEXT NOT NULL, started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at timestamptz, state TEXT NOT NULL, cleanup jsonb NOT NULL
  )`);
}

/** Offline projection. Never include session errors, labels, event text, credentials, paths, or config. */
export async function inspectRecovery(context: RecoveryContext, id: string) {
  if (!SESSION_UUID.test(id)) throw new RecoveryError('invalid_arguments');
  const session = await context.repo.get(id);
  if (!session) throw new RecoveryError('session_not_found');
  const creation = await context.repo.creationAttempt(id);
  const creationUncertaintyUntil = creation?.uncertaintyUntil ?? await context.repo.uncertaintyUntil(id);
  const issuance = await context.store.issuanceStatus(id);
  const { rows } = await context.db.query<{ id: string; reason: string; outcome: string; started_at: string | Date; finished_at: string | Date | null }>(
    'SELECT id,reason,outcome,started_at,finished_at FROM ephemeral_operator_recovery WHERE session_id=$1 ORDER BY started_at DESC,id DESC LIMIT 10', [id]);
  const blockers: string[] = [];
  if (!['cleanup_pending', 'provisioning'].includes(session.state)) blockers.push('session_not_eligible_for_operator_cleanup');
  for (const key of ['vm', 'github', 'gateway'] as const) if (session.cleanup[key] !== 'confirmed') blockers.push(`${key}_cleanup_unconfirmed`);
  if (session.cleanup.vm !== 'confirmed' && creation && ['pending', 'unknown'].includes(creation.status)) blockers.push('sandbox_creation_uncertain');
  if (session.cleanup.vm !== 'confirmed' && !creation && creationUncertaintyUntil) blockers.push('legacy_sandbox_creation_uncertain');
  if (issuance.uncertaintyUntil) blockers.push('github_issuance_uncertain');
  if (issuance.attempts.some(attempt => ['uncertain', 'issued', 'revoke_pending'].includes(attempt.status))) blockers.push('github_credentials_unresolved');
  const lease = (await context.db.query<{ active: boolean }>('SELECT lease_until>CURRENT_TIMESTAMP AS active FROM ephemeral_sessions WHERE id=$1', [id])).rows[0];
  if (lease?.active) blockers.push('session_lease_active');
  return {
    sessionId: id, state: choice(session.state, states), createdAt: date(session.createdAt), expiresAt: date(session.expiresAt),
    maxExpiresAt: date(session.maxExpiresAt), endedAt: date(session.endedAt), creationUncertaintyUntil: date(creationUncertaintyUntil), cleanup: cleanup(session), codexRemoteRevocation: 'unverified',
    knownSandboxIds: [...new Set([resourceId(session.sandboxId), resourceId(creation?.sandboxId)].filter((value): value is string => value !== null))],
    creationAttempt: creation ? { status: choice(creation.status, ['pending', 'not_created', 'unknown', 'created']), reason: choice(creation.reason, creationReasons),
      sandboxId: resourceId(creation.sandboxId), uncertaintyUntil: date(creation.uncertaintyUntil), startedAt: date(creation.startedAt), updatedAt: date(creation.updatedAt) } : null,
    github: { uncertaintyUntil: date(issuance.uncertaintyUntil), attempts: issuance.attempts.map(attempt => ({
      id: SESSION_UUID.test(attempt.id) ? attempt.id : null, status: choice(attempt.status, issuanceStates), reason: choice(attempt.reason, issuanceReasons),
      startedAt: date(attempt.startedAt), updatedAt: date(attempt.updatedAt), expiresAt: date(attempt.expiresAt),
    })) }, blockers,
    recentOperatorAttempts: rows.map(row => ({ id: SESSION_UUID.test(row.id) ? row.id : null,
      reason: choice(row.reason, RECOVERY_REASONS), outcome: choice(row.outcome, outcomes), startedAt: date(row.started_at), finishedAt: date(row.finished_at) })),
  };
}

/** Audit admission before any provider mutation. A deadline never becomes deletion/revocation evidence. */
export async function reconcileRecovery(context: RecoveryContext, id: string, confirmedId: string, reason: string, timeoutMs = 120_000) {
  if (!SESSION_UUID.test(id) || confirmedId !== id || !RECOVERY_REASONS.includes(reason as RecoveryReason)) throw new RecoveryError('invalid_arguments');
  const current = await context.repo.get(id);
  if (!current) throw new RecoveryError('session_not_found');
  if (!['cleanup_pending', 'provisioning'].includes(current.state) || !context.manager) throw new RecoveryError('ineligible_session');
  const attemptId = randomUUID();
  await context.db.query(`INSERT INTO ephemeral_operator_recovery(id,session_id,reason,outcome,state,cleanup)
    VALUES($1,$2,$3,'started',$4,$5::jsonb)`, [attemptId, id, reason, current.state, JSON.stringify(cleanup(current))]);
  let outcome = 'failed';
  let ownershipRetained = false;
  // Observe settlement independently: timeout does not cancel or drain a remote operation.
  let settled = false;
  const work = context.manager.reconcileOne(id).finally(() => { settled = true; });
  try {
    const result = await beforeDeadline(work, timeoutMs);
    outcome = ['ended', 'failed'].includes(result.state) && ['vm', 'gateway', 'github'].every(key => result.cleanup[key as keyof Session['cleanup']] === 'confirmed') ? 'completed' : 'incomplete';
  } catch { outcome = settled ? 'failed' : 'timed_out'; ownershipRetained = !settled; }
  const latest = await context.repo.get(id);
  await context.db.query(`UPDATE ephemeral_operator_recovery SET outcome=$2,finished_at=CURRENT_TIMESTAMP,state=$3,cleanup=$4::jsonb WHERE id=$1`,
    [attemptId, outcome, choice(latest?.state, states), JSON.stringify(latest ? cleanup(latest) : {})]);
  return { attemptId, outcome, ownershipRetained, diagnostic: await inspectRecovery(context, id) };
}

/** Delete the exact recorded session disk only; never remove a root or sweep another session. */
export async function disableRecoveryGateway(store: Pick<CredentialStore, 'disable' | 'disk' | 'hasRoot' | 'forgetDisk'>, id: string): Promise<void> {
  if (!SESSION_UUID.test(id)) throw new RecoveryError('invalid_arguments');
  await store.disable(id);
  const disk = await store.disk(id);
  if (!disk) return;
  const root = dirname(disk.path);
  if (!/^\/tmp\/ep-gh-[A-Za-z0-9]+$/.test(root) || disk.path !== join(root, `repo-${id}.git`) || !await store.hasRoot(root)) throw new RecoveryError('operation_failed');
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 ||
      await realpath(root) !== join(await realpath('/tmp'), root.slice('/tmp/'.length))) throw new RecoveryError('operation_failed');
    try {
      const target = await lstat(disk.path);
      if (!target.isDirectory() || target.isSymbolicLink() || target.uid !== process.getuid?.()) throw new RecoveryError('operation_failed');
      await rm(disk.path, { recursive: true, force: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await store.forgetDisk(id);
}
