import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandExitError, Sandbox } from 'e2b';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Database, GatewayCredentials, SandboxProvider, Session } from '../server/contracts.js';
import { createSessionRepository, type DurableSessionRepository } from '../server/core/repository.js';
import { SessionManager } from '../server/core/lifecycle.js';
import { E2BProvider } from '../server/infra/e2b.js';
import { ContinuationSourceChangedError } from '../server/core/continuation.js';
import { prepareGitCommand, shellQuote, SOURCE_CHANGED_EXIT } from '../server/infra/git-prepare.js';

const input = { userId: 'alice', repository: 'alice/project', repositoryId: 1, installationId: 2, baseBranch: 'main' };
const sourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const continuation = () => ({ sourceSessionId: sourceId, sourceBranch: `ephemeral/${sourceId}`, commitSha: 'a'.repeat(40), verifiedAt: new Date().toISOString() });
const databases: PGlite[] = [];
const managers: SessionManager[] = [];
const credentials = (): GatewayCredentials => ({ issue: vi.fn(async () => 'gateway-secret'), disable: vi.fn(async () => {}), revokeGitHub: vi.fn(async () => {}) });
class FakeProvider implements SandboxProvider {
  live = new Set<string>();
  ids = new Map<string, string>();
  create = vi.fn(async (session: Session) => { const id = `vm-${session.id}`; this.live.add(id); this.ids.set(session.id, id); return id; });
  prepare = vi.fn(async (_session: Session) => {});
  setTimeout = vi.fn(async () => {});
  kill = vi.fn(async (id: string) => { this.live.delete(id); });
  exists = vi.fn(async (id: string) => this.live.has(id));
  cleanupCodex = vi.fn(async () => true);
  discover = vi.fn(async (id: string) => { const vm = this.ids.get(id); return vm && this.live.has(vm) ? [vm] : []; });
  connectTerminal = vi.fn(async () => ({ write: async () => {}, resize: async () => {}, disconnect: async () => {} }));
}
async function setup(provider = new FakeProvider(), creds = credentials()) {
  const db = new PGlite(); databases.push(db);
  const adapter: Database = { query: async <T>(sql: string, params?: unknown[]) => {
    const result = await db.query<T>(sql, params); return { rows: result.rows };
  }, close: async () => { await db.close(); } };
  const repo = await createSessionRepository(adapter);
  const manager = new SessionManager(repo, provider, creds); managers.push(manager);
  return { db, repo, manager, provider, creds };
}
async function until(work: () => Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await work()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for lifecycle task.');
}
async function running(manager: SessionManager) {
  const session = await manager.create(input);
  await until(async () => (await manager.get(session.id))?.state === 'running');
  return (await manager.get(session.id))!;
}
function abandoned(id: string, age = 0): Session {
  const now = Date.now() - age;
  return { ...input, id, branch: `ephemeral/${id}`, state: 'provisioning', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(), maxExpiresAt: new Date(now + 14_400_000).toISOString(), sandboxId: null, endedAt: null, error: null, cleanup: { vm: 'pending', gateway: 'pending', github: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified' };
}
async function markCreation(repo: DurableSessionRepository, id: string, untilDate: number) {
  expect(await repo.claim(id, 'test-owner')).toBe(true);
  await repo.markCreation(id, 'test-owner', new Date(untilDate).toISOString());
  await repo.release(id, 'test-owner');
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const manager of managers.splice(0)) await manager.shutdown();
  for (const db of databases.splice(0)) await db.close();
});

