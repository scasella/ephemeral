/** Only trusted adapters may assert that no remote create could have succeeded. */
export type CreationReason = 'request_started' | 'request_not_sent' | 'request_rejected' | 'request_uncertain' | 'resource_record_failed' | 'resource_created';
export type CreationOutcome = 'not_created' | 'unknown' | 'created';
export interface CreationAttempt {
  status: 'pending' | CreationOutcome;
  reason: CreationReason;
  sandboxId: string | null;
  uncertaintyUntil: string;
  startedAt: string;
  updatedAt: string;
}
export class SandboxCreationError extends Error {
  constructor(readonly outcome: CreationOutcome, readonly reason: CreationReason, readonly knownSandboxId?: string) {
    super('Sandbox creation did not complete.');
    if (outcome === 'created' && !knownSandboxId) throw new Error('A created outcome requires a known sandbox.');
    if (!['request_not_sent', 'request_rejected', 'request_uncertain', 'resource_record_failed', 'resource_created'].includes(reason)) throw new Error('Invalid creation outcome reason.');
    if (outcome === 'not_created' && reason !== 'request_not_sent' && reason !== 'request_rejected') throw new Error('A not-created outcome requires a definitive reason.');
    if (knownSandboxId && outcome === 'not_created') throw new Error('A known sandbox cannot have a not-created outcome.');
    Object.freeze(this);
  }
}
/** Proof that this invocation failed before inserting a session. Database transport errors are never this type. */
export class SessionNotCreatedError extends Error {
  readonly outcome = 'not_created';
}
