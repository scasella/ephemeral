import type { Database, Session } from './contracts.js';

export interface StartupProgress {
  startedAt: string;
  firstTerminalAttachedAt: string | null;
  firstUsefulResponseAt: string | null;
  timeToFirstUsefulResponseMs: number | null;
  measurement: 'user_reported';
  mode: 'live' | 'preview';
}

interface StartupRow {
  first_terminal_attached_at: Date | string | null;
  first_useful_response_at: Date | string | null;
}

/** Stores timestamps only, separately from lifecycle-owned session JSON. */
export async function createStartupRepository(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS session_startup_metrics (
    session_id text PRIMARY KEY REFERENCES ephemeral_sessions(id),
    first_terminal_attached_at timestamptz NOT NULL,
    first_useful_response_at timestamptz
  )`);

  // Lock the session row only for this statement, so stop/expiry cannot race a
  // metric write. This does not acquire or modify the lifecycle worker lease.
  const activeSession = `SELECT id FROM ephemeral_sessions WHERE id=$1
    AND state='running' AND data->>'sandboxId' IS NOT NULL
    AND (data->>'expiresAt')::timestamptz>clock_timestamp() FOR UPDATE`;
  return {
    async progress(session: Session, mode: 'live' | 'preview'): Promise<StartupProgress> {
      const { rows } = mode === 'live'
        ? await db.query<StartupRow>('SELECT first_terminal_attached_at,first_useful_response_at FROM session_startup_metrics WHERE session_id=$1', [session.id])
        : { rows: [] };
      const attached = rows[0]?.first_terminal_attached_at;
      const useful = rows[0]?.first_useful_response_at;
      const firstUsefulResponseAt = useful ? new Date(useful).toISOString() : null;
      return {
        startedAt: session.createdAt,
        firstTerminalAttachedAt: attached ? new Date(attached).toISOString() : null,
        firstUsefulResponseAt,
        timeToFirstUsefulResponseMs: firstUsefulResponseAt ? Math.max(0, Date.parse(firstUsefulResponseAt) - Date.parse(session.createdAt)) : null,
        measurement: 'user_reported', mode,
      };
    },
    async recordTerminalAttached(sessionId: string): Promise<boolean> {
      const { rows } = await db.query(`WITH active_session AS (${activeSession})
        INSERT INTO session_startup_metrics(session_id,first_terminal_attached_at)
        SELECT id,clock_timestamp() FROM active_session
        ON CONFLICT(session_id) DO UPDATE SET first_terminal_attached_at=session_startup_metrics.first_terminal_attached_at
        RETURNING session_id`, [sessionId]);
      return rows.length > 0;
    },
    async recordFirstUsefulResponse(sessionId: string): Promise<boolean> {
      const { rows } = await db.query(`WITH active_session AS (${activeSession})
        UPDATE session_startup_metrics SET first_useful_response_at=COALESCE(first_useful_response_at,clock_timestamp())
        FROM active_session WHERE session_id=active_session.id AND first_terminal_attached_at IS NOT NULL
        RETURNING session_id`, [sessionId]);
      return rows.length > 0;
    },
  };
}
