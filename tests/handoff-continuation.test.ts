import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database, Session } from '../server/contracts.js';
import { createContinuationController, continuationPreview, type ContinuationPreview } from '../server/continuation.js';
import { createSessionRepository } from '../server/core/repository.js';
import { SessionManager } from '../server/core/lifecycle.js';
import { createHandoffNotesService } from '../server/handoff-notes.js';
import { PreviewProvider, previewCredentials } from '../server/preview.js';

const sha = 'a'.repeat(40);
const close: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of close.splice(0).reverse()) await action(); vi.restoreAllMocks(); });

async function fixture() {
  const id = randomUUID(), now = new Date().toISOString();
  const source: Session = { id, userId: '42', repository: 'owner/repo', repositoryId: 1, installationId: 2,
    branch: `ephemeral/${id}`, baseBranch: 'main', state: 'ended', createdAt: now, expiresAt: now, maxExpiresAt: now,
    sandboxId: null, endedAt: now, error: null, cleanup: { vm: 'confirmed', github: 'confirmed', gateway: 'confirmed', codex: 'not_applicable' },
    codexRemoteRevocation: 'unverified' };
  const db = new PGlite(); close.push(() => db.close());
  const database = db as unknown as Database;
  const repo = await createSessionRepository(database); await repo.insert(source);
  const notes = await createHandoffNotesService(database, repo);
  const manager = new SessionManager(repo, new PreviewProvider(), previewCredentials); close.push(() => manager.shutdown());
  const github = { authorizeContinuation: vi.fn(async () => {}), continuationPreview: vi.fn(async (session: Session): Promise<ContinuationPreview> =>
    ({ ...continuationPreview(session, 'ready', null), commitSha: sha })) };
  const published = async () => [] as unknown[];
  const reopen = () => createContinuationController(database, repo, manager, github, published, notes);
  const controller = await reopen();
  const save = (expectedRevision: number, nextStep: string, unresolvedIssues = 'A failing test remains', verification = 'Unit tests passed') =>
    notes.save(source.userId, source.id, { expectedRevision, nextStep, unresolvedIssues, verification });
  return { db, database, repo, notes, manager, github, published, source, controller, reopen, save };
}

