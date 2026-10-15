import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database, GatewayCredentials, SandboxProvider, Session } from '../server/contracts.js';
import { createSessionRepository } from '../server/core/repository.js';
import { SessionManager } from '../server/core/lifecycle.js';
import { SandboxCreationError } from '../server/core/provisioning.js';

const input = { userId: 'alice', repository: 'alice/project', repositoryId: 1, installationId: 2, baseBranch: 'main' };
const close: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of close.splice(0).reverse()) await action(); vi.restoreAllMocks(); });
function provider() {
  const live = new Set<string>();
  return { live, create: vi.fn(async (_s: Session, _token: string) => { live.add('vm'); return 'vm'; }),
    prepare: vi.fn(async (_s: Session) => {}), setTimeout: vi.fn(async () => {}), kill: vi.fn(async (id: string) => { live.delete(id); }),
    exists: vi.fn(async (id: string) => live.has(id)), discover: vi.fn(async (_id: string) => [...live]), cleanupCodex: vi.fn(async () => true),
    connectTerminal: vi.fn(async () => ({ write: async () => {}, resize: async () => {}, disconnect: async () => {} })) } satisfies SandboxProvider & { discover(id: string): Promise<string[]>; live: Set<string> };
}
async function fixture() {
  const db = new PGlite(); close.push(() => db.close());
  const repo = await createSessionRepository(db as unknown as Database), vm = provider();
  const creds: GatewayCredentials = { issue: vi.fn(async () => 'token'), disable: vi.fn(async () => {}), revokeGitHub: vi.fn(async () => {}) };
  const manager = new SessionManager(repo, vm, creds); close.push(() => manager.shutdown());
  return { db, repo, vm, creds, manager };
}
async function settled(manager: SessionManager) { await manager.shutdown(); }
function abandoned(id = randomUUID()): Session {
  const now = Date.now();
  return { ...input, id, branch: `ephemeral/${id}`, state: 'provisioning', createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(), maxExpiresAt: new Date(now + 14_400_000).toISOString(), sandboxId: null,
    endedAt: null, error: null, cleanup: { vm: 'pending', gateway: 'pending', github: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified' };
}

describe('creation outcome recovery', () => {
  it('commits the attempt before the provider side effect and confirms definitive rejection without waiting an hour', async () => {
    const f = await fixture();
    f.vm.create.mockImplementation(async session => {
      expect(await f.repo.creationAttempt(session.id)).toMatchObject({ status: 'pending', reason: 'request_started', sandboxId: null });
      throw new SandboxCreationError('not_created', 'request_rejected');
    });
    const session = await f.manager.create(input); await settled(f.manager);
    expect(await f.repo.get(session.id)).toMatchObject({ state: 'failed', cleanup: { vm: 'confirmed', github: 'confirmed', gateway: 'confirmed' } });
    expect(await f.repo.creationAttempt(session.id)).toMatchObject({ status: 'not_created', reason: 'request_rejected' });
  });

  it.each([new Error('secret response lost'), Object.assign(new Error('secret server error'), { status: 500 }), new SandboxCreationError('unknown', 'request_uncertain')])('retains ambiguity and the active slot despite empty early discovery (%s)', async error => {
    const f = await fixture(); f.vm.create.mockRejectedValue(error);
    const session = await f.manager.create(input); await settled(f.manager);
    expect(await f.repo.get(session.id)).toMatchObject({ state: 'cleanup_pending', cleanup: { vm: 'pending' } });
    const attempt = await f.repo.creationAttempt(session.id);
    expect(attempt).toMatchObject({ status: 'unknown', reason: 'request_uncertain' });
    expect(Date.parse(attempt!.uncertaintyUntil)).toBe(Date.parse(session.expiresAt) + 120_000);
    const restarted = new SessionManager(f.repo, f.vm, f.creds); close.push(() => restarted.shutdown());
    await expect(restarted.create(input)).rejects.toThrow('active session');
    await restarted.reconcileOne(session.id);
    expect(f.vm.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await f.repo.events(session.id))).not.toContain('secret');
  });

  it('does not call the provider when the durable attempt acknowledgement fails', async () => {
    const f = await fixture(); const begin = f.repo.beginCreationAttempt.bind(f.repo);
    vi.spyOn(f.repo, 'beginCreationAttempt').mockImplementationOnce(async (...args) => { await begin(...args); throw new Error('lost DB acknowledgement'); });
    const session = await f.manager.create(input); await settled(f.manager);
    expect(f.vm.create).not.toHaveBeenCalled();
    expect(await f.repo.creationAttempt(session.id)).toMatchObject({ status: 'pending' });
    expect(await f.repo.get(session.id)).toMatchObject({ state: 'cleanup_pending', cleanup: { vm: 'pending' } });
  });

  it('retains a returned VM ID when the session snapshot fails, and cleans it using the journal', async () => {
    const f = await fixture(); const save = f.repo.save.bind(f.repo); let failed = false;
    f.vm.discover.mockResolvedValue([]);
    vi.spyOn(f.repo, 'save').mockImplementation(async (session, owner) => {
      if (session.sandboxId && !failed) { failed = true; throw new Error('snapshot unavailable'); }
      return save(session, owner);
    });
    const session = await f.manager.create(input); await settled(f.manager);
    expect(await f.repo.creationAttempt(session.id)).toMatchObject({ status: 'created', sandboxId: 'vm' });
    expect(f.vm.kill).toHaveBeenCalledWith('vm'); expect(f.vm.prepare).not.toHaveBeenCalled();
    expect(await f.repo.get(session.id)).toMatchObject({ state: 'failed', cleanup: { vm: 'confirmed' } });
  });

  it('resolves a trusted definitive created outcome after vault failure using the retained VM ID', async () => {
    const f = await fixture(); f.vm.discover.mockResolvedValue([]);
    f.vm.create.mockImplementation(async () => { f.vm.live.add('vault-created'); throw new SandboxCreationError('created', 'resource_record_failed', 'vault-created'); });
    const session = await f.manager.create(input); await settled(f.manager);
    expect(await f.repo.creationAttempt(session.id)).toMatchObject({ status: 'created', sandboxId: 'vault-created', reason: 'resource_record_failed' });
    expect(f.vm.kill).toHaveBeenCalledWith('vault-created'); expect(f.vm.prepare).not.toHaveBeenCalled();
    expect(await f.repo.get(session.id)).toMatchObject({ state: 'failed', cleanup: { vm: 'confirmed' } });
  });

  it('cleans a VM returned through a trusted adapter failure without resolving its outstanding create uncertainty', async () => {
    const f = await fixture(); f.vm.discover.mockResolvedValue([]);
    f.vm.create.mockImplementation(async () => { f.vm.live.add('vault-orphan'); throw new SandboxCreationError('unknown', 'resource_record_failed', 'vault-orphan'); });
    const session = await f.manager.create(input); await settled(f.manager);
    expect(await f.repo.creationAttempt(session.id)).toMatchObject({ status: 'unknown', sandboxId: 'vault-orphan', reason: 'resource_record_failed' });
    expect(f.vm.kill).toHaveBeenCalledWith('vault-orphan');
    expect(await f.repo.get(session.id)).toMatchObject({ state: 'cleanup_pending', cleanup: { vm: 'pending' } });
    const restarted = new SessionManager(f.repo, f.vm, f.creds); close.push(() => restarted.shutdown());
    await restarted.reconcileOne(session.id);
    expect(await f.repo.get(session.id)).toMatchObject({ state: 'cleanup_pending' });
    await f.db.query("UPDATE ephemeral_creation_attempts SET uncertainty_until=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE session_id=$1", [session.id]);
    expect(await restarted.reconcileOne(session.id)).toMatchObject({ state: 'failed' });
    expect(f.vm.create).toHaveBeenCalledTimes(1);
  });

  it('keeps the bound after an early orphan kill and cleans a later discovered resource without replaying create', async () => {
    const f = await fixture();
    f.vm.create.mockImplementation(async () => { f.vm.live.add('early-orphan'); throw new Error('lost create response'); });
    const session = await f.manager.create(input); await settled(f.manager);
    expect(f.vm.kill).toHaveBeenCalledWith('early-orphan');
    expect(await f.repo.get(session.id)).toMatchObject({ state: 'cleanup_pending' });
    f.vm.live.add('late-orphan');
    const restarted = new SessionManager(f.repo, f.vm, f.creds); close.push(() => restarted.shutdown());
    expect(await restarted.reconcileOne(session.id)).toMatchObject({ state: 'cleanup_pending' });
    expect(f.vm.kill).toHaveBeenCalledWith('late-orphan'); expect(f.vm.create).toHaveBeenCalledTimes(1);
  });

  it('keeps uncertainty when all outcome persistence fails, while retaining the returned ID for immediate cleanup', async () => {
    const f = await fixture(); f.vm.discover.mockResolvedValue([]);
    vi.spyOn(f.repo, 'recordCreationOutcome').mockRejectedValue(new Error('outcome storage unavailable'));
    const session = await f.manager.create(input); await settled(f.manager);
    expect(f.vm.kill).toHaveBeenCalledWith('vm'); expect(f.vm.prepare).not.toHaveBeenCalled();
    expect(await f.repo.creationAttempt(session.id)).toMatchObject({ status: 'pending', sandboxId: null });
    expect(await f.repo.get(session.id)).toMatchObject({ state: 'cleanup_pending', cleanup: { vm: 'pending' } });
  });

  it('does not prepare after stop while create is in flight and records the known outcome before cleanup', async () => {
    const f = await fixture(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    f.vm.create.mockImplementation(async () => { await gate; f.vm.live.add('vm'); return 'vm'; });
    const session = await f.manager.create(input);
    await vi.waitFor(() => expect(f.vm.create).toHaveBeenCalledTimes(1));
    await f.manager.stop(session.id); release(); await settled(f.manager);
    expect(await f.repo.creationAttempt(session.id)).toMatchObject({ status: 'created', sandboxId: 'vm' });
    expect(await f.repo.get(session.id)).toMatchObject({ state: 'ended' }); expect(f.vm.prepare).not.toHaveBeenCalled();
  });

  it('fences stale outcome updates and refuses a second create attempt', async () => {
    const f = await fixture(), session = abandoned(); await f.repo.insert(session);
    await f.repo.claim(session.id, 'old'); await f.repo.beginCreationAttempt(session.id, 'old', session.expiresAt);
    await expect(f.repo.beginCreationAttempt(session.id, 'old', session.expiresAt)).rejects.toThrow('already attempted');
    await f.db.query("UPDATE ephemeral_sessions SET lease_until=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=$1", [session.id]);
    await f.repo.claim(session.id, 'new');
    await expect(f.repo.recordCreationOutcome(session.id, 'old', { status: 'not_created', reason: 'request_rejected' })).rejects.toThrow('lease');
    expect(await f.repo.creationAttempt(session.id)).toMatchObject({ status: 'pending' });
    await expect(f.manager.reconcileOne(session.id)).rejects.toThrow('lease');
  });

  it('recovers an unresolved attempt after closing and reopening a real PGlite directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ephemeral-attempt-')); close.push(() => rm(directory, { recursive: true, force: true }));
    const session = abandoned(); const first = new PGlite(directory);
    const old = await createSessionRepository(first as unknown as Database); await old.insert(session);
    await old.claim(session.id, 'owner'); await old.beginCreationAttempt(session.id, 'owner', session.expiresAt); await old.release(session.id, 'owner');
    await first.close();
    const db = new PGlite(directory); close.push(() => db.close());
    const repo = await createSessionRepository(db as unknown as Database), vm = provider();
    const manager = new SessionManager(repo, vm, { issue: async () => 'token', disable: async () => {}, revokeGitHub: async () => {} }); close.push(() => manager.shutdown());
    expect(await repo.creationAttempt(session.id)).toMatchObject({ status: 'pending' });
    expect(await manager.reconcileOne(session.id)).toMatchObject({ state: 'cleanup_pending', cleanup: { vm: 'pending' } });
    expect(vm.create).not.toHaveBeenCalled();
  });
});
