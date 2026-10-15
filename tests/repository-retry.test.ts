import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database, RetryState, Session } from '../server/contracts.js';
import { createSessionRepository } from '../server/core/repository.js';

function session(id: string, state: Session['state'] = 'running'): Session {
  return { id, userId: id, repository: 'owner/repo', repositoryId: 1, installationId: 2,
    baseBranch: 'main', branch: `ephemeral/${id}`, state, createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), maxExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
    sandboxId: 'existing-vm', endedAt: null, error: null,
    cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified' };
}
const retry: RetryState = { attempts: 3, nextAt: '2026-10-15T12:00:00.000Z', state: 'health' };

describe('durable reconciliation repository', () => {
  const db = new PGlite();
  let repo: Awaited<ReturnType<typeof createSessionRepository>>;
  beforeAll(async () => { repo = await createSessionRepository(db as unknown as Database); });
  afterAll(async () => { await db.close(); });

  it('filters active states in SQL and creates the active partial index', async () => {
    for (const state of ['provisioning', 'running', 'cleanup_pending', 'ended', 'failed'] as const) await repo.insert(session(`list-${state}`, state));
    await repo.setLabel('list-running', 'list-running', 'Still active');
    const sql: string[] = [];
    const recording = await createSessionRepository({ query: async <T>(query: string, params?: unknown[]) => {
      sql.push(query); return db.query<T>(query, params);
    }, close: async () => {} });
    sql.length = 0;
    expect((await recording.listActive()).map(s => s.state).sort()).toEqual(['cleanup_pending', 'provisioning', 'running']);
    expect((await recording.listActive()).find(s => s.id === 'list-running')?.label).toBe('Still active');
    expect(sql.every(q => /WHERE s.state IN \('provisioning','running','cleanup_pending'\)/.test(q))).toBe(true);
    const indexes = await db.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname='ephemeral_active_sessions'");
    expect(indexes.rows[0].indexdef).toContain('WHERE');
  });

  it('fences retry writes and events by current ownership, expiry and lifecycle state', async () => {
    const initial = session('fence'); await repo.insert(initial); await repo.claim(initial.id, 'owner');
    await repo.setRetryState(initial.id, 'owner', retry);
    await expect(repo.setRetryState(initial.id, 'wrong', retry)).rejects.toThrow('lost its lease');
    await expect(repo.eventUnderLease(initial.id, 'wrong', 'health_retry', 'Temporary interruption.')).rejects.toThrow('lost its lease');
    await expect(repo.setRetryState(initial.id, 'owner', { ...retry, state: 'cleanup' })).rejects.toThrow('state changed');
    await repo.eventUnderLease(initial.id, 'owner', 'health_retry', 'Temporary interruption.', 'running');
    await db.query("UPDATE ephemeral_sessions SET lease_until=CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id=$1", [initial.id]);
    await expect(repo.setRetryState(initial.id, 'owner', null)).rejects.toThrow('lost its lease');
    await expect(repo.eventUnderLease(initial.id, 'owner', 'health_retry', 'Temporary interruption.')).rejects.toThrow('lost its lease');
    expect(await repo.getRetryState(initial.id)).toEqual(retry);
    expect(await repo.events(initial.id)).toHaveLength(1);
    await repo.claim(initial.id, 'replacement');
    await expect(repo.setRetryState(initial.id, 'owner', retry)).rejects.toThrow('lost its lease');
    await repo.requestStop(initial.id);
    await expect(repo.setRetryState(initial.id, 'replacement', retry)).rejects.toThrow('state changed');
    await expect(repo.eventUnderLease(initial.id, 'replacement', 'health_retry', 'Temporary interruption.', 'running')).rejects.toThrow('state changed');
  });

  it('explicit stop resets both health and cleanup delays while preserving session identity and labels', async () => {
    const initial = session('stop'); await repo.insert(initial); await repo.claim(initial.id, 'owner');
    await repo.setLabel(initial.id, initial.userId, 'Keep this label'); await repo.setRetryState(initial.id, 'owner', retry);
    await repo.requestStop(initial.id); expect(await repo.getRetryState(initial.id)).toBeNull();
    const cleanup = { ...retry, state: 'cleanup' as const }; await repo.setRetryState(initial.id, 'owner', cleanup);
    await repo.requestStop(initial.id); expect(await repo.getRetryState(initial.id)).toBeNull();
    expect(await repo.get(initial.id)).toEqual({ ...initial, state: 'cleanup_pending', label: 'Keep this label' });
    await expect(repo.save(initial, 'owner')).rejects.toThrow('session was stopped');
    await repo.save({ ...initial, state: 'ended' }, 'owner'); await repo.requestStop(initial.id);
    expect((await repo.get(initial.id))?.state).toBe('ended');
    expect(await repo.getRetryState('missing')).toBeNull();
  });
});

it('persists reconciliation delay after closing and reopening the database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ep-retry-'));
  let db = new PGlite(directory);
  try {
    let repo = await createSessionRepository(db as unknown as Database);
    await repo.insert(session('restart')); await repo.claim('restart', 'owner'); await repo.setRetryState('restart', 'owner', retry);
    await repo.release('restart', 'owner'); await db.close(); db = new PGlite(directory);
    repo = await createSessionRepository(db as unknown as Database);
    expect(await repo.getRetryState('restart')).toEqual(retry);
    await repo.claim('restart', 'new-owner'); await repo.setRetryState('restart', 'new-owner', null);
    expect(await repo.getRetryState('restart')).toBeNull();
  } finally { await db.close(); await rm(directory, { recursive: true, force: true }); }
});
