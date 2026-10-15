import type { Database, Session } from '../contracts.js';
import { copyContinuation } from '../core/continuation.js';
import { GitHubError } from './security.js';

interface AnchorRow { session_id: string; identity: string; commit_sha: string; clone_complete: boolean }
const identity = (session: Session): string => JSON.stringify([session.id, session.userId, session.createdAt, session.repository, session.repositoryId,
  session.installationId, session.baseBranch, session.branch,
  session.continuation ? copyContinuation(session.continuation) : null]);

/** Immutable provenance survives credential rotation and disposable mirror cleanup. */
export class GitAnchors {
  constructor(private db: Database) {}
  async migrate(): Promise<void> {
    await this.db.query(`CREATE TABLE IF NOT EXISTS github_clone_anchors (
      session_id TEXT PRIMARY KEY, identity TEXT NOT NULL, commit_sha TEXT NOT NULL, clone_complete BOOLEAN NOT NULL DEFAULT FALSE)`);
  }
  async get(session: Session): Promise<string | null> {
    const row = (await this.db.query<AnchorRow>('SELECT * FROM github_clone_anchors WHERE session_id=$1', [session.id])).rows[0];
    if (!row) return null;
    if (row.identity !== identity(session) || !/^[a-f0-9]{40}$/.test(row.commit_sha)) {
      throw new GitHubError('Saved clone anchor does not match this session identity', 409);
    }
    return row.commit_sha;
  }
  async eligible(session: Session): Promise<boolean> {
    // A continuation already has exact reviewed provenance, including for legacy sessions.
    if (session.continuation) { copyContinuation(session.continuation); return true; }
    const row = (await this.db.query<{ clone_anchor_version: number | null }>(
      'SELECT clone_anchor_version FROM github_gateway_credentials WHERE session_id=$1', [session.id])).rows[0];
    return row?.clone_anchor_version === 1;
  }
  async capture(session: Session, sha: string): Promise<string> {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new GitHubError('Invalid clone anchor', 409);
    await this.db.query(`INSERT INTO github_clone_anchors(session_id,identity,commit_sha) VALUES($1,$2,$3)
      ON CONFLICT(session_id) DO NOTHING`, [session.id, identity(session), sha]);
    return (await this.get(session))!;
  }
  async complete(session: Session): Promise<void> {
    await this.get(session);
    await this.db.query('UPDATE github_clone_anchors SET clone_complete=TRUE WHERE session_id=$1', [session.id]);
  }
  async cloneComplete(session: Session): Promise<boolean> {
    return (await this.db.query<AnchorRow>('SELECT * FROM github_clone_anchors WHERE session_id=$1', [session.id])).rows[0]?.clone_complete ?? false;
  }
}
