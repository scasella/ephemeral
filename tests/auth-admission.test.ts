import express from 'express';
import { createServer, request } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuth } from '../server/auth/index.js';
import { createAdmission, oauthStartPolicy, oauthCallbackPolicy, type AuthAdmissionOptions } from '../server/auth/admission.js';
import { readConfig } from '../server/config.js';
import type { Database } from '../server/contracts.js';
import { WorkTracker } from '../server/shutdown.js';

const realFetch = globalThis.fetch;
const key = Buffer.alloc(32, 17).toString('base64');

describe('OAuth admission at the HTTP database boundary', () => {
  const pg = new PGlite();
  const statements: string[] = [];
  let intercept: ((sql: string) => Promise<void>) | undefined;
  const db: Database = {
    async query<T>(sql: string, params: unknown[] = []) {
      statements.push(sql);
      await intercept?.(sql);
      return { rows: (await pg.query<T>(sql, params)).rows };
    },
    close: () => pg.close(),
  };
  const config = { ...readConfig({ ENCRYPTION_KEY: key, ALLOWED_GITHUB_IDS: '42' }), mode: 'live' as const };
  let auth: Awaited<ReturnType<typeof createAuth>>, origin: string, time = 0;
  let work: WorkTracker;
  const server = createServer();
  const releases: (() => void)[] = [];
  async function reset(options: AuthAdmissionOptions = {}) {
    work = new WorkTracker();
    auth = await createAuth(db, config, work, { now: () => time, ...options });
    statements.length = 0;
  }
  beforeAll(async () => {
    await pg.waitReady;
    const app = express();
    // Deliberately trust proxy at the host level: the auth gate must still use
    // the transport peer, even when Express req.ip accepts attacker input.
    app.set('trust proxy', true);
    app.use('/auth', (req, res, next) => auth.router(req, res, next));
    app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).send('Sign-in failed.'));
    server.on('request', app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener');
    origin = `http://127.0.0.1:${address.port}`;
  }, 30_000);
  beforeEach(async () => {
    time = 0; intercept = undefined;
    await reset();
    await pg.query('DELETE FROM browser_sessions');
    await pg.query('DELETE FROM oauth_states');
  });
  afterEach(() => { for (const release of releases.splice(0)) release(); intercept = undefined; vi.unstubAllGlobals(); });
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await pg.close(); });
  const start = (headers: Record<string, string> = {}) => realFetch(`${origin}/auth/github`, { redirect: 'manual', headers });
  const callback = (state: string, cookie = `ephemeral-oauth=${state}`) => realFetch(`${origin}/auth/github/callback?state=${state}&code=synthetic-code`, { redirect: 'manual', headers: { cookie } });
  async function issued() {
    const response = await start();
    expect(response.status).toBe(302);
    return new URL(response.headers.get('location')!).searchParams.get('state')!;
  }
  function upstream() {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async input => String(input).includes('access_token')
      ? Response.json({ access_token: 'synthetic-grant' }) : Response.json({ id: 42, login: 'owner', avatar_url: '' }));
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }
  function hold(matches: (sql: string) => boolean, count = 1, fail = false) {
    let arrivals = 0;
    let signal!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { signal = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    releases.push(release);
    intercept = async sql => {
      if (!matches(sql)) return;
      arrivals++;
      if (arrivals === count) signal();
      await blocked;
      if (fail) throw new Error('synthetic private database failure');
    };
    return { entered, release, arrivals: () => arrivals };
  }
  function rejected(response: Response) {
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
  }

  it('caps starts per transport client before DB access, ignores forged headers, and recovers after the window', async () => {
    for (let i = 0; i < oauthStartPolicy.perClientLimit; i++) expect((await start()).status).toBe(302);
    expect(statements).toHaveLength(oauthStartPolicy.perClientLimit);
    expect(statements.every(sql => sql.startsWith('INSERT INTO oauth_states'))).toBe(true);
    for (let i = 0; i < 5; i++) {
      const response = await start({ 'x-forwarded-for': `203.0.113.${i}`, forwarded: `for=198.51.100.${i}`, 'x-real-ip': `192.0.2.${i}` });
      rejected(response);
      expect(response.headers.get('retry-after')).toBe('600');
      expect(await response.text()).toBe('Too many sign-in requests. Try again later.');
    }
    expect(statements).toHaveLength(oauthStartPolicy.perClientLimit);
    expect((await pg.query('SELECT hash FROM oauth_states')).rows).toHaveLength(oauthStartPolicy.perClientLimit);
    time += oauthStartPolicy.windowMs;
    expect((await start()).status).toBe(302);
    expect(statements).toHaveLength(oauthStartPolicy.perClientLimit + 1);
  });

  it('applies a global start budget independently of the client budget', async () => {
    await reset({ startPolicy: { ...oauthStartPolicy, globalLimit: 2 } });
    expect((await start()).status).toBe(302); expect((await start()).status).toBe(302);
    rejected(await start()); expect(statements).toHaveLength(2);
    time += oauthStartPolicy.windowMs;
    expect((await start()).status).toBe(302);
  });

  it('caps concurrent global DB work without queuing requests and releases completed slots', async () => {
    await reset({ startPolicy: { ...oauthStartPolicy, maxConcurrent: 2, maxConcurrentPerClient: 3 } });
    const blocked = hold(sql => sql.startsWith('INSERT INTO oauth_states'), 2);
    const pending = [start(), start()];
    await blocked.entered;
    rejected(await start());
    expect(blocked.arrivals()).toBe(2); expect(statements).toHaveLength(2);
    blocked.release();
    expect((await Promise.all(pending)).map(response => response.status)).toEqual([302, 302]);
    expect((await start()).status).toBe(302);
  });

  it('caps concurrent work per client and releases slots when a database operation fails', async () => {
    await reset({ startPolicy: { ...oauthStartPolicy, maxConcurrentPerClient: 1 } });
    const blocked = hold(sql => sql.startsWith('INSERT INTO oauth_states'), 1, true);
    const pending = start(); await blocked.entered;
    rejected(await start()); expect(statements).toHaveLength(1);
    blocked.release();
    const failure = await pending;
    expect(failure.status).toBe(500); expect(await failure.text()).toBe('Sign-in failed.');
    intercept = undefined;
    expect((await start()).status).toBe(302);
  });

  it('retains an admission slot after client disconnect until its real database work settles', async () => {
    await reset({ startPolicy: { ...oauthStartPolicy, maxConcurrent: 1 } });
    const blocked = hold(sql => sql.startsWith('INSERT INTO oauth_states'));
    const abandoned = request(`${origin}/auth/github`);
    abandoned.on('error', () => {});
    abandoned.end(); await blocked.entered;
    const closed = new Promise<void>(resolve => abandoned.once('close', resolve));
    abandoned.destroy(); await closed;
    rejected(await start()); expect(blocked.arrivals()).toBe(1);
    blocked.release(); await work.drain();
    expect((await start()).status).toBe(302);
  });

  it('allows browser-bound, one-use completion after starts are throttled', async () => {
    await reset({ startPolicy: { ...oauthStartPolicy, perClientLimit: 1 } });
    const state = await issued(); rejected(await start());
    const fetch = upstream(), before = statements.length;
    expect((await callback(state, 'ephemeral-oauth=wrong')).status).toBe(400);
    expect(statements).toHaveLength(before); expect(fetch).not.toHaveBeenCalled();
    expect((await callback(state)).status).toBe(302);
    expect((await callback(state)).status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await pg.query('SELECT hash FROM oauth_states')).rows).toHaveLength(0);
    expect((await pg.query('SELECT hash FROM browser_sessions')).rows).toHaveLength(1);
  });

  it('bounds callback DB concurrency while preserving a throttled browser state for retry', async () => {
    await reset({ callbackPolicy: { ...oauthCallbackPolicy, maxConcurrent: 1 } });
    const state = await issued(); const fetch = upstream();
    const blocked = hold(sql => sql.startsWith('DELETE FROM oauth_states WHERE hash=$1'));
    const pending = callback('unknown-state'); await blocked.entered;
    const before = statements.length;
    rejected(await callback(state)); expect(statements).toHaveLength(before); expect(fetch).not.toHaveBeenCalled();
    expect((await pg.query('SELECT hash FROM oauth_states')).rows).toHaveLength(1);
    blocked.release(); expect((await pending).status).toBe(400);
    expect((await callback(state)).status).toBe(302);
    expect((await callback(state)).status).toBe(400);
  });

  it('caps callback attempts before DB work and permits retry after its independent window', async () => {
    await reset({ callbackPolicy: { ...oauthCallbackPolicy, perClientLimit: 1 } });
    const state = await issued(); const fetch = upstream();
    expect((await callback('unknown-state')).status).toBe(400);
    const before = statements.length;
    rejected(await callback(state)); expect(statements).toHaveLength(before);
    time += oauthCallbackPolicy.windowMs;
    expect((await callback(state)).status).toBe(302); expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('releases callback slots after an upstream failure while consuming the failed state once', async () => {
    await reset({ callbackPolicy: { ...oauthCallbackPolicy, maxConcurrent: 1 } });
    const first = await issued(), second = await issued();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('synthetic private upstream failure')));
    expect((await callback(first)).status).toBe(500);
    const fetch = upstream();
    expect((await callback(first)).status).toBe(400);
    expect((await callback(second)).status).toBe(302); expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('indexes expiry and prunes bounded batches only during controlled maintenance', async () => {
    const indexes = await pg.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename IN ('oauth_states','browser_sessions')");
    expect(indexes.rows.map(row => row.indexname)).toEqual(expect.arrayContaining(['oauth_states_expiry', 'browser_sessions_expiry']));
    await pg.query("INSERT INTO oauth_states(hash,expires_at) SELECT 'expired-' || n,NOW()-INTERVAL '1 second' FROM generate_series(1,1002) n");
    await issued();
    expect(statements).toHaveLength(1);
    await auth.prune();
    expect((await pg.query('SELECT hash FROM oauth_states WHERE expires_at<NOW()')).rows).toHaveLength(2);
    expect((await pg.query('SELECT hash FROM oauth_states WHERE expires_at>NOW()')).rows).toHaveLength(1);
    await auth.prune();
    expect((await pg.query('SELECT hash FROM oauth_states')).rows).toHaveLength(1);
  });
});

it('keeps the client registry bounded across arbitrary addresses and windows with active work', () => {
  let time = 0;
  const gate = createAdmission({ ...oauthStartPolicy, maxClients: 2, maxConcurrent: 3 }, () => time);
  const first = gate.acquire('peer-one'), second = gate.acquire('peer-two');
  expect('release' in first && 'release' in second).toBe(true);
  for (let i = 0; i < 10_000; i++) expect(gate.acquire(`new-peer-${i}`)).toHaveProperty('retryAfter');
  time += oauthStartPolicy.windowMs;
  // Expired but active entries cannot be evicted to admit unbounded new peers.
  expect(gate.acquire('new-peer')).toHaveProperty('retryAfter');
  if ('release' in first) { first.release(); first.release(); }
  const next = gate.acquire('new-peer'); expect(next).toHaveProperty('release');
  if ('release' in next) next.release();
  if ('release' in second) second.release();
});
