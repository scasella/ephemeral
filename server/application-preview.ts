import { randomUUID } from 'node:crypto';
import { generationViewerOrigin } from '../shared/preview-origin.js';
import type { Database, Session, SessionRepository, SandboxProvider } from './contracts.js';
import type { Config } from './config.js';
import type { createAuth } from './auth/index.js';
import { digest, token } from './auth/crypto.js';
import { isApplicationPreviewPort } from './infra/application-preview.js';
import { createPreviewAuthorizationCache } from './application-preview-authorization.js';
import { probeApplicationPreview, type ApplicationPreviewCheck } from './preview-readiness.js';

export class ApplicationPreviewError extends Error { constructor(public status: number, message: string) { super(message); } }
interface PreviewRow { session_id: string; port: number; generation: string; enabled: boolean; updated_at: string }
export interface PreviewGrant { session_id: string; user_id: string; browser_hash: string; generation: string; expires_at: string }
export interface ApplicationPreviewState { mode: 'live' | 'preview'; state: 'enabled' | 'disabled' | 'unavailable'; port: number | null; generation: string | null; updatedAt: string | null; reason: string | null; viewerOrigin: string | null }
export const previewRunning = (s: Session) => s.state === 'running' && !!s.sandboxId &&
  s.endedAt === null &&
  Number.isFinite(Date.parse(s.expiresAt)) && Number.isFinite(Date.parse(s.maxExpiresAt)) && Math.min(Date.parse(s.expiresAt), Date.parse(s.maxExpiresAt)) > Date.now();
