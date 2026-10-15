import { randomBytes, randomUUID } from 'node:crypto';
import type { Database, Session } from '../contracts.js';
import { capabilityHash, decrypt, encrypt, equalHash, GitHubError } from './security.js';
import type { GitHubAPI } from './api.js';
interface Capability { session_id: string; token_hash: string; disabled: boolean }
interface TokenRow { id: string; session_id: string; ciphertext: string | null; expires_at: string; status: string }
export class CredentialStore {
  constructor(private db: Database, private key: Buffer, private api: GitHubAPI) {}
  async migrate(): Promise<void> {
    await this.db.query(`CREATE TABLE IF NOT EXISTS github_gateway_credentials (
      session_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, disabled BOOLEAN NOT NULL DEFAULT FALSE)`);
    await this.db.query(`CREATE TABLE IF NOT EXISTS github_installation_tokens (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, ciphertext TEXT, expires_at TEXT NOT NULL, status TEXT NOT NULL)`);
    await this.db.query('CREATE INDEX IF NOT EXISTS github_tokens_session ON github_installation_tokens(session_id)');
    await this.db.query(`CREATE TABLE IF NOT EXISTS github_token_issuance (session_id TEXT PRIMARY KEY, uncertainty_until TEXT NOT NULL)`);
    await this.db.query(`CREATE TABLE IF NOT EXISTS github_gateway_roots (path TEXT PRIMARY KEY)`);
    await this.db.query(`CREATE TABLE IF NOT EXISTS github_gateway_disks (session_id TEXT PRIMARY KEY, path TEXT NOT NULL)`);
  }
  async issue(session: Session): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.db.query(`INSERT INTO github_gateway_credentials(session_id,token_hash,disabled) VALUES($1,$2,FALSE)
      ON CONFLICT(session_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,disabled=FALSE`, [session.id, capabilityHash(token)]);
    return token;
  }
  async enabled(sessionId: string, capability?: string): Promise<boolean> {
    const row = (await this.db.query<Capability>('SELECT * FROM github_gateway_credentials WHERE session_id=$1', [sessionId])).rows[0];
    return Boolean(row && !row.disabled && (capability === undefined || equalHash(capability, row.token_hash)));
  }
  async disable(sessionId: string): Promise<void> { await this.db.query('UPDATE github_gateway_credentials SET disabled=TRUE WHERE session_id=$1', [sessionId]); }
  async token(session: Session): Promise<string> {
    if (!await this.enabled(session.id)) throw new GitHubError('Gateway credential is disabled', 403);
    const rows = (await this.db.query<TokenRow>(`SELECT * FROM github_installation_tokens WHERE session_id=$1 AND status='active' ORDER BY expires_at DESC`, [session.id])).rows;
    const current = rows.find(row => Date.parse(row.expires_at) > Date.now() + 120_000 && row.ciphertext);
    if (current) return decrypt(current.ciphertext!, this.key, `github:${current.id}:${session.id}`);
    const pending = (await this.db.query<{ uncertainty_until: string }>('SELECT uncertainty_until FROM github_token_issuance WHERE session_id=$1', [session.id])).rows[0];
    if (pending && Date.parse(pending.uncertainty_until) > Date.now()) throw new GitHubError('Previous GitHub token issuance is uncertain; cleanup must retry', 503);
    if (pending) await this.clearIssuance(session.id);
    // Persist uncertainty before the remote side effect. A crash can otherwise lose the only revocation handle.
    await this.db.query('INSERT INTO github_token_issuance(session_id,uncertainty_until) VALUES($1,$2) ON CONFLICT(session_id) DO UPDATE SET uncertainty_until=EXCLUDED.uncertainty_until', [session.id, new Date(Date.now() + 65 * 60_000).toISOString()]);
    let issued: { token: string; expires_at: string };
    try { issued = await this.api.installationToken(session); }
    catch (error) {
      if (error instanceof GitHubError && error.upstreamStatus && error.upstreamStatus >= 400 && error.upstreamStatus < 500) await this.clearIssuance(session.id);
      throw error;
    }
    if (!issued.token || !Number.isFinite(Date.parse(issued.expires_at)) || Date.parse(issued.expires_at) <= Date.now()) throw new GitHubError('GitHub returned an invalid installation token');
    const id = randomUUID();
    try {
      await this.db.query('INSERT INTO github_installation_tokens(id,session_id,ciphertext,expires_at,status) VALUES($1,$2,$3,$4,$5)',
        [id, session.id, encrypt(issued.token, this.key, `github:${id}:${session.id}`), issued.expires_at, 'active']);
    } catch (error) {
      try { await this.api.revoke(issued.token); await this.clearIssuance(session.id); } catch { /* Unknown remote credential must age out before cleanup can confirm. */ }
      throw error;
    }
    await this.clearIssuance(session.id);
    // Old tokens remain encrypted and retryable if GitHub is unavailable during rotation.
    for (const row of rows) await this.revokeRow(row).catch(() => undefined);
    if (!await this.enabled(session.id)) { await this.revoke(session.id); throw new GitHubError('Gateway credential is disabled', 403); }
    return issued.token;
  }
  private async revokeRow(row: TokenRow): Promise<void> {
    await this.db.query(`UPDATE github_installation_tokens SET status='revoke_pending' WHERE id=$1`, [row.id]);
    if (row.ciphertext && Date.parse(row.expires_at) > Date.now()) {
      try { await this.api.revoke(decrypt(row.ciphertext, this.key, `github:${row.id}:${row.session_id}`)); }
      catch (error) {
        // A token GitHub already rejects is no longer usable. Other failures remain retryable.
        if (!(error instanceof GitHubError) || error.upstreamStatus !== 401) throw error;
      }
    }
    await this.db.query(`UPDATE github_installation_tokens SET status='revoked',ciphertext=NULL WHERE id=$1`, [row.id]);
  }
  async revoke(sessionId: string): Promise<void> {
    const rows = (await this.db.query<TokenRow>(`SELECT * FROM github_installation_tokens WHERE session_id=$1 AND status<>'revoked'`, [sessionId])).rows;
    let failed = false;
    for (const row of rows) try { await this.revokeRow(row); } catch { failed = true; }
    const uncertainty = (await this.db.query<{ uncertainty_until: string }>('SELECT uncertainty_until FROM github_token_issuance WHERE session_id=$1', [sessionId])).rows[0];
    if (uncertainty && Date.parse(uncertainty.uncertainty_until) > Date.now()) failed = true;
    else if (uncertainty) await this.clearIssuance(sessionId);
    if (failed) throw new GitHubError('GitHub token revocation is pending; cleanup must retry');
  }
  async retryRotated(): Promise<void> {
    const rows = (await this.db.query<TokenRow>(`SELECT * FROM github_installation_tokens WHERE status='revoke_pending'`)).rows;
    for (const row of rows) await this.revokeRow(row).catch(() => undefined);
  }
  private async clearIssuance(id: string): Promise<void> { await this.db.query('DELETE FROM github_token_issuance WHERE session_id=$1', [id]); }
  async roots(): Promise<{ path: string }[]> { return (await this.db.query<{ path: string }>('SELECT path FROM github_gateway_roots')).rows; }
  async recordRoot(path: string): Promise<void> { await this.db.query('INSERT INTO github_gateway_roots(path) VALUES($1)', [path]); }
  async forgetRoot(path: string): Promise<void> { await this.db.query('DELETE FROM github_gateway_roots WHERE path=$1', [path]); }
  async recordDisk(sessionId: string, path: string): Promise<void> {
    await this.db.query('INSERT INTO github_gateway_disks(session_id,path) VALUES($1,$2) ON CONFLICT(session_id) DO UPDATE SET path=EXCLUDED.path', [sessionId, path]);
  }
  async disks(): Promise<{ session_id: string; path: string }[]> { return (await this.db.query<{ session_id: string; path: string }>('SELECT * FROM github_gateway_disks')).rows; }
  async forgetDisk(id: string): Promise<void> { await this.db.query('DELETE FROM github_gateway_disks WHERE session_id=$1', [id]); }
}
