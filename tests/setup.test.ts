import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createSessionRepository } from '../server/core/repository.js';
import { createSetupController, createSetupRepository, redactSetupOutput } from '../server/setup.js';
import { PreviewProvider } from '../server/preview.js';
import type { Database, SandboxProvider, Session } from '../server/contracts.js';

const input = { label: 'Install and test', command: 'npm ci && npm test', timeoutSeconds: 5 };
const session = (id: string, changes: Partial<Session> = {}): Session => ({ id, userId: id, repository: 'owner/repo', repositoryId: 1, installationId: 2,
  baseBranch: 'main', branch: `ephemeral/${id}`, state: 'running', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  maxExpiresAt: new Date(Date.now() + 3600_000).toISOString(), sandboxId: 'sandbox', endedAt: null, error: null,
  cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified', ...changes });

describe('durable explicit repository setup', () => {
  const db = new PGlite();
  const database: Database = { async query<T>(sql: string, params?: unknown[]) { return { rows: (await db.query<T>(sql, params)).rows }; }, close: () => db.close() };
  let repo: Awaited<ReturnType<typeof createSessionRepository>>, setup: Awaited<ReturnType<typeof createSetupController>>;
  let provider: SandboxProvider, run: Mock<NonNullable<SandboxProvider['runSetup']>>, authorize: Mock<(s: Session) => Promise<void>>;
  beforeAll(async () => { repo = await createSessionRepository(database); });
  beforeEach(async () => {
    run = vi.fn<NonNullable<SandboxProvider['runSetup']>>(async () => ({ status: 'succeeded' as const, exitCode: 0 })); authorize = vi.fn<(s: Session) => Promise<void>>(async () => {});
    provider = new PreviewProvider(); provider.runSetup = run;
    setup = await createSetupController(database, repo, provider, 'live', authorize);
  });
  afterEach(async () => { await setup.close(); vi.restoreAllMocks(); });
  afterAll(() => db.close());
  async function saved(id: string, changes: Partial<Session> = {}) { const s = session(id, changes); await repo.insert(s); return { s, state: await setup.save(s, input) }; }
  async function finished(s: Session) { await vi.waitFor(async () => expect((await setup.progress(s)).run?.finishedAt).toBeTruthy()); return (await setup.progress(s)).run!; }

  it('saves without execution, versions edits, and reuses the same owner/repository recipe in a fresh session', async () => {
    const { s, state } = await saved('reuse'); expect(run).not.toHaveBeenCalled(); expect(state.run).toBeNull();
    const edited = await setup.save(s, { ...input, command: 'npm test' }); expect(edited.recipe!.version).not.toBe(state.recipe!.version);
    await repo.update({ ...s, state: 'ended' });
    const fresh = session('reuse-fresh', { userId: s.userId, repository: 'renamed/repo' }); await repo.insert(fresh);
    expect((await setup.progress(fresh)).recipe).toEqual(edited.recipe); expect((await setup.progress(fresh)).run).toBeNull();
    const foreign = session('reuse-foreign'); await repo.insert(foreign); expect((await setup.progress(foreign)).recipe).toBeNull();
    expect(await repo.get(fresh.id)).toEqual(fresh);
  });

  it('requires the exact reviewed version and snapshots the command for the run', async () => {
    const { s, state } = await saved('snapshot');
    let finish!: (value: { status: 'succeeded'; exitCode: number }) => void;
    run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await expect(setup.start(s, 'stale-version')).rejects.toMatchObject({ status: 409 });
    await setup.start(s, state.recipe!.version); await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const edited = await setup.save(s, { ...input, command: 'echo updated' });
    expect((await setup.progress(s)).run!.recipe).toEqual(state.recipe); expect(edited.recipe!.command).toBe('echo updated');
    expect(run.mock.calls[0][1]).toMatchObject({ command: input.command, timeoutMs: expect.any(Number), deadlineAt: expect.any(String) });
    finish({ status: 'succeeded', exitCode: 0 }); expect((await finished(s)).status).toBe('succeeded');
  });

  it('allows only one concurrent run and allows rerun after confirmed completion', async () => {
    const { s, state } = await saved('concurrent'); let finish!: (value: { status: 'succeeded'; exitCode: number }) => void;
    run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const starts = await Promise.allSettled([setup.start(s, state.recipe!.version), setup.start(s, state.recipe!.version)]);
    expect(starts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1)); finish({ status: 'succeeded', exitCode: 0 }); await finished(s);
    await setup.start(s, state.recipe!.version); await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2)); await finished(s);
  });

  it('streams bounded, redacted output before completion and retains useful failure', async () => {
    const { s, state } = await saved('output'); let emit!: (value: string) => void;
    let finish!: (value: { status: 'failed'; exitCode: number }) => void;
    run.mockImplementationOnce((_session, _input, onOutput) => { emit = onOutput; return new Promise(resolve => { finish = resolve; }); });
    await setup.start(s, state.recipe!.version); await vi.waitFor(() => expect(emit).toBeTypeOf('function'));
    emit('\x1b[31mInstalling\x1b[0m\nTOKEN=private-value\nghp_abcdef'); emit('12345\nBearer private-token\n');
    await vi.waitFor(async () => expect((await setup.progress(s)).run!.output).toContain('Installing'));
    const live = (await setup.progress(s)).run!; expect(live.output).not.toMatch(/private-value|abcdef|12345|private-token|\x1b/);
    emit('x'.repeat(80_000)); finish({ status: 'failed', exitCode: 23 });
    const result = await finished(s); expect(result.status).toBe('failed'); expect(result.exitCode).toBe(23); expect(result.error).toContain('Review');
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(65536); expect(result.truncated).toBe(true);
    expect(result.blockedUntil).toBeNull();
  });

  it('retains redacted startup and final failure output after exceeding the output budget', async () => {
    const { s, state } = await saved('head-tail');
    run.mockImplementationOnce(async (_session, _input, output) => {
      output('setup startup diagnostic\n');
      output('middle progress line\n'.repeat(5000));
      output('TOKEN=private-tail-value\nFinal failure: package registry unavailable\n');
      return { status: 'failed', exitCode: 17 };
    });
    await setup.start(s, state.recipe!.version);
    const result = await finished(s);
    expect(result).toMatchObject({ status: 'failed', truncated: true, outputRetention: 'head_tail', exitCode: 17 });
    expect(result.output).toContain('setup startup diagnostic');
    expect(result.output).toContain('[Setup output limit reached; omitted middle output.]');
    expect(result.output).toContain('Final failure: package registry unavailable');
    expect(result.output).not.toContain('private-tail-value');
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(65536);
  });

  it('never persists split credential values or clipped prefixes in durable snapshots', async () => {
    const { s, state } = await saved('redaction-persistence');
    const secret = randomBytes(32).toString('hex');
    let emit!: (text: string) => void, finish!: () => void;
    run.mockImplementationOnce((_session, _input, onOutput) => {
      emit = onOutput; return new Promise(resolve => { finish = () => resolve({ status: 'succeeded', exitCode: 0 }); });
    });
    const snapshots: string[] = [];
    const query = database.query.bind(database);
    vi.spyOn(database, 'query').mockImplementation(async (sql, params) => {
      if (sql.startsWith('UPDATE session_setup_runs SET data=$2')) snapshots.push(String(params?.[1]));
      return query(sql, params);
    });
    await setup.start(s, state.recipe!.version); await vi.waitFor(() => expect(emit).toBeTypeOf('function'));
    emit('safe progress\n{"access_token":"' + secret.slice(0, 18));
    // Wait for an actual durable running snapshot, not a timing assumption.
    await vi.waitFor(() => expect(snapshots.some(snapshot => snapshot.includes('safe progress'))).toBe(true));
    expect(snapshots.every(snapshot => !snapshot.includes(secret.slice(0, 8)))).toBe(true);
    emit('\x1b['); emit('31m' + secret.slice(18) + '"}\n');
    emit('x'.repeat(65520) + '\n{"refresh_token":"' + secret.slice(0, 14));
    emit(secret.slice(14) + '"}\n'); finish();
    const result = await finished(s);
    const stored = await db.query<{ data: { output: string } }>('SELECT data FROM session_setup_runs WHERE id=$1', [result.id]);
    expect(snapshots.every(snapshot => !snapshot.includes(secret.slice(0, 8)))).toBe(true);
    expect(stored.rows[0]!.data.output.includes(secret.slice(0, 8))).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.recipe.command).toBe(input.command);
  });

  it('retains an uncertain execution hold across controller restart and never replays it', async () => {
    const { s, state } = await saved('unknown'); run.mockRejectedValueOnce(new Error('ghp_do-not-echo-private-token'));
    await setup.start(s, state.recipe!.version); const result = await finished(s);
    expect(result.status).toBe('interrupted'); expect(result.error).not.toContain('ghp_'); expect(result.blockedUntil).toBeTruthy();
    await expect(setup.start(s, state.recipe!.version)).rejects.toMatchObject({ status: 409 });
    await setup.close(); setup = await createSetupController(database, repo, provider, 'live', authorize);
    expect((await setup.progress(s)).run).toEqual(result); expect(run).toHaveBeenCalledTimes(1);
    await expect(setup.start(s, state.recipe!.version)).rejects.toMatchObject({ status: 409 });
    await db.query(`UPDATE session_setup_runs SET blocked_until=clock_timestamp()-INTERVAL '1 second' WHERE session_id=$1`, [s.id]);
    await setup.start(s, state.recipe!.version); await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2)); await finished(s);
  });

  it('reports provider wire truncation even when retained text is below the local output cap', async () => {
    const { s, state } = await saved('wire-truncated');
    run.mockImplementationOnce(async (_session, _input, onOutput) => {
      onOutput('partial output\n[Setup output limit reached; further output omitted.]\n');
      return { status: 'succeeded', exitCode: 0 };
    });
    await setup.start(s, state.recipe!.version);
    expect(await finished(s)).toMatchObject({ status: 'succeeded', truncated: true, output: expect.stringContaining('further output omitted') });
  });

  it('marks orphaned active runs interrupted on startup and preserves the deadline', async () => {
    const { s, state } = await saved('orphan'); const store = await createSetupRepository(database);
    const deadline = new Date(Date.now() + 60_000).toISOString();
    await store.insert(s, { id: 'orphan-run', sessionId: s.id, recipe: state.recipe!, status: 'running', output: 'before restart', truncated: false,
      exitCode: null, startedAt: new Date().toISOString(), finishedAt: null, error: null, blockedUntil: deadline });
    await setup.close(); setup = await createSetupController(database, repo, provider, 'live', authorize);
    expect((await setup.progress(s)).run).toMatchObject({ status: 'interrupted', output: 'before restart', blockedUntil: deadline });
    await expect(setup.start(s, state.recipe!.version)).rejects.toMatchObject({ status: 409 }); expect(run).not.toHaveBeenCalled();
  });

  it('confirms cancellation, stops on expiry, and releases only confirmed termination', async () => {
    const { s, state } = await saved('cancel');
    run.mockImplementationOnce((_s, _i, _output, signal: AbortSignal) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ status: 'cancelled', exitCode: null }), { once: true })));
    const started = await setup.start(s, state.recipe!.version); await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await expect(setup.cancel(s, 'foreign-run')).rejects.toMatchObject({ status: 409 });
    await setup.cancel(s, started.run.id); expect(await finished(s)).toMatchObject({ status: 'cancelled', reason: 'user_cancelled', blockedUntil: null });
    run.mockImplementationOnce((_s, _i, _output, signal: AbortSignal) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ status: 'cancelled', exitCode: null }), { once: true })));
    await setup.start(s, state.recipe!.version); await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await repo.update({ ...s, expiresAt: new Date(Date.now() - 1).toISOString() });
    expect(await finished(s)).toMatchObject({ status: 'interrupted', reason: 'session_ended', blockedUntil: null });
  });

  it('caps execution at remaining session time and records timeout when its deadline triggers', async () => {
    const { s, state } = await saved('timeout', { expiresAt: new Date(Date.now() + 1800).toISOString() });
    run.mockImplementationOnce((_s, _i, onOutput, signal: AbortSignal) => new Promise(resolve => {
      onOutput('TIMEOUT_START');
      signal.addEventListener('abort', () => {
        onOutput('ED: child must stop before writing marker\n');
        resolve({ status: 'cancelled', exitCode: null });
      }, { once: true });
    }));
    await setup.start(s, state.recipe!.version); await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(1800);
    await vi.waitFor(async () => expect((await setup.progress(s)).run?.status).toBe('timed_out'), { timeout: 4000 });
    expect((await setup.progress(s)).run).toMatchObject({ blockedUntil: null, output: 'TIMEOUT_STARTED: child must stop before writing marker\n' });
  });

  it('retains buffered output on cancellation and ignores callbacks after confirmed completion', async () => {
    const { s, state } = await saved('cancel-output'); let emit!: (value: string) => void;
    run.mockImplementationOnce((_s, _i, onOutput, signal: AbortSignal) => new Promise(resolve => {
      emit = onOutput; onOutput('starting\n');
      signal.addEventListener('abort', () => { onOutput('buffered tail\n'); resolve({ status: 'cancelled', exitCode: null }); }, { once: true });
    }));
    const started = await setup.start(s, state.recipe!.version); await vi.waitFor(() => expect(emit).toBeTypeOf('function'));
    await setup.cancel(s, started.run.id);
    const result = await finished(s);
    expect(result).toMatchObject({ status: 'cancelled', output: 'starting\nbuffered tail\n' });
    emit('callback after completion must be ignored');
    expect((await setup.progress(s)).run).toEqual(result);
  });

  it('rejects ended sessions, authorization loss, and end during authorization without command execution', async () => {
    const { s, state } = await saved('guards');
    authorize.mockRejectedValueOnce(new Error('Repository unavailable')); await expect(setup.start(s, state.recipe!.version)).rejects.toThrow();
    authorize.mockImplementationOnce(async () => { await repo.update({ ...s, state: 'ended' }); });
    await expect(setup.start(s, state.recipe!.version)).rejects.toMatchObject({ status: 409 });
    await expect(setup.save(s, input)).rejects.toMatchObject({ status: 409 }); expect(run).not.toHaveBeenCalled();
    expect((await setup.progress(s)).recipe).toEqual(state.recipe);
  });

  it('retries a failed final write after database recovery instead of leaving a permanently active run', async () => {
    const { s, state } = await saved('final-write');
    const query = database.query.bind(database);
    const spy = vi.spyOn(database, 'query').mockImplementation((sql, params) => {
      if (sql.startsWith('UPDATE session_setup_runs SET data=') && JSON.parse(String(params?.[1])).finishedAt)
        return Promise.reject(new Error('temporary database failure'));
      return query(sql, params);
    });
    await setup.start(s, state.recipe!.version);
    await vi.waitFor(() => expect(stubsForFinalWrite()).toBe(true));
    expect((await setup.progress(s)).run!.status).toBe('running');
    await expect(setup.start(s, state.recipe!.version)).rejects.toThrow('temporary database failure');
    spy.mockRestore();
    expect((await setup.progress(s)).run).toMatchObject({ status: 'succeeded', exitCode: 0, blockedUntil: null });
    await setup.start(s, state.recipe!.version); await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2)); await finished(s);
    function stubsForFinalWrite() { return spy.mock.calls.some(([sql, params]) => sql.startsWith('UPDATE session_setup_runs SET data=') && JSON.parse(String(params?.[1])).finishedAt); }
  });

  it('does not overwrite lifecycle data or its worker lease', async () => {
    const { s, state } = await saved('lease'); await repo.claim(s.id, 'lifecycle');
    await setup.start(s, state.recipe!.version); await finished(s);
    await repo.save({ ...s, expiresAt: new Date(Date.now() + 4000_000).toISOString() }, 'lifecycle');
    expect((await repo.get(s.id))!.state).toBe('running'); expect((await setup.progress(s)).run!.status).toBe('succeeded');
  });
});

it('sanitizes common tokens, credentials, URL passwords, and terminal controls', () => {
  expect(redactSetupOutput('https://user:password@example.test\nAPI_KEY=abc\nBearer xyz\ngithub_pat_abcdef\x07')).toBe('https://[REDACTED]@example.test\nAPI_KEY=[REDACTED]\nBearer [REDACTED]\n[REDACTED]');
});
