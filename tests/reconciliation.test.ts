import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database, GatewayCredentials, SandboxProvider, Session } from '../server/contracts.js';
import { createSessionRepository, type DurableSessionRepository } from '../server/core/repository.js';
import { SessionManager } from '../server/core/lifecycle.js';
import { nextRetry } from '../server/core/reconciliation.js';

const managers: SessionManager[] = [];
const databases = new Set<PGlite>();
const directories: string[] = [];
const start = Date.parse('2026-10-15T12:00:00Z');
function session(id: string, state: Session['state'] = 'running'): Session {
  return { id, userId: id, repository: 'alice/project', repositoryId: 1, installationId: 2, baseBranch: 'main', branch: `ephemeral/${id}`, state,
    createdAt: new Date(start).toISOString(), expiresAt: new Date(start + 3_600_000).toISOString(), maxExpiresAt: new Date(start + 14_400_000).toISOString(),
    sandboxId: `vm-${id}`, endedAt: null, error: null, cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified' };
}
function provider() {
  const live = new Set<string>();
  return { live, create: vi.fn(async () => 'unused'), prepare: vi.fn(async () => {}), setTimeout: vi.fn(async () => {}),
    kill: vi.fn(async (id: string) => { live.delete(id); }), exists: vi.fn(async (id: string) => live.has(id)), cleanupCodex: vi.fn(async () => true),
    discover: vi.fn(async (_id: string): Promise<string[]> => []), connectTerminal: vi.fn(async () => ({ write: async () => {}, resize: async () => {}, disconnect: async () => {} })) } satisfies SandboxProvider & { live: Set<string>; discover(id: string): Promise<string[]> };
}
function credentials(): GatewayCredentials {
  return { issue: vi.fn(async () => 'unused'), disable: vi.fn(async () => {}), revokeGitHub: vi.fn(async () => {}) };
}
async function open(path?: string) {
  const db = new PGlite(path); databases.add(db);
  const adapter: Database = { query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await db.query<T>(sql, params)).rows }), close: () => db.close() };
  return { db, repo: await createSessionRepository(adapter) };
}
function manager(repo: DurableSessionRepository, fake = provider(), creds = credentials(), clock = { now: start }) {
  const service = new SessionManager(repo, fake, creds, { now: () => clock.now }); managers.push(service);
  return { service, fake, creds, clock };
}
async function drain(service: SessionManager) {
  // Wait for worker lease release as well as the last observable state write.
  await Promise.allSettled([...((service as unknown as { tasks: Map<string, Promise<void>> }).tasks.values())]);
}
afterEach(async () => {
  for (const service of managers.splice(0)) await service.shutdown();
  for (const db of databases) await db.close();
  databases.clear();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('durable automatic reconciliation retries', () => {
  it('backs off failed probes, caps delay, stays quiet, resets on success, and permits extension while deferred', async () => {
    const { repo } = await open();
    const { service, fake, clock } = manager(repo);
    await repo.insert(session('health'));
    fake.exists.mockRejectedValue(new Error('Bearer private-provider-secret'));
    for (const [index, delay] of [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000].entries()) {
      await service.reconcile(); await drain(service);
      const retry = (await repo.getRetryState('health'))!;
      expect(retry).toEqual({ state: 'health', attempts: index + 1, nextAt: new Date(clock.now + delay).toISOString() });
      const calls = fake.exists.mock.calls.length;
      for (let i = 0; i < 5; i++) await service.reconcile();
      await drain(service);
      expect(fake.exists).toHaveBeenCalledTimes(calls);
      expect(await repo.events('health')).toEqual([]);
      clock.now += delay;
    }
    // Skipping a deferred health check must not create an in-process task.
    clock.now -= 1;
    await service.reconcile();
    await expect(service.extend('health', 1)).resolves.toMatchObject({ state: 'running' });
    fake.exists.mockResolvedValue(true); clock.now += 1;
    await service.reconcile(); await drain(service);
    expect(await repo.getRetryState('health')).toBeNull();
    fake.exists.mockRejectedValue(new Error('provider-secret'));
    await service.reconcile(); await drain(service);
    expect(await repo.getRetryState('health')).toMatchObject({ attempts: 1 });
    expect(JSON.stringify(await repo.events('health'))).not.toContain('provider-secret');
  });

  it('retains health and cleanup retries across a real PGlite close and reopen', async () => {
    const path = await mkdtemp(join(tmpdir(), 'ephemeral-reconcile-')); directories.push(path);
    const first = await open(path);
    const fake = provider(), clock = { now: start };
    fake.exists.mockRejectedValue(new Error('network unavailable'));
    fake.discover.mockRejectedValue(new Error('network unavailable'));
    const initial = manager(first.repo, fake, credentials(), clock).service;
    await first.repo.insert(session('restart'));
    await first.repo.insert(session('cleanup-restart', 'cleanup_pending'));
    await initial.reconcile(); await drain(initial); await initial.shutdown();
    const retry = await first.repo.getRetryState('restart');
    const cleanupRetry = await first.repo.getRetryState('cleanup-restart');
    await first.db.close(); databases.delete(first.db);
    const second = await open(path);
    const restarted = manager(second.repo, fake, credentials(), clock).service;
    await restarted.reconcile(); await drain(restarted);
    expect(fake.exists).toHaveBeenCalledTimes(1);
    expect(await second.repo.getRetryState('restart')).toEqual(retry);
    expect(await second.repo.getRetryState('cleanup-restart')).toEqual(cleanupRetry);
    expect(fake.discover).toHaveBeenCalledTimes(1);
    clock.now += 5_000;
    await restarted.reconcile(); await drain(restarted);
    expect(fake.exists).toHaveBeenCalledTimes(2);
    expect(await second.repo.getRetryState('restart')).toMatchObject({ attempts: 2 });
    expect(await second.repo.getRetryState('cleanup-restart')).toMatchObject({ attempts: 2 });
    expect(fake.discover).toHaveBeenCalledTimes(2);
    expect((await second.repo.events('cleanup-restart')).filter(event => event.kind === 'cleanup_retry')).toHaveLength(1);
  });

  it('tries independent cleanup phases, persists incomplete retries, and bounds cleanup events', async () => {
    const { repo } = await open();
    const { service, fake, creds, clock } = manager(repo);
    await repo.insert(session('cleanup', 'cleanup_pending'));
    fake.live.add('vm-cleanup'); fake.kill.mockImplementation(async () => {});
    fake.cleanupCodex.mockResolvedValue(false);
    vi.mocked(creds.revokeGitHub).mockRejectedValue(new Error('private credential error'));
    await service.reconcile(); await drain(service);
    expect(creds.disable).toHaveBeenCalledTimes(1);
    expect(creds.revokeGitHub).toHaveBeenCalledTimes(1);
    expect(fake.kill).toHaveBeenCalledTimes(1);
    expect((await repo.get('cleanup'))?.cleanup).toEqual({ gateway: 'confirmed', github: 'failed', vm: 'pending', codex: 'failed' });
    await service.reconcile(); await drain(service);
    expect(fake.kill).toHaveBeenCalledTimes(1);
    clock.now += 5_000;
    await service.reconcile(); await drain(service);
    expect(fake.kill).toHaveBeenCalledTimes(2);
    expect(creds.disable).toHaveBeenCalledTimes(1);
    // Events can share a timestamp; UUID ordering does not imply insertion order.
    expect((await repo.events('cleanup')).map(event => event.kind).sort()).toEqual(['cleanup_retry', 'codex_logout_unconfirmed']);
    expect(await repo.getRetryState('cleanup')).toMatchObject({ attempts: 2, state: 'cleanup' });
    fake.kill.mockImplementation(async id => { fake.live.delete(id); });
    vi.mocked(creds.revokeGitHub).mockResolvedValue();
    // An explicit cleanup retry ignores the ten-second automatic delay.
    await service.retryCleanup('cleanup'); await drain(service);
    expect((await repo.get('cleanup'))?.state).toBe('ended');
    expect(await repo.getRetryState('cleanup')).toBeNull();
    expect(JSON.stringify(await repo.events('cleanup'))).not.toContain('credential error');
  });

  it('lets explicit stop and operator reconciliation bypass cleanup backoff', async () => {
    const { repo } = await open();
    const { service, fake, creds } = manager(repo);
    await repo.insert(session('operator', 'cleanup_pending'));
    fake.discover.mockRejectedValue(new Error('unavailable'));
    await service.reconcile(); await drain(service);
    expect(await repo.getRetryState('operator')).toMatchObject({ attempts: 1 });
    await service.reconcileOne('operator');
    expect(fake.discover).toHaveBeenCalledTimes(2);
    expect(await repo.getRetryState('operator')).toMatchObject({ attempts: 2 });
    fake.discover.mockResolvedValue([]);
    await service.stop('operator');
    expect(creds.disable).toHaveBeenCalledTimes(2); // Initial phase and immediate explicit stop.
    await drain(service);
    expect((await repo.get('operator'))?.state).toBe('ended');
    expect(await repo.getRetryState('operator')).toBeNull();
  });

  it('expires a running session immediately during health backoff', async () => {
    const { repo } = await open();
    const { service, fake, creds, clock } = manager(repo);
    const current = session('expired'); current.expiresAt = new Date(start + 1_000).toISOString();
    await repo.insert(current);
    fake.exists.mockRejectedValue(new Error('unavailable'));
    await service.reconcile(); await drain(service);
    expect(await repo.getRetryState('expired')).toMatchObject({ nextAt: new Date(start + 5_000).toISOString() });
    clock.now += 1_001;
    fake.exists.mockResolvedValue(false);
    await service.reconcile();
    expect(creds.disable).toHaveBeenCalled();
    await drain(service);
    expect((await repo.get('expired'))?.state).toBe('ended');
    expect(await repo.getRetryState('expired')).toBeNull();
  });

  it('disables an expired session while its health probe is still in flight', async () => {
    const { repo } = await open();
    const { service, fake, creds, clock } = manager(repo);
    const current = session('held'); current.expiresAt = new Date(start + 1_000).toISOString();
    await repo.insert(current); fake.live.add('vm-held');
    let release!: (exists: boolean) => void;
    fake.exists.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve; }));
    await service.reconcile();
    for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(release).toBeDefined();
    clock.now += 1_001;
    await service.reconcile();
    expect((await repo.get('held'))?.state).toBe('cleanup_pending');
    expect(creds.disable).toHaveBeenCalledTimes(1);
    release(true); await drain(service);
    expect((await repo.get('held'))?.state).toBe('ended');
    expect(await repo.getRetryState('held')).toBeNull();
    expect(fake.kill).toHaveBeenCalledTimes(1);
  });

  it('isolates failing sessions and never lists historical sessions for reconciliation', async () => {
    const { repo } = await open();
    const { service, fake } = manager(repo);
    await repo.insert(session('bad')); await repo.insert(session('good'));
    await repo.insert(session('historical-ended', 'ended')); await repo.insert(session('historical-failed', 'failed'));
    const list = vi.spyOn(repo, 'list');
    fake.exists.mockImplementation(async id => { if (id === 'vm-bad') throw new Error('network'); return true; });
    await service.reconcile(); await drain(service);
    await service.reconcile(); await drain(service);
    expect(list).not.toHaveBeenCalled();
    expect(fake.exists.mock.calls.map(([id]) => id).sort()).toEqual(['vm-bad', 'vm-good', 'vm-good']);
    expect(await repo.getRetryState('bad')).toMatchObject({ attempts: 1 });
    expect(await repo.getRetryState('good')).toBeNull();
  });

  it('does not write retry state or events after a worker loses its lease', async () => {
    const { repo, db } = await open();
    const { service, fake } = manager(repo);
    await repo.insert(session('lease'));
    let rejectProbe!: (error: Error) => void;
    fake.exists.mockImplementation(() => new Promise<boolean>((_resolve, reject) => { rejectProbe = reject; }));
    await service.reconcile();
    for (let i = 0; i < 100 && !rejectProbe; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(rejectProbe).toBeDefined();
    await db.query("UPDATE ephemeral_sessions SET lease_until=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id='lease'");
    expect(await repo.claim('lease', 'replacement-worker')).toBe(true);
    rejectProbe(new Error('private SDK error')); await drain(service);
    expect(await repo.getRetryState('lease')).toBeNull();
    expect(await repo.events('lease')).toEqual([]);
    await repo.release('lease', 'replacement-worker');
    await service.shutdown();
    const calls = fake.exists.mock.calls.length;
    await service.reconcile();
    expect(fake.exists).toHaveBeenCalledTimes(calls);
    expect((await repo.get('lease'))?.state).toBe('running');
  });

  it('saturates retry counters as well as retry delay', () => {
    let retry = null;
    for (let i = 0; i < 100; i++) retry = nextRetry(retry, 'health', start);
    expect(retry).toEqual({ state: 'health', attempts: 32, nextAt: new Date(start + 300_000).toISOString() });
  });
});
