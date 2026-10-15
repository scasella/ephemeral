import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import type { Database, SandboxProvider, Session } from '../server/contracts.js';
import { openDatabase } from '../server/db.js';
import { createSessionRepository } from '../server/core/repository.js';
import { SessionManager } from '../server/core/lifecycle.js';
import { CredentialStore } from '../server/github/store.js';
import { GitHubAPI } from '../server/github/api.js';
import { disableRecoveryGateway, inspectRecovery, migrateRecoveryAudit, reconcileRecovery, type RecoveryContext } from '../server/operator-recovery.js';
import { runSessionRecovery } from '../scripts/session-recovery.js';

const directories: string[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const close of closes.splice(0)) await close();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
function session(state: Session['state'] = 'cleanup_pending'): Session {
  const id = randomUUID();
  return { id, userId: id, repository: 'fixture/test', repositoryId: 1, installationId: 2, baseBranch: 'main', branch: `ephemeral/${id}`,
    state, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), maxExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    sandboxId: `vm-${id}`, endedAt: null, error: null, cleanup: { vm: 'pending', gateway: 'pending', github: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified' };
}
function syntheticProvider() {
  return {
    create: vi.fn(async () => { throw new Error('must not create'); }), prepare: vi.fn(async () => {}), setTimeout: vi.fn(async () => {}),
    exists: vi.fn(async (_id: string) => false), discover: vi.fn(async (_id: string): Promise<string[]> => []), kill: vi.fn(async (_id: string) => {}),
    cleanupCodex: vi.fn(async () => true), connectTerminal: vi.fn(async () => { throw new Error('must not connect'); }),
  } satisfies SandboxProvider & { discover(id: string): Promise<string[]> };
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ephemeral-operator-')); directories.push(dir);
  const db = await openDatabase(undefined, join(dir, 'live')); closes.push(() => db.close());
  const repo = await createSessionRepository(db);
  const store = new CredentialStore(db, Buffer.alloc(32), new GitHubAPI('', '', ''));
  await store.migrate(); await migrateRecoveryAudit(db);
  return { dir, db, repo, store };
}
function output() {
  const out: string[] = [], err: string[] = [];
  return { out, err, stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) };
}

