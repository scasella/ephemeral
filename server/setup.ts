import { randomUUID } from 'node:crypto';
import type { Database, SandboxProvider, Session, SessionRepository } from './contracts.js';

export interface SetupRecipe { version: string; label: string; command: string; timeoutSeconds: number; updatedAt: string }
export type SetupStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'interrupted';
export interface SetupRun {
  id: string; sessionId: string; recipe: SetupRecipe; status: SetupStatus; output: string; truncated: boolean;
  exitCode: number | null; startedAt: string | null; finishedAt: string | null; error: string | null; blockedUntil: string | null;
}
export class SetupError extends Error { constructor(public status: number, message: string) { super(message); } }
const OUTPUT_LIMIT = 64 * 1024;
const active = `SELECT id FROM ephemeral_sessions WHERE id=$1 AND user_id=$2
  AND state='running' AND data->>'sandboxId' IS NOT NULL
  AND (data->>'expiresAt')::timestamptz>clock_timestamp() FOR UPDATE`;
const running = (s: Session) => s.state === 'running' && !!s.sandboxId && Date.parse(s.expiresAt) > Date.now();

// Defense in depth for common credential formats. Arbitrary application secrets
// cannot be identified reliably; the UI explicitly warns that output is retained.
export function redactSetupOutput(value: string) {
  return value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:TOKEN|PASSWORD|SECRET|API_KEY|PRIVATE_KEY)\s*[=:]\s*)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@');
}

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
      await db.query(`UPDATE session_setup_runs SET data=data || jsonb_build_object(
        'status','interrupted','finishedAt',clock_timestamp(),'error','Server restarted. The command was not replayed. Wait for the previous execution deadline before running again.')
        WHERE data->>'status' IN ('queued','running')`);
    },
  };
}

