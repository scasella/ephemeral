import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database, Session } from '../server/contracts.js';
import { createSessionRepository } from '../server/core/repository.js';
import { encodeSessionEventCursor, parseSessionEventPageOptions, SessionEventPageError } from '../server/core/session-events.js';

function session(id: string): Session {
  return { id, userId: id, repository: 'owner/repo', repositoryId: 1, installationId: 2,
    baseBranch: 'main', branch: `ephemeral/${id}`, state: 'ended', createdAt: '2026-10-14T00:00:00.000Z',
    expiresAt: '2026-10-14T01:00:00.000Z', maxExpiresAt: '2026-10-14T04:00:00.000Z', sandboxId: null,
    endedAt: '2026-10-14T00:30:00.000Z', error: null,
    cleanup: { vm: 'confirmed', github: 'confirmed', gateway: 'confirmed', codex: 'confirmed' }, codexRemoteRevocation: 'unverified' };
}

describe('bounded session event pages', () => {
  const db = new PGlite();
  let repo: Awaited<ReturnType<typeof createSessionRepository>>;
  beforeAll(async () => { repo = await createSessionRepository(db as unknown as Database); });
  afterAll(async () => { await db.close(); });
  async function seed(id: string, count: number) {
    await repo.insert(session(id));
    await db.query(`INSERT INTO ephemeral_session_events(id,session_id,at,kind,message)
      SELECT $1 || '-' || lpad(n::text,4,'0'),$1,
        '2026-10-14T00:00:00.123000Z'::timestamptz + (n / 3) * INTERVAL '1 microsecond','test',n::text
      FROM generate_series(1,$2::integer) n`, [id, count]);
  }

  it('walks hundreds of tied microsecond timestamps once, with chronological pages and concurrent inserts', async () => {
    await seed('walk', 241);
    const first = await repo.eventPage('walk', { limit: 17 });
    expect(first.events).toHaveLength(17);
    expect(first.events.map(e => e.message)).toEqual(Array.from({ length: 17 }, (_, i) => String(225 + i)));
    const payload = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString());
    expect(payload).toMatchObject({ version: 1, sessionId: 'walk', at: '2026-10-14T00:00:00.123075Z', id: 'walk-0225' });
    await db.query(`INSERT INTO ephemeral_session_events(id,session_id,at,kind,message)
      VALUES ('walk-new','walk','2026-10-15T00:00:00Z','test','new')`);
    const messages = [...first.events.map(e => e.message)];
    let before = first.nextCursor;
    while (before) {
      const page = await repo.eventPage('walk', { limit: 17, before });
      const values = page.events.map(e => Number(e.message));
      expect(values).toEqual([...values].sort((a, b) => a - b));
      messages.push(...page.events.map(e => e.message)); before = page.nextCursor;
    }
    expect(messages).toHaveLength(241);
    expect(new Set(messages).size).toBe(241);
    expect(messages.map(Number).sort((a, b) => a - b)).toEqual(Array.from({ length: 241 }, (_, i) => i + 1));
    expect((await repo.eventPage('walk')).events.at(-1)?.message).toBe('new');
  });

  it('handles empty, exact-limit, default and capped legacy pages without changing retention or labels', async () => {
    await seed('empty', 0); expect(await repo.eventPage('empty')).toEqual({ events: [], nextCursor: null });
    await seed('exact', 50);
    const exact = await repo.eventPage('exact'); expect(exact.events).toHaveLength(50); expect(exact.nextCursor).toBeNull();
    await seed('cap', 130); await repo.setLabel('cap', 'cap', 'Keep my label');
    expect((await repo.eventPage('cap')).events).toHaveLength(50);
    const capped = await repo.eventPage('cap', { limit: 100 });
    expect(capped.events).toHaveLength(100); expect(capped.nextCursor).toBeTruthy();
    expect(await repo.events('cap')).toEqual(capped.events);
    expect((await repo.get('cap'))).toMatchObject({ state: 'ended', label: 'Keep my label' });
    expect((await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM ephemeral_session_events WHERE session_id=$1', ['cap'])).rows[0].count).toBe(130);
  });

  it('rejects malformed, oversized, cross-session and invalid-calendar cursors before issuing a page query', async () => {
    const valid = encodeSessionEventCursor('cap', '2026-10-14T00:00:00.123001Z', 'cap-0001');
    const malformed = [null, '', '***', [], 'a'.repeat(2049), `${valid}=`,
      encodeSessionEventCursor('other', '2026-10-14T00:00:00.123001Z', 'cap-0001'),
      encodeSessionEventCursor('cap', '2026-02-30T00:00:00.123001Z', 'cap-0001'),
      encodeSessionEventCursor('cap', '0000-10-14T00:00:00.123001Z', 'cap-0001'),
      encodeSessionEventCursor('cap', '2026-10-14T00:00:00.123001Z', '\ud800'),
      Buffer.concat([Buffer.from('{"bad":"'), Buffer.from([0xff]), Buffer.from('"}')]).toString('base64url'),
      Buffer.from(JSON.stringify({ version: 2, sessionId: 'cap', at: '2026-10-14T00:00:00.123001Z', id: 'cap-0001' })).toString('base64url')];
    for (const before of malformed) {
      await expect(repo.eventPage('cap', { before: before as string })).rejects.toMatchObject({ status: 400, message: 'Invalid session event pagination.' });
    }
    for (const limit of [0, -1, 101, 1.5, NaN, Infinity, null, '', '1e2', '050', [], {}]) {
      expect(() => parseSessionEventPageOptions({ limit }, 'cap')).toThrow(SessionEventPageError);
    }
    expect(parseSessionEventPageOptions({ limit: '100', before: valid }, 'cap')).toEqual({ limit: 100, before: valid });
    expect(parseSessionEventPageOptions({}, 'cap')).toEqual({ limit: 50 });
    await expect(repo.eventPage('cap', { limit: 101 })).rejects.toBeInstanceOf(SessionEventPageError);
  });
});
