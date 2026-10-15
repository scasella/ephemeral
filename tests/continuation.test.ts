import { afterEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import type { Database, Session } from '../server/contracts.js';
import { createContinuationController, continuationPreview, type ContinuationPreview } from '../server/continuation.js';
import { createSessionRepository } from '../server/core/repository.js';
import { SessionManager } from '../server/core/lifecycle.js';
import { PreviewProvider, previewCredentials } from '../server/preview.js';
import { GitHubAPI } from '../server/github/api.js';
import { GitHubError } from '../server/github/security.js';

const sha = 'a'.repeat(40), otherSha = 'b'.repeat(40);
const source = (): Session => { const id = randomUUID(); return ({ id, userId: '42', repository: 'owner/repo', repositoryId: 1, installationId: 2,
  branch: `ephemeral/${id}`, baseBranch: 'main', state: 'ended', createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(),
  maxExpiresAt: new Date().toISOString(), sandboxId: 'old-destroyed-vm', endedAt: new Date().toISOString(), error: null,
  cleanup: { vm: 'confirmed', github: 'confirmed', gateway: 'confirmed', codex: 'not_applicable' }, codexRemoteRevocation: 'unverified' }); };
const close: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of close.splice(0).reverse()) await action(); vi.restoreAllMocks(); });
async function fixture(s = source()) {
  const db = new PGlite(); close.push(() => db.close());
  const repo = await createSessionRepository(db as unknown as Database); await repo.insert(s);
  const provider = new PreviewProvider();
  const manager = new SessionManager(repo, provider, previewCredentials); close.push(() => manager.shutdown());
  const github = { authorizeContinuation: vi.fn(async () => {}), continuationPreview: vi.fn(async (session: Session): Promise<ContinuationPreview> => ({ ...continuationPreview(session, 'ready', null), commitSha: sha })) };
  const published = vi.fn(async () => [] as unknown[]);
  const controller = await createContinuationController(db as unknown as Database, repo, manager, github, published);
  return { db, repo, provider, manager, github, published, controller, source: s };
}

describe('GitHub saved branch verification with current user OAuth', () => {
  it('verifies current user and App repository identity, base and exact source head using only OAuth GETs', async () => {
    const api = new GitHubAPI('42', 'unused', 'app'), s = source();
    vi.spyOn(api, 'repositories').mockResolvedValue([{ id: 1, installationId: 2, fullName: 'owner/repo', defaultBranch: 'main' }]);
    const request = vi.spyOn(api, 'request').mockResolvedValueOnce({ object: { sha: otherSha, type: 'commit' } }).mockResolvedValueOnce({ object: { sha, type: 'commit' } });
    expect(await api.continuationPreview(s, 'CURRENT-USER-OAUTH')).toMatchObject({ state: 'ready', sourceBranch: s.branch, commitSha: sha, baseBranch: 'main' });
    expect(request.mock.calls).toEqual([
      ['/repos/owner/repo/git/ref/heads/main', 'CURRENT-USER-OAUTH'],
      [`/repos/owner/repo/git/ref/heads/${encodeURIComponent(s.branch)}`, 'CURRENT-USER-OAUTH'],
    ]);
    expect(api.repositories).toHaveBeenCalledWith('CURRENT-USER-OAUTH');
  });
  it.each([{ id: 9, installationId: 2, fullName: 'owner/repo' }, { id: 1, installationId: 3, fullName: 'owner/repo' }, { id: 1, installationId: 2, fullName: 'other/repo' }])('rejects changed repository or installation identity %j', async mismatch => {
    const api = new GitHubAPI('42', 'unused', 'app'); vi.spyOn(api, 'repositories').mockResolvedValue([{ ...mismatch, defaultBranch: 'main' }]);
    const request = vi.spyOn(api, 'request');
    await expect(api.continuationPreview(source(), 'user-token')).rejects.toMatchObject({ status: 403 }); expect(request).not.toHaveBeenCalled();
  });
  it('blocks missing base, absent saved branch, malformed SHA and uncertain GitHub results without recovering PR commits', async () => {
    const api = new GitHubAPI('42', 'unused', 'app'); vi.spyOn(api, 'repositories').mockResolvedValue([{ id: 1, installationId: 2, fullName: 'owner/repo', defaultBranch: 'main' }]);
    const request = vi.spyOn(api, 'request').mockRejectedValueOnce(new GitHubError('missing', 502, 404));
    expect(await api.continuationPreview(source(), 'token')).toMatchObject({ state: 'unavailable', commitSha: null });
    request.mockResolvedValueOnce({ object: { sha, type: 'commit' } }).mockRejectedValueOnce(new GitHubError('missing', 502, 404));
    expect(await api.continuationPreview(source(), 'token')).toMatchObject({ state: 'unpublished', commitSha: null });
    request.mockResolvedValueOnce({ object: { sha: 'invalid', type: 'commit' } });
    expect(await api.continuationPreview(source(), 'token')).toMatchObject({ state: 'unknown', commitSha: null });
    request.mockRejectedValueOnce(new Error('Bearer secret upstream body'));
    expect(JSON.stringify(await api.continuationPreview(source(), 'token'))).not.toContain('secret');
    request.mockRejectedValueOnce(new GitHubError('expired browser OAuth', 403, 401));
    await expect(api.continuationPreview(source(), 'token')).rejects.toMatchObject({ status: 403 });
  });
});

