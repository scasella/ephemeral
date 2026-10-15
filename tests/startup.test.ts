import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRepository } from '../server/core/repository.js';
import { createStartupRepository } from '../server/startup.js';
import type { Database, Session } from '../server/contracts.js';

function session(id: string, changes: Partial<Session> = {}): Session {
  return { id, userId: id, repository: 'owner/repo', repositoryId: 1, installationId: 2,
    baseBranch: 'main', branch: `ephemeral/${id}`, state: 'running',
    createdAt: new Date(Date.now() - 10_000).toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    maxExpiresAt: new Date(Date.now() + 3600_000).toISOString(), sandboxId: 'sandbox', endedAt: null, error: null,
    cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified', ...changes };
}
const asDatabase = (db: PGlite) => db as unknown as Database;

describe('durable startup timestamps', () => {
  const db = new PGlite();
  let repo: Awaited<ReturnType<typeof createSessionRepository>>, startup: Awaited<ReturnType<typeof createStartupRepository>>;
  beforeAll(async () => { repo = await createSessionRepository(asDatabase(db)); startup = await createStartupRepository(asDatabase(db)); });
  afterAll(() => db.close());

  it('requires a successful attachment before a useful response and records immutable first timestamps', async () => {
    const s = session('first'); await repo.insert(s);
    expect(await startup.recordFirstUsefulResponse(s.id)).toBe(false);
    expect(await startup.progress(s, 'live')).toMatchObject({ startedAt: s.createdAt, firstTerminalAttachedAt: null, firstUsefulResponseAt: null, timeToFirstUsefulResponseMs: null });
    expect(await startup.recordTerminalAttached(s.id)).toBe(true);
    const attached = await startup.progress(s, 'live');
    expect(attached.firstTerminalAttachedAt).toBeTruthy(); expect(attached.firstUsefulResponseAt).toBeNull();
    expect(await startup.recordFirstUsefulResponse(s.id)).toBe(true);
    const marked = await startup.progress(s, 'live');
    expect(marked.timeToFirstUsefulResponseMs).toBe(Date.parse(marked.firstUsefulResponseAt!) - Date.parse(s.createdAt));
    expect(marked.timeToFirstUsefulResponseMs).toBeGreaterThanOrEqual(10_000);
    await startup.recordTerminalAttached(s.id); await startup.recordFirstUsefulResponse(s.id);
    expect(await startup.progress(s, 'live')).toEqual(marked);
    expect(await repo.get(s.id)).toEqual(s);
  });

  it('uses current database lifecycle state instead of a stale session snapshot', async () => {
    const s = session('stopped'); await repo.insert(s); await startup.recordTerminalAttached(s.id);
    await repo.requestStop(s.id);
    expect(await startup.recordFirstUsefulResponse(s.id)).toBe(false);
    expect(await startup.recordTerminalAttached(s.id)).toBe(false);
    expect((await startup.progress(s, 'live')).firstUsefulResponseAt).toBeNull();
  });

  it('declines expired, ended, provisioning, and missing-sandbox sessions', async () => {
    const cases: Partial<Session>[] = [{ expiresAt: new Date(Date.now() - 1).toISOString() }, { state: 'ended' }, { state: 'provisioning' }, { sandboxId: null }];
    for (const [index, changes] of cases.entries()) {
      const s = session(`inactive-${index}`, changes); await repo.insert(s);
      expect(await startup.recordTerminalAttached(s.id)).toBe(false);
      expect(await startup.recordFirstUsefulResponse(s.id)).toBe(false);
    }
  });

  it('returns only timestamps and suppresses actual measurements in preview', async () => {
    const s = session('preview'); await repo.insert(s); await startup.recordTerminalAttached(s.id); await startup.recordFirstUsefulResponse(s.id);
    expect(await startup.progress(s, 'preview')).toEqual({ startedAt: s.createdAt, firstTerminalAttachedAt: null, firstUsefulResponseAt: null,
      timeToFirstUsefulResponseMs: null, measurement: 'user_reported', mode: 'preview' });
    const columns = await db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name='session_startup_metrics' ORDER BY ordinal_position");
    expect(columns.rows.map(row => row.column_name)).toEqual(['session_id', 'first_terminal_attached_at', 'first_useful_response_at']);
  });

  it('preserves concurrent first writes without changing worker leases', async () => {
    const s = session('concurrent'); await repo.insert(s); await repo.claim(s.id, 'lifecycle-owner');
    await Promise.all([startup.recordTerminalAttached(s.id), startup.recordTerminalAttached(s.id)]);
    await Promise.all([startup.recordFirstUsefulResponse(s.id), startup.recordFirstUsefulResponse(s.id)]);
    const before = await startup.progress(s, 'live');
    await repo.save({ ...s, expiresAt: new Date(Date.now() + 4000_000).toISOString() }, 'lifecycle-owner');
    await startup.recordFirstUsefulResponse(s.id);
    expect(await startup.progress(s, 'live')).toEqual(before);
  });
});

it('retains completed measurements after lifecycle updates and reopening the database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ep-startup-store-'));
  let db = new PGlite(directory);
  try {
    let repo = await createSessionRepository(asDatabase(db)); let startup = await createStartupRepository(asDatabase(db));
    const s = session('persistent'); await repo.insert(s);
    await startup.recordTerminalAttached(s.id); await startup.recordFirstUsefulResponse(s.id);
    const expected = await startup.progress(s, 'live');
    await repo.update({ ...s, state: 'ended', endedAt: new Date().toISOString() });
    await db.close(); db = new PGlite(directory);
    repo = await createSessionRepository(asDatabase(db)); startup = await createStartupRepository(asDatabase(db));
    expect(await startup.progress((await repo.get(s.id))!, 'live')).toEqual(expected);
    expect(await startup.recordFirstUsefulResponse(s.id)).toBe(false);
  } finally { await db.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