describe('durable lifecycle', () => {
  it('creates fresh continuation identity and credentials, preserving reviewed metadata through cleanup', async () => {
    const { manager, repo, provider, creds } = await setup();
    const source = { ...abandoned(sourceId), state: 'ended' as const, endedAt: new Date().toISOString(), sandboxId: 'old-vm' };
    await repo.insert(source);
    const reviewed = continuation(), expected = { ...reviewed };
    const next = await manager.create({ ...input, continuation: reviewed });
    reviewed.commitSha = 'b'.repeat(40);
    await until(async () => (await manager.get(next.id))?.state === 'running');
    const created = (await manager.get(next.id))!;
    expect(created.id).not.toBe(source.id);
    expect(created.branch).toBe(`ephemeral/${created.id}`);
    expect(created.branch).not.toBe(source.branch);
    expect(created.sandboxId).not.toBe(source.sandboxId);
    expect(created.continuation).toEqual(expected);
    expect(created.baseBranch).toBe('main');
    expect(creds.issue).toHaveBeenCalledWith(expect.objectContaining({ id: created.id, continuation: expected }));
    expect(provider.prepare).toHaveBeenCalledWith(expect.objectContaining({ id: created.id, continuation: expected }));
    expect(await manager.get(source.id)).toEqual(source);
    await manager.stop(created.id);
    await until(async () => (await manager.get(created.id))?.state === 'ended');
    expect((await manager.get(created.id))?.continuation).toEqual(expected);
  });

  it('validates continuation references and internal reserved identities before issuing credentials', async () => {
    const { manager, creds, provider } = await setup();
    for (const invalid of [
      { sourceSessionId: 'old-session' }, { sourceBranch: 'main' }, { sourceBranch: `ephemeral/${sourceId}/../other` },
      { commitSha: 'HEAD' }, { commitSha: 'a'.repeat(39) }, { verifiedAt: 'invalid' },
    ]) await expect(manager.create({ ...input, continuation: { ...continuation(), ...invalid } })).rejects.toThrow('Invalid continuation');
    await expect(manager.create({ ...input, continuation: continuation() }, { id: sourceId })).rejects.toThrow('fresh session ID');
    await expect(manager.create(input, { id: 'bad-id' })).rejects.toThrow('fresh session ID');
    expect(creds.issue).not.toHaveBeenCalled(); expect(provider.create).not.toHaveBeenCalled();
    const reserved = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const next = await manager.create({ ...input, continuation: continuation() }, { id: reserved });
    expect(next.id).toBe(reserved);
    await until(async () => (await manager.get(next.id))?.state === 'running');
    await expect(manager.create(input, { id: reserved })).rejects.toThrow('already exists');
  });

  it('cleans up changed-source preparation with a fixed actionable error', async () => {
    const { manager, provider, creds } = await setup();
    provider.prepare.mockRejectedValue(new ContinuationSourceChangedError());
    const next = await manager.create({ ...input, continuation: continuation() });
    await until(async () => (await manager.get(next.id))?.state === 'failed');
    expect((await manager.get(next.id))?.error).toContain('published source branch changed');
    expect(provider.live.size).toBe(0);
    expect(creds.disable).toHaveBeenCalledWith(next.id);
    expect(creds.revokeGitHub).toHaveBeenCalledWith(next.id);
  });

  it('persists a VM ID before prepare and confirms ordered cleanup after stop', async () => {
    const { manager, provider, creds } = await setup();
    provider.prepare.mockImplementation(async session => { expect((await manager.get(session.id))?.sandboxId).toBe(session.sandboxId); });
    const session = await running(manager);
    expect(Date.parse(session.expiresAt) - Date.parse(session.createdAt)).toBe(3_600_000);
    await manager.stop(session.id);
    await until(async () => (await manager.get(session.id))?.state === 'ended');
    const result = (await manager.get(session.id))!;
    expect(result.cleanup).toEqual({ gateway: 'confirmed', github: 'confirmed', vm: 'confirmed', codex: 'confirmed' });
    expect(result.codexRemoteRevocation).toBe('unverified');
    expect(vi.mocked(creds.revokeGitHub).mock.invocationCallOrder[0]).toBeLessThan(provider.cleanupCodex.mock.invocationCallOrder[0]);
    expect(provider.cleanupCodex.mock.invocationCallOrder[0]).toBeLessThan(provider.kill.mock.invocationCallOrder[0]);
  });

  it('enforces one active session per user across competing managers and pending cleanup', async () => {
    const { manager, repo, provider, creds } = await setup();
    const other = new SessionManager(repo, provider, creds); managers.push(other);
    const attempts = await Promise.allSettled([manager.create(input), other.create(input)]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const session = (attempts.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Session>).value;
    await until(async () => (await manager.get(session.id))?.state === 'running');
    provider.kill.mockRejectedValue(new Error('provider offline'));
    await manager.stop(session.id);
    await until(async () => provider.kill.mock.calls.length > 0);
    await expect(manager.create(input)).rejects.toThrow('already have an active');
    expect((await manager.get(session.id))?.state).toBe('cleanup_pending');
  });

  it('retains failed revocation and VM deletion until a restarted worker retries successfully', async () => {
    const { manager, repo, provider, creds } = await setup();
    const session = await running(manager);
    vi.mocked(creds.revokeGitHub).mockRejectedValue(new Error('transient'));
    provider.kill.mockRejectedValue(new Error('transient'));
    await manager.stop(session.id);
    await until(async () => (await manager.get(session.id))?.cleanup.github === 'failed' && provider.kill.mock.calls.length > 0);
    await manager.shutdown();
    expect((await manager.get(session.id))?.state).toBe('cleanup_pending');
    provider.kill.mockImplementation(async id => { provider.live.delete(id); });
    vi.mocked(creds.revokeGitHub).mockResolvedValue();
    const restarted = new SessionManager(repo, provider, creds); managers.push(restarted);
    await restarted.reconcileOne(session.id);
    await until(async () => (await restarted.get(session.id))?.state === 'ended');
  });

  it.each(['gateway', 'github'] as const)('retains active ownership after VM deletion while %s cleanup fails across restart', async phase => {
    const { db, manager, repo, provider, creds } = await setup();
    const session = await running(manager);
    const failure = phase === 'gateway' ? vi.mocked(creds.disable) : vi.mocked(creds.revokeGitHub);
    failure.mockRejectedValue(new Error('credential cleanup unavailable'));
    await manager.stop(session.id);
    await manager.shutdown();
    const pending = (await repo.get(session.id))!;
    expect(pending.state).toBe('cleanup_pending');
    expect(pending.endedAt).toBeNull();
    expect(pending.cleanup.vm).toBe('confirmed');
    expect(pending.cleanup[phase]).toBe('failed');
    expect(pending.cleanup[phase === 'gateway' ? 'github' : 'gateway']).toBe('confirmed');
    expect(provider.live.size).toBe(0);
    expect((await repo.events(session.id)).some(event => event.kind === 'ended')).toBe(false);

    // Reopen the repository as a new worker would: the SQL active-user index must
    // continue excluding a second session even though the VM is already absent.
    const reopened = await createSessionRepository({
      query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await db.query<T>(sql, params)).rows }), close: async () => {},
    });
    const restarted = new SessionManager(reopened, provider, creds); managers.push(restarted);
    await expect(restarted.create(input)).rejects.toThrow('already have an active');
    const stillPending = await restarted.reconcileOne(session.id);
    expect(stillPending.state).toBe('cleanup_pending');
    expect(stillPending.endedAt).toBeNull();
    expect(stillPending.cleanup[phase]).toBe('failed');
    expect(provider.create).toHaveBeenCalledTimes(1);
    failure.mockResolvedValue();
    const recovered = await restarted.reconcileOne(session.id);
    expect(recovered.state).toBe('ended');
    expect(recovered.endedAt).not.toBeNull();
    expect(recovered.cleanup).toEqual({ vm: 'confirmed', gateway: 'confirmed', github: 'confirmed', codex: 'confirmed' });
    const next = await running(restarted);
    expect(next.id).not.toBe(session.id);
  });

  it('marks preparation failure only after confirmed destruction and does not leak SDK errors', async () => {
    const { manager, provider } = await setup();
    provider.prepare.mockRejectedValue(new Error('secret bearer gateway-secret'));
    const session = await manager.create(input);
    await until(async () => (await manager.get(session.id))?.state === 'failed');
    expect(provider.live.size).toBe(0);
    expect(JSON.stringify(await manager.get(session.id)) + JSON.stringify(await manager.events(session.id))).not.toContain('gateway-secret');
  });

  it('discovers and destroys an orphan VM after a crash during create; reports uncertainty honestly', async () => {
    const { manager, repo, provider } = await setup();
    const session = abandoned('orphan');
    await repo.insert(session);
    await markCreation(repo, session.id, Date.now() + 60_000);
    provider.ids.set(session.id, 'orphan-vm'); provider.live.add('orphan-vm');
    await manager.reconcile();
    await until(async () => provider.kill.mock.calls.length > 0);
    await manager.shutdown();
    expect(provider.live.size).toBe(0);
    expect((await repo.get(session.id))?.state).toBe('cleanup_pending');
    await markCreation(repo, session.id, Date.now() - 1000);
    const restarted = new SessionManager(repo, provider, credentials()); managers.push(restarted);
    await restarted.reconcileOne(session.id);
    await until(async () => (await repo.get(session.id))?.state === 'failed');
  });

  it('recovers a crash before create with no resource uncertainty or fresh credential issuance', async () => {
    const { manager, repo, provider, creds } = await setup();
    const session = abandoned('pre-create'); await repo.insert(session);
    await manager.reconcile();
    await until(async () => (await repo.get(session.id))?.state === 'failed');
    expect(creds.issue).not.toHaveBeenCalled(); expect(provider.create).not.toHaveBeenCalled();
    expect((await repo.get(session.id))?.cleanup.vm).toBe('confirmed');
  });

  it('stops while create is in flight and never prepares or promotes the resulting VM', async () => {
    const { manager, provider } = await setup();
    let complete!: () => void;
    const gate = new Promise<void>(resolve => { complete = resolve; });
    provider.create.mockImplementation(async session => { await gate; const id = 'late-vm'; provider.live.add(id); provider.ids.set(session.id, id); return id; });
    const session = await manager.create(input);
    await until(async () => provider.create.mock.calls.length > 0);
    expect((await manager.stop(session.id)).state).toBe('cleanup_pending');
    complete();
    await until(async () => (await manager.get(session.id))?.state === 'ended');
    expect(provider.prepare).not.toHaveBeenCalled(); expect(provider.live.size).toBe(0);
  });

  it('expires independently of any terminal connection, and caps explicit extensions at four hours', async () => {
    const { manager, repo, provider } = await setup();
    const session = await running(manager);
    await manager.extend(session.id, 60); await manager.extend(session.id, 60); await manager.extend(session.id, 60);
    expect((await manager.get(session.id))?.expiresAt).toBe(session.maxExpiresAt);
    await expect(manager.extend(session.id, 30)).rejects.toThrow('maximum lifetime of 4 hours');
    const current = (await manager.get(session.id))!;
    current.expiresAt = new Date(Date.now() - 1).toISOString(); await repo.update(current);
    await manager.reconcile();
    await until(async () => (await manager.get(session.id))?.state === 'ended');
    expect(provider.connectTerminal).not.toHaveBeenCalled();
  });

  it('reauthorizes extensions inside the lease and leaves deadline and provider untouched on denial', async () => {
    const { manager, provider } = await setup(), session = await running(manager);
    const authorize = vi.fn(async () => { throw new Error('access revoked'); });
    await expect(manager.extend(session.id, 30, authorize)).rejects.toThrow('access revoked');
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ id: session.id, sandboxId: session.sandboxId }));
    expect((await manager.get(session.id))?.expiresAt).toBe(session.expiresAt);
    expect(provider.setTimeout).not.toHaveBeenCalled();
  });

  it.each(['stop', 'repository', 'sandboxId', 'expiresAt'] as const)('rejects an extension when %s changes during authorization', async change => {
    const { manager, repo, provider } = await setup(), session = await running(manager);
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const extension = manager.extend(session.id, 30, async () => { entered(); await gate; });
    const rejected = expect(extension).rejects.toThrow('Session changed during authorization');
    await waiting;
    if (change === 'stop') await manager.stop(session.id);
    else {
      const current = (await repo.get(session.id))!;
      if (change === 'repository') current.repository = 'alice/other';
      if (change === 'sandboxId') current.sandboxId = 'replacement-vm';
      if (change === 'expiresAt') current.expiresAt = new Date(Date.parse(current.expiresAt) - 1000).toISOString();
      await repo.update(current);
    }
    release(); await rejected;
    expect(provider.setTimeout).not.toHaveBeenCalled();
    expect((await repo.events(session.id)).some(event => event.kind === 'extended')).toBe(false);
    if (change === 'stop') expect((await repo.get(session.id))?.state).toBe('cleanup_pending');
  });

  it('rolls back a provider extension failure to the original deadline', async () => {
    const { manager, provider } = await setup();
    const session = await running(manager);
    provider.setTimeout.mockRejectedValue(new Error('timeout'));
    await expect(manager.extend(session.id, 30)).rejects.toThrow('original deadline');
    expect((await manager.get(session.id))?.expiresAt).toBe(session.expiresAt);
  });

  it('enforces a one-hour Hobby maximum and rejects extension calls at the backend', async () => {
    const { repo, provider, creds } = await setup();
    const hobby = new SessionManager(repo, provider, creds, { maxHours: 1 }); managers.push(hobby);
    const session = await running(hobby);
    expect(session.maxExpiresAt).toBe(session.expiresAt);
    expect(Date.parse(session.maxExpiresAt) - Date.parse(session.createdAt)).toBe(3_600_000);
    await expect(hobby.extend(session.id, 30)).rejects.toThrow('one-hour maximum');
    expect(provider.setTimeout).not.toHaveBeenCalled();
    expect((await hobby.get(session.id))?.expiresAt).toBe(session.expiresAt);
  });

  it('fences stale SQL workers and prevents promotion after a concurrent stop', async () => {
    const { repo, db } = await setup();
    const session = abandoned('leased'); await repo.insert(session);
    expect(await repo.claim(session.id, 'old')).toBe(true);
    expect(await repo.claim(session.id, 'new')).toBe(false);
    await db.query("UPDATE ephemeral_sessions SET lease_until=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=$1", [session.id]);
    expect(await repo.claim(session.id, 'new')).toBe(true);
    await expect(repo.save(session, 'old')).rejects.toThrow('lease');
    await repo.requestStop(session.id);
    session.state = 'running'; await expect(repo.save(session, 'new')).rejects.toThrow('stopped');
    expect((await repo.get(session.id))?.state).toBe('cleanup_pending');
  });
});

