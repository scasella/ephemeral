import { randomUUID } from 'node:crypto';
import type { Database, RetryState, Session, SessionState, SessionRepository } from '../contracts.js';
import { SessionNotCreatedError, type CreationAttempt, type CreationOutcome, type CreationReason } from './provisioning.js';
import { decodeSessionEventCursor, encodeSessionEventCursor, parseSessionEventPageOptions } from './session-events.js';

/** Leases fence writes after a worker loses ownership. Dates use the DB clock. */
export interface DurableSessionRepository extends SessionRepository {
  listActive(): Promise<Session[]>;
  getRetryState(id: string): Promise<RetryState | null>;
  setRetryState(id: string, owner: string, value: RetryState | null): Promise<void>;
  eventUnderLease(id: string, owner: string, kind: string, message: string, expectedState?: SessionState): Promise<void>;
  claim(id: string, owner: string): Promise<boolean>;
  renew(id: string, owner: string): Promise<boolean>;
  release(id: string, owner: string): Promise<void>;
  save(session: Session, owner: string): Promise<void>;
  beginCreationAttempt(id: string, owner: string, uncertaintyUntil: string): Promise<void>;
  recordCreationOutcome(id: string, owner: string, outcome: { status: CreationOutcome; reason: CreationReason; sandboxId?: string }): Promise<void>;
  creationAttempt(id: string): Promise<CreationAttempt | null>;
  markCreation(id: string, owner: string, uncertaintyUntil: string): Promise<void>;
  uncertaintyUntil(id: string): Promise<string | null>;
  requestStop(id: string): Promise<void>;
  setLabel(id: string, userId: string, label: string): Promise<Session | null>;
}

