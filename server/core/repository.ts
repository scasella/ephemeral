import { randomUUID } from 'node:crypto';
import type { Database, Session, SessionEvent, SessionRepository } from '../contracts.js';

/** Leases fence writes after a worker loses ownership. Dates use the DB clock. */
export interface DurableSessionRepository extends SessionRepository {
  claim(id: string, owner: string): Promise<boolean>;
  renew(id: string, owner: string): Promise<boolean>;
  release(id: string, owner: string): Promise<void>;
  save(session: Session, owner: string): Promise<void>;
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
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS ephemeral_one_active_session
    ON ephemeral_sessions(user_id) WHERE state IN ('provisioning', 'running', 'cleanup_pending')`);
  // User metadata is independent of lifecycle snapshots, which workers may save later.
  await db.query(`CREATE TABLE IF NOT EXISTS ephemeral_session_labels (
    session_id text PRIMARY KEY REFERENCES ephemeral_sessions(id), label text
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS ephemeral_session_events (
    id text PRIMARY KEY, session_id text NOT NULL REFERENCES ephemeral_sessions(id),
    at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, kind text NOT NULL, message text NOT NULL
  )`);
  await db.query('CREATE INDEX IF NOT EXISTS ephemeral_events_session ON ephemeral_session_events(session_id, at)');
  const repo: DurableSessionRepository = {
    async insert(session) {
      try {
        await db.query(`WITH inserted AS (
          INSERT INTO ephemeral_sessions (id,user_id,state,data) VALUES ($1,$2,$3,$4::jsonb - 'label') RETURNING id
        ) INSERT INTO ephemeral_session_labels(session_id,label) SELECT id,$5 FROM inserted`,
          [session.id, session.userId, session.state, JSON.stringify(session), session.label || null]);
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new Error('You already have an active session. Finish its cleanup before creating another.');
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
      await db.query(`UPDATE ephemeral_sessions SET state='cleanup_pending',
        data=jsonb_set(data,'{state}','"cleanup_pending"'::jsonb)
        WHERE id=$1 AND state IN ('provisioning','running')`, [id]);
    },
    async event(sessionId, kind, message) {
      await db.query('INSERT INTO ephemeral_session_events(id,session_id,kind,message) VALUES ($1,$2,$3,$4)', [randomUUID(), sessionId, kind, message]);
    },
    async events(sessionId) {
      const { rows } = await db.query<{ id: string; session_id: string; at: Date | string; kind: string; message: string }>(
        'SELECT * FROM ephemeral_session_events WHERE session_id=$1 ORDER BY at,id', [sessionId]);
      return rows.map(row => ({ id: row.id, sessionId: row.session_id, at: new Date(row.at).toISOString(), kind: row.kind, message: row.message } satisfies SessionEvent));
    },
  };
  return repo;
}

function labeled(row: { data: Session; label: string | null }): Session {
  return row.label ? { ...row.data, label: row.label } : row.data;
}