export async function createSetupController(db: Database, sessions: SessionRepository, provider: SandboxProvider, mode: 'live' | 'preview', authorize: (s: Session) => Promise<void>) {
  const store = await createSetupRepository(db);
  await store.interrupt();
  type Execution = { run: SetupRun; abort: AbortController; task: Promise<void>; persist: Promise<void>; dirty: boolean; stopping: boolean; completed: boolean; savingFinal: Promise<void> | null };
  const executions = new Map<string, Execution>();
  let closed = false;
  let mutations = Promise.resolve(); let pending = 0;
  async function serialize<T>(fn: () => Promise<T>): Promise<T> {
    if (closed) throw new SetupError(409, 'Server is restarting. Retry setup after reconnecting.');
    if (pending >= 32) throw new SetupError(429, 'Too many setup requests. Retry shortly.');
    pending++;
    const task = mutations.then(() => { if (closed) throw new SetupError(409, 'Server is restarting. Retry setup after reconnecting.'); return fn(); }); mutations = task.then(() => {}, () => {});
    try { return await task; } finally { pending--; }
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
    const s = await sessions.get(session.id);
    if (!s || s.userId !== session.userId || !running(s)) throw new SetupError(409, 'Setup is available only while the session is running.');
    if (mode === 'live' && checkAuthorization) await authorize(s);
    const checked = await sessions.get(s.id);
    if (!checked || checked.userId !== session.userId || !running(checked)) throw new SetupError(409, 'Session ended while setup was being authorized.');
    return checked;
  }
  function flush(e: Execution) {
    if (!e.dirty) return e.persist;
    e.dirty = false;
    const snapshot = { ...e.run };
    e.persist = e.persist.then(() => store.update(snapshot));
    return e.persist;
  }
  async function execute(session: Session, e: Execution, timeoutMs: number) {
    let rawOutput = '';
    let timedOut = false;
    let acceptingOutput = true;
    const output = (chunk: string) => {
      // Providers flush buffered redacted output while confirming termination.
      // An abort request must not discard that final output.
      if (!chunk || !acceptingOutput || e.run.truncated) return;
      // Slice before retaining data so a single huge provider chunk stays bounded.
      const room = OUTPUT_LIMIT - Buffer.byteLength(rawOutput);
      const buffer = Buffer.from(chunk.slice(0, OUTPUT_LIMIT));
      const addition = buffer.subarray(0, Math.max(0, room)).toString('utf8').replace(/\ufffd$/, '');
      rawOutput += addition;
      e.run.truncated = Buffer.byteLength(chunk) > room || rawOutput.includes('[Setup output limit reached; further output omitted.]');
      const sanitized = Buffer.from(redactSetupOutput(rawOutput));
      e.run.truncated ||= sanitized.length > OUTPUT_LIMIT;
      e.run.output = sanitized.subarray(0, OUTPUT_LIMIT).toString('utf8').replace(/\ufffd$/, ''); e.dirty = true;
    };
    let healthChecking = false;
    let lastAuthorization = Date.now();
    const health = setInterval(() => {
      if (healthChecking || e.abort.signal.aborted) return;
      healthChecking = true;
      const checkAuthorization = Date.now() - lastAuthorization >= 30_000;
      if (checkAuthorization) lastAuthorization = Date.now();
      void current(session, checkAuthorization).catch(() => e.abort.abort()).finally(() => { healthChecking = false; });
    }, 1000);
    const persistence = setInterval(() => { void flush(e).catch(() => e.abort.abort()); }, 250);
    const timeout = setTimeout(() => { if (!e.abort.signal.aborted) { timedOut = true; e.abort.abort(); } }, timeoutMs);
    let watchdog: NodeJS.Timeout | undefined;
    try {
      const fresh = await current(session);
      if (closed || e.abort.signal.aborted) { e.run.status = 'cancelled'; e.run.blockedUntil = null; return; }
      e.run.status = 'running'; e.run.startedAt = new Date().toISOString(); e.dirty = true;
      await flush(e);
      if (!provider.runSetup) throw new Error('Setup execution is unavailable');
      const deadlineAt = new Date(Math.min(Date.parse(e.run.blockedUntil!) - 5000, Date.parse(fresh.expiresAt))).toISOString();
      const effectiveTimeout = Math.max(1, Math.min(timeoutMs, Date.parse(deadlineAt) - Date.now()));
      const result = await Promise.race([
        provider.runSetup(fresh, { runId: e.run.id, command: e.run.recipe.command, timeoutMs: effectiveTimeout, deadlineAt }, output, e.abort.signal),
        new Promise<never>((_resolve, reject) => { watchdog = setTimeout(() => { e.abort.abort(); reject(new Error('Setup completion was not confirmed')); }, effectiveTimeout + 5000); }),
      ]);
      e.run.status = e.stopping ? 'interrupted' : timedOut && result.status === 'cancelled' ? 'timed_out' : result.status;
      e.run.exitCode = result.exitCode; e.run.blockedUntil = null;
      e.run.error = result.status === 'failed' ? 'Command failed. Review its output and exit code, update setup if needed, then run again.'
        : e.run.status === 'timed_out' ? 'Setup reached its timeout. Review the output or increase the saved timeout before retrying.'
        : e.stopping ? 'Server stopped this setup run. It was not replayed.' : null;
    } catch {
      e.run.status = 'interrupted'; e.run.error = 'Setup could not confirm command completion. Review output and wait for the execution deadline before retrying.';
    } finally {
      acceptingOutput = false;
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
    stopSession(sessionId: string) { executions.get(sessionId)?.abort.abort(); },
    save(session: Session, input: Omit<SetupRecipe, 'version' | 'updatedAt'>) {
      return serialize(async () => {
        const s = await current(session);
        if (closed) throw new SetupError(409, 'Server is restarting. Retry setup after reconnecting.');
        await store.save(s, { ...input, version: randomUUID(), updatedAt: new Date().toISOString() });
        return progress(s);
      });
    },
    start(session: Session, recipeVersion: string) {
      return serialize(async () => {
        const s = await current(session);
        if (closed) throw new SetupError(409, 'Server is restarting. Retry setup after reconnecting.');
        await retryFinal(s.id);
        if (executions.has(s.id)) throw new SetupError(409, 'Another setup run is still active. Refresh its status.');
        if (executions.size >= 8) throw new SetupError(429, 'Setup execution capacity is full. Retry shortly.');
        const recipe = await store.recipe(s);
        if (!recipe || recipe.version !== recipeVersion) throw new SetupError(409, 'Saved setup changed. Refresh and review the command before running.');
        const timeoutMs = Math.min(recipe.timeoutSeconds * 1000, Date.parse(s.expiresAt) - Date.now());
        if (timeoutMs < 1000) throw new SetupError(409, 'Session is expiring. Extend it before running setup.');
        const run: SetupRun = { id: randomUUID(), sessionId: s.id, recipe: { ...recipe }, status: 'queued', output: '', truncated: false,
          exitCode: null, startedAt: null, finishedAt: null, error: null, blockedUntil: new Date(Date.now() + timeoutMs + 5000).toISOString() };
        await store.insert(s, run);
        const e: Execution = { run, abort: new AbortController(), task: Promise.resolve(), persist: Promise.resolve(), dirty: false, stopping: false, completed: false, savingFinal: null };
        executions.set(s.id, e);
        e.task = execute(s, e, timeoutMs);
        return { recipe, run: { ...run }, mode };
      });
    },
    cancel(session: Session, runId: string) {
      return serialize(async () => {
        const s = await current(session);
        const e = executions.get(s.id);
        if (!e || e.run.id !== runId) throw new SetupError(409, 'Setup run is no longer active. Refresh its status.');
        e.abort.abort();
        return progress(s);
      });
    },
    async close() {
      closed = true;
      clearInterval(finalPersistence);
      await mutations;
      for (const e of executions.values()) { e.stopping = true; e.abort.abort(); }
      // Providers have bounded remote execution. Do not hang server shutdown on
      // an unreachable VM; interrupted rows preserve their original deadline.
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.allSettled([...executions.values()].map(e => e.task)), new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]);
      clearTimeout(timer);
      await Promise.allSettled([...executions.keys()].map(retryFinal));
      await store.interrupt();
    },
  };
}
