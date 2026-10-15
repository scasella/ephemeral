import { randomUUID } from 'node:crypto';
import { createSetupOutputRedactor } from './setup-redaction.js';
import { createSetupOutputBuffer } from './setup-output.js';
export { redactSetupOutput } from './setup-redaction.js';
import type { Database, SandboxProvider, Session, SessionRepository } from './contracts.js';

export interface SetupRecipe { version: string; label: string; command: string; timeoutSeconds: number; updatedAt: string }
export type SetupStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'interrupted';
export type SetupReason = 'user_cancelled' | 'session_ended' | 'authorization_failed' | 'persistence_failed' | 'server_shutdown' | 'timeout' | 'provider_unavailable' | 'completion_unconfirmed';
export interface SetupRun {
  id: string; sessionId: string; recipe: SetupRecipe; status: SetupStatus; output: string; truncated: boolean;
  reason?: SetupReason; invocationStarted?: boolean; outputRetention?: 'head_tail';
  exitCode: number | null; startedAt: string | null; finishedAt: string | null; error: string | null; blockedUntil: string | null;
}
export class SetupError extends Error { constructor(public status: number, message: string) { super(message); } }
const OUTPUT_LIMIT = 64 * 1024;
const reasons: Record<SetupReason, string> = {
  user_cancelled: 'You cancelled this setup run.',
  session_ended: 'The session ended or expired while setup was active.',
  authorization_failed: 'Setup could not verify repository authorization. Reconnect and verify access before retrying.',
  persistence_failed: 'Setup stopped because its state could not be saved. Retry after storage recovers.',
  server_shutdown: 'The server stopped this setup run. It was not replayed.',
  timeout: 'Setup reached its timeout. Review the output or increase the saved timeout before retrying.',
  provider_unavailable: 'Setup execution is unavailable. Retry after the service recovers.',
  completion_unconfirmed: 'Setup could not confirm command completion. Review output and wait for the execution deadline before retrying.',
};
class SetupFailure extends SetupError {
  constructor(public reason: SetupReason) { super(409, reasons[reason]); }
}
const sameTarget = (a: Session, b: Session) => a.id === b.id && a.createdAt === b.createdAt && a.userId === b.userId && a.repositoryId === b.repositoryId
  && a.installationId === b.installationId && a.repository === b.repository && a.sandboxId === b.sandboxId
  && a.branch === b.branch && a.baseBranch === b.baseBranch;

const active = `SELECT id FROM ephemeral_sessions WHERE id=$1 AND user_id=$2
  AND state='running' AND data->>'sandboxId' IS NOT NULL
  AND (data->>'expiresAt')::timestamptz>clock_timestamp() FOR UPDATE`;
const running = (s: Session) => s.state === 'running' && !!s.sandboxId && Date.parse(s.expiresAt) > Date.now();