export async function createApplicationPreview(db: Database, repo: SessionRepository, provider: SandboxProvider, auth: Awaited<ReturnType<typeof createAuth>>, config: Config, options: { authorizationCacheMs?: number } = {}) {
  await db.query(`CREATE TABLE IF NOT EXISTS application_previews (session_id TEXT PRIMARY KEY, port INTEGER NOT NULL, generation TEXT NOT NULL, enabled BOOLEAN NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`);
  await db.query(`CREATE TABLE IF NOT EXISTS preview_handoffs (hash TEXT PRIMARY KEY, session_id TEXT NOT NULL,user_id TEXT NOT NULL,browser_hash TEXT NOT NULL,generation TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL)`);
  await db.query(`CREATE TABLE IF NOT EXISTS preview_grants (hash TEXT PRIMARY KEY, session_id TEXT NOT NULL,user_id TEXT NOT NULL,browser_hash TEXT NOT NULL,generation TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL)`);
  const listeners = new Set<(id: string) => void>();
  const mutations = new Set<string>();
  const authorization = createPreviewAuthorizationCache(auth.authorizeSession, options.authorizationCacheMs);
  const row = async (id: string) => (await db.query<PreviewRow>('SELECT * FROM application_previews WHERE session_id=$1', [id])).rows[0];
  const available = (s: Session) => config.mode === 'live' && !!config.previewPublicUrl && !!provider.previewTarget && previewRunning(s);
  async function state(s: Session): Promise<ApplicationPreviewState> {
    const r = await row(s.id);
    return { mode: config.mode, state: !available(s) ? 'unavailable' : r?.enabled ? 'enabled' : 'disabled', port: r?.port ?? null, generation: r?.generation ?? null,
      updatedAt: r ? new Date(r.updated_at).toISOString() : null, reason: config.mode !== 'live' ? 'Local preview does not execute an application.' : !config.previewPublicUrl ? 'The operator has not configured a separate preview origin.' : !previewRunning(s) ? 'Application preview requires a running session.' : !provider.previewTarget ? 'The sandbox provider does not support private previews.' : null, viewerOrigin: config.previewPublicUrl && r ? generationViewerOrigin(config.previewPublicUrl, r.generation) : config.previewPublicUrl };
  }
  async function validate(grant: PreviewGrant) {
    if (Date.parse(grant.expires_at) <= Date.now()) throw new ApplicationPreviewError(401, 'Preview access expired. Open it again from Ephemeral.');
    const user = await auth.readByHash(grant.browser_hash);
    const s = await repo.get(grant.session_id), r = await row(grant.session_id);
    if (!user || user.id !== grant.user_id || !s || s.userId !== user.id || !available(s) || !r?.enabled || !isApplicationPreviewPort(r.port) || r.generation !== grant.generation) throw new ApplicationPreviewError(403, 'Preview access is no longer available.');
    try { await authorization.authorize(s, grant.browser_hash); } catch { throw new ApplicationPreviewError(403, 'Repository access could not be verified.'); }
    const current = await repo.get(s.id), currentRow = await row(s.id), still = await auth.readByHash(grant.browser_hash);
    if (!still || still.id !== s.userId || !current || !available(current) || current.sandboxId !== s.sandboxId || !currentRow?.enabled || currentRow.generation !== grant.generation || Date.parse(grant.expires_at) <= Date.now()) throw new ApplicationPreviewError(403, 'Preview access is no longer available.');
    return { session: current, port: currentRow.port };
  }
  async function revoke(id: string) {
    authorization.revoke(id);
    listeners.forEach(listener => listener(id));
    await db.query('DELETE FROM preview_handoffs WHERE session_id=$1', [id]);
    await db.query('DELETE FROM preview_grants WHERE session_id=$1', [id]);
  }
  return {
    state, validate,
    async check(s: Session, browserHash: string | null, authorize: (session: Session, accessToken: string, signal: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<ApplicationPreviewCheck> {
      const unavailable = (reason: string, remedy: string, port: number | null = null): ApplicationPreviewCheck => ({ state: 'unavailable', checkedAt: new Date().toISOString(), port, httpStatus: null, reason, remedy });
      const unknown = (): ApplicationPreviewCheck => ({ state: 'unknown', checkedAt: new Date().toISOString(), port: null, httpStatus: null,
        reason: 'Application readiness could not be verified.', remedy: 'Retry the check after verifying repository access.' });
      signal.throwIfAborted();
      const selected = await row(s.id);
      if (!available(s)) return unavailable(config.mode !== 'live' ? 'Local preview does not execute an application.' : !config.previewPublicUrl ? 'A separate preview origin is not configured.' : !previewRunning(s) ? 'Application checks require a running session.' : 'The provider does not support private previews.', 'Configure private preview access in a running session.');
      if (!selected?.enabled || !isApplicationPreviewPort(selected.port)) return unavailable('No enabled application preview port is selected.', 'Select and enable an application preview port first.');
      if (!browserHash) throw new ApplicationPreviewError(401, 'Sign in again before checking the application.');
      const user = await auth.readByHash(browserHash);
      if (!user || user.id !== s.userId) throw new ApplicationPreviewError(401, 'Sign in again before checking the application.');
      const sameSession = (current: Session) => current.id === s.id && current.userId === s.userId && current.sandboxId === s.sandboxId &&
        current.repository === s.repository && current.repositoryId === s.repositoryId && current.installationId === s.installationId &&
        current.branch === s.branch && current.baseBranch === s.baseBranch && current.createdAt === s.createdAt &&
        current.expiresAt === s.expiresAt && current.maxExpiresAt === s.maxExpiresAt && available(current);
      const current = async () => {
        signal.throwIfAborted();
        const latest = await repo.get(s.id), latestRow = await row(s.id), browser = await auth.readByHash(browserHash);
        signal.throwIfAborted();
        if (!browser || browser.id !== user.id || browser.accessToken !== user.accessToken) throw new ApplicationPreviewError(401, 'Sign in again before checking the application.');
        return latest && sameSession(latest) && latestRow?.enabled && latestRow.generation === selected.generation && latestRow.port === selected.port ? latest : null;
      };
      const verify = async (latest: Session) => {
        try { await authorize(latest, user.accessToken, signal); }
        catch (error) {
          signal.throwIfAborted();
          if (error && typeof error === 'object' && 'status' in error && (error.status === 401 || error.status === 403)) throw new ApplicationPreviewError(403, 'Repository access could not be verified.');
          return false;
        }
        signal.throwIfAborted(); return true;
      };
      const changed = () => unavailable('Preview access or the session changed during the check.', 'Refresh preview access and check again.');
      const before = await current();
      if (!before) return changed();
      if (!await verify(before)) return unknown();
      const authorized = await current();
      if (!authorized) return changed();
      const result = await probeApplicationPreview(provider, authorized, selected.port, { signal });
      const after = await current();
      if (!after) return changed();
      if (!await verify(after)) return unknown();
      return await current() ? result : changed();
    },
    async mutate<T>(id: string, operation: () => Promise<T>): Promise<T> {
      if (mutations.has(id)) throw new ApplicationPreviewError(429, 'A preview update is already in progress. Retry shortly.');
      mutations.add(id);
      try { return await operation(); } finally { mutations.delete(id); }
    },
    onRevoke(listener: (id: string) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    async enable(s: Session, port: number) {
      if (!isApplicationPreviewPort(port)) throw new ApplicationPreviewError(400, 'Select a valid application preview port.');
      if (!available(s)) throw new ApplicationPreviewError(409, 'Application preview is unavailable.');
      const generation = randomUUID();
      await db.query(`INSERT INTO application_previews(session_id,port,generation,enabled,updated_at) VALUES($1,$2,$3,true,NOW()) ON CONFLICT(session_id) DO UPDATE SET port=$2,generation=$3,enabled=true,updated_at=NOW()`, [s.id, port, generation]);
      await revoke(s.id); return state(s);
    },
    async disable(s: Session) { await db.query('UPDATE application_previews SET enabled=false,generation=$2,updated_at=NOW() WHERE session_id=$1', [s.id, randomUUID()]); await revoke(s.id); return state(s); },
    revoke,
    async open(s: Session, browserHash: string) {
      const r = await row(s.id), user = await auth.readByHash(browserHash);
      if (!r?.enabled || !user || user.id !== s.userId || !available(s)) throw new ApplicationPreviewError(409, 'Enable preview for a running session first.');
      const secret = token(), expiresAt = new Date(Math.min(Date.now() + 60_000, Date.parse(user.expiresAt), Date.parse(s.expiresAt), Date.parse(s.maxExpiresAt))).toISOString();
      await validate({ session_id: s.id, user_id: s.userId, browser_hash: browserHash, generation: r.generation, expires_at: expiresAt });
      await db.query('DELETE FROM preview_handoffs WHERE expires_at<NOW()');
      await db.query('INSERT INTO preview_handoffs(hash,session_id,user_id,browser_hash,generation,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [digest(secret), s.id, s.userId, browserHash, r.generation, expiresAt]);
      return { action: `${generationViewerOrigin(config.previewPublicUrl!, r.generation)}/__ephemeral/open`, token: secret, expiresAt, port: r.port, generation: r.generation };
    },
    async consume(secret: string, generation: string) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new ApplicationPreviewError(401, 'Invalid or expired preview handoff.');
      const r = (await db.query<PreviewGrant>('DELETE FROM preview_handoffs WHERE hash=$1 AND generation=$2 AND expires_at>NOW() RETURNING *', [digest(secret), generation])).rows[0];
      if (!r) throw new ApplicationPreviewError(401, 'Invalid or expired preview handoff.');
      const { session } = await validate(r), user = await auth.readByHash(r.browser_hash);
      if (!user) throw new ApplicationPreviewError(401, 'Preview access expired.');
      const expiresAt = new Date(Math.min(Date.now() + 600_000, Date.parse(user.expiresAt), Date.parse(session.expiresAt), Date.parse(session.maxExpiresAt))).toISOString();
      const grant = token();
      await db.query('DELETE FROM preview_grants WHERE expires_at<NOW()');
      await db.query('INSERT INTO preview_grants(hash,session_id,user_id,browser_hash,generation,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [digest(grant), r.session_id, r.user_id, r.browser_hash, r.generation, expiresAt]);
      return { token: grant, expiresAt };
    },
    async readGrant(secret: string, generation: string) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new ApplicationPreviewError(401, 'Open preview from Ephemeral to continue.');
      const r = (await db.query<PreviewGrant>('SELECT * FROM preview_grants WHERE hash=$1 AND generation=$2 AND expires_at>NOW()', [digest(secret), generation])).rows[0];
      if (!r) throw new ApplicationPreviewError(401, 'Open preview from Ephemeral to continue.');
      return r;
    },
    async target(grant: PreviewGrant) {
      const { session, port } = await validate(grant);
      try { const target = await provider.previewTarget!(session, port); await validate(grant); return { ...target, sandboxId: session.sandboxId! }; }
      catch (error) { if (error instanceof ApplicationPreviewError) throw error; throw new ApplicationPreviewError(502, 'Application preview could not connect. Check that the app is listening on the selected port.'); }
    },
  };
}
export type ApplicationPreview = Awaited<ReturnType<typeof createApplicationPreview>>;