describe('durable continuation intent and fresh session creation', () => {
  it('creates a fresh sandbox session, assigned branch and credentials while retaining original PR base and verified source metadata', async () => {
    const f = await fixture(); const create = vi.spyOn(f.manager, 'create');
    const next = await f.controller.continue(f.source, 'oauth', sha, randomUUID());
    expect(next.id).not.toBe(f.source.id); expect(next.branch).toBe(`ephemeral/${next.id}`); expect(next.baseBranch).toBe('main');
    expect(next.sandboxId).toBeNull(); expect(next.continuation).toMatchObject({ sourceSessionId: f.source.id, sourceBranch: f.source.branch, commitSha: sha });
    expect(next.expiresAt).not.toBe(f.source.expiresAt); expect(create).toHaveBeenCalledTimes(1);
    expect(await f.repo.get(f.source.id)).toEqual(f.source);
  });
  it('replays the same durable target after that child ends, after reopening the controller, and when the source branch moved', async () => {
    const f = await fixture(), request = randomUUID();
    const child = await f.controller.continue(f.source, 'oauth', sha, request); await f.manager.shutdown();
    await f.repo.update({ ...child, state: 'ended' });
    f.github.continuationPreview.mockResolvedValueOnce({ ...continuationPreview(f.source, 'ready', null), commitSha: otherSha });
    const reopened = await createContinuationController(f.db as unknown as Database, f.repo, f.manager, f.github, f.published);
    const replay = await reopened.continue(f.source, 'fresh-oauth', sha, request);
    expect(replay.id).toBe(child.id); expect(replay.state).toBe('ended'); expect(f.github.continuationPreview).toHaveBeenCalledTimes(1);
    expect(f.github.authorizeContinuation).toHaveBeenLastCalledWith(f.source, 'fresh-oauth');
    await expect(reopened.continue(f.source, 'oauth', otherSha, request)).rejects.toThrow('different commit');
  });
  it('concurrent identical retries create one target, and a different request respects the one-active-session guard', async () => {
    const f = await fixture(), request = randomUUID();
    const results = await Promise.all([f.controller.continue(f.source, 'oauth', sha, request), f.controller.continue(f.source, 'oauth', sha, request)]);
    expect(results[0].id).toBe(results[1].id); expect(await f.repo.list('42')).toHaveLength(2);
    await expect(f.controller.continue(f.source, 'oauth', sha, randomUUID())).rejects.toThrow('active session');
  });
  it('resets only a proven pre-insert uniqueness conflict and retries the same reserved target', async () => {
    const f = await fixture(), request = randomUUID(), activeId = randomUUID();
    const active = { ...f.source, id: activeId, branch: `ephemeral/${activeId}`, state: 'running' as const };
    await f.repo.insert(active);
    await expect(f.controller.continue(f.source, 'oauth', sha, request)).rejects.toMatchObject({ code: 'CONTINUATION_REJECTED', outcome: 'not_created' });
    const row = (await f.db.query<{ status: string; target_id: string }>('SELECT status,target_id FROM ephemeral_continuation_requests')).rows[0];
    expect(row.status).toBe('reserved'); expect(await f.repo.get(row.target_id)).toBeNull();
    await f.repo.update({ ...active, state: 'ended' });
    expect((await f.controller.continue(f.source, 'oauth', sha, request)).id).toBe(row.target_id);
  });
  it('keeps creating after an arbitrary insert connection error despite an empty recovery read', async () => {
    const f = await fixture(), request = randomUUID();
    vi.spyOn(f.repo, 'insert').mockRejectedValueOnce(new Error('storage connection lost'));
    await expect(f.controller.continue(f.source, 'oauth', sha, request)).rejects.toThrow('connection lost');
    const row = (await f.db.query<{ status: string; target_id: string }>('SELECT status,target_id FROM ephemeral_continuation_requests')).rows[0];
    expect(row.status).toBe('creating'); expect(await f.repo.get(row.target_id)).toBeNull();
    expect((await f.controller.continue(f.source, 'oauth', sha, request)).id).toBe(row.target_id);
  });
  it('recovers a real committed session insert whose acknowledgement was lost', async () => {
    const f = await fixture(), request = randomUUID(), insert = f.repo.insert.bind(f.repo);
    vi.spyOn(f.repo, 'insert').mockImplementationOnce(async session => { await insert(session); throw new Error('insert acknowledgement lost'); });
    const child = await f.controller.continue(f.source, 'oauth', sha, request);
    expect(child.state).toBe('provisioning');
    expect((await f.controller.continue(f.source, 'oauth', sha, request)).id).toBe(child.id);
    expect((await f.db.query<{ status: string }>('SELECT status FROM ephemeral_continuation_requests')).rows[0].status).toBe('creating');
    expect(await f.repo.list('42')).toHaveLength(2);
  });
  it('recovers a lost response after session insertion without allocating a second target', async () => {
    const f = await fixture(), request = randomUUID(); const real = f.manager.create.bind(f.manager);
    vi.spyOn(f.manager, 'create').mockImplementationOnce(async (...args) => { await real(...args); throw new Error('response lost after insert'); });
    const child = await f.controller.continue(f.source, 'oauth', sha, request);
    expect((await f.controller.continue(f.source, 'oauth', sha, request)).id).toBe(child.id); expect(await f.repo.list('42')).toHaveLength(2);
  });
  it('reuses a reserved target after interruption before insertion, and keeps intent immutable', async () => {
    const f = await fixture(), request = randomUUID();
    vi.spyOn(f.manager, 'create').mockRejectedValueOnce(new Error('interrupted before insert'));
    await expect(f.controller.continue(f.source, 'oauth', sha, request)).rejects.toThrow('interrupted');
    const row = (await f.db.query<{ target_id: string }>('SELECT target_id FROM ephemeral_continuation_requests')).rows[0];
    await expect(f.controller.continue(f.source, 'oauth', otherSha, request)).rejects.toThrow('different commit');
    expect((await f.controller.continue(f.source, 'oauth', sha, request)).id).toBe(row.target_id);
  });
  it('permanently rejects the reviewed request before creation even if a delayed retry sees the source head restored', async () => {
    const f = await fixture(), request = randomUUID(); const create = vi.spyOn(f.manager, 'create');
    f.github.continuationPreview.mockResolvedValueOnce({ ...continuationPreview(f.source, 'ready', null), commitSha: otherSha });
    await expect(f.controller.continue(f.source, 'oauth', sha, request)).rejects.toMatchObject({ code: 'CONTINUATION_REJECTED', outcome: 'not_created' });
    const reopened = await createContinuationController(f.db as unknown as Database, f.repo, f.manager, f.github, f.published);
    await expect(reopened.continue(f.source, 'fresh-oauth', sha, request)).rejects.toMatchObject({ code: 'CONTINUATION_REJECTED', outcome: 'not_created' });
    expect(create).not.toHaveBeenCalled(); expect(f.github.continuationPreview).toHaveBeenCalledTimes(1);
    expect((await reopened.continue(f.source, 'fresh-oauth', sha, randomUUID())).continuation?.commitSha).toBe(sha);
  });
  it('retains ambiguity after an attempted create and recovery read failure, even if the source subsequently moved', async () => {
    const f = await fixture(), request = randomUUID();
    vi.spyOn(f.manager, 'create').mockRejectedValueOnce(new Error('ambiguous create response'));
    await expect(f.controller.continue(f.source, 'oauth', sha, request)).rejects.toThrow('ambiguous');
    f.github.continuationPreview.mockResolvedValueOnce({ ...continuationPreview(f.source, 'ready', null), commitSha: otherSha });
    let failure: unknown;
    try { await f.controller.continue(f.source, 'oauth', sha, request); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ status: 409 }); expect(failure).not.toHaveProperty('code', 'CONTINUATION_REJECTED');
    expect((await f.db.query<{ status: string }>('SELECT status FROM ephemeral_continuation_requests')).rows[0].status).toBe('creating');
  });
  it('does not report not_created if a child persisted but its recovery read failed; the same UUID later recovers that child', async () => {
    const f = await fixture(), request = randomUUID();
    const get = f.repo.get.bind(f.repo); let insertedId = '', failRecoveryRead = false;
    vi.spyOn(f.repo, 'get').mockImplementation(async id => {
      if (id === insertedId && failRecoveryRead) { failRecoveryRead = false; throw new Error('recovery storage unavailable'); }
      return get(id);
    });
    vi.spyOn(f.manager, 'create').mockImplementationOnce(async (input, options) => {
      insertedId = options!.id!;
      await f.repo.insert({ ...f.source, ...input, id: insertedId, branch: `ephemeral/${insertedId}`, state: 'failed' });
      failRecoveryRead = true;
      throw new Error('response unavailable after insertion');
    });
    let failure: unknown;
    try { await f.controller.continue(f.source, 'oauth', sha, request); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error); expect(failure).not.toHaveProperty('outcome', 'not_created');
    expect((await f.controller.continue(f.source, 'fresh-oauth', sha, request.toUpperCase())).id).toBe(insertedId);
    expect(await f.repo.list('42')).toHaveLength(2);
  });
  it('serializes conflicting SHAs on one request key without claiming that the original request was rejected', async () => {
    const f = await fixture(), request = randomUUID();
    const result = await Promise.allSettled([f.controller.continue(f.source, 'oauth', sha, request), f.controller.continue(f.source, 'oauth', otherSha, request)]);
    expect(result[0].status).toBe('fulfilled'); expect(result[1]).toMatchObject({ status: 'rejected', reason: { status: 409 } });
    if (result[1].status === 'rejected') expect(result[1].reason.code).toBeUndefined();
    expect(await f.repo.list('42')).toHaveLength(2);
  });
  it.each(['provisioning', 'running', 'cleanup_pending'] as const)('blocks %s sources before remote verification', async state => {
    const f = await fixture({ ...source(), state });
    expect(await f.controller.preview(f.source, 'oauth')).toMatchObject({ state: 'unavailable', commitSha: null });
    await expect(f.controller.continue(f.source, 'oauth', sha, randomUUID())).rejects.toThrow('cleanup');
    expect(f.github.continuationPreview).not.toHaveBeenCalled();
  });
  it('blocks incomplete cleanup, changed head, lost access and source changes during verification', async () => {
    const f = await fixture();
    await expect(f.controller.continue({ ...f.source, cleanup: { ...f.source.cleanup, vm: 'failed' } }, 'oauth', sha, randomUUID())).rejects.toThrow('cleanup');
    await expect(f.controller.continue(f.source, 'oauth', otherSha, randomUUID())).rejects.toThrow('changed');
    f.github.continuationPreview.mockImplementationOnce(async s => { await f.repo.update({ ...s, state: 'cleanup_pending' }); return { ...continuationPreview(s, 'ready', null), commitSha: sha }; });
    await expect(f.controller.continue(f.source, 'oauth', sha, randomUUID())).rejects.toThrow('cleanup');
    expect(await f.repo.list('42')).toHaveLength(1);
  });
  it('rejects replay access loss and changed source identity or tampered target metadata', async () => {
    const f = await fixture(), request = randomUUID(); const child = await f.controller.continue(f.source, 'oauth', sha, request);
    f.github.authorizeContinuation.mockRejectedValueOnce(new GitHubError('revoked', 403));
    await expect(f.controller.continue(f.source, 'oauth', sha, request)).rejects.toMatchObject({ status: 403 });
    await expect(f.controller.continue({ ...f.source, repositoryId: 9 }, 'oauth', sha, request)).rejects.toThrow('source');
    await f.manager.shutdown(); await f.repo.update({ ...child, continuation: { ...child.continuation!, commitSha: otherSha } });
    await expect(f.controller.continue(f.source, 'oauth', sha, request)).rejects.toThrow('verified');
  });
  it('returns unavailable for a deleted previously published branch and for preview integrations', async () => {
    const f = await fixture(); f.published.mockResolvedValueOnce([{}]);
    f.github.continuationPreview.mockResolvedValueOnce(continuationPreview(f.source, 'unpublished', 'Missing source branch'));
    expect(await f.controller.preview(f.source, 'oauth')).toMatchObject({ state: 'unavailable', commitSha: null });
    const preview = await createContinuationController(f.db as unknown as Database, f.repo, f.manager, null, f.published);
    expect(await preview.preview(f.source, '')).toMatchObject({ state: 'unavailable', commitSha: null });
    await expect(preview.continue(f.source, '', sha, randomUUID())).rejects.toThrow('Preview');
  });
});
