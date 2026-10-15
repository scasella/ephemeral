import { randomBytes, randomUUID } from 'node:crypto';
import type { Database, Session } from '../contracts.js';
import { capabilityHash, decrypt, encrypt, equalHash, GitHubError, InstallationTokenIssuanceError } from './security.js';
import type { GitHubAPI } from './api.js';
import { GitAnchors } from './anchors.js';
interface Capability { session_id: string; token_hash: string; disabled: boolean }
interface TokenRow { id: string; session_id: string; ciphertext: string | null; expires_at: string; status: string }
const ISSUANCE_LIFETIME_MS = 65 * 60_000;
export type IssuanceState = 'uncertain' | 'not_issued' | 'issued' | 'revoke_pending' | 'revoked' | 'expired';
export type IssuanceReason = 'request_uncertain' | 'request_rejected' | 'request_not_sent' | 'invalid_grant' | 'token_record_failed' | 'token_recorded' | 'revocation_pending' | 'revoked' | 'expired';
interface AttemptRow { id: string; session_id: string; status: IssuanceState; reason: IssuanceReason; started_at: string; updated_at: string; expires_at: string; ciphertext: string | null; token_id: string | null }
interface IssuanceMarker { uncertainty_until: string; attempt_id: string | null }
export interface IssuanceDiagnostics {
  uncertaintyUntil: string | null;
  attempts: { id: string; status: IssuanceState; reason: IssuanceReason; startedAt: string; updatedAt: string; expiresAt: string }[];
}
type TokenAPI = Pick<GitHubAPI, 'installationToken' | 'revoke'> & Partial<Pick<GitHubAPI, 'prepareInstallationToken'>>;
const unexpired = (value: string): boolean => !Number.isFinite(Date.parse(value)) || Date.parse(value) > Date.now();
export class CredentialStore {
  readonly anchors: GitAnchors;
  constructor(private db: Database, private key: Buffer, private api: TokenAPI) { this.anchors = new GitAnchors(db); }
  async migrate(): Promise<void> {
    await this.db.query(`CREATE TABLE IF NOT EXISTS github_gateway_credentials (
      session_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, disabled BOOLEAN NOT NULL DEFAULT FALSE)`);
    await this.db.query('ALTER TABLE github_gateway_credentials ADD COLUMN IF NOT EXISTS clone_anchor_version INTEGER');
    await this.anchors.migrate();
    await this.db.query(`CREATE TABLE IF NOT EXISTS github_installation_tokens (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, ciphertext TEXT, expires_at TEXT NOT NULL, status TEXT NOT NULL)`);
    await this.db.query('CREATE INDEX IF NOT EXISTS github_tokens_session ON github_installation_tokens(session_id)');
    await this.db.query(`CREATE TABLE IF NOT EXISTS github_token_issuance (session_id TEXT PRIMARY KEY, uncertainty_until TEXT NOT NULL)`);
    await this.db.query('ALTER TABLE github_token_issuance ADD COLUMN IF NOT EXISTS attempt_id TEXT');
    await this.db.query(`CREATE TABLE IF NOT EXISTS github_token_issuance_attempts (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL,
      started_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL, ciphertext TEXT, token_id TEXT)`);
    await this.db.query('CREATE INDEX IF NOT EXISTS github_issuance_session ON github_token_issuance_attempts(session_id)');
    await this.db.query(`CREATE TABLE IF NOT EXISTS github_gateway_roots (path TEXT PRIMARY KEY)`);
    await this.db.query(`CREATE TABLE IF NOT EXISTS github_gateway_disks (session_id TEXT PRIMARY KEY, path TEXT NOT NULL)`);
  }
  async issue(session: Session): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.db.query(`INSERT INTO github_gateway_credentials(session_id,token_hash,disabled,clone_anchor_version) VALUES($1,$2,FALSE,1)
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
    const current = rows.find(row => Number.isFinite(Date.parse(row.expires_at)) && Date.parse(row.expires_at) > Date.now() + 120_000 && row.ciphertext);
    if (current) {
      if (!await this.enabled(session.id)) throw new GitHubError('Gateway credential is disabled', 403);
      return decrypt(current.ciphertext!, this.key, `github:${current.id}:${session.id}`);
    }
    const pending = (await this.db.query<IssuanceMarker>('SELECT uncertainty_until,attempt_id FROM github_token_issuance WHERE session_id=$1', [session.id])).rows[0];
    if (pending && unexpired(pending.uncertainty_until)) throw new GitHubError('Previous GitHub token issuance is uncertain; cleanup must retry', 503);
    if (pending) {
      if (pending.attempt_id) await this.outcome(pending.attempt_id, 'expired', 'expired');
      await this.clearIssuance(session.id, pending.attempt_id);
    }
    const id = randomUUID(), started = new Date().toISOString(), until = new Date(Date.now() + ISSUANCE_LIFETIME_MS).toISOString();
    let mint: () => Promise<{ token: string; expires_at: string }>;
    try {
      // Optional only for legacy adapters: they stay conservative after any error.
      mint = this.api.prepareInstallationToken?.(session) ?? (() => this.api.installationToken(session));
    } catch {
      await this.db.query(`INSERT INTO github_token_issuance_attempts(id,session_id,status,reason,started_at,updated_at,expires_at)
        VALUES($1,$2,'not_issued','request_not_sent',$3,$3,$3)`, [id, session.id, started]);
      throw new GitHubError('GitHub token request could not be prepared');
    }
    // One durable claim fences simultaneous callers and restarts. Never overwrite
    // another attempt's marker, even if that caller began before this one.
    const claim = await this.db.query<{ session_id: string }>(`INSERT INTO github_token_issuance(session_id,uncertainty_until,attempt_id) VALUES($1,$2,$3)
      ON CONFLICT(session_id) DO NOTHING RETURNING session_id`, [session.id, until, id]);
    if (!claim.rows.length) throw new GitHubError('Previous GitHub token issuance is uncertain; cleanup must retry', 503);
    await this.db.query(`INSERT INTO github_token_issuance_attempts(id,session_id,status,reason,started_at,updated_at,expires_at)
      VALUES($1,$2,'uncertain','request_uncertain',$3,$3,$4)`, [id, session.id, started, until]);
    if (!await this.enabled(session.id)) {
      await this.outcome(id, 'not_issued', 'request_not_sent'); await this.clearIssuance(session.id, id);
      throw new GitHubError('Gateway credential is disabled', 403);
    }
    let issued: { token: string; expires_at: string };
    try { issued = await mint(); }
    catch (error) {
      if (error instanceof InstallationTokenIssuanceError && error.outcome === 'not_issued') {
        await this.outcome(id, 'not_issued', 'request_rejected'); await this.clearIssuance(session.id, id);
      }
      throw error;
    }
    if (!issued || typeof issued.token !== 'string' || !issued.token || /[\r\n]/.test(issued.token)) {
      await this.outcome(id, 'uncertain', 'invalid_grant');
      throw new GitHubError('GitHub returned an invalid installation token');
    }
    const tokenId = randomUUID();
    const validExpiry = typeof issued.expires_at === 'string' && Number.isFinite(Date.parse(issued.expires_at)) &&
      Date.parse(issued.expires_at) > Date.now() && Date.parse(issued.expires_at) <= Date.parse(until);
    // Invalid provider expiry cannot prove expiration. Keep the documented one-hour
    // grant lifetime plus margin, and retain the encrypted revocation handle.
    const expiry = validExpiry ? issued.expires_at : until;
    let ciphertext: string | undefined;
    try {
      ciphertext = encrypt(issued.token, this.key, `github:${tokenId}:${session.id}`);
      await this.db.query(`UPDATE github_token_issuance_attempts SET ciphertext=$2,token_id=$3,expires_at=$4,status='revoke_pending',reason=$5,updated_at=$6 WHERE id=$1`,
        [id, ciphertext, tokenId, expiry, validExpiry ? 'token_record_failed' : 'invalid_grant', new Date().toISOString()]);
      if (!validExpiry) throw new GitHubError('GitHub returned an invalid installation token');
      await this.db.query('INSERT INTO github_installation_tokens(id,session_id,ciphertext,expires_at,status) VALUES($1,$2,$3,$4,$5)',
        [tokenId, session.id, ciphertext, expiry, 'active']);
      await this.outcome(id, 'issued', 'token_recorded');
      await this.clearIssuance(session.id, id);
    } catch (error) {
      // Even a failed normal token INSERT has a second durable encrypted handle
      // in the issuance journal. Retry preserving it before compensation as well.
      if (ciphertext) await this.db.query(`UPDATE github_token_issuance_attempts SET ciphertext=$2,token_id=$3,expires_at=$4,status='revoke_pending',reason=$5,updated_at=$6 WHERE id=$1`,
        [id, ciphertext, tokenId, expiry, validExpiry ? 'token_record_failed' : 'invalid_grant', new Date().toISOString()]).catch(() => undefined);
      try {
        await this.api.revoke(issued.token);
        await this.db.query(`UPDATE github_installation_tokens SET status='revoked',ciphertext=NULL WHERE id=$1`, [tokenId]);
        await this.outcome(id, 'revoked', 'revoked'); await this.clearIssuance(session.id, id);
      } catch { /* The durable marker/handle must survive failure or process exit. */ }
      throw error;
    }
    // Old tokens remain encrypted and retryable if GitHub is unavailable.
    for (const row of rows) await this.revokeRow(row).catch(() => undefined);
    if (!await this.enabled(session.id)) { await this.revoke(session.id); throw new GitHubError('Gateway credential is disabled', 403); }
    return issued.token;
  }
  private async outcome(id: string, status: IssuanceState, reason: IssuanceReason): Promise<void> {
    await this.db.query(`UPDATE github_token_issuance_attempts SET status=$2,reason=$3,updated_at=$4,
      ciphertext=CASE WHEN $2 IN ('not_issued','issued','revoked','expired') THEN NULL ELSE ciphertext END WHERE id=$1`, [id, status, reason, new Date().toISOString()]);
  }
  private async revokeRow(row: TokenRow): Promise<void> {
    await this.db.query(`UPDATE github_installation_tokens SET status='revoke_pending' WHERE id=$1`, [row.id]);
    if (!row.ciphertext && unexpired(row.expires_at)) throw new GitHubError('GitHub token revocation handle is unavailable; cleanup must retry');
    if (row.ciphertext && unexpired(row.expires_at)) {
      try { await this.api.revoke(decrypt(row.ciphertext, this.key, `github:${row.id}:${row.session_id}`)); }
      catch (error) {
        // A token GitHub already rejects is no longer usable. Other failures remain retryable.
        if (!(error instanceof GitHubError) || error.upstreamStatus !== 401) throw error;
      }
    }
    await this.db.query(`UPDATE github_installation_tokens SET status='revoked',ciphertext=NULL WHERE id=$1`, [row.id]);
    const settled = await this.db.query<{ id: string; session_id: string }>(`UPDATE github_token_issuance_attempts SET status='revoked',reason='revoked',ciphertext=NULL,updated_at=$2 WHERE token_id=$1 RETURNING id,session_id`, [row.id, new Date().toISOString()]);
    for (const attempt of settled.rows) await this.clearIssuance(attempt.session_id, attempt.id);
  }
  private async revokeAttempt(row: AttemptRow): Promise<void> {
    if (row.ciphertext && row.token_id) {
      if (unexpired(row.expires_at)) {
        try { await this.api.revoke(decrypt(row.ciphertext, this.key, `github:${row.token_id}:${row.session_id}`)); }
        catch (error) { if (!(error instanceof GitHubError) || error.upstreamStatus !== 401) throw error; }
      }
      await this.db.query(`UPDATE github_installation_tokens SET status='revoked',ciphertext=NULL WHERE id=$1`, [row.token_id]);
      await this.outcome(row.id, 'revoked', 'revoked');
      await this.clearIssuance(row.session_id, row.id);
    } else if (!unexpired(row.expires_at)) {
      await this.outcome(row.id, 'expired', 'expired'); await this.clearIssuance(row.session_id, row.id);
    } else throw new GitHubError('GitHub token issuance is uncertain; cleanup must retry');
  }
  async revoke(sessionId: string): Promise<void> {
    const rows = (await this.db.query<TokenRow>(`SELECT * FROM github_installation_tokens WHERE session_id=$1 AND status<>'revoked'`, [sessionId])).rows;
    let failed = false;
    for (const row of rows) try { await this.revokeRow(row); } catch { failed = true; }
    const attempts = (await this.db.query<AttemptRow>(`SELECT * FROM github_token_issuance_attempts WHERE session_id=$1 AND status IN ('uncertain','revoke_pending')`, [sessionId])).rows;
    for (const row of attempts) try { await this.revokeAttempt(row); } catch { failed = true; }
    const uncertainty = (await this.db.query<IssuanceMarker>('SELECT uncertainty_until,attempt_id FROM github_token_issuance WHERE session_id=$1', [sessionId])).rows[0];
    if (uncertainty) {
      const settled = uncertainty.attempt_id ? (await this.db.query<{ status: string }>('SELECT status FROM github_token_issuance_attempts WHERE id=$1 AND session_id=$2', [uncertainty.attempt_id, sessionId])).rows[0] : undefined;
      if (settled && ['not_issued', 'revoked', 'expired'].includes(settled.status)) await this.clearIssuance(sessionId, uncertainty.attempt_id);
      else if (unexpired(uncertainty.uncertainty_until)) failed = true;
      else await this.clearIssuance(sessionId, uncertainty.attempt_id);
    }
    if (failed) throw new GitHubError('GitHub token revocation is pending; cleanup must retry');
  }
  async retryRotated(): Promise<void> {
    const rows = (await this.db.query<TokenRow>(`SELECT * FROM github_installation_tokens WHERE status='revoke_pending'`)).rows;
    for (const row of rows) await this.revokeRow(row).catch(() => undefined);
    const attempts = (await this.db.query<AttemptRow>(`SELECT * FROM github_token_issuance_attempts WHERE status='revoke_pending'`)).rows;
    for (const row of attempts) await this.revokeAttempt(row).catch(() => undefined);
  }
  private async clearIssuance(id: string, attemptId: string | null): Promise<void> {
    await this.db.query('DELETE FROM github_token_issuance WHERE session_id=$1 AND (attempt_id=$2 OR (attempt_id IS NULL AND $2 IS NULL))', [id, attemptId]);
  }
  async issuanceStatus(sessionId: string): Promise<IssuanceDiagnostics> {
    const marker = (await this.db.query<IssuanceMarker>('SELECT uncertainty_until,attempt_id FROM github_token_issuance WHERE session_id=$1', [sessionId])).rows[0];
    const rows = (await this.db.query<Omit<AttemptRow, 'ciphertext' | 'token_id'>>(`SELECT id,session_id,status,reason,started_at,updated_at,expires_at FROM github_token_issuance_attempts WHERE session_id=$1 ORDER BY started_at,id`, [sessionId])).rows;
    return { uncertaintyUntil: marker?.uncertainty_until ?? null, attempts: rows.map(row => ({ id: row.id, status: row.status, reason: row.reason,
      startedAt: row.started_at, updatedAt: row.updated_at, expiresAt: row.expires_at })) };
  }
  async roots(): Promise<{ path: string }[]> { return (await this.db.query<{ path: string }>('SELECT path FROM github_gateway_roots')).rows; }
  async hasRoot(path: string): Promise<boolean> {
    return (await this.db.query<{ path: string }>('SELECT path FROM github_gateway_roots WHERE path=$1', [path])).rows.length > 0;
  }
  async recordRoot(path: string): Promise<void> { await this.db.query('INSERT INTO github_gateway_roots(path) VALUES($1)', [path]); }
  async forgetRoot(path: string): Promise<void> { await this.db.query('DELETE FROM github_gateway_roots WHERE path=$1', [path]); }
  async recordDisk(sessionId: string, path: string): Promise<void> {
    await this.db.query('INSERT INTO github_gateway_disks(session_id,path) VALUES($1,$2) ON CONFLICT(session_id) DO UPDATE SET path=EXCLUDED.path', [sessionId, path]);
  }
  async disks(): Promise<{ session_id: string; path: string }[]> { return (await this.db.query<{ session_id: string; path: string }>('SELECT * FROM github_gateway_disks')).rows; }
  async disk(sessionId: string): Promise<{ path: string } | null> {
    return (await this.db.query<{ path: string }>('SELECT path FROM github_gateway_disks WHERE session_id=$1', [sessionId])).rows[0] ?? null;
  }
  async forgetDisk(id: string): Promise<void> { await this.db.query('DELETE FROM github_gateway_disks WHERE session_id=$1', [id]); }
}
