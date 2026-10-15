import express from 'express';
import { createServer } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuth } from '../server/auth/index.js';
import { digest, seal } from '../server/auth/crypto.js';
import { readConfig } from '../server/config.js';
import type { Database, Session } from '../server/contracts.js';

const key = Buffer.alloc(32, 13).toString('base64');
const session = { id: 'session', userId: '42', repository: 'owner/repo', repositoryId: 1 } as Session;
const realFetch = globalThis.fetch;

describe('real persisted authorization and OAuth boundaries', () => {
  const pg = new PGlite();
  const db: Database = { async query<T>(sql: string, params: unknown[] = []) { return { rows: (await pg.query<T>(sql, params)).rows }; }, close: () => pg.close() };
  const config = { ...readConfig({ ENCRYPTION_KEY: key, ALLOWED_GITHUB_IDS: '42' }), mode: 'live' as const, secure: true, publicUrl: 'https://control.example.test' };
  let auth: Awaited<ReturnType<typeof createAuth>>, origin: string;
  let admissionTime = 0;
  const server = createServer();
  let upstream = vi.fn<typeof fetch>();
  beforeAll(async () => {
    auth = await createAuth(db, config, undefined, { now: () => admissionTime });
    const app = express(); app.use('/auth', auth.router);
    app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).send('Sign-in failed.'));
    server.on('request', app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    origin = `http://127.0.0.1:${address.port}`;
  }, 30_000);
  beforeEach(async () => {
    admissionTime += 10 * 60_000;
    await db.query('DELETE FROM browser_sessions'); await db.query('DELETE FROM oauth_states'); config.allowedIds.add('42');
    upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 1, permissions: { push: true } }));
    vi.stubGlobal('fetch', upstream);
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await pg.close(); });
  async function browser(expiry = Date.now() + 60_000, credential = seal('synthetic-access', key)) {
    await db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [digest('browser'), '42', 'owner', '', credential, new Date(expiry).toISOString()]);
  }
  it('authorizes an invited owner only for the stored repository ID with current push access', async () => {
    await browser(); await expect(auth.authorizeSession(session)).resolves.toBeUndefined();
    expect(upstream).toHaveBeenCalledWith('https://api.github.com/repos/owner/repo', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer synthetic-access' }), signal: expect.any(AbortSignal) }));
  });
  it('denies missing, expired, uninvited and undecryptable credentials before any GitHub request', async () => {
    await expect(auth.authorizeSession(session)).rejects.toThrow(/Sign in/);
    await browser(Date.now() - 1000); await expect(auth.authorizeSession(session)).rejects.toThrow(/Sign in/);
    await db.query('DELETE FROM browser_sessions'); await browser(); config.allowedIds.delete('42');
    await expect(auth.authorizeSession(session)).rejects.toThrow(/invited/);
    config.allowedIds.add('42'); await db.query("UPDATE browser_sessions SET credential='corrupt-private-value'");
    await expect(auth.authorizeSession(session)).rejects.toThrow('Sign in to Ephemeral again to restore repository access');
    expect(await auth.read({ headers: { cookie: '__Host-ephemeral=browser' } })).toBeNull();
    expect(upstream).not.toHaveBeenCalled();
  });
  for (const result of [{ id: 2, permissions: { push: true } }, { id: 1, permissions: { push: false } }, { id: 1 }]) {
    it(`denies repository mismatch or missing push permission: ${JSON.stringify(result)}`, async () => {
      await browser(); upstream.mockResolvedValue(Response.json(result));
      await expect(auth.authorizeSession(session)).rejects.toThrow('Repository write access is no longer authorized');
    });
  }
  for (const status of [401, 403]) it(`fails closed for GitHub ${status} without returning its private response`, async () => {
    await browser(); upstream.mockResolvedValue(new Response('private upstream token ghp_secret', { status }));
    await expect(auth.authorizeSession(session)).rejects.toThrow(status === 401 ? 'GitHub sign-in expired. Sign in again.' : 'GitHub authorization check failed.');
  });
  it('fails closed for upstream transport errors with a trusted message', async () => {
    await browser(); upstream.mockRejectedValue(new Error('https://private.test?token=secret'));
    await expect(auth.authorizeSession(session)).rejects.toThrow('GitHub authorization check failed.');
  });
  async function start() {
    const response = await realFetch(`${origin}/auth/github`, { redirect: 'manual' });
    const state = new URL(response.headers.get('location')!).searchParams.get('state')!;
    return { state, cookie: `__Host-ephemeral-oauth=${state}`, response };
  }
  const callback = (state: string, cookie = '') => realFetch(`${origin}/auth/github/callback?state=${state}&code=synthetic-code`, { headers: { cookie }, redirect: 'manual' });
  function grant(expires_in?: unknown, id = 42) {
    upstream.mockImplementation(async input => String(input).includes('access_token') ? Response.json({ access_token: 'synthetic-grant', ...(expires_in === undefined ? {} : { expires_in }) }) : Response.json({ id, login: 'owner', avatar_url: '' }));
  }
  it('binds OAuth state to its browser cookie and consumes it only once', async () => {
    const { state, cookie, response } = await start();
    expect(response.headers.get('set-cookie')).toMatch(/__Host-ephemeral-oauth=.*Max-Age=600.*Path=\/.*HttpOnly.*Secure.*SameSite=Lax/);
    for (const value of ['', '__Host-ephemeral-oauth=wrong']) expect((await callback(state, value)).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    grant(); expect((await callback(state, cookie)).status).toBe(302);
    expect((await callback(state, cookie)).status).toBe(400); expect(upstream).toHaveBeenCalledTimes(2);
  });
  it('rejects expired state and uninvited profiles without creating browser sessions', async () => {
    const expired = await start(); await db.query("UPDATE oauth_states SET expires_at=NOW()-INTERVAL '1 second'");
    expect((await callback(expired.state, expired.cookie)).status).toBe(400); expect(upstream).not.toHaveBeenCalled();
    const other = await start(); grant(undefined, 99);
    expect((await callback(other.state, other.cookie)).status).toBe(403);
    expect((await db.query('SELECT hash FROM browser_sessions')).rows).toHaveLength(0);
  });
  for (const expiry of [undefined, 60, 100_000]) it(`caps persisted lifetime and secure cookie lifetime for expires_in=${expiry}`, async () => {
    const { state, cookie } = await start(); grant(expiry);
    const before = Date.now(), response = await callback(state, cookie), after = Date.now();
    expect(response.status).toBe(302);
    const seconds = Math.min(expiry ?? 28800, 28800), value = response.headers.get('set-cookie')!;
    expect(value).toMatch(new RegExp(`__Host-ephemeral=[^;]+; Max-Age=${seconds}; Path=/;`));
    expect(value).toContain('HttpOnly; Secure; SameSite=Lax');
    const rows = await db.query<{ expires_at: string; credential: string }>('SELECT expires_at,credential FROM browser_sessions');
    const deadline = new Date(rows.rows[0].expires_at).getTime();
    expect(deadline).toBeGreaterThanOrEqual(before + seconds * 1000); expect(deadline).toBeLessThanOrEqual(after + seconds * 1000);
    expect(rows.rows[0].credential).not.toContain('synthetic-grant');
  });
  for (const expiry of [0, -1, 1.5, 1e100, '3600', 'not-a-number', null]) it(`rejects malformed expires_in=${expiry} with a fixed response`, async () => {
    const { state, cookie } = await start(); grant(expiry);
    const response = await callback(state, cookie);
    expect(response.status).toBe(401); expect(await response.text()).toBe('GitHub sign-in failed. Start again.');
    expect((await db.query('SELECT hash FROM browser_sessions')).rows).toHaveLength(0);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
