import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { createApplication } from '../server/app.js';
import { createLiveApplication } from './helpers/create-live-application.js';
import { readConfig } from '../server/config.js';
import { digest, seal } from '../server/auth/crypto.js';
import type { Session, SessionEventPage } from '../server/contracts.js';

const operations = vi.hoisted(() => ({ issue: vi.fn(async () => 'unused-token'), create: vi.fn(async () => 'unused-vm') }));
vi.mock('../server/github/index.js', async () => {
  const { Router } = await import('express'); const { previewCredentials } = await import('../server/preview.js');
  return { createGitHubServices: async () => ({ router: Router(), credentials: { ...previewCredentials, issue: operations.issue }, close: async () => {} }) };
});
vi.mock('../server/infra/e2b.js', async () => {
  const { PreviewProvider } = await import('../server/preview.js');
  return { E2BProvider: class extends PreviewProvider { create = operations.create; } };
});
const key = Buffer.alloc(32, 1).toString('base64');
const headers = { Cookie: 'ephemeral=activity-owner' };

describe('Activity HTTP ownership and bounded historical pagination', () => {
  let application: Awaited<ReturnType<typeof createApplication>>, directory: string, origin: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ep-activity-http-'));
    const config = readConfig({ EPHEMERAL_MODE: 'preview', DATA_DIR: directory, PUBLIC_URL: 'http://localhost:4329', ENCRYPTION_KEY: key, ALLOWED_GITHUB_IDS: '42,99' });
    application = await createLiveApplication({ ...config, mode: 'live' });
    await new Promise<void>((resolve, reject) => {
      application.server.once('error', reject);
      application.server.listen(0, '127.0.0.1', () => { application.server.off('error', reject); resolve(); });
    });
    const address = application.server.address(); if (!address || typeof address === 'string') throw new Error('No server address');
    origin = `http://127.0.0.1:${address.port}`;
    for (const [cookie, expires] of [['activity-owner', Date.now() + 3600_000], ['activity-expired', Date.now() - 1]] as const) {
      await application.db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
        [digest(cookie), '42', 'owner', '', seal('SYNTHETIC-CREDENTIAL', key), new Date(expires).toISOString()]);
    }
  }, 30_000);
  afterAll(async () => { await application?.close(); if (directory) await rm(directory, { recursive: true, force: true }); }, 30_000);
  async function insert(count = 0, userId = '42') {
    const id = randomUUID(), now = new Date().toISOString();
    const session: Session = { id, userId, repository: 'owner/repo', repositoryId: 1, installationId: 2,
      baseBranch: 'main', branch: `ephemeral/${id}`, state: 'ended', createdAt: now,
      expiresAt: now, maxExpiresAt: now, sandboxId: null, endedAt: now, error: null,
      cleanup: { vm: 'not_applicable', github: 'not_applicable', gateway: 'not_applicable', codex: 'not_applicable' }, codexRemoteRevocation: 'unverified' };
    await application.repo.insert(session);
    // Historical events remain available beyond the lifecycle startup horizon.
    // Distinct microseconds within a single JS millisecond exercise precise cursor boundaries.
    if (count) await application.db.query(`INSERT INTO ephemeral_session_events(id,session_id,at,kind,message)
      SELECT $1 || '-' || lpad(number::text,4,'0'), $1, '2000-01-01T00:00:00Z'::timestamptz + number * interval '1 microsecond', 'fixture_event', 'Historical event ' || number
      FROM generate_series(1,$2::integer) number`, [id, count]);
    return session;
  }
  const get = (id: string, query = '', extra: Record<string, string> = {}) => fetch(`${origin}/api/sessions/${id}/events${query}`, { headers: { ...headers, ...extra } });
  async function read(id: string, query = ''): Promise<SessionEventPage> {
    const response = await get(id, query); expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    return response.json();
  }

  it('authorizes before validating cursors and hides foreign or missing sessions', async () => {
    const owned = await insert(2), foreign = await insert(2, '99');
    const cursor = (await read(owned.id, '?limit=1')).nextCursor!;
    for (const query of ['', '?limit=bad&before=bad', `?before=${cursor}`]) {
      expect((await get(foreign.id, query)).status).toBe(404);
      expect((await get(randomUUID(), query)).status).toBe(404);
      expect((await get(owned.id, query, { Cookie: '' })).status).toBe(401);
      expect((await get(owned.id, query, { Cookie: 'ephemeral=activity-expired' })).status).toBe(401);
    }
    const otherOwned = await insert(1);
    const wrongSession = await get(otherOwned.id, `?before=${cursor}`);
    expect(wrongSession.status).toBe(400); expect(await wrongSession.json()).toEqual({ error: 'Invalid session event pagination.' });
  });
  it('rejects unknown, repeated, noninteger, out-of-range and oversized query values with fixed errors', async () => {
    const session = await insert(2);
    const cursor = (await read(session.id, '?limit=1')).nextCursor!;
    for (const query of ['?limit=', '?limit=0', '?limit=-1', '?limit=101', '?limit=1.5', '?limit=1e2', '?limit=NaN', '?limit=%201', '?limit=01', '?limit=Infinity', '?limit=1&limit=2', '?limit[]=1', '?all=true', '?before=', '?before=not-a-cursor', '?before=%00', `?before=${'a'.repeat(2049)}`, `?limit=${'9'.repeat(2000)}`, `?before=${cursor}&before=${cursor}`]) {
      const response = await get(session.id, query);
      expect(response.status, query.slice(0, 100)).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid session event pagination.' });
    }
  });
  it('returns only the latest 50 by default, allows at most 100, and keeps each page chronological', async () => {
    const session = await insert(205);
    const defaultPage = await read(session.id);
    expect(Object.keys(defaultPage).sort()).toEqual(['events', 'nextCursor']);
    expect(defaultPage.events).toHaveLength(50); expect(defaultPage.nextCursor).toEqual(expect.any(String));
    expect(defaultPage.events[0]).toMatchObject({ id: `${session.id}-0156`, sessionId: session.id, message: 'Historical event 156' });
    expect(defaultPage.events.at(-1)?.id).toBe(`${session.id}-0205`);
    const large = await read(session.id, '?limit=100');
    expect(large.events).toHaveLength(100); expect(large.events[0].id).toBe(`${session.id}-0106`);
    expect((await read(session.id, '?limit=1')).events.map(event => event.id)).toEqual([`${session.id}-0205`]);
  });
  it('reaches all historical events without skips or repeats despite equal displayed milliseconds and new inserts', async () => {
    const session = await insert(205);
    let page = await read(session.id, '?limit=17');
    const newestPage = page.events, ids = page.events.map(event => event.id);
    // A new latest event must not shift an existing cursor into duplicate or skipped history.
    await application.repo.event(session.id, 'new_event', 'Arrived during browsing');
    for (let pages = 0; page.nextCursor && pages < 20; pages++) {
      page = await read(session.id, `?limit=17&before=${encodeURIComponent(page.nextCursor)}`);
      expect(page.events.length).toBeLessThanOrEqual(17);
      const ordered = [...page.events].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
      expect(page.events).toEqual(ordered);
      ids.push(...page.events.map(event => event.id));
    }
    expect(page.nextCursor).toBeNull(); expect(ids).toHaveLength(205); expect(new Set(ids).size).toBe(205);
    expect([...ids].sort()).toEqual(Array.from({ length: 205 }, (_, index) => `${session.id}-${String(index + 1).padStart(4, '0')}`));
    expect(newestPage[0].at).toBe('2000-01-01T00:00:00.000189Z');
    expect((await read(session.id)).events.at(-1)?.message).toBe('Arrived during browsing');
  });
  it('reports an accepted empty log and final page without a cursor or external operations', async () => {
    const empty = await insert(); expect(await read(empty.id)).toEqual({ events: [], nextCursor: null });
    const one = await insert(1), page = await read(one.id);
    expect(page.events).toHaveLength(1); expect(page.nextCursor).toBeNull();
    expect(operations.issue).not.toHaveBeenCalled(); expect(operations.create).not.toHaveBeenCalled();
  });
});