describe('continuation handoff capture and recovery', () => {
  it('captures the reviewed note atomically with reservation before source edits during GitHub verification', async () => {
    const f = await fixture(), first = await f.save(0, 'Finish the migration');
    f.github.continuationPreview.mockImplementationOnce(async session => {
      await f.save(1, 'New source next step', 'New issue', 'New verification');
      return { ...continuationPreview(session, 'ready', null), commitSha: sha };
    });
    const child = await f.controller.continue(f.source, 'oauth', sha, randomUUID(), first.note.revision);
    const result = await f.notes.get('42', child.id);
    expect(result.note).toMatchObject({ revision: 0, nextStep: '' });
    expect(result.inherited).toMatchObject({ sourceSessionId: f.source.id, sourceBranch: f.source.branch, sourceCommitSha: sha,
      sourceNoteRevision: 1, sourceNoteUpdatedAt: first.note.updatedAt, nextStep: 'Finish the migration',
      unresolvedIssues: 'A failing test remains', verification: 'Unit tests passed' });
    expect(result.inherited?.capturedAt).toEqual(expect.any(String));
    expect((await f.notes.get('42', f.source.id)).note).toMatchObject({ revision: 2, nextStep: 'New source next step' });
    expect(child).not.toHaveProperty('handoffNote');
  });

  it('recovers the same reserved target and capture after a crash before session creation', async () => {
    const f = await fixture(), request = randomUUID(); await f.save(0, 'Reviewed before crash');
    const create = vi.spyOn(f.manager, 'create');
    f.github.continuationPreview.mockRejectedValueOnce(new Error('server interrupted after reservation'));
    await expect(f.controller.continue(f.source, 'oauth', sha, request, 1)).rejects.toThrow('interrupted');
    expect(create).not.toHaveBeenCalled();
    const row = (await f.db.query<{ target_id: string }>('SELECT target_id FROM ephemeral_continuation_requests')).rows[0];
    await f.save(1, 'Edited while server was down');
    const child = await (await f.reopen()).continue(f.source, 'fresh-oauth', sha, request, 1);
    expect(child.id).toBe(row.target_id);
    expect((await f.notes.get('42', child.id)).inherited).toMatchObject({ sourceNoteRevision: 1, nextStep: 'Reviewed before crash' });
  });

  it('retains the same capture after uncertain creation and a lost response after insertion', async () => {
    const f = await fixture(), request = randomUUID(); await f.save(0, 'Original handoff');
    const real = f.manager.create.bind(f.manager);
    const create = vi.spyOn(f.manager, 'create').mockRejectedValueOnce(new Error('creation may have started'));
    await expect(f.controller.continue(f.source, 'oauth', sha, request, 1)).rejects.toThrow('may have started');
    const captured = (await f.db.query('SELECT * FROM ephemeral_inherited_handoff_notes')).rows[0];
    await f.save(1, 'Source edited after uncertain create');
    create.mockImplementationOnce(async (...args) => { await real(...args); throw new Error('reply lost'); });
    const reopened = await f.reopen(), child = await reopened.continue(f.source, 'oauth', sha, request, 2);
    expect((await reopened.continue(f.source, 'oauth', sha, request.toUpperCase(), 2)).id).toBe(child.id);
    expect((await f.db.query('SELECT * FROM ephemeral_inherited_handoff_notes')).rows).toEqual([captured]);
    expect(await f.repo.list('42')).toHaveLength(2);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('rejects a stale reviewed note before reserving or starting a VM, then accepts a fresh request', async () => {
    const f = await fixture(); await f.save(0, 'Reviewed note'); await f.save(1, 'New note');
    const create = vi.spyOn(f.manager, 'create');
    await expect(f.controller.continue(f.source, 'oauth', sha, randomUUID(), 1)).rejects.toMatchObject({ status: 409,
      code: 'CONTINUATION_REJECTED', outcome: 'not_created' });
    expect(create).not.toHaveBeenCalled(); expect(f.github.continuationPreview).not.toHaveBeenCalled();
    expect((await f.db.query('SELECT * FROM ephemeral_continuation_requests')).rows).toEqual([]);
    expect((await f.db.query('SELECT * FROM ephemeral_inherited_handoff_notes')).rows).toEqual([]);
    const child = await f.controller.continue(f.source, 'oauth', sha, randomUUID(), 2);
    expect((await f.notes.get('42', child.id)).inherited).toMatchObject({ sourceNoteRevision: 2, nextStep: 'New note' });
  });

  it('rolls back the target reservation when snapshot persistence fails and never invokes creation', async () => {
    const f = await fixture(); await f.save(0, 'fail snapshot storage');
    await f.db.query("ALTER TABLE ephemeral_inherited_handoff_notes ADD CONSTRAINT simulated_storage_failure CHECK(next_step <> 'fail snapshot storage')");
    const create = vi.spyOn(f.manager, 'create'), request = randomUUID();
    await expect(f.controller.continue(f.source, 'oauth', sha, request, 1)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled(); expect(f.github.continuationPreview).not.toHaveBeenCalled();
    expect((await f.db.query('SELECT * FROM ephemeral_continuation_requests')).rows).toEqual([]);
    expect((await f.db.query('SELECT * FROM ephemeral_inherited_handoff_notes')).rows).toEqual([]);
    await f.db.query('ALTER TABLE ephemeral_inherited_handoff_notes DROP CONSTRAINT simulated_storage_failure');
    expect((await f.controller.continue(f.source, 'oauth', sha, request, 1)).continuation?.commitSha).toBe(sha);
  });

  it('does not copy source content before authorization or for a source owned by another user', async () => {
    const f = await fixture(); await f.save(0, 'Private source note');
    const reserve = vi.spyOn(f.notes, 'reserveContinuation'), create = vi.spyOn(f.manager, 'create');
    f.github.authorizeContinuation.mockRejectedValueOnce(new Error('access revoked'));
    await expect(f.controller.continue(f.source, 'oauth', sha, randomUUID(), 1)).rejects.toThrow('revoked');
    expect(reserve).not.toHaveBeenCalled();
    await expect(f.controller.continue({ ...f.source, userId: '43' }, 'oauth', sha, randomUUID(), 1)).rejects.toMatchObject({ status: 404 });
    expect(create).not.toHaveBeenCalled();
    expect((await f.db.query('SELECT * FROM ephemeral_continuation_requests')).rows).toEqual([]);
    expect((await f.db.query('SELECT * FROM ephemeral_inherited_handoff_notes')).rows).toEqual([]);
  });

  it('captures explicit cleared fields, while legacy callers can capture an unsaved empty note', async () => {
    const f = await fixture(); await f.save(0, 'Old next step'); await f.save(1, '', '', '');
    const child = await f.controller.continue(f.source, 'oauth', sha, randomUUID(), 2);
    expect((await f.notes.get('42', child.id)).inherited).toMatchObject({ sourceNoteRevision: 2,
      nextStep: '', unresolvedIssues: '', verification: '' });
    const empty = await fixture(), legacyChild = await empty.controller.continue(empty.source, 'oauth', sha, randomUUID());
    expect((await empty.notes.get('42', legacyChild.id)).inherited).toMatchObject({ sourceNoteRevision: 0,
      sourceNoteUpdatedAt: null, nextStep: '', unresolvedIssues: '', verification: '' });
  });

  it('never overwrites a captured snapshot when recovering a target with tampered ownership or commit', async () => {
    const f = await fixture(), request = randomUUID(); await f.save(0, 'Original private note');
    const child = await f.controller.continue(f.source, 'oauth', sha, request, 1); await f.manager.shutdown();
    const capture = (await f.db.query('SELECT * FROM ephemeral_inherited_handoff_notes')).rows;
    await f.save(1, 'New private note'); await f.repo.update({ ...child, userId: '43' });
    await expect(f.controller.continue(f.source, 'oauth', sha, request, 2)).rejects.toMatchObject({ status: 404 });
    expect((await f.db.query('SELECT * FROM ephemeral_inherited_handoff_notes')).rows).toEqual(capture);
    await f.repo.update({ ...child, continuation: { ...child.continuation!, commitSha: 'b'.repeat(40) } });
    await expect(f.controller.continue(f.source, 'oauth', sha, request, 2)).rejects.toMatchObject({ status: 409 });
    expect((await f.db.query('SELECT * FROM ephemeral_inherited_handoff_notes')).rows).toEqual(capture);
  });

  it('recovers a legacy completed continuation without inventing historical notes from current source text', async () => {
    const f = await fixture(), request = randomUUID();
    const legacy = await createContinuationController(f.database, f.repo, f.manager, f.github, f.published);
    const child = await legacy.continue(f.source, 'oauth', sha, request);
    await f.save(0, 'Source text written after the legacy child existed');
    const recovered = await f.controller.continue(f.source, 'oauth', sha, request, 0);
    expect(recovered.id).toBe(child.id);
    expect((await f.notes.get('42', child.id)).inherited).toBeNull();
    expect((await f.db.query('SELECT * FROM ephemeral_inherited_handoff_notes')).rows).toEqual([]);
  });

  it('preserves uncertainty and the target of a legacy creation attempt lacking a captured note', async () => {
    const f = await fixture(), request = randomUUID(); await f.save(0, 'Legacy source notes');
    const legacy = await createContinuationController(f.database, f.repo, f.manager, f.github, f.published);
    vi.spyOn(f.manager, 'create').mockRejectedValueOnce(new Error('legacy uncertain creation'));
    await expect(legacy.continue(f.source, 'oauth', sha, request)).rejects.toThrow('uncertain');
    const row = (await f.db.query<{ target_id: string }>('SELECT target_id FROM ephemeral_continuation_requests')).rows[0];
    await f.save(1, 'Source edited before upgrading server');
    const child = await f.controller.continue(f.source, 'oauth', sha, request, 1);
    expect(child.id).toBe(row.target_id);
    expect((await f.notes.get('42', child.id)).inherited).toMatchObject({ sourceNoteRevision: 2,
      nextStep: 'Source edited before upgrading server' });
  });
});
