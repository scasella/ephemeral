import { Router, type Request, type Response } from 'express';
import type { Database, Identity, Session } from '../contracts.js';
import type { Config } from '../config.js';
import { digest, seal, unseal, token, same } from './crypto.js';

interface AuthRow { hash: string; user_id: string; login: string; avatar_url: string; credential: string; expires_at: string }
export function cookies(req: Pick<Request, 'headers'>): Record<string, string> {
  const pairs = (req.headers.cookie || '').split(';').map(part => { const i = part.indexOf('='); return i < 0 ? [] : [part.slice(0, i).trim(), part.slice(i + 1).trim()]; }).filter(p => p.length === 2);
  return Object.fromEntries(pairs);
}
export function isSameOrigin(req: Pick<Request, 'headers'>, publicUrl: string): boolean {
  const origin = req.headers.origin;
  if (origin && origin !== publicUrl) return false;
  const fetchSite = req.headers['sec-fetch-site'];
  return !fetchSite || fetchSite === 'same-origin' || fetchSite === 'none';
}
export async function createAuth(db: Database, config: Config) {
  await db.query(`CREATE TABLE IF NOT EXISTS browser_sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, login TEXT NOT NULL, avatar_url TEXT NOT NULL, credential TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL)`);
  await db.query(`CREATE TABLE IF NOT EXISTS oauth_states (hash TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL)`);
  const cookieName = config.secure ? '__Host-ephemeral' : 'ephemeral';
  const stateName = config.secure ? '__Host-ephemeral-oauth' : 'ephemeral-oauth';
  function cookie(res: Response, name: string, value: string, maxAge: number) { res.cookie(name, value, { httpOnly: true, secure: config.secure, sameSite: 'lax', path: '/', maxAge }); }
  async function read(req: Pick<Request, 'headers'>): Promise<(Identity & { accessToken: string }) | null> {
    const value = cookies(req)[cookieName];
    if (!value || value.length > 128) return null;
    return readByHash(digest(value));
  }
  function browserHash(req: Pick<Request, 'headers'>) {
    const value = cookies(req)[cookieName];
    return value && value.length <= 128 ? digest(value) : null;
  }
  async function readByHash(hash: string): Promise<(Identity & { accessToken: string; expiresAt: string }) | null> {
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    const { rows } = await db.query<AuthRow>('SELECT * FROM browser_sessions WHERE hash=$1 AND expires_at>NOW()', [hash]);
    const row = rows[0];
    if (!row || !config.allowedIds.has(row.user_id)) return null;
    return { id: row.user_id, login: row.login, avatarUrl: row.avatar_url, accessToken: unseal(row.credential, config.encryptionKey), expiresAt: new Date(row.expires_at).toISOString() };
  }
  async function github(path: string, credential: string) {
    const response = await fetch(`https://api.github.com${path}`, { headers: { Authorization: `Bearer ${credential}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(response.status === 401 ? 'GitHub sign-in expired. Sign in again.' : 'GitHub authorization check failed.');
    return response.json();
  }
  async function authorizeSession(session: Session) {
    if (!config.allowedIds.has(session.userId)) throw new Error('User is no longer invited');
    const { rows } = await db.query<AuthRow>('SELECT * FROM browser_sessions WHERE user_id=$1 AND expires_at>NOW() ORDER BY expires_at DESC LIMIT 1', [session.userId]);
    if (!rows[0]) throw new Error('Sign in to Ephemeral again to restore repository access');
    const [owner, repo] = session.repository.split('/');
    const result = await github(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, unseal(rows[0].credential, config.encryptionKey));
    if (result.id !== session.repositoryId || result.permissions?.push !== true) throw new Error('Repository write access is no longer authorized');
  }
  const router = Router();
  router.get('/github', async (_req, res) => {
    if (config.mode !== 'live') { res.redirect('/'); return; }
    const state = token();
    await db.query('DELETE FROM oauth_states WHERE expires_at<NOW()');
    await db.query("INSERT INTO oauth_states(hash,expires_at) VALUES($1,NOW()+INTERVAL '10 minutes')", [digest(state)]);
    cookie(res, stateName, state, 10 * 60_000);
    const target = new URL('https://github.com/login/oauth/authorize');
    target.search = new URLSearchParams({ client_id: config.githubClientId, redirect_uri: `${config.publicUrl}/auth/github/callback`, state, allow_signup: 'false' }).toString();
    res.redirect(target.toString());
  });
  router.get('/github/callback', async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const stateCookie = cookies(req)[stateName] || '';
    cookie(res, stateName, '', 0);
    if (!state || !code || !stateCookie || state.length > 128 || code.length > 512 || !same(state, stateCookie)) { res.status(400).send('Sign-in could not be verified. Start again from Ephemeral.'); return; }
    const consumed = await db.query('DELETE FROM oauth_states WHERE hash=$1 AND expires_at>NOW() RETURNING hash', [digest(state)]);
    if (!consumed.rows.length) { res.status(400).send('Sign-in has expired or was already used. Start again.'); return; }
    const exchanged = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: config.githubClientId, client_secret: config.githubClientSecret, code, redirect_uri: `${config.publicUrl}/auth/github/callback` }), signal: AbortSignal.timeout(15000) });
    const grant = await exchanged.json() as { access_token?: string; expires_in?: number; error?: string };
    if (!exchanged.ok || !grant.access_token) { res.status(401).send('GitHub sign-in failed. Start again.'); return; }
    const profile = await github('/user', grant.access_token);
    if (!config.allowedIds.has(String(profile.id))) { res.status(403).send('Ephemeral is invite-only. Ask the operator to add your numeric GitHub user ID.'); return; }
    const secret = token();
    // Require a fresh login at most every eight hours; refresh tokens are not retained.
    const lifetime = Math.min(Number(grant.expires_in) || 8 * 3600, 8 * 3600) * 1000;
    await db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [digest(secret), String(profile.id), profile.login, profile.avatar_url || '', seal(grant.access_token, config.encryptionKey), new Date(Date.now() + lifetime).toISOString()]);
    cookie(res, cookieName, secret, lifetime);
    res.redirect('/');
  });
  return {
    router, read, readByHash, browserHash, authorizeSession,
    async logout(req: Request, res: Response) { await db.query('DELETE FROM browser_sessions WHERE hash=$1', [digest(cookies(req)[cookieName] || '')]); cookie(res, cookieName, '', 0); },
    async prune() { await db.query('DELETE FROM browser_sessions WHERE expires_at<NOW()'); await db.query('DELETE FROM oauth_states WHERE expires_at<NOW()'); },
  };
}
