import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createSessionRepository } from '../server/core/repository.js';
import { createSetupController, createSetupRepository, type SetupRun } from '../server/setup.js';
import { PreviewProvider } from '../server/preview.js';
import type { Database, SandboxProvider, Session } from '../server/contracts.js';

const input = { label: 'Check', command: 'echo checked', timeoutSeconds: 30 };
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const session = (id: string): Session => ({ id, userId: id, repository: 'owner/repo', repositoryId: 1, installationId: 2,
  baseBranch: 'main', branch: `ephemeral/${id}`, state: 'running', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  maxExpiresAt: new Date(Date.now() + 3600_000).toISOString(), sandboxId: 'sandbox', endedAt: null, error: null,
  cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified' });

describe('setup lifecycle boundaries and isolated admission', () => {
  const db = new PGlite();
  const database: Database = { async query<T>(sql: string, params?: unknown[]) { return { rows: (await db.query<T>(sql, params)).rows }; }, close: () => db.close() };
  let repo: Awaited<ReturnType<typeof createSessionRepository>>, setup: Awaited<ReturnType<typeof createSetupController>>;
  let provider: SandboxProvider, run: Mock<NonNullable<SandboxProvider['runSetup']>>, authorize: Mock<(s: Session) => Promise<void>>;
  beforeAll(async () => { repo = await createSessionRepository(database); });
  beforeEach(async () => {
    run = vi.fn<NonNullable<SandboxProvider['runSetup']>>(async () => ({ status: 'succeeded', exitCode: 0 }));
    authorize = vi.fn<(s: Session) => Promise<void>>(async () => {});
    provider = new PreviewProvider(); provider.runSetup = run;
    setup = await createSetupController(database, repo, provider, 'live', authorize);
  });
  afterEach(async () => { vi.restoreAllMocks(); await setup.close(); });
  afterAll(() => db.close());
  async function saved(id: string) { const s = session(id); await repo.insert(s); return { s, recipe: (await setup.save(s, input)).recipe! }; }
  async function finished(s: Session) { await vi.waitFor(async () => expect((await setup.progress(s)).run?.finishedAt).toBeTruthy()); return (await setup.progress(s)).run!; }
  const cancellable = (_s: Session, _i: unknown, _output: unknown, signal: AbortSignal) => new Promise<{ status: 'cancelled'; exitCode: null }>(resolve => {
    signal.addEventListener('abort', () => resolve({ status: 'cancelled', exitCode: null }), { once: true });
  });

  it('makes a failed pre-launch authorization retryable without exposing upstream errors', async () => {
    const { s, recipe } = await saved('before-auth');
    authorize.mockResolvedValueOnce().mockRejectedValueOnce(new Error('private upstream detail'));
    await setup.start(s, recipe.version);
    expect(await finished(s)).toMatchObject({ status: 'failed', reason: 'authorization_failed', invocationStarted: false, blockedUntil: null });
    expect((await setup.progress(s)).run?.error).not.toContain('private'); expect(run).not.toHaveBeenCalled();
    await setup.start(s, recipe.version); expect((await finished(s)).status).toBe('succeeded'); expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('never invokes when the running marker write fails (committed before error: %s)', async committed => {
    const { s, recipe } = await saved(`before-persist-${committed}`);
    const query = database.query.bind(database); let failed = false;
    vi.spyOn(database, 'query').mockImplementation(async (sql, params) => {
      if (!failed && sql.startsWith('UPDATE session_setup_runs SET data=$2') && JSON.parse(String(params?.[1])).status === 'running') {
        failed = true; if (committed) await query(sql, params); throw new Error('database acknowledgement unavailable');
      }
      return query(sql, params);
    });
    await setup.start(s, recipe.version);
    expect(await finished(s)).toMatchObject({ status: 'failed', reason: 'persistence_failed', invocationStarted: false, blockedUntil: null });
    expect(run).not.toHaveBeenCalled();
    await setup.start(s, recipe.version); expect((await finished(s)).status).toBe('succeeded');
  });

  it('keeps admission owned until a pre-launch failure final record becomes durable', async () => {
    const { s, recipe } = await saved('before-final-persist');
    const query = database.query.bind(database); let finalAttempt = false;
    const spy = vi.spyOn(database, 'query').mockImplementation(async (sql, params) => {
      if (sql.startsWith('UPDATE session_setup_runs SET data=$2')) {
        const snapshot = JSON.parse(String(params?.[1]));
        if (snapshot.finishedAt) finalAttempt = true;
        throw new Error('database unavailable');
      }
      return query(sql, params);
    });
    await setup.start(s, recipe.version); await vi.waitFor(() => expect(finalAttempt).toBe(true));
    expect((await setup.progress(s)).run?.status).toBe('queued');
    await expect(setup.start(s, recipe.version)).rejects.toThrow('database unavailable'); expect(run).not.toHaveBeenCalled();
    spy.mockRestore();
    expect((await setup.progress(s)).run).toMatchObject({ status: 'failed', reason: 'persistence_failed', blockedUntil: null });
    await setup.start(s, recipe.version); expect((await finished(s)).status).toBe('succeeded');
  });

  it('finalizes an acknowledged-lost insert without invoking the provider', async () => {
    const { s, recipe } = await saved('insert-ack-lost');
    const query = database.query.bind(database); let failed = false;
    vi.spyOn(database, 'query').mockImplementation(async (sql, params) => {
      const result = await query(sql, params);
      if (!failed && sql.includes('INSERT INTO session_setup_runs(id,session_id,data,blocked_until)')) {
        failed = true; throw new Error('insert acknowledgement lost');
      }
      return result;
    });
    await expect(setup.start(s, recipe.version)).rejects.toThrow('insert acknowledgement lost');
    expect(await finished(s)).toMatchObject({ status: 'failed', reason: 'persistence_failed', blockedUntil: null, invocationStarted: false });
    expect(run).not.toHaveBeenCalled();
    await setup.start(s, recipe.version); expect((await finished(s)).status).toBe('succeeded');
  });

  it('records provider absence as a safe pre-launch failure', async () => {
    const { s, recipe } = await saved('provider-absent'); provider.runSetup = undefined;
    await setup.start(s, recipe.version);
    expect(await finished(s)).toMatchObject({ status: 'failed', reason: 'provider_unavailable', invocationStarted: false, blockedUntil: null });
    provider.runSetup = run; await setup.start(s, recipe.version); expect((await finished(s)).status).toBe('succeeded');
  });

  it('checks sandbox identity again after the durable marker and never launches a changed target', async () => {
    const { s, recipe } = await saved('target-changed'); const query = database.query.bind(database); let changed = false;
    vi.spyOn(database, 'query').mockImplementation(async (sql, params) => {
      const result = await query(sql, params);
      if (!changed && sql.startsWith('UPDATE session_setup_runs SET data=$2') && JSON.parse(String(params?.[1])).status === 'running') {
        changed = true; await repo.update({ ...s, sandboxId: 'replacement-sandbox' });
      }
      return result;
    });
    await setup.start(s, recipe.version);
    expect(await finished(s)).toMatchObject({ status: 'failed', reason: 'authorization_failed', blockedUntil: null });
    expect(run).not.toHaveBeenCalled();
  });

  it('checks repository identity again after asynchronous authorization', async () => {
    const { s, recipe } = await saved('repository-changed');
    authorize.mockImplementationOnce(async () => { await repo.update({ ...s, repositoryId: 999 }); });
    await expect(setup.start(s, recipe.version)).rejects.toMatchObject({ status: 409 });
    expect(run).not.toHaveBeenCalled(); expect((await setup.progress(s)).run).toBeNull();
  });

  it('releases only explicitly uninvoked queued records on restart and never replays uncertain records', async () => {
    const entries = await Promise.all(['restart-queued', 'restart-legacy', 'restart-running'].map(saved));
    await setup.close(); const store = await createSetupRepository(database);
    for (const [index, { s, recipe }] of entries.entries()) {
      const record: SetupRun = { id: s.id, sessionId: s.id, recipe, status: index === 2 ? 'running' : 'queued', output: '', truncated: false,
        exitCode: null, startedAt: null, finishedAt: null, error: null, blockedUntil: new Date(Date.now() + 60_000).toISOString(),
        ...(index === 0 ? { invocationStarted: false } : index === 2 ? { invocationStarted: true } : {}) };
      await store.insert(s, record);
    }
    setup = await createSetupController(database, repo, provider, 'live', authorize);
    expect((await setup.progress(entries[0]!.s)).run).toMatchObject({ status: 'failed', reason: 'server_shutdown', blockedUntil: null });
    for (const { s, recipe } of entries.slice(1)) {
      expect((await setup.progress(s)).run).toMatchObject({ status: 'interrupted', reason: 'server_shutdown', blockedUntil: expect.any(String) });
      await expect(setup.start(s, recipe.version)).rejects.toMatchObject({ status: 409 });
    }
    expect(run).not.toHaveBeenCalled();
    await setup.start(entries[0]!.s, entries[0]!.recipe.version); expect((await finished(entries[0]!.s)).status).toBe('succeeded');
  });

  it('persists the invocation boundary before calling the provider', async () => {
    const { s, recipe } = await saved('marker-before-call');
    run.mockImplementationOnce(async (_session, command) => {
      const { rows } = await db.query<{ data: SetupRun }>('SELECT data FROM session_setup_runs WHERE id=$1', [command.runId]);
      expect(rows[0]?.data).toMatchObject({ status: 'running', invocationStarted: true, blockedUntil: expect.any(String) });
      return { status: 'succeeded', exitCode: 0 };
    });
    await setup.start(s, recipe.version); expect((await finished(s)).status).toBe('succeeded'); expect(run).toHaveBeenCalledTimes(1);
  });

  it('fences an inserted but not launched run when shutdown begins', async () => {
    const { s, recipe } = await saved('shutdown-insert'); const gate = deferred(); let inserted = false;
    const query = database.query.bind(database);
    vi.spyOn(database, 'query').mockImplementation(async (sql, params) => {
      const result = await query(sql, params);
      if (sql.includes('INSERT INTO session_setup_runs(id,session_id,data,blocked_until)')) { inserted = true; await gate.promise; }
      return result;
    });
    const starting = setup.start(s, recipe.version); await vi.waitFor(() => expect(inserted).toBe(true));
    const closing = setup.close(); gate.resolve(); await starting; await closing;
    expect(await finished(s)).toMatchObject({ status: 'failed', reason: 'server_shutdown', invocationStarted: false, blockedUntil: null });
    expect(run).not.toHaveBeenCalled();
  });

  it('cancels without upstream authorization and distinguishes unconfirmed cancellation', async () => {
    const { s, recipe } = await saved('cancel-unconfirmed');
    run.mockImplementationOnce((_s, _i, _output, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('remote response lost')), { once: true })));
    const started = await setup.start(s, recipe.version); await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const authorized = authorize.mock.calls.length; authorize.mockRejectedValue(new Error('GitHub unavailable'));
    await setup.cancel(s, started.run.id);
    expect(await finished(s)).toMatchObject({ status: 'interrupted', reason: 'user_cancelled', blockedUntil: expect.any(String), invocationStarted: true });
    expect(authorize).toHaveBeenCalledTimes(authorized);
  });

  it('records failed authorization verification during execution and confirms termination', async () => {
    const { s, recipe } = await saved('during-auth');
    run.mockImplementationOnce(cancellable);
    await setup.start(s, recipe.version); await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    authorize.mockRejectedValue(new Error('authorization service unavailable'));
    // Advance the authorization age without replacing timers used by PGlite.
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    expect(await finished(s)).toMatchObject({ status: 'interrupted', reason: 'authorization_failed', blockedUntil: null });
  });

  it('fences a late health-check rejection after confirmed completion', async () => {
    const { s, recipe } = await saved('late-health'); const completion = deferred<{ status: 'succeeded'; exitCode: number }>();
    run.mockImplementationOnce(() => completion.promise);
    await setup.start(s, recipe.version); await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const check = deferred(); let checking = false;
    authorize.mockImplementation(async () => { checking = true; await check.promise; throw new Error('late authorization failure'); });
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    await vi.waitFor(() => expect(checking).toBe(true), { timeout: 2000 });
    completion.resolve({ status: 'succeeded', exitCode: 0 }); const result = await finished(s);
    check.resolve(); await Promise.resolve(); await Promise.resolve();
    expect((await setup.progress(s)).run).toEqual(result); expect(result).toMatchObject({ status: 'succeeded', blockedUntil: null });
    expect(result.reason).toBeUndefined();
  });

  it('retains the first cancellation cause when shutdown races confirmed termination', async () => {
    const { s, recipe } = await saved('first-cause'); const completion = deferred<{ status: 'cancelled'; exitCode: null }>();
    run.mockImplementationOnce(() => completion.promise);
    const started = await setup.start(s, recipe.version); await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await setup.cancel(s, started.run.id); const closing = setup.close(); completion.resolve({ status: 'cancelled', exitCode: null }); await closing;
    expect(await finished(s)).toMatchObject({ status: 'cancelled', reason: 'user_cancelled', blockedUntil: null });
  });

  it('records a persistence failure during execution separately from user cancellation', async () => {
    const { s, recipe } = await saved('during-persist');
    run.mockImplementationOnce((_s, _i, output, signal) => { output('safe progress\n'); return cancellable(_s, _i, output, signal); });
    const query = database.query.bind(database); let failed = false;
    vi.spyOn(database, 'query').mockImplementation(async (sql, params) => {
      if (!failed && sql.startsWith('UPDATE session_setup_runs SET data=$2') && JSON.parse(String(params?.[1])).output) {
        failed = true; throw new Error('database unavailable');
      }
      return query(sql, params);
    });
    await setup.start(s, recipe.version);
    expect(await finished(s)).toMatchObject({ status: 'interrupted', reason: 'persistence_failed', blockedUntil: null });
  });

  it('lets another session save and cancel while one authorization is slow', async () => {
    const a = await saved('isolation-a'), b = await saved('isolation-b'), c = await saved('isolation-c');
    run.mockImplementationOnce(cancellable); const started = await setup.start(b.s, b.recipe.version);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const gate = deferred(); authorize.mockImplementation(async s => { if (s.id === a.s.id) await gate.promise; });
    const savingA = setup.save(a.s, { ...input, command: 'echo slow' });
    await vi.waitFor(() => expect(authorize.mock.calls.some(([s]) => s.id === a.s.id)).toBe(true));
    try {
      await setup.cancel(b.s, started.run.id);
      expect(await finished(b.s)).toMatchObject({ reason: 'user_cancelled', status: 'cancelled' });
      expect((await setup.save(c.s, { ...input, command: 'echo independent' })).recipe?.command).toBe('echo independent');
    } finally { gate.resolve(); await savingA; }
  });

  it('orders one session requests and caps that session at eight pending mutations', async () => {
    const { s } = await saved('queue-order'); const gate = deferred(); let entered = false;
    authorize.mockImplementationOnce(async () => { entered = true; await gate.promise; });
    const requests = Array.from({ length: 8 }, (_, i) => setup.save(s, { ...input, command: `echo ${i}` }));
    await vi.waitFor(() => expect(entered).toBe(true));
    await expect(setup.save(s, input)).rejects.toMatchObject({ status: 429 });
    gate.resolve(); const results = await Promise.all(requests);
    expect(results.map(result => result.recipe?.command)).toEqual(Array.from({ length: 8 }, (_, i) => `echo ${i}`));
    expect((await setup.progress(s)).recipe?.command).toBe('echo 7');
  });

  it('caps pending requests across sessions at 32 and fences queued mutations on shutdown', async () => {
    const entries = await Promise.all(Array.from({ length: 5 }, (_, i) => saved(`queue-total-${i}`)));
    const gate = deferred(); let entered = 0; authorize.mockImplementation(async () => { entered++; await gate.promise; });
    const requests = entries.slice(0, 4).flatMap(({ s }) => Array.from({ length: 8 }, () => setup.save(s, { ...input, command: 'echo must not save' })));
    const results = Promise.allSettled(requests); await vi.waitFor(() => expect(entered).toBe(4));
    await expect(setup.save(entries[4]!.s, input)).rejects.toMatchObject({ status: 429 });
    const closing = setup.close(); gate.resolve(); await closing;
    expect((await results).every(result => result.status === 'rejected')).toBe(true);
    for (const { s, recipe } of entries) expect((await setup.progress(s)).recipe).toEqual(recipe);
    await expect(setup.save(entries[0]!.s, input)).rejects.toMatchObject({ status: 409 });
  });

  it('reserves the global eight execution slots before asynchronous inserts can race', async () => {
    const entries = await Promise.all(Array.from({ length: 10 }, (_, i) => saved(`capacity-${i}`)));
    run.mockImplementation(cancellable);
    const results = await Promise.allSettled(entries.map(({ s, recipe }) => setup.start(s, recipe.version)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(8);
    expect(results.filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason.status)).toEqual([429, 429]);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(8));
    await setup.close();
    for (const [i, result] of results.entries()) if (result.status === 'fulfilled')
      expect((await setup.progress(entries[i]!.s)).run).toMatchObject({ status: 'interrupted', reason: 'server_shutdown', blockedUntil: null });
  });
});
