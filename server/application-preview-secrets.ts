import type { Database, Session } from './contracts.js';
import { seal, unseal } from './auth/crypto.js';

/** Native ingress credentials never enter Session JSON or browser responses. */
export async function createPreviewTokenStore(db: Database, encryptionKey: string) {
  await db.query(`CREATE TABLE IF NOT EXISTS preview_ingress_credentials (session_id TEXT NOT NULL, sandbox_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, credential TEXT NOT NULL)`);
  return {
    async save(session: Session, sandboxId: string, credential: string) {
      const payload = JSON.stringify({ sessionId: session.id, sandboxId, userId: session.userId, token: credential });
      await db.query(`INSERT INTO preview_ingress_credentials(session_id,sandbox_id,user_id,credential) VALUES($1,$2,$3,$4) ON CONFLICT(sandbox_id) DO UPDATE SET session_id=$1,user_id=$3,credential=$4`, [session.id, sandboxId, session.userId, seal(payload, encryptionKey)]);
    },
    async read(session: Session, sandboxId: string) {
      const { rows } = await db.query<{ credential: string }>('SELECT credential FROM preview_ingress_credentials WHERE session_id=$1 AND sandbox_id=$2 AND user_id=$3', [session.id, sandboxId, session.userId]);
      if (!rows[0]) return null;
      const value = JSON.parse(unseal(rows[0].credential, encryptionKey));
      if (value.sessionId !== session.id || value.sandboxId !== sandboxId || value.userId !== session.userId || typeof value.token !== 'string') throw new Error('Private preview credential scope is invalid.');
      return value.token;
    },
    async remove(sandboxId: string) { await db.query('DELETE FROM preview_ingress_credentials WHERE sandbox_id=$1', [sandboxId]); },
    async prune() { await db.query(`DELETE FROM preview_ingress_credentials c WHERE NOT EXISTS (SELECT 1 FROM ephemeral_sessions s WHERE s.id=c.session_id AND s.user_id=c.user_id AND s.state IN ('provisioning','running') AND (s.data->>'sandboxId' IS NULL OR s.data->>'sandboxId'=c.sandbox_id))`); },
  };
}