export async function createSetupRepository(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS repository_setup_recipes (
    user_id text NOT NULL, repository_id bigint NOT NULL, data jsonb NOT NULL,
    PRIMARY KEY(user_id,repository_id))`);
  await db.query(`CREATE TABLE IF NOT EXISTS session_setup_runs (
    id text PRIMARY KEY, session_id text NOT NULL REFERENCES ephemeral_sessions(id),
    data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), blocked_until timestamptz)`);
  await db.query('CREATE INDEX IF NOT EXISTS session_setup_runs_session ON session_setup_runs(session_id,created_at DESC)');
  await db.query('CREATE UNIQUE INDEX IF NOT EXISTS session_setup_one_execution ON session_setup_runs(session_id) WHERE blocked_until IS NOT NULL');
  return {
    async recipe(session: Session): Promise<SetupRecipe | null> {
      const { rows } = await db.query<{ data: SetupRecipe }>('SELECT data FROM repository_setup_recipes WHERE user_id=$1 AND repository_id=$2', [session.userId, session.repositoryId]);
      return rows[0]?.data ?? null;
    },
    async latest(sessionId: string): Promise<SetupRun | null> {
      const { rows } = await db.query<{ data: SetupRun }>('SELECT data FROM session_setup_runs WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [sessionId]);
      return rows[0]?.data ?? null;
    },
    async save(session: Session, recipe: SetupRecipe) {
      const { rows } = await db.query(`WITH active_session AS (${active})
        INSERT INTO repository_setup_recipes(user_id,repository_id,data)
        SELECT $2,$3,$4::jsonb FROM active_session
        ON CONFLICT(user_id,repository_id) DO UPDATE SET data=EXCLUDED.data RETURNING user_id`,
      [session.id, session.userId, session.repositoryId, JSON.stringify(recipe)]);
      if (!rows.length) throw new SetupError(409, 'Save setup while the session is running.');
    },
    async insert(session: Session, run: SetupRun) {
      // Completed uncertain runs may release their hold only after the remote
      // absolute deadline and cleanup grace. Running work never expires locally.
      await db.query(`UPDATE session_setup_runs SET blocked_until=NULL,data=jsonb_set(data,'{blockedUntil}','null'::jsonb)
        WHERE session_id=$1 AND data->>'status'='interrupted' AND blocked_until<=clock_timestamp()`, [session.id]);
      let rows: unknown[];
      try { ({ rows } = await db.query(`WITH active_session AS (${active})
        INSERT INTO session_setup_runs(id,session_id,data,blocked_until)
        SELECT $3,id,$4::jsonb,$5::timestamptz FROM active_session
        WHERE EXISTS(SELECT 1 FROM repository_setup_recipes WHERE user_id=$2 AND repository_id=$6 AND data->>'version'=$7)
        AND NOT EXISTS(SELECT 1 FROM session_setup_runs WHERE session_id=$1 AND (blocked_until IS NOT NULL OR data->>'status' IN ('queued','running')))
        RETURNING id`, [session.id, session.userId, run.id, JSON.stringify(run), run.blockedUntil, session.repositoryId, run.recipe.version])); }
      catch (error) { if ((error as { code?: string }).code === '23505') throw new SetupError(409, 'Another setup run is still active. Refresh its status.'); throw error; }
      if (!rows.length) throw new SetupError(409, 'Setup changed, another run is still active, or the session ended. Refresh before running.');
    },
    async update(run: SetupRun) {
      await db.query('UPDATE session_setup_runs SET data=$2::jsonb,blocked_until=$3 WHERE id=$1', [run.id, JSON.stringify(run), run.blockedUntil]);
    },
    async interrupt() {
      // Only a new queued record with an explicit false marker proves that no
      // invocation was possible. Legacy queued records remain uncertain.
      await db.query(`UPDATE session_setup_runs SET blocked_until=NULL,data=data || jsonb_build_object(
        'status','failed','finishedAt',clock_timestamp(),'blockedUntil',NULL,'reason','server_shutdown',
        'error','The server stopped before setup started. You can run setup again.')
        WHERE data->>'status'='queued' AND data->'invocationStarted'='false'::jsonb`);
      await db.query(`UPDATE session_setup_runs SET data=data || jsonb_build_object(
        'status','interrupted','finishedAt',clock_timestamp(),'reason',COALESCE(data->>'reason','server_shutdown'),
        'error','Server restarted. The command was not replayed. Wait for the previous execution deadline before running again.')
        WHERE data->>'status' IN ('queued','running')`);
    },
  };
}

export async function createSetupController(db: Database, sessions: SessionRepository, provider: SandboxProvider, mode: 'live' | 'preview', authorize: (s: Session) => Promise<void>) {
  const store = await createSetupRepository(db);
  await store.interrupt();
  type Execution = { run: SetupRun; abort: AbortController; task: Promise<void>; persist: Promise<void>; dirty: boolean; completed: boolean; savingFinal: Promise<void> | null };
  const executions = new Map<string, Execution>();
  let closed = false;
  type MutationQueue = { tail: Promise<void>; pending: number };
  const mutations = new Map<string, MutationQueue>();
  let pending = 0;
  async function serialize<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    if (closed) throw new SetupError(409, 'Server is restarting. Retry setup after reconnecting.');
    const queue = mutations.get(sessionId) ?? { tail: Promise.resolve(), pending: 0 };
    if (pending >= 32 || queue.pending >= 8) throw new SetupError(429, 'Too many setup requests. Retry shortly.');
    mutations.set(sessionId, queue); pending++; queue.pending++;
    const task = queue.tail.then(() => {
      if (closed) throw new SetupError(409, 'Server is restarting. Retry setup after reconnecting.');
      return fn();
    });
    queue.tail = task.then(() => {}, () => {});
    try { return await task; } finally {
      pending--; queue.pending--;
      if (!queue.pending && mutations.get(sessionId) === queue) mutations.delete(sessionId);
    }
  }
  function abort(e: Execution, reason: SetupReason) {
    if (e.completed || e.run.finishedAt) return;
    e.run.reason ??= reason;
    e.abort.abort();
  }
  async function retryFinal(sessionId: string) {
    const e = executions.get(sessionId);
    if (!e?.completed) return;
    if (!e.savingFinal) e.savingFinal = store.update({ ...e.run }).then(() => {
      if (executions.get(sessionId) === e) executions.delete(sessionId);
    }).finally(() => { e.savingFinal = null; });
    await e.savingFinal;
  }
  const finalPersistence = setInterval(() => {
    for (const [sessionId, e] of executions) if (e.completed) void retryFinal(sessionId).catch(() => {});
  }, 1000);
  const progress = async (session: Session) => {
    await retryFinal(session.id).catch(() => {});
    return { recipe: await store.recipe(session), run: await store.latest(session.id), mode };
  };
  async function current(session: Session, checkAuthorization = true) {
    const read = async () => {
      let value: Session | null;
      try { value = await sessions.get(session.id); }
      catch { throw new SetupFailure('persistence_failed'); }
      if (!value || value.userId !== session.userId || !running(value)) throw new SetupFailure('session_ended');
      if (!sameTarget(value, session)) throw new SetupFailure('authorization_failed');
      return value;
    };
    const s = await read();
    if (mode === 'live' && checkAuthorization) {
      try { await authorize(s); }
      catch { throw new SetupFailure('authorization_failed'); }
    }
    // Authorization is asynchronous: recheck both liveness and immutable target.
    return read();
  }
  function flush(e: Execution) {
    if (!e.dirty) return e.persist;
    e.dirty = false;
    const snapshot = { ...e.run };
    e.persist = e.persist.then(() => store.update(snapshot));
    return e.persist;
  }
  async function execute(session: Session, e: Execution, timeoutMs: number) {
    const outputBuffer = createSetupOutputBuffer(OUTPUT_LIMIT);
    const redactor = createSetupOutputRedactor(text => {
      outputBuffer.write(text);
      const snapshot = outputBuffer.snapshot();
      e.run.output = snapshot.output;
      e.run.truncated ||= snapshot.truncated || /\[Setup output limit reached; (?:further output omitted|omitted middle output|overlong line omitted)\.\]/.test(text);
      e.dirty = true;
    }, { limit: OUTPUT_LIMIT, streaming: true });
    let invoked = false;
    let acceptingOutput = true;
    const output = (chunk: string) => {
      // Providers flush buffered redacted output while confirming termination.
      // An abort request must not discard that final output.
      if (!chunk || !acceptingOutput) return;
      redactor.write(chunk);
      e.run.truncated ||= redactor.truncated;
      e.dirty = true;
    };
    let healthChecking = false;
    let lastAuthorization = Date.now();
    const health = setInterval(() => {
      if (healthChecking || e.abort.signal.aborted) return;
      healthChecking = true;
      const checkAuthorization = Date.now() - lastAuthorization >= 30_000;
      if (checkAuthorization) lastAuthorization = Date.now();
      void current(session, checkAuthorization).catch(error => abort(e, error instanceof SetupFailure ? error.reason : 'authorization_failed')).finally(() => { healthChecking = false; });
    }, 1000);
    const persistence = setInterval(() => { void flush(e).catch(() => abort(e, 'persistence_failed')); }, 250);
    const timeout = setTimeout(() => abort(e, 'timeout'), Math.max(1, Date.parse(e.run.blockedUntil!) - 5000 - Date.now()));
    let watchdog: NodeJS.Timeout | undefined;
    try {
      await current(session);
      if (closed) abort(e, 'server_shutdown');
      if (e.abort.signal.aborted) throw new SetupFailure(e.run.reason!);
      if (!provider.runSetup) throw new SetupFailure('provider_unavailable');
      // This durable marker is the crash boundary. Once written, a restart must
      // assume remote invocation was possible, even if we crashed before calling.
      e.run.status = 'running'; e.run.invocationStarted = true;
      e.run.startedAt = new Date().toISOString(); e.dirty = true;
      try { await flush(e); } catch { throw new SetupFailure('persistence_failed'); }
      const fresh = await current(session, false);
      if (closed) abort(e, 'server_shutdown');
      if (e.abort.signal.aborted) throw new SetupFailure(e.run.reason!);
      const deadlineAt = new Date(Math.min(Date.parse(e.run.blockedUntil!) - 5000, Date.parse(fresh.expiresAt))).toISOString();
      const effectiveTimeout = Math.min(timeoutMs, Date.parse(deadlineAt) - Date.now());
      if (effectiveTimeout <= 0) throw new SetupFailure('timeout');
      // Never classify a provider rejection as pre-start: invocation may have
      // reached the remote service before its promise rejects (or throws).
      invoked = true;
      const result = await Promise.race([
        provider.runSetup(fresh, { runId: e.run.id, command: e.run.recipe.command, timeoutMs: effectiveTimeout, deadlineAt }, output, e.abort.signal),
        new Promise<never>((_resolve, reject) => { watchdog = setTimeout(() => { abort(e, 'completion_unconfirmed'); reject(new Error('Setup completion was not confirmed')); }, effectiveTimeout + 5000); }),
      ]);
      if (result.status === 'timed_out') e.run.reason ??= 'timeout';
      const reason = e.run.reason;
      e.run.status = reason === 'timeout' ? 'timed_out' : reason === 'user_cancelled' ? 'cancelled'
        : reason ? 'interrupted' : result.status;
      e.run.exitCode = result.exitCode; e.run.blockedUntil = null;
      e.run.error = reason ? reasons[reason] : result.status === 'failed'
        ? 'Command failed. Review its output and exit code, update setup if needed, then run again.' : null;
    } catch (error) {
      e.run.reason ??= error instanceof SetupFailure ? error.reason : invoked ? 'completion_unconfirmed' : 'persistence_failed';
      e.run.status = invoked ? 'interrupted' : 'failed';
      e.run.error = reasons[e.run.reason];
      if (!invoked) { e.run.blockedUntil = null; e.run.invocationStarted = false; e.run.startedAt = null; }
    } finally {
      acceptingOutput = false;
      redactor.end(); e.run.truncated ||= redactor.truncated;
      clearInterval(health); clearInterval(persistence); clearTimeout(timeout); clearTimeout(watchdog);
      e.run.finishedAt = new Date().toISOString(); e.dirty = true;
      // Retry the final bounded snapshot if an intermediate persistence failed.
      await e.persist.catch(() => {});
      e.completed = true;
      // Keep ownership until the final status is durable. GET, a later start,
      // and the bounded background worker all retry after database recovery.
      await retryFinal(session.id).catch(() => {});
    }
  }
  return {
    progress,
    stopSession(sessionId: string) { const e = executions.get(sessionId); if (e) abort(e, 'session_ended'); },
    save(session: Session, input: Omit<SetupRecipe, 'version' | 'updatedAt'>) {
      return serialize(session.id, async () => {
        const s = await current(session);
        if (closed) throw new SetupError(409, 'Server is restarting. Retry setup after reconnecting.');
        await store.save(s, { ...input, version: randomUUID(), updatedAt: new Date().toISOString() });
        return progress(s);
      });
    },
    start(session: Session, recipeVersion: string) {
      return serialize(session.id, async () => {
        const s = await current(session);
        if (closed) throw new SetupError(409, 'Server is restarting. Retry setup after reconnecting.');
        await retryFinal(s.id);
        if (executions.has(s.id)) throw new SetupError(409, 'Another setup run is still active. Refresh its status.');
        if (executions.size >= 8) throw new SetupError(429, 'Setup execution capacity is full. Retry shortly.');
        const recipe = await store.recipe(s);
        if (!recipe || recipe.version !== recipeVersion) throw new SetupError(409, 'Saved setup changed. Refresh and review the command before running.');
        const fresh = await current(s, false);
        if (closed) throw new SetupError(409, 'Server is restarting. Retry setup after reconnecting.');
        const timeoutMs = Math.min(recipe.timeoutSeconds * 1000, Date.parse(fresh.expiresAt) - Date.now());
        if (timeoutMs < 1000) throw new SetupError(409, 'Session is expiring. Extend it before running setup.');
        const run: SetupRun = { id: randomUUID(), sessionId: s.id, recipe: { ...recipe }, status: 'queued', output: '', truncated: false, outputRetention: 'head_tail',
          invocationStarted: false, exitCode: null, startedAt: null, finishedAt: null, error: null, blockedUntil: new Date(Date.now() + timeoutMs + 5000).toISOString() };
        // Reserve synchronously, before the insert yields, so independent session
        // queues cannot oversubscribe the global execution limit.
        if (executions.size >= 8) throw new SetupError(429, 'Setup execution capacity is full. Retry shortly.');
        const e: Execution = { run, abort: new AbortController(), task: Promise.resolve(), persist: Promise.resolve(), dirty: false, completed: false, savingFinal: null };
        executions.set(s.id, e);
        try { await store.insert(fresh, run); }
        catch (error) {
          // An insert may commit before its acknowledgement is lost. No provider
          // call occurred, so persist a safe retryable final record if it exists.
          e.run.status = 'failed'; e.run.reason = 'persistence_failed';
          e.run.error = reasons.persistence_failed; e.run.invocationStarted = false;
          e.run.blockedUntil = null; e.run.finishedAt = new Date().toISOString(); e.completed = true;
          await retryFinal(s.id).catch(() => {});
          throw error;
        }
        e.task = execute(s, e, timeoutMs);
        return { recipe, run: { ...run }, mode };
      });
    },
    cancel(session: Session, runId: string) {
      return serialize(session.id, async () => {
        // Ownership is local. Cancellation must remain available when GitHub
        // authorization is slow or unavailable, and after the session ends.
        const s = await sessions.get(session.id);
        if (!s || s.userId !== session.userId) throw new SetupError(409, 'Setup run is no longer active. Refresh its status.');
        const e = executions.get(s.id);
        if (!e || e.run.id !== runId) throw new SetupError(409, 'Setup run is no longer active. Refresh its status.');
        abort(e, 'user_cancelled');
        return progress(s);
      });
    },
    async close() {
      closed = true;
      clearInterval(finalPersistence);
      for (const e of executions.values()) abort(e, 'server_shutdown');
      await Promise.all([...mutations.values()].map(queue => queue.tail));
      // The application owns the overall shutdown deadline. Do not report a
      // successful drain while a provider can still resume and persist output.
      await Promise.allSettled([...executions.values()].map(e => e.task));
      await Promise.allSettled([...executions.keys()].map(retryFinal));
      await store.interrupt();
    },
  };
}
