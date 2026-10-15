import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Database, Session } from '../server/contracts.js';
import { createSessionRepository } from '../server/core/repository.js';

function session(id = 'labeled-session'): Session {
  const now = new Date().toISOString();
  return { id, userId: 'owner', repository: 'owner/repo', repositoryId: 1, installationId: 2,
    baseBranch: 'main', branch: `ephemeral/${id}`, state: 'running', createdAt: now,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), maxExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
    sandboxId: 'existing-vm', endedAt: null, error: null,
    cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified' };
}

describe('durable session labels', () => {
  it('keeps label changes independent of stale lifecycle saves, updates, and stop requests', async () => {
    const db = new PGlite();
    try {
      const repo = await createSessionRepository(db as unknown as Database), initial = session();
      await repo.insert(initial); expect(await repo.get(initial.id)).not.toHaveProperty('label');
      const stale = (await repo.get(initial.id))!;
      expect(await repo.claim(initial.id, 'worker')).toBe(true);
      expect(await repo.setLabel(initial.id, 'owner', 'Investigate checkout')).toMatchObject({ label: 'Investigate checkout' });
      await repo.save({ ...stale, error: 'Progress from lifecycle' }, 'worker');
      expect(await repo.get(initial.id)).toMatchObject({ label: 'Investigate checkout', error: 'Progress from lifecycle' });
      const staleWithLabel = (await repo.get(initial.id))!;
      await repo.setLabel(initial.id, 'owner', 'Fix checkout');
      await repo.requestStop(initial.id);
      await repo.save({ ...staleWithLabel, state: 'ended', endedAt: new Date().toISOString() }, 'worker');
      expect(await repo.get(initial.id)).toMatchObject({ label: 'Fix checkout', state: 'ended', error: 'Progress from lifecycle' });
      // Renaming cannot overwrite the latest lifecycle snapshot either.
      expect(await repo.setLabel(initial.id, 'owner', 'Checkout complete')).toMatchObject({ label: 'Checkout complete', state: 'ended' });
      await repo.setLabel(initial.id, 'owner', '');
      await repo.update({ ...staleWithLabel, state: 'ended' });
      expect(await repo.get(initial.id)).not.toHaveProperty('label');
      expect((await repo.list('owner'))[0]).not.toHaveProperty('label');
      expect(await repo.setLabel(initial.id, 'someone-else', 'Forbidden')).toBeNull();
      expect(await repo.setLabel('missing', 'owner', 'Missing')).toBeNull();
      expect(await repo.get(initial.id)).not.toHaveProperty('label');
    } finally { await db.close(); }
  });

  it('enriches old sessions without metadata rows and persists labels after reopening the database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ep-session-labels-'));
    let db = new PGlite(directory);
    try {
      let repo = await createSessionRepository(db as unknown as Database);
      const legacy = { ...session('legacy'), state: 'ended' as const };
      await db.query('INSERT INTO ephemeral_sessions(id,user_id,state,data) VALUES($1,$2,$3,$4::jsonb)',
        [legacy.id, legacy.userId, legacy.state, JSON.stringify(legacy)]);
      expect(await repo.get(legacy.id)).toEqual(legacy);
      await repo.setLabel(legacy.id, legacy.userId, 'Published checkout fix');
      await repo.insert({ ...session('other-owner'), userId: 'other', state: 'ended', label: 'Other task' });
      await db.close(); db = new PGlite(directory);
      repo = await createSessionRepository(db as unknown as Database);
      expect(await repo.get(legacy.id)).toEqual({ ...legacy, label: 'Published checkout fix' });
      expect(await repo.list('owner')).toEqual([{ ...legacy, label: 'Published checkout fix' }]);
      expect(await repo.list()).toHaveLength(2);
      await repo.setLabel(legacy.id, legacy.userId, '');
      await db.close(); db = new PGlite(directory);
      repo = await createSessionRepository(db as unknown as Database);
      expect(await repo.get(legacy.id)).toEqual(legacy);
      expect((await repo.list('other'))[0]).toMatchObject({ label: 'Other task' });
    } finally { await db.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
