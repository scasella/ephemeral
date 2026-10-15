import type { Database } from '../contracts.js';

export interface PullRequestPreview {
  state: 'ready' | 'unpublished' | 'no_changes' | 'unknown' | 'unavailable';
  checkedAt: string; reason: string | null; headSha: string | null; baseSha: string | null;
  baseBranch: string; headBranch: string; aheadCommits: number | null;
}
export interface SavedPullRequest {
  url: string; number: number; headSha: string; baseSha: string;
  baseBranch: string; headBranch: string; createdAt: string;
}
interface RecordRow { url: string; number: number; head_sha: string; base_sha: string; base_branch: string; head_branch: string; created_at: string }
export async function createPullRequestRepository(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS session_pull_requests (
    session_id TEXT NOT NULL, number INTEGER NOT NULL, url TEXT NOT NULL,
    head_sha TEXT NOT NULL, base_sha TEXT NOT NULL, head_branch TEXT NOT NULL,
    base_branch TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (session_id, number)
  )`);
  return {
    async save(sessionId: string, pr: SavedPullRequest): Promise<void> {
      await db.query(`INSERT INTO session_pull_requests (session_id, number, url, head_sha, base_sha, head_branch, base_branch, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (session_id, number) DO UPDATE
        SET url=EXCLUDED.url, head_sha=EXCLUDED.head_sha, base_sha=EXCLUDED.base_sha,
        head_branch=EXCLUDED.head_branch, base_branch=EXCLUDED.base_branch`,
      [sessionId, pr.number, pr.url, pr.headSha, pr.baseSha, pr.headBranch, pr.baseBranch, pr.createdAt]);
    },
    async list(sessionId: string): Promise<SavedPullRequest[]> {
      const { rows } = await db.query<RecordRow>('SELECT * FROM session_pull_requests WHERE session_id=$1 ORDER BY created_at DESC, number DESC', [sessionId]);
      return rows.map(r => ({ url: r.url, number: r.number, headSha: r.head_sha, baseSha: r.base_sha, headBranch: r.head_branch, baseBranch: r.base_branch, createdAt: r.created_at }));
    },
  };
}
export type PullRequestRepository = Awaited<ReturnType<typeof createPullRequestRepository>>;
