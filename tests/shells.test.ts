import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createSessionRepository } from '../server/core/repository.js';
import { createShellController, createShellRepository } from '../server/shells.js';
import { PreviewProvider } from '../server/preview.js';
import type { Database, SandboxProvider, Session } from '../server/contracts.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const session = (): Session => {
  const id = randomUUID(), now = new Date().toISOString();
  return { id, userId: id, repository: 'owner/repo', repositoryId: 1, installationId: 1, baseBranch: 'main', branch: `ephemeral/${id}`,
    state: 'running', createdAt: now, expiresAt: new Date(Date.now() + 3600_000).toISOString(), maxExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
    sandboxId: 'vm', endedAt: null, error: null, cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified' };
};
describe('durable supplemental shells', () => {
  const db = new PGlite();
  const database: Database = { async query<T>(sql: string, params?: unknown[]) { return { rows: (await db.query<T>(sql, params)).rows }; }, close: () => db.close() };
  let repo: Awaited<ReturnType<typeof createSessionRepository>>, shells: Awaited<ReturnType<typeof createShellController>>, provider: PreviewProvider;
  const ensure = vi.fn<NonNullable<PreviewProvider['ensureShell']>>(), inspect = vi.fn<NonNullable<PreviewProvider['inspectShell']>>(), close = vi.fn<NonNullable<PreviewProvider['closeShell']>>();
  const authorize = vi.fn(async () => {}), onClosing = vi.fn();
  beforeAll(async () => { repo = await createSessionRepository(database); });
  beforeEach(async () => {
    vi.clearAllMocks(); ensure.mockResolvedValue('open'); inspect.mockResolvedValue('open'); close.mockResolvedValue('closed');
    provider = new PreviewProvider(); provider.ensureShell = ensure; provider.inspectShell = inspect; provider.closeShell = close;
    shells = await createShellController(database, repo, provider, 'live', authorize, onClosing);
  });
  afterAll(() => db.close());
  async function saved() { const s = session(); await repo.insert(s); return s; }
  const supplemental = (result: Awaited<ReturnType<typeof shells.list>>) => result.shells.filter(shell => shell.kind === 'supplemental');

  it('serializes duplicate creation and enforces one supplemental across distinct requests', async () => {
    const s = await saved(), requestId = randomUUID();
    const [a,b] = await Promise.all([shells.create(s, requestId, 'Build'), shells.create(s, requestId, 'Build')]);
    expect(supplemental(a)).toHaveLength(1); expect(supplemental(b)[0].id).toBe(supplemental(a)[0].id); expect(ensure).toHaveBeenCalledTimes(1);
    await expect(shells.create(s, randomUUID(), 'Another')).rejects.toMatchObject({ status: 409 }); expect(ensure).toHaveBeenCalledTimes(1);
  });
  it('protects primary, renames secondary, disconnects before remote close and never recreates closed request', async () => {
    const s = await saved(), requestId = randomUUID(), shell = supplemental(await shells.create(s, requestId, 'Build'))[0];
    await expect(shells.rename(s, 'codex', 'Other')).rejects.toMatchObject({ status: 409 });
    await expect(shells.closeShell(s, 'codex')).rejects.toMatchObject({ status: 409 });
    expect(supplemental(await shells.rename(s, shell.id, '  Tests  '))[0].name).toBe('Tests');
    close.mockImplementationOnce(async () => {
      expect(onClosing).toHaveBeenCalledWith(s.id, shell.id); expect(await shells.attachable(s, shell.id)).toBe(false);
      expect((await shells.store.list(s.id))[0].state).toBe('closing'); return 'closed';
    });
    await shells.closeShell(s, shell.id); await shells.closeShell(s, shell.id); expect(close).toHaveBeenCalledTimes(1);
    const replay = supplemental(await shells.create(s, requestId.toUpperCase(), 'Replay')); expect(replay[0].state).toBe('closed'); expect(ensure).toHaveBeenCalledTimes(1);
    const next = supplemental(await shells.create(s, randomUUID(), 'Fresh')); expect(next[1].id).not.toBe(shell.id); expect(next[1].state).toBe('open');
  });
  it('retains ambiguous creation across restart and recovers only by inspecting', async () => {
    const s = await saved(), requestId = randomUUID(); ensure.mockRejectedValueOnce(new Error('secret-token')); inspect.mockResolvedValue('unknown');
    const uncertain = supplemental(await shells.create(s, requestId, 'Unknown'))[0]; expect(uncertain.state).toBe('uncertain'); expect(uncertain.error).not.toContain('secret-token');
    await shells.close(); shells = await createShellController(database, repo, provider, 'live', authorize, onClosing);
    await expect(shells.create(s, randomUUID(), 'Blocked')).rejects.toMatchObject({ status: 409 });
    await shells.create(s, requestId, 'Retry'); expect(ensure).toHaveBeenCalledTimes(1);
    inspect.mockResolvedValue('open'); expect(supplemental(await shells.list(s))[0].state).toBe('open'); expect(ensure).toHaveBeenCalledTimes(1);
  });
  it('reserves an absent target after ambiguous creation until explicit close fences it', async () => {
    const s = await saved(), requestId = randomUUID(); ensure.mockRejectedValueOnce(new Error('offline')); inspect.mockResolvedValue('closed');
    const shell = supplemental(await shells.create(s, requestId, 'Failed'))[0]; expect(shell.state).toBe('uncertain');
    await shells.create(s, requestId, 'Retry'); expect(ensure).toHaveBeenCalledTimes(1);
    await expect(shells.create(s, randomUUID(), 'Too soon')).rejects.toMatchObject({ status: 409 });
    await shells.closeShell(s, shell.id); await shells.create(s, requestId, 'Closed replay'); expect(ensure).toHaveBeenCalledTimes(1);
    ensure.mockResolvedValue('open'); await shells.create(s, randomUUID(), 'Fresh'); expect(ensure).toHaveBeenCalledTimes(2);
  });
  it('orphaned close is inspected after restart, requires explicit retry when still open, and does not reopen closed ids', async () => {
    const s = await saved(), shell = supplemental(await shells.create(s, randomUUID(), 'Close'))[0];
    const store = await createShellRepository(database); await store.save({ ...shell, state: 'closing', intent: 'close' });
    await shells.close(); shells = await createShellController(database, repo, provider, 'live', authorize, onClosing);
    expect(supplemental(await shells.list(s))[0]).toMatchObject({ state: 'uncertain', intent: 'close' }); expect(close).not.toHaveBeenCalled();
    await shells.closeShell(s, shell.id); expect(close).toHaveBeenCalledTimes(1); expect(await shells.attachable(s, shell.id)).toBe(false);
  });
  it('ambiguous close reserves slot until read-only inspection confirms termination', async () => {
    const s = await saved(), shell = supplemental(await shells.create(s, randomUUID(), 'Close'))[0];
    close.mockRejectedValueOnce(new Error('token')); inspect.mockResolvedValue('unknown');
    expect(supplemental(await shells.closeShell(s, shell.id))[0].state).toBe('uncertain');
    await expect(shells.create(s, randomUUID(), 'New')).rejects.toMatchObject({ status: 409 });
    inspect.mockResolvedValue('closed'); expect((await shells.list(s)).canCreate).toBe(true); expect(close).toHaveBeenCalledTimes(1);
  });
  it('rechecks running state after authorization and closes target when session ends during create', async () => {
    const s = await saved(); authorize.mockImplementationOnce(async () => { await repo.update({ ...s, state: 'cleanup_pending' }); });
    await expect(shells.create(s, randomUUID(), 'Ended')).rejects.toMatchObject({ status: 409 }); expect(ensure).not.toHaveBeenCalled();
    await repo.update(s); ensure.mockImplementationOnce(async () => { await repo.update({ ...s, state: 'cleanup_pending' }); return 'open'; });
    const result = await shells.create(s, randomUUID(), 'Ending'); expect(supplemental(result)[0].state).toBe('closed'); expect(result.canCreate).toBe(false); expect(close).toHaveBeenCalledTimes(1);
  });
  it('does not release the slot when close resolves unknown or open', async () => {
    for (const state of ['unknown', 'open'] as const) {
      const s = await saved(), shell = supplemental(await shells.create(s, randomUUID(), 'Close'))[0];
      close.mockResolvedValueOnce(state); inspect.mockResolvedValueOnce('open');
      expect(supplemental(await shells.closeShell(s, shell.id))[0]).toMatchObject({ state: 'uncertain', intent: 'close' });
      await expect(shells.create(s, randomUUID(), 'Unsafe new generation')).rejects.toMatchObject({ status: 409 });
    }
  });
  it('preserves a required close acknowledgment across ambiguous create, ambiguous close and restart', async () => {
    const s = await saved(); ensure.mockRejectedValueOnce(new Error('transport unknown')); inspect.mockResolvedValue('closed');
    const shell = supplemental(await shells.create(s, randomUUID(), 'Fence'))[0]; expect(shell).toMatchObject({ state: 'uncertain', requiresCloseAck: true });
    close.mockResolvedValueOnce('unknown'); expect(supplemental(await shells.closeShell(s, shell.id))[0]).toMatchObject({ state: 'uncertain', intent: 'close', requiresCloseAck: true });
    await shells.close(); shells = await createShellController(database, repo, provider, 'live', authorize, onClosing); await shells.reconcile();
    const recovered = await shells.list(s); expect(supplemental(recovered)[0]).toMatchObject({ state: 'uncertain', requiresCloseAck: true }); expect(recovered.canCreate).toBe(false); expect(ensure).toHaveBeenCalledTimes(1);
    await expect(shells.create(s, randomUUID(), 'Unsafe')).rejects.toMatchObject({ status: 409 });
    const confirmed = await shells.closeShell(s, shell.id); expect(supplemental(confirmed)[0]).toMatchObject({ state: 'closed', requiresCloseAck: false }); expect(confirmed.canCreate).toBe(true);
  });
  it('requires current authorization and expiry for actions and validates provider-independent names', async () => {
    const s = await saved(); authorize.mockRejectedValueOnce(new Error('Access revoked'));
    await expect(shells.create(s, randomUUID(), 'No access')).rejects.toThrow('Access revoked'); expect(ensure).not.toHaveBeenCalled();
    for (const name of ['', '\nShell', 'x'.repeat(81)]) await expect(shells.create(s, randomUUID(), name)).rejects.toMatchObject({ status: 400 });
    await repo.update({ ...s, expiresAt: new Date(Date.now()-100).toISOString() });
    await expect(shells.create(s, randomUUID(), 'Expired')).rejects.toMatchObject({ status: 409 }); expect((await shells.list(s)).canCreate).toBe(false);
  });
  it('observes primary exit and recovers only a confirmed closed shell through an explicit action', async () => {
    const s = await saved(), recover = vi.fn<NonNullable<SandboxProvider['recoverPrimaryShell']>>().mockResolvedValue('open');
    (provider as SandboxProvider).recoverPrimaryShell = recover;
    inspect.mockResolvedValue('closed');
    expect((await shells.list(s)).shells[0].state).toBe('closed'); expect(recover).not.toHaveBeenCalled();
    inspect.mockImplementation(async (_s, id) => id === 'codex' && !recover.mock.calls.length ? 'closed' : 'open');
    expect((await shells.recoverPrimary(s)).shells[0].state).toBe('open'); expect(recover).toHaveBeenCalledTimes(1);
    await shells.recoverPrimary(s); expect(recover).toHaveBeenCalledTimes(1);
    inspect.mockResolvedValue('unknown');
    expect((await shells.list(s)).shells[0].state).toBe('uncertain');
    await expect(shells.recoverPrimary(s)).rejects.toMatchObject({ status: 409 }); expect(recover).toHaveBeenCalledTimes(1);
    await expect(shells.closeShell(s, 'codex')).rejects.toMatchObject({ status: 409 }); expect(close).not.toHaveBeenCalled();
  });
  it('allows another session to proceed while one VM is slow and drains every active queue on shutdown', async () => {
    const a = await saved(), b = await saved();
    let releaseA!: () => void, releaseB!: () => void;
    const enteredA = deferred(), enteredB = deferred();
    ensure.mockImplementation(async s => {
      if (s.id === a.id) { enteredA.resolve(); await new Promise<void>(resolve => { releaseA = resolve; }); }
      else { enteredB.resolve(); await new Promise<void>(resolve => { releaseB = resolve; }); }
      return 'open';
    });
    const first = shells.create(a, randomUUID(), 'Slow A'); await enteredA.promise;
    const second = shells.create(b, randomUUID(), 'Slow B'); await enteredB.promise;
    let drained = false; const shutdown = shells.close().then(() => { drained = true; });
    await expect(shells.list(a)).rejects.toMatchObject({ status: 409 });
    releaseA(); await first; await Promise.resolve(); expect(drained).toBe(false);
    releaseB(); await second; await shutdown; expect(drained).toBe(true);
  });
  it('bounds per-session admission without consuming every slot and freezes queued work on shutdown', async () => {
    const a = await saved(), b = await saved(), entered = deferred(), release = deferred();
    ensure.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return 'open'; });
    const creating = shells.create(a, randomUUID(), 'Blocked'); await entered.promise;
    const queued = Array.from({ length: 7 }, () => shells.list(a));
    const outcomes = queued.map(task => task.catch(error => error));
    await expect(shells.list(a)).rejects.toMatchObject({ status: 429 });
    expect((await shells.list(b)).shells[0].state).toBe('open');
    const shutdown = shells.close(); release.resolve(); await creating;
    expect((await Promise.all(outcomes)).every(value => value.status === 409)).toBe(true); await shutdown;
  });
  it('bounds total admitted operations across independent session queues', async () => {
    const values = await Promise.all(Array.from({ length: 5 }, saved)), entered = deferred(), release = deferred();
    let started = 0;
    ensure.mockImplementation(async () => { if (++started === 4) entered.resolve(); await release.promise; return 'open'; });
    const creating = values.slice(0, 4).map(s => shells.create(s, randomUUID(), 'Concurrent'));
    await entered.promise;
    const queued = values.slice(0, 4).flatMap(s => Array.from({ length: 7 }, () => shells.list(s)));
    await expect(shells.list(values[4])).rejects.toMatchObject({ status: 429 });
    release.resolve(); await Promise.all([...creating, ...queued]);
    expect((await shells.list(values[4])).shells[0].state).toBe('open');
  });
  it('serializes overlapping primary recoveries and supplemental creation for one session', async () => {
    const s = await saved(), entered = deferred(), release = deferred();
    let primary: 'open' | 'closed' = 'closed';
    inspect.mockImplementation(async (_s, id) => id === 'codex' ? primary : 'open');
    const recover = vi.fn(async () => { entered.resolve(); await release.promise; primary = 'open'; return primary; });
    (provider as SandboxProvider).recoverPrimaryShell = recover;
    const first = shells.recoverPrimary(s); await entered.promise;
    const second = shells.recoverPrimary(s), supplemental = shells.create(s, randomUUID(), 'After recovery');
    expect(ensure).not.toHaveBeenCalled(); release.resolve();
    await Promise.all([first, second, supplemental]); expect(recover).toHaveBeenCalledTimes(1); expect(ensure).toHaveBeenCalledTimes(1);
  });
  it('rechecks running state, expiry and authorization after a slow primary inspection before recovery', async () => {
    for (const change of ['stop', 'expire', 'revoke'] as const) {
      const s = await saved(), entered = deferred(), release = deferred();
      const recover = vi.fn<NonNullable<SandboxProvider['recoverPrimaryShell']>>().mockResolvedValue('open');
      (provider as SandboxProvider).recoverPrimaryShell = recover;
      inspect.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return 'closed'; });
      const recovery = shells.recoverPrimary(s); const outcome = recovery.catch(error => error); await entered.promise;
      if (change === 'stop') await repo.update({ ...s, state: 'cleanup_pending' });
      else if (change === 'expire') await repo.update({ ...s, expiresAt: new Date(Date.now() - 100).toISOString() });
      else authorize.mockRejectedValueOnce(new Error('Access revoked during inspection'));
      release.resolve(); expect(await outcome).toBeInstanceOf(Error); expect(recover).not.toHaveBeenCalled();
    }
  });
});
