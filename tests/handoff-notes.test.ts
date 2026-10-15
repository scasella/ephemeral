import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database, Session } from '../server/contracts.js';
import { createSessionRepository } from '../server/core/repository.js';
import { createHandoffNotesService } from '../server/handoff-notes.js';
import { createContinuationController } from '../server/continuation.js';

function session(userId = 'owner', state: Session['state'] = 'ended'): Session {
  const id = randomUUID(), now = new Date().toISOString();
  return { id, userId, repository: 'owner/repo', repositoryId: 1, installationId: 2,
    baseBranch: 'main', branch: `ephemeral/${id}`, state, createdAt: now,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), maxExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
    sandboxId: state === 'running' ? 'vm' : null, endedAt: state === 'ended' ? now : null, error: null,
    cleanup: { vm: 'confirmed', github: 'confirmed', gateway: 'confirmed', codex: 'not_applicable' }, codexRemoteRevocation: 'unverified' };
}
const fields = { nextStep: 'Investigate checkout', unresolvedIssues: 'Race on retry', verification: 'Only unit tests ran' };

describe('durable handoff notes', () => {
  let db: PGlite, repo: Awaited<ReturnType<typeof createSessionRepository>>, notes: Awaited<ReturnType<typeof createHandoffNotesService>>;
  beforeAll(async () => {
    db = new PGlite(); repo = await createSessionRepository(db as unknown as Database);
    notes = await createHandoffNotesService(db as unknown as Database, repo);
    await createContinuationController(db as unknown as Database, repo, { async create() { throw new Error('Unexpected VM'); } }, null, async () => []);
  }, 30_000);
  afterAll(async () => { await db.close(); });
  async function insert(userId?: string, state?: Session['state']) { const source = session(userId, state); await repo.insert(source); return source; }
  function continuation(source: Session) { return { sourceSessionId: source.id, sourceBranch: source.branch, commitSha: 'a'.repeat(40), verifiedAt: new Date().toISOString() }; }
  function reservation(source: Session, expectedNoteRevision = 0) {
    return { userId: source.userId, sourceSessionId: source.id, targetSessionId: randomUUID(), requestId: randomUUID(),
      expectedHeadSha: 'a'.repeat(40), repository: source.repository, repositoryId: source.repositoryId,
      installationId: source.installationId, sourceBranch: source.branch, baseBranch: source.baseBranch, expectedNoteRevision };
  }

  it('reads legacy revision zero, normalizes literal text, clears with a version, and hides foreign/missing notes', async () => {
    const source = await insert();
    expect(await notes.get(source.userId, source.id)).toEqual({ sessionId: source.id,
      note: { revision: 0, updatedAt: null, nextStep: '', unresolvedIssues: '', verification: '' }, inherited: null });
    const saved = await notes.save(source.userId, source.id, { expectedRevision: 0,
      nextStep: '  <script>alert(1)</script>\r\n\tgit push  ', unresolvedIssues: '  issue  ', verification: '  no tests  ' });
    expect(saved.note).toMatchObject({ revision: 1, nextStep: '<script>alert(1)</script>\n\tgit push', unresolvedIssues: 'issue', verification: 'no tests' });
    expect(saved.note.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await notes.save(source.userId, source.id, { expectedRevision: 1, nextStep: ' ', unresolvedIssues: '', verification: '\n\t' })).note)
      .toMatchObject({ revision: 2, nextStep: '', unresolvedIssues: '', verification: '' });
    for (const owner of ['other', 'missing']) {
      await expect(notes.get(owner, source.id)).rejects.toMatchObject({ status: 404 });
      await expect(notes.save(owner, source.id, { expectedRevision: 2, ...fields })).rejects.toMatchObject({ status: 404 });
    }
    await expect(notes.get('owner', randomUUID())).rejects.toMatchObject({ status: 404 });
  });
  it('checks all three fields and rejects controls, extra metadata, bad revisions, and oversized text', async () => {
    const source = await insert();
    for (const field of ['nextStep', 'unresolvedIssues', 'verification']) {
      for (const value of ['x'.repeat(2001), '\0', '\x01', '\r', '\x0b', '\x1f', '\x7f', 1, null]) {
        await expect(notes.save('owner', source.id, { expectedRevision: 0, ...fields, [field]: value } as never)).rejects.toThrow();
      }
    }
    for (const bad of [{ expectedRevision: -1, ...fields }, { expectedRevision: 0.5, ...fields },
      { expectedRevision: 0, ...fields, userId: 'other' }, { expectedRevision: '0', ...fields }]) {
      await expect(notes.save('owner', source.id, bad as never)).rejects.toThrow();
    }
    expect((await notes.get('owner', source.id)).note.revision).toBe(0);
    expect((await notes.save('owner', source.id, { expectedRevision: 0, ...fields, nextStep: 'x'.repeat(2000) })).note.nextStep).toHaveLength(2000);
  });
  it('fences simultaneous and stale saves, and lets a lost response recover through GET', async () => {
    const source = await insert();
    const results = await Promise.allSettled([
      notes.save('owner', source.id, { expectedRevision: 0, ...fields }),
      notes.save('owner', source.id, { expectedRevision: 0, ...fields, nextStep: 'Competing edit' }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ status: 409, code: 'note_revision_conflict' });
    const recovered = await notes.get('owner', source.id);
    expect(recovered.note.revision).toBe(1);
    await expect(notes.save('owner', source.id, { expectedRevision: 0, ...fields })).rejects.toMatchObject({ status: 409 });
    expect(await notes.get('owner', source.id)).toEqual(recovered);
    const missingVersion = await insert();
    await expect(notes.save('owner', missingVersion.id, { expectedRevision: 4, ...fields })).rejects.toMatchObject({ status: 409 });
  });
  it('retains notes through lifecycle saves and cleanup without session JSON or event content', async () => {
    for (const state of ['running', 'cleanup_pending', 'ended', 'failed'] as const) {
      const source = await insert(`owner-${state}`, state);
      await notes.save(source.userId, source.id, { expectedRevision: 0, ...fields });
      await repo.update({ ...source, state: 'ended', sandboxId: null, cleanup: { vm: 'confirmed', github: 'confirmed', gateway: 'confirmed', codex: 'confirmed' } });
      expect((await notes.get(source.userId, source.id)).note).toMatchObject({ revision: 1, ...fields });
      expect(JSON.stringify(await repo.get(source.id))).not.toContain(fields.nextStep);
      expect(JSON.stringify(await repo.list(source.userId))).not.toContain(fields.unresolvedIssues);
      expect(await repo.events(source.id)).toEqual([]);
    }
  });
  it('atomically freezes the first reservation, never recaptures edits on retry, and creates independent target notes', async () => {
    const source = await insert(); await notes.save('owner', source.id, { expectedRevision: 0, ...fields });
    const input = reservation(source, 1), reserved = await notes.reserveContinuation(input);
    expect(reserved.targetSessionId).toBe(input.targetSessionId);
    const target = { ...session(), id: input.targetSessionId, branch: `ephemeral/${input.targetSessionId}`, continuation: continuation(source) }; await repo.insert(target);
    const captured = (await notes.get('owner', target.id)).inherited!;
    expect(captured).toMatchObject({ ...fields, sourceSessionId: source.id, sourceBranch: source.branch, sourceNoteRevision: 1, sourceCommitSha: 'a'.repeat(40) });
    expect(captured.sourceNoteUpdatedAt).toBe((await notes.get('owner', source.id)).note.updatedAt);
    await notes.save('owner', source.id, { expectedRevision: 1, ...fields, nextStep: 'Later source edit' });
    expect(await notes.reserveContinuation({ ...input, targetSessionId: randomUUID() })).toEqual(reserved);
    expect((await notes.get('owner', target.id)).inherited).toEqual(captured);
    await notes.save('owner', target.id, { expectedRevision: 0, ...fields, nextStep: 'Target plan' });
    expect((await notes.get('owner', target.id)).inherited).toEqual(captured);
    expect((await notes.get('owner', source.id)).note.nextStep).toBe('Later source edit');
    await expect(notes.get('other', target.id)).rejects.toMatchObject({ status: 404 });
    await expect(notes.reserveContinuation({ ...input, expectedHeadSha: 'b'.repeat(40) })).rejects.toMatchObject({ status: 409 });
  });
  it('guards reviewed revisions before reserving and captures empty sources as revision zero', async () => {
    const source = await insert(); await notes.save('owner', source.id, { expectedRevision: 0, ...fields });
    const stale = reservation(source, 0);
    await expect(notes.reserveContinuation(stale)).rejects.toMatchObject({ status: 409, code: 'note_revision_conflict' });
    expect((await db.query('SELECT * FROM ephemeral_continuation_requests WHERE request_id=$1', [stale.requestId])).rows).toEqual([]);
    expect((await db.query('SELECT * FROM ephemeral_inherited_handoff_notes WHERE target_session_id=$1', [stale.targetSessionId])).rows).toEqual([]);
    const empty = await insert(), input = reservation(empty);
    await notes.reserveContinuation(input);
    const target = { ...session(), id: input.targetSessionId, continuation: continuation(empty) }; await repo.insert(target);
    expect((await notes.get('owner', target.id)).inherited).toMatchObject({ nextStep: '', unresolvedIssues: '', verification: '', sourceNoteRevision: 0, sourceNoteUpdatedAt: null });
  });
  it('rolls back the reservation if snapshot persistence fails', async () => {
    const source = await insert(); await notes.save('owner', source.id, { expectedRevision: 0, ...fields, nextStep: 'fail-snapshot' });
    const input = reservation(source, 1);
    await db.query("ALTER TABLE ephemeral_inherited_handoff_notes ADD CONSTRAINT test_snapshot_failure CHECK(next_step <> 'fail-snapshot')");
    try {
      await expect(notes.reserveContinuation(input)).rejects.toThrow();
      expect((await db.query('SELECT * FROM ephemeral_continuation_requests WHERE request_id=$1', [input.requestId])).rows).toEqual([]);
    } finally { await db.query('ALTER TABLE ephemeral_inherited_handoff_notes DROP CONSTRAINT test_snapshot_failure'); }
  });
  it('checks source and target ownership for capture and rejects mismatched reservation identities', async () => {
    const source = await insert(), target = await insert('other'), input = reservation(source);
    await expect(notes.capture({ userId: 'other', sourceSessionId: source.id, targetSessionId: randomUUID(), sourceBranch: source.branch })).rejects.toMatchObject({ status: 404 });
    await expect(notes.reserveContinuation({ ...input, targetSessionId: target.id })).rejects.toMatchObject({ status: 404 });
    await expect(notes.reserveContinuation({ ...input, repositoryId: 44 })).rejects.toMatchObject({ status: 409 });
    await notes.reserveContinuation(input);
    await db.query('UPDATE ephemeral_continuation_requests SET repository=$2 WHERE request_id=$1', [input.requestId, 'different/repo']);
    await expect(notes.reserveContinuation(input)).rejects.toMatchObject({ status: 409 });
  });
});