describe('E2B API adapter', () => {
  it('fails closed before user work when the trusted root gateway cannot be prepared', async () => {
    for (const stage of ['install', 'write', 'start']) {
      const run = vi.fn(async (_command: string, options: { user: string }) => ({ exitCode: stage === 'install' ||
        (stage === 'start' && run.mock.calls.length === 2) ? 1 : 0, stdout: 'native-secret', stderr: 'envd-secret' }));
      const write = vi.fn(async () => { if (stage === 'write') throw new Error('native-secret'); });
      vi.spyOn(Sandbox, 'connect').mockResolvedValue({ commands: { run }, files: { write } } as unknown as Sandbox);
      const provider = new E2BProvider({ apiKey: 'api-key', templateId: 'template', gatewayUrl: 'https://gateway.example' });
      await expect(provider.prepare({ ...abandoned('gateway-failed'), sandboxId: 'vm' })).rejects.toThrow('Sandbox application gateway preparation failed.');
      expect(run.mock.calls.every(([_command, options]) => options.user === 'root')).toBe(true);
    }
  });

  it('prepares from the reviewed source through the new gateway and starts fresh Codex auth only after checkout', async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const write = vi.fn(async () => {});
    vi.spyOn(Sandbox, 'connect').mockResolvedValue({ commands: { run }, files: { write } } as unknown as Sandbox);
    const provider = new E2BProvider({ apiKey: 'api-key', templateId: 'template', gatewayUrl: 'https://gateway.example' });
    const next = { ...abandoned('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), sandboxId: 'fresh-vm', continuation: continuation() };
    await provider.prepare(next);
    const commands = run.mock.calls.map(call => (call as unknown as [string])[0]);
    const clone = commands.find(command => command.includes('git clone'))!;
    expect(clone).toContain(`--branch '${next.continuation.sourceBranch}'`);
    expect(clone).toContain(`/gateway/git/${next.id}.git`);
    expect(clone).not.toContain(`/gateway/git/${sourceId}.git`);
    expect(clone).toContain(`checkout -b '${next.branch}' '${next.continuation.commitSha}'`);
    expect(commands[0]).toContain('install -d -m 700 -o root -g root');
    expect(commands[1]).toContain('env -i');
    expect(commands[2]).toContain('test ! -f "$HOME/.codex/auth.json"');
    expect((run.mock.calls[0] as unknown as [string, { user: string }])[1].user).toBe('root');
    expect((run.mock.calls[1] as unknown as [string, { user: string }])[1].user).toBe('root');
    expect(commands.at(-1)).toContain('codex login --device-auth');
    expect(JSON.stringify(commands)).not.toContain('setup-runner');
  });

  it('does not launch the terminal or Codex after a changed-source mismatch', async () => {
    const run = vi.fn(async (command: string) => ({ exitCode: command.includes('git clone') ? SOURCE_CHANGED_EXIT : 0, stdout: '', stderr: '' }));
    vi.spyOn(Sandbox, 'connect').mockResolvedValue({ commands: { run }, files: { write: vi.fn(async () => {}) } } as unknown as Sandbox);
    const provider = new E2BProvider({ apiKey: 'api-key', templateId: 'template', gatewayUrl: 'https://gateway.example' });
    const next = { ...abandoned('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), sandboxId: 'fresh-vm', continuation: continuation() };
    await expect(provider.prepare(next)).rejects.toBeInstanceOf(ContinuationSourceChangedError);
    expect(run.mock.calls.some(([command]) => command.includes('tmux new-session'))).toBe(false);
  });

  it('recognizes the real SDK nonzero command error without exposing its output', async () => {
    const run = vi.fn(async (command: string) => {
      if (command.includes('git clone')) throw new CommandExitError({ exitCode: SOURCE_CHANGED_EXIT, stdout: 'gateway-secret', stderr: 'upstream-secret', error: 'SDK secret' });
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    vi.spyOn(Sandbox, 'connect').mockResolvedValue({ commands: { run }, files: { write: vi.fn(async () => {}) } } as unknown as Sandbox);
    const provider = new E2BProvider({ apiKey: 'api-key', templateId: 'template', gatewayUrl: 'https://gateway.example' });
    const next = { ...abandoned('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), sandboxId: 'fresh-vm', continuation: continuation() };
    await expect(provider.prepare(next)).rejects.toThrow('published source branch changed');
    expect(run.mock.calls.some(([command]) => command.includes('tmux new-session'))).toBe(false);
  });

  it('creates with bounded TTL and recoverable session metadata, without preparing before ID persistence', async () => {
    const create = vi.spyOn(Sandbox, 'create').mockResolvedValue({ sandboxId: 'real-api-vm' } as Sandbox);
    const provider = new E2BProvider({ apiKey: 'api-key', templateId: 'ephemeral-template', gatewayUrl: 'https://gateway.example' });
    const session = abandoned('sdk-session');
    expect(await provider.create(session, 'gateway-secret')).toBe('real-api-vm');
    expect(create).toHaveBeenCalledWith('ephemeral-template', expect.objectContaining({
      requestTimeoutMs: 60_000, timeoutMs: expect.any(Number), metadata: { ephemeral_session_id: session.id, ephemeral_user_id: session.userId, ephemeral_repository: session.repository, ephemeral_repository_id: String(session.repositoryId), ephemeral_branch: session.branch, ephemeral_preview_gateway: '1' }, envs: { EPHEMERAL_GATEWAY_TOKEN: 'gateway-secret' },
      secure: true, network: { allowPublicTraffic: false, maskRequestHost: 'localhost:${PORT}' },
      retries: 0, lifecycle: { onTimeout: 'kill', autoResume: false },
    }));
    expect((create.mock.calls[0]?.[1] as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(3_600_000);
    await expect(provider.prepare(session)).rejects.toThrow('persisted');
  });

  it('treats provider network errors as unknown existence, never confirmed deletion', async () => {
    vi.spyOn(Sandbox, 'getInfo').mockRejectedValue(new Error('network unavailable'));
    const provider = new E2BProvider({ apiKey: 'api-key', templateId: 'template', gatewayUrl: 'https://gateway.example' });
    await expect(provider.exists('vm')).rejects.toThrow('network unavailable');
  });

  it('keeps the token out of setup commands and scopes the executable Git credential helper', async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const write = vi.fn(async () => {});
    vi.spyOn(Sandbox, 'connect').mockResolvedValue({ commands: { run }, files: { write } } as unknown as Sandbox);
    const provider = new E2BProvider({ apiKey: 'api-key', templateId: 'template', gatewayUrl: 'https://gateway.example' });
    const session = { ...abandoned('helper-session'), sandboxId: 'vm' };
    await provider.prepare(session);
    expect(JSON.stringify(run.mock.calls)).not.toContain('gateway-secret');
    expect(JSON.stringify(run.mock.calls)).not.toContain('x-access-token:');
    const helper = (write.mock.calls[1] as unknown as [string, string])[1];
    expect(helper).not.toContain('gateway-secret');
    const directory = await mkdtemp(join(tmpdir(), 'ephemeral-helper-test-'));
    try {
      const path = join(directory, 'helper'); await writeFile(path, helper);
      const execute = (host: string, remotePath: string, protocol = 'https') => spawnSync('/bin/sh', [path, 'get'], {
        input: `protocol=${protocol}\nhost=${host}\npath=${remotePath}\n`, encoding: 'utf8', env: { ...process.env, EPHEMERAL_GATEWAY_TOKEN: 'gateway-secret' },
      });
      const valid = execute('gateway.example', 'gateway/git/helper-session.git');
      expect(valid.status).toBe(0); expect(valid.stdout).toBe('username=x-access-token\npassword=gateway-secret\n');
      expect(execute('attacker.example', 'gateway/git/helper-session.git').stdout).toBe('');
      expect(execute('gateway.example', 'gateway/git/other-session.git').stdout).toBe('');
      expect(execute('gateway.example', 'gateway/git/helper-session.git', 'http').stdout).toBe('');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe('continuation Git checkout', () => {
  it('clones the exact reviewed published commit into the new branch, and fails closed when the source moves', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ephemeral-continuation-'));
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { encoding: 'utf8', env });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    try {
      const upstream = join(directory, 'upstream.git'), seed = join(directory, 'seed');
      git(['init', '--bare', upstream]); git(['init', '-b', 'main', seed]);
      git(['-C', seed, 'config', 'user.name', 'Test']); git(['-C', seed, 'config', 'user.email', 'test@example.com']);
      await writeFile(join(seed, 'published.txt'), 'reviewed\n'); git(['-C', seed, 'add', '.']); git(['-C', seed, 'commit', '-m', 'reviewed']);
      git(['-C', seed, 'branch', `ephemeral/${sourceId}`]); git(['-C', seed, 'push', upstream, 'main', `ephemeral/${sourceId}`]);
      const sha = git(['-C', seed, 'rev-parse', 'HEAD']);
      const next = { ...abandoned('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), continuation: { ...continuation(), commitSha: sha } };
      const work = join(directory, 'fresh-work');
      const first = spawnSync('/bin/sh', ['-c', prepareGitCommand(next, upstream, work)], { encoding: 'utf8', env });
      expect(first.status).toBe(0);
      expect(git(['-C', work, 'rev-parse', 'HEAD'])).toBe(sha);
      expect(git(['-C', work, 'branch', '--show-current'])).toBe(next.branch);
      expect(git(['-C', work, 'remote', 'get-url', 'origin'])).toBe(upstream);
      git(['-C', seed, 'checkout', next.continuation.sourceBranch]);
      await writeFile(join(seed, 'published.txt'), 'moved\n'); git(['-C', seed, 'commit', '-am', 'moved']); git(['-C', seed, 'push', upstream, next.continuation.sourceBranch]);
      const staleWork = join(directory, 'stale-work');
      const stale = spawnSync('/bin/sh', ['-c', prepareGitCommand(next, upstream, staleWork)], { encoding: 'utf8', env });
      expect(stale.status).toBe(SOURCE_CHANGED_EXIT);
      expect(spawnSync('git', ['-C', staleWork, 'show-ref', '--verify', `refs/heads/${next.branch}`], { env }).status).not.toBe(0);
      // Complete the object download, then move upstream before clone returns.
      // Its tracking ref still contains the reviewed SHA; the final remote
      // check must detect the race before creating the assigned branch.
      const moved = git(['-C', seed, 'rev-parse', 'HEAD']);
      git(['--git-dir', upstream, 'update-ref', `refs/heads/${next.continuation.sourceBranch}`, sha]);
      const realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8', env }).stdout.trim();
      const wrapper = `#!/bin/sh\nif [ "$1" = clone ]; then\n  ${shellQuote(realGit)} "$@" || exit $?\n  ${shellQuote(realGit)} --git-dir ${shellQuote(upstream)} update-ref ${shellQuote(`refs/heads/${next.continuation.sourceBranch}`)} ${shellQuote(moved)}\nelse\n  exec ${shellQuote(realGit)} "$@"\nfi\n`;
      await writeFile(join(directory, 'git'), wrapper, { mode: 0o700 });
      const racedWork = join(directory, 'raced-work');
      const raced = spawnSync('/bin/sh', ['-c', prepareGitCommand(next, upstream, racedWork)], { encoding: 'utf8', env: { ...env, PATH: `${directory}:${env.PATH}` } });
      expect(raced.status).toBe(SOURCE_CHANGED_EXIT);
      expect(git(['-C', racedWork, 'rev-parse', `refs/remotes/origin/${next.continuation.sourceBranch}`])).toBe(sha);
      expect(spawnSync('git', ['-C', racedWork, 'show-ref', '--verify', `refs/heads/${next.branch}`], { env }).status).not.toBe(0);
      expect(() => prepareGitCommand({ ...next, id: sourceId, branch: next.continuation.sourceBranch }, upstream, join(directory, 'reused'))).toThrow('fresh assigned');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