describe('restricted operator recovery', () => {
  it('passes env-file PostgreSQL credentials and TLS defaults to the real pg parser without changing the inherited environment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ephemeral-operator-pg-')); directories.push(dir);
    const filename = join(dir, 'operator.env');
    const selectedPassword = 'selected#/?%@:+!';
    await writeFile(filename, `DATABASE_URL=postgresql://selected@database.invalid:5433/selected\nPGPASSWORD='${selectedPassword}'\nPGSSLMODE=verify-full\nPGSSLNEGOTIATION=direct\n`, { mode: 0o600 });
    vi.stubEnv('PGPASSWORD', 'inherited-password');
    vi.stubEnv('PGSSLMODE', 'disable');
    vi.stubEnv('PGSSLNEGOTIATION', 'postgres');
    let client: pg.Client | undefined;
    const pool = vi.spyOn(pg, 'Pool').mockImplementation(function (config) {
      client = new pg.Client(config);
      // Stop at acquisition: this fixture never contacts a database/provider.
      return { on() {}, connect: async () => { throw new Error('synthetic acquisition refusal'); }, end: async () => {} } as unknown as pg.Pool;
    });
    const io = output();
    expect(await runSessionRecovery(['inspect', '--session', randomUUID(), '--env-file', filename], { env: { ...process.env }, ...io })).toBe(1);
    expect(pool).toHaveBeenCalledTimes(1);
    expect(client).toMatchObject({ password: selectedPassword, user: 'selected', host: 'database.invalid', port: 5433, database: 'selected', ssl: true });
    expect(pool.mock.calls[0][0]).toMatchObject({ sslnegotiation: 'direct' });
    expect(process.env).toMatchObject({ PGPASSWORD: 'inherited-password', PGSSLMODE: 'disable', PGSSLNEGOTIATION: 'postgres' });
    expect(io.out).toEqual([]); expect(io.err.join('')).toBe('{"error":"ownership_unavailable"}\n');
    expect(io.err.join('')).not.toContain(selectedPassword);
  });

  it('runs offline CLI inspection against an existing PGlite database with no provider configuration or secret output', async () => {
    const f = await fixture(); const target = session();
    target.error = 'ghp_private_upstream_error'; target.label = 'private label'; target.sandboxId = 'ghp_hidden_token';
    await f.repo.insert(target);
    await f.repo.claim(target.id, 'legacy-fixture');
    await f.repo.markCreation(target.id, 'legacy-fixture', new Date(Date.now() + 60_000).toISOString());
    await f.repo.release(target.id, 'legacy-fixture');
    await f.db.query(`INSERT INTO github_token_issuance(session_id,uncertainty_until) VALUES($1,$2)`, [target.id, new Date(Date.now() + 60_000).toISOString()]);
    await f.db.query(`INSERT INTO github_installation_tokens(id,session_id,ciphertext,expires_at,status) VALUES($1,$2,$3,$4,'active')`, [randomUUID(), target.id, 'private-ciphertext', new Date(Date.now() + 60_000).toISOString()]);
    await f.db.close();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no cloud requests'));
    const io = output();
    expect(await runSessionRecovery(['inspect', '--session', target.id], { env: { DATA_DIR: f.dir, NODE_ENV: 'production', E2B_API_KEY: 'e2b_private_config' }, ...io })).toBe(0);
    const text = io.out.join('');
    expect(text).not.toMatch(/ghp_|private|ciphertext|token_hash|authorization|encryption/i);
    expect(JSON.parse(text)).toMatchObject({ sessionId: target.id, state: 'cleanup_pending', knownSandboxIds: [], codexRemoteRevocation: 'unverified', blockers: expect.arrayContaining(['github_issuance_uncertain', 'legacy_sandbox_creation_uncertain']) });
    expect(fetch).not.toHaveBeenCalled(); expect(io.err).toEqual([]);
    const child = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/session-recovery.ts', 'inspect', '--session', target.id], {
      cwd: resolve('.'), env: { PATH: process.env.PATH, DATA_DIR: f.dir }, encoding: 'utf8', timeout: 15_000,
    });
    expect(JSON.parse(child).sessionId).toBe(target.id);
  });

  it('refuses a live owner, second operator, and stale lock without removing ownership', async () => {
    const f = await fixture(); const target = session(); await f.repo.insert(target);
    const io = output();
    expect(await runSessionRecovery(['inspect', '--session', target.id], { env: { DATA_DIR: f.dir }, ...io })).toBe(1);
    expect(io.err.join('')).toContain('ownership_unavailable');
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/session-recovery.ts', 'inspect', '--session', target.id], {
      cwd: resolve('.'), env: { PATH: process.env.PATH, DATA_DIR: f.dir }, encoding: 'utf8', timeout: 15_000,
    });
    expect(child.status).toBe(1); expect(child.stdout).toBe(''); expect(child.stderr).toBe('{"error":"ownership_unavailable"}\n');
    const lock = join(f.dir, 'live', 'control-plane.lock');
    expect(await readFile(lock, 'utf8')).toBe(String(process.pid));
    await f.db.close(); await writeFile(lock, '2147483647');
    expect(await runSessionRecovery(['inspect', '--session', target.id], { env: { DATA_DIR: f.dir }, ...output() })).toBe(1);
    expect(await readFile(lock, 'utf8')).toBe('2147483647');
    await rm(lock); // Fixture teardown only; the production operator has no unlock path.
  });

  it('refuses missing database paths, mismatched confirmation, running sessions and freeform/manual claims before providers', async () => {
    const f = await fixture(); const target = session('running'); await f.repo.insert(target); await f.db.close();
    const construct = vi.fn(async () => { throw new Error('private config'); });
    for (const args of [
      ['reconcile', '--session', target.id, '--confirm-session', randomUUID(), '--reason', 'configuration_fixed'],
      ['reconcile', '--session', target.id, '--confirm-session', target.id, '--reason', 'I deleted the VM'],
      ['reconcile', '--session', target.id, '--confirm-session', target.id, '--reason', 'configuration_fixed'],
    ]) expect(await runSessionRecovery(args, { env: { DATA_DIR: f.dir }, createManager: construct, ...output() })).toBe(1);
    expect(construct).not.toHaveBeenCalled();
    const missing = join(f.dir, 'typo'); const io = output();
    expect(await runSessionRecovery(['inspect', '--session', target.id], { env: { DATA_DIR: missing }, ...io })).toBe(1);
    expect(io.err.join('')).toContain('database_not_found'); await expect(access(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('audits before remote mutation, awaits only the selected session, and persists the outcome across reopen', async () => {
    const f = await fixture(); const a = session(), b = session(); await f.repo.insert(a); await f.repo.insert(b);
    const provider = syntheticProvider();
    provider.exists.mockImplementation(async id => id === a.sandboxId && provider.kill.mock.calls.length === 0);
    provider.kill.mockImplementation(async () => {
      expect((await f.db.query<{ outcome: string }>('SELECT outcome FROM ephemeral_operator_recovery WHERE session_id=$1', [a.id])).rows).toEqual([{ outcome: 'started' }]);
    });
    const disable = vi.fn(async (_id: string) => {}), revoke = vi.fn(async (_id: string) => {});
    const manager = new SessionManager(f.repo, provider, { issue: async () => { throw new Error('forbidden'); }, disable, revokeGitHub: revoke });
    const result = await reconcileRecovery({ ...f, manager }, a.id, a.id, 'configuration_fixed');
    expect(result.outcome).toBe('completed'); expect(result.ownershipRetained).toBe(false);
    expect(disable).toHaveBeenCalledExactlyOnceWith(a.id); expect(revoke).toHaveBeenCalledExactlyOnceWith(a.id);
    expect(provider.discover).toHaveBeenCalledExactlyOnceWith(a.id); expect(provider.kill).toHaveBeenCalledExactlyOnceWith(a.sandboxId);
    expect(await f.repo.get(b.id)).toEqual(b); expect(provider.create).not.toHaveBeenCalled();
    await manager.shutdown(); await f.db.close();
    const reopened = await openDatabase(undefined, join(f.dir, 'live')); closes.push(() => reopened.close());
    expect((await reopened.query<{ reason: string; outcome: string }>('SELECT reason,outcome FROM ephemeral_operator_recovery')).rows).toEqual([{ reason: 'configuration_fixed', outcome: 'completed' }]);
  });

  it('retains ownership on undrained work, records timeout, and never closes the DB before late worker writes', async () => {
    const f = await fixture(); const target = session(); await f.repo.insert(target); await f.db.close();
    let finish!: (value: string[]) => void;
    const delayed = new Promise<string[]>(resolve => { finish = resolve; });
    let captured!: RecoveryContext; let manager!: SessionManager;
    const provider = syntheticProvider(); provider.discover.mockImplementation(() => delayed);
    const io = output();
    const code = await runSessionRecovery(['reconcile', '--session', target.id, '--confirm-session', target.id, '--reason', 'provider_recovered'], {
      env: { DATA_DIR: f.dir }, ...io, workTimeoutMs: 20,
      createManager: async context => {
        captured = context;
        manager = new SessionManager(context.repo, provider, { issue: async () => '', disable: async () => {}, revokeGitHub: async () => {} }); return manager;
      },
    });
    expect(code).toBe(2); expect(io.err.join('')).toContain('ownershipRetained');
    expect(JSON.parse(io.out.join(''))).toMatchObject({ outcome: 'timed_out', ownershipRetained: true });
    await expect(openDatabase(undefined, join(f.dir, 'live'))).rejects.toThrow('lock exists');
    expect((await captured.db.query<{ outcome: string }>('SELECT outcome FROM ephemeral_operator_recovery')).rows[0]?.outcome).toBe('timed_out');
    finish([]); await manager.shutdown();
    expect((await captured.repo.get(target.id))?.state).toBe('ended'); // Late persistence succeeds while ownership is still held.
    await captured.db.close();
  });

  it('keeps uncertain creation and token issuance unresolved; an operator reason never proves cleanup', async () => {
    const f = await fixture(); const target = session('provisioning'); target.sandboxId = null; await f.repo.insert(target);
    await f.repo.claim(target.id, 'fixture');
    await f.repo.beginCreationAttempt(target.id, 'fixture', new Date(Date.now() + 60_000).toISOString());
    await f.repo.recordCreationOutcome(target.id, 'fixture', { status: 'unknown', reason: 'request_uncertain' }); await f.repo.release(target.id, 'fixture');
    await f.db.query('INSERT INTO github_token_issuance(session_id,uncertainty_until) VALUES($1,$2)', [target.id, new Date(Date.now() + 60_000).toISOString()]);
    const manager = new SessionManager(f.repo, syntheticProvider(), { issue: async () => '', disable: async () => {}, revokeGitHub: id => f.store.revoke(id) });
    const result = await reconcileRecovery({ ...f, manager }, target.id, target.id, 'incident_cleanup');
    expect(result.outcome).toBe('incomplete'); expect((await f.repo.get(target.id))?.cleanup).toMatchObject({ vm: 'pending', github: 'failed' });
    expect(result.diagnostic.blockers).toContain('sandbox_creation_uncertain');
    await expect(reconcileRecovery({ ...f, manager }, target.id, target.id, 'manual deletion confirmed')).rejects.toThrow('invalid_arguments');
    expect((await f.repo.get(target.id))?.state).toBe('cleanup_pending'); await manager.shutdown();
  });

  it.each(['journaled', 'legacy'] as const)('retains %s uncertain creation history without a blocker after evidenced cleanup', async kind => {
    const f = await fixture(); const target = session('provisioning'); target.sandboxId = null; await f.repo.insert(target);
    const deadline = new Date(Date.now() - 1_000).toISOString();
    await f.repo.claim(target.id, 'fixture');
    if (kind === 'journaled') {
      await f.repo.beginCreationAttempt(target.id, 'fixture', deadline);
      await f.repo.recordCreationOutcome(target.id, 'fixture', { status: 'unknown', reason: 'request_uncertain' });
    } else await f.repo.markCreation(target.id, 'fixture', deadline);
    await f.repo.release(target.id, 'fixture');
    const before = await inspectRecovery(f, target.id);
    const blocker = kind === 'journaled' ? 'sandbox_creation_uncertain' : 'legacy_sandbox_creation_uncertain';
    expect(before.blockers).toContain(blocker);
    const provider = syntheticProvider();
    const manager = new SessionManager(f.repo, provider, { issue: async () => '', disable: async () => {}, revokeGitHub: id => f.store.revoke(id) });
    const result = await reconcileRecovery({ ...f, manager }, target.id, target.id, 'provider_recovered');
    expect(result.outcome).toBe('completed'); expect(result.diagnostic.cleanup.vm).toBe('confirmed');
    expect(result.diagnostic.state).toBe('failed'); expect(provider.discover).toHaveBeenCalledExactlyOnceWith(target.id);
    expect(result.diagnostic.blockers).not.toContain(blocker);
    expect(result.diagnostic.creationUncertaintyUntil).toBe(deadline);
    if (kind === 'journaled') expect(result.diagnostic.creationAttempt).toMatchObject({ status: 'unknown', reason: 'request_uncertain', uncertaintyUntil: deadline });
    else expect(result.diagnostic.creationAttempt).toBeNull();
    await manager.shutdown();
  });

  it('disables only the target disk, preserves sibling/root files and rejects symlink or mismatched paths', async () => {
    const f = await fixture(); const a = session(), b = session();
    const root = await mkdtemp('/tmp/ep-gh-'); directories.push(root); await chmod(root, 0o700); await f.store.recordRoot(root);
    const target = join(root, `repo-${a.id}.git`), sibling = join(root, `repo-${b.id}.git`);
    await mkdir(target); await mkdir(sibling); await writeFile(join(root, 'auth-sensitive-fixture'), 'private');
    await f.store.recordDisk(a.id, target); await f.store.recordDisk(b.id, sibling); await f.store.issue(a);
    await disableRecoveryGateway(f.store, a.id);
    expect(await f.store.enabled(a.id)).toBe(false); await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await access(sibling); await access(join(root, 'auth-sensitive-fixture')); expect(await f.store.disks()).toEqual([{ session_id: b.id, path: sibling }]);
    await f.store.recordDisk(a.id, sibling); await expect(disableRecoveryGateway(f.store, a.id)).rejects.toThrow('operation_failed'); await access(sibling);
    await symlink(sibling, target); await f.store.recordDisk(a.id, target);
    await expect(disableRecoveryGateway(f.store, a.id)).rejects.toThrow('operation_failed'); await access(sibling);
  });

  it('sanitizes configuration failures and only reads explicitly selected private environment files', async () => {
    const f = await fixture(); const target = session(); await f.repo.insert(target); await f.db.close();
    const envFile = join(f.dir, 'operator.env');
    const fixtureKey = randomUUID();
    await writeFile(envFile, `DATA_DIR=${f.dir}\nE2B_API_KEY=${fixtureKey}\n`, { mode: 0o600 });
    const io = output();
    expect(await runSessionRecovery(['inspect', '--session', target.id, '--env-file', envFile], { env: {}, ...io })).toBe(0);
    const bad = output();
    expect(await runSessionRecovery(['reconcile', '--session', target.id, '--confirm-session', target.id, '--reason', 'credential_recovery', '--env-file', envFile], {
      env: {}, ...bad, createManager: async () => { throw new Error('Authorization Bearer ghp_private_fixture'); },
    })).toBe(1);
    expect(bad.err.join('')).toBe('{"error":"configuration_invalid"}\n');
    expect(io.out.join('') + bad.err.join('')).not.toContain(fixtureKey);
    await chmod(envFile, 0o644);
    expect(await runSessionRecovery(['inspect', '--session', target.id, '--env-file', envFile], { env: {}, ...output() })).toBe(1);
    await chmod(envFile, 0o600);
    const link = join(f.dir, 'linked.env'); await symlink(envFile, link);
    expect(await runSessionRecovery(['inspect', '--session', target.id, '--env-file', link], { env: {}, ...output() })).toBe(1);
  });
});