export async function createSessionRepository(db: Database): Promise<DurableSessionRepository> {
  await db.query(`CREATE TABLE IF NOT EXISTS ephemeral_sessions (
    id text PRIMARY KEY, user_id text NOT NULL, state text NOT NULL,
    data jsonb NOT NULL, lease_owner text, lease_until timestamptz,
    uncertainty_until timestamptz
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS ephemeral_creation_attempts (
    session_id text PRIMARY KEY REFERENCES ephemeral_sessions(id), status text NOT NULL, reason text NOT NULL,
    sandbox_id text, uncertainty_until timestamptz NOT NULL,
    started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS ephemeral_one_active_session
    ON ephemeral_sessions(user_id) WHERE state IN ('provisioning', 'running', 'cleanup_pending')`);
  await db.query('ALTER TABLE ephemeral_sessions ADD COLUMN IF NOT EXISTS reconciliation_retry jsonb');
  await db.query(`CREATE INDEX IF NOT EXISTS ephemeral_active_sessions ON ephemeral_sessions(state)
    WHERE state IN ('provisioning', 'running', 'cleanup_pending')`);
  // User metadata is independent of lifecycle snapshots, which workers may save later.
  await db.query(`CREATE TABLE IF NOT EXISTS ephemeral_session_labels (
    session_id text PRIMARY KEY REFERENCES ephemeral_sessions(id), label text
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS ephemeral_session_events (
    id text PRIMARY KEY, session_id text NOT NULL REFERENCES ephemeral_sessions(id),
    at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, kind text NOT NULL, message text NOT NULL
  )`);
  await db.query('CREATE INDEX IF NOT EXISTS ephemeral_events_session ON ephemeral_session_events(session_id, at)');
  await db.query('CREATE INDEX IF NOT EXISTS ephemeral_events_page ON ephemeral_session_events(session_id, at DESC, id DESC)');
  const repo: DurableSessionRepository = {
    async insert(session) {
      try {
        await db.query(`WITH inserted AS (
          INSERT INTO ephemeral_sessions (id,user_id,state,data) VALUES ($1,$2,$3,$4::jsonb - 'label') RETURNING id
        ) INSERT INTO ephemeral_session_labels(session_id,label) SELECT id,$5 FROM inserted`,
          [session.id, session.userId, session.state, JSON.stringify(session), session.label || null]);
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new SessionNotCreatedError('You already have an active session. Finish its cleanup before creating another.');
        throw error;
      }
    },
    async get(id) {
      const { rows } = await db.query<{ data: Session; label: string | null }>(`SELECT s.data - 'label' AS data, l.label
        FROM ephemeral_sessions s LEFT JOIN ephemeral_session_labels l ON l.session_id=s.id WHERE s.id=$1`, [id]);
      return rows[0] ? labeled(rows[0]) : null;
    },
    async list(userId) {
      const { rows } = await db.query<{ data: Session; label: string | null }>(`SELECT s.data - 'label' AS data, l.label
        FROM ephemeral_sessions s LEFT JOIN ephemeral_session_labels l ON l.session_id=s.id
        ${userId ? 'WHERE s.user_id=$1' : ''} ORDER BY s.data->>'createdAt' DESC`, userId ? [userId] : []);
      return rows.map(labeled);
    },
    async listActive() {
      const { rows } = await db.query<{ data: Session; label: string | null }>(`SELECT s.data - 'label' AS data, l.label
        FROM ephemeral_sessions s LEFT JOIN ephemeral_session_labels l ON l.session_id=s.id
        WHERE s.state IN ('provisioning','running','cleanup_pending') ORDER BY s.data->>'createdAt' DESC`);
      return rows.map(labeled);
    },
    async getRetryState(id) {
      const { rows } = await db.query<{ reconciliation_retry: RetryState | null }>(
        'SELECT reconciliation_retry FROM ephemeral_sessions WHERE id=$1', [id]);
      return rows[0]?.reconciliation_retry ?? null;
    },
    async setRetryState(id, owner, value) {
      const { rows } = await db.query(`UPDATE ephemeral_sessions SET reconciliation_retry=$3::jsonb
        WHERE id=$1 AND lease_owner=$2 AND lease_until>CURRENT_TIMESTAMP
        AND ($3::jsonb IS NULL OR (state='running' AND $3::jsonb->>'state'='health')
          OR (state='cleanup_pending' AND $3::jsonb->>'state'='cleanup')) RETURNING id`,
      [id, owner, value === null ? null : JSON.stringify(value)]);
      if (!rows.length) throw new Error('Session worker lost its lease or session state changed.');
    },
    async eventUnderLease(id, owner, kind, message, expectedState) {
      const { rows } = await db.query(`WITH owned AS (
        SELECT id FROM ephemeral_sessions WHERE id=$1 AND lease_owner=$2
        AND lease_until>CURRENT_TIMESTAMP AND ($6::text IS NULL OR state=$6) FOR UPDATE
      ) INSERT INTO ephemeral_session_events(id,session_id,kind,message)
        SELECT $3,id,$4,$5 FROM owned RETURNING id`,
      [id, owner, randomUUID(), kind, message, expectedState ?? null]);
      if (!rows.length) throw new Error('Session worker lost its lease or session state changed.');
    },
    async setLabel(id, userId, label) {
      const { rows } = await db.query(`INSERT INTO ephemeral_session_labels(session_id,label)
        SELECT id,$3 FROM ephemeral_sessions WHERE id=$1 AND user_id=$2
        ON CONFLICT(session_id) DO UPDATE SET label=EXCLUDED.label RETURNING session_id`, [id, userId, label || null]);
      return rows.length ? repo.get(id) : null;
    },
    async update(session) {
      await db.query("UPDATE ephemeral_sessions SET state=$2,data=$3::jsonb - 'label' WHERE id=$1", [session.id, session.state, JSON.stringify(session)]);
    },
    async save(session, owner) {
      // A concurrent stop may move provisioning/running into cleanup_pending.
      const { rows } = await db.query<{ id: string }>(`UPDATE ephemeral_sessions SET state=$3,data=$4::jsonb - 'label'
        WHERE id=$1 AND lease_owner=$2 AND lease_until>CURRENT_TIMESTAMP
        AND (state<>'cleanup_pending' OR $3 IN ('cleanup_pending','ended','failed')) RETURNING id`,
      [session.id, owner, session.state, JSON.stringify(session)]);
      if (!rows.length) throw new Error('Session worker lost its lease or session was stopped.');
    },
    async claim(id, owner) {
      const { rows } = await db.query(`UPDATE ephemeral_sessions SET lease_owner=$2,lease_until=CURRENT_TIMESTAMP + INTERVAL '45 seconds'
        WHERE id=$1 AND (lease_until IS NULL OR lease_until<CURRENT_TIMESTAMP OR lease_owner=$2) RETURNING id`, [id, owner]);
      return rows.length > 0;
    },
    async renew(id, owner) {
      const { rows } = await db.query(`UPDATE ephemeral_sessions SET lease_until=CURRENT_TIMESTAMP + INTERVAL '45 seconds'
        WHERE id=$1 AND lease_owner=$2 AND lease_until>CURRENT_TIMESTAMP RETURNING id`, [id, owner]);
      return rows.length > 0;
    },
    async release(id, owner) {
      await db.query('UPDATE ephemeral_sessions SET lease_owner=NULL,lease_until=NULL WHERE id=$1 AND lease_owner=$2', [id, owner]);
    },
    async beginCreationAttempt(id, owner, until) {
      // The attempt and legacy uncertainty marker commit together before any provider call.
      const { rows } = await db.query(`WITH owned AS (
        UPDATE ephemeral_sessions SET uncertainty_until=$3 WHERE id=$1 AND state='provisioning'
        AND lease_owner=$2 AND lease_until>CURRENT_TIMESTAMP
        AND NOT EXISTS (SELECT 1 FROM ephemeral_creation_attempts WHERE session_id=$1) RETURNING id
      ) INSERT INTO ephemeral_creation_attempts(session_id,status,reason,uncertainty_until)
        SELECT id,'pending','request_started',$3 FROM owned RETURNING session_id`, [id, owner, until]);
      if (!rows.length) throw new Error('Session worker lost its lease, session was stopped, or creation was already attempted.');
    },
    async recordCreationOutcome(id, owner, outcome) {
      const { rows } = await db.query(`UPDATE ephemeral_creation_attempts SET status=$3,reason=$4,
        sandbox_id=COALESCE($5,sandbox_id),updated_at=CURRENT_TIMESTAMP
        WHERE session_id=$1 AND status IN ('pending','unknown') AND EXISTS (
          SELECT 1 FROM ephemeral_sessions WHERE id=$1 AND lease_owner=$2 AND lease_until>CURRENT_TIMESTAMP
        ) RETURNING session_id`, [id, owner, outcome.status, outcome.reason, outcome.sandboxId ?? null]);
      if (!rows.length) throw new Error('Session worker lost its lease or creation outcome was already resolved.');
    },
    async creationAttempt(id) {
      const { rows } = await db.query<{ status: CreationAttempt['status']; reason: CreationReason; sandbox_id: string | null;
        uncertainty_until: Date | string; started_at: Date | string; updated_at: Date | string }>(
        'SELECT * FROM ephemeral_creation_attempts WHERE session_id=$1', [id]);
      const row = rows[0];
      return row ? { status: row.status, reason: row.reason, sandboxId: row.sandbox_id,
        uncertaintyUntil: new Date(row.uncertainty_until).toISOString(), startedAt: new Date(row.started_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString() } : null;
    },
    async markCreation(id, owner, until) {
      const { rows } = await db.query(`UPDATE ephemeral_sessions SET uncertainty_until=$3 WHERE id=$1
        AND lease_owner=$2 AND lease_until>CURRENT_TIMESTAMP RETURNING id`, [id, owner, until]);
      if (!rows.length) throw new Error('Session worker lost its lease.');
    },
    async uncertaintyUntil(id) {
      const { rows } = await db.query<{ uncertainty_until: Date | string | null }>('SELECT uncertainty_until FROM ephemeral_sessions WHERE id=$1', [id]);
      const value = rows[0]?.uncertainty_until;
      return value ? new Date(value).toISOString() : null;
    },
    async requestStop(id) {
      await db.query(`UPDATE ephemeral_sessions SET state='cleanup_pending', reconciliation_retry=NULL,
        data=jsonb_set(data,'{state}','"cleanup_pending"'::jsonb)
        WHERE id=$1 AND state IN ('provisioning','running','cleanup_pending')`, [id]);
    },
    async event(sessionId, kind, message) {
      await db.query('INSERT INTO ephemeral_session_events(id,session_id,kind,message) VALUES ($1,$2,$3,$4)', [randomUUID(), sessionId, kind, message]);
    },
    async events(sessionId) {
      return (await repo.eventPage(sessionId, { limit: 100 })).events;
    },
    async eventPage(sessionId, options = {}) {
      const { limit = 50, before } = parseSessionEventPageOptions(options, sessionId);
      const cursor = before ? decodeSessionEventCursor(before, sessionId) : null;
      const { rows } = await db.query<{ id: string; session_id: string; exact_at: string; kind: string; message: string }>(
        `SELECT id,session_id,to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact_at,kind,message
        FROM ephemeral_session_events WHERE session_id=$1
        ${cursor ? 'AND (at,id)<($3::timestamptz,$4::text)' : ''}
        ORDER BY at DESC,id DESC LIMIT $2`, cursor ? [sessionId, limit + 1, cursor.at, cursor.id] : [sessionId, limit + 1]);
      const selected = rows.slice(0, limit), oldest = selected.at(-1);
      const nextCursor = rows.length > limit && oldest ? encodeSessionEventCursor(sessionId, oldest.exact_at, oldest.id) : null;
      return { events: selected.reverse().map(row => ({ id: row.id, sessionId: row.session_id,
        at: row.exact_at, kind: row.kind, message: row.message })), nextCursor };
    },
  };
  return repo;
}

function labeled(row: { data: Session; label: string | null }): Session {
  return row.label ? { ...row.data, label: row.label } : row.data;
}