it('reopens durable notes and immutable inherited context from a local database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ep-handoff-notes-'));
  let db = new PGlite(directory);
  try {
    let repo = await createSessionRepository(db as unknown as Database), notes = await createHandoffNotesService(db as unknown as Database, repo);
    const source = session(), target = { ...session(), continuation: { sourceSessionId: '', sourceBranch: '', commitSha: 'a'.repeat(40), verifiedAt: new Date().toISOString() } };
    target.continuation.sourceSessionId = source.id; target.continuation.sourceBranch = source.branch; await repo.insert(source); await repo.insert(target);
    await notes.save('owner', source.id, { expectedRevision: 0, ...fields });
    const captured = await notes.capture({ userId: 'owner', sourceSessionId: source.id, targetSessionId: target.id, sourceBranch: source.branch, expectedNoteRevision: 1 });
    await db.close(); db = new PGlite(directory);
    repo = await createSessionRepository(db as unknown as Database); notes = await createHandoffNotesService(db as unknown as Database, repo);
    expect((await notes.get('owner', source.id)).note).toMatchObject({ revision: 1, ...fields });
    expect((await notes.get('owner', target.id)).inherited).toEqual(captured);
    await notes.save('owner', source.id, { expectedRevision: 1, nextStep: '', unresolvedIssues: '', verification: '' });
    await db.close(); db = new PGlite(directory);
    repo = await createSessionRepository(db as unknown as Database); notes = await createHandoffNotesService(db as unknown as Database, repo);
    expect((await notes.get('owner', source.id)).note).toMatchObject({ revision: 2, nextStep: '', unresolvedIssues: '', verification: '' });
    expect((await notes.get('owner', target.id)).inherited).toEqual(captured);
  } finally { await db.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
