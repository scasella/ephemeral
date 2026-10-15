import type { SessionContinuation } from '../contracts.js';

export const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Copy reviewed provenance so callers cannot mutate a scheduled provision. */
export function copyContinuation(value: SessionContinuation): SessionContinuation {
  if (!value || !SESSION_UUID.test(value.sourceSessionId) ||
      value.sourceBranch !== `ephemeral/${value.sourceSessionId}` ||
      !/^[0-9a-f]{40}$/.test(value.commitSha) ||
      typeof value.verifiedAt !== 'string' || !Number.isFinite(Date.parse(value.verifiedAt))) {
    throw new Error('Invalid continuation source.');
  }
  return { sourceSessionId: value.sourceSessionId, sourceBranch: value.sourceBranch,
    commitSha: value.commitSha, verifiedAt: value.verifiedAt };
}

/** Only this safe, fixed error crosses the SDK preparation boundary. */
export class ContinuationSourceChangedError extends Error {
  constructor() {
    super('The published source branch changed during preparation. Review its latest commit and try a fresh session. Cleanup is being retried.');
    this.name = 'ContinuationSourceChangedError';
  }
}
