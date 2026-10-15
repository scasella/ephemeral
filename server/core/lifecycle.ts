import { randomUUID } from 'node:crypto';
import type { CreateSessionInput, GatewayCredentials, SandboxProvider, Session, SessionRepository } from '../contracts.js';
import type { DurableSessionRepository } from './repository.js';
import { ContinuationSourceChangedError, copyContinuation, SESSION_UUID } from './continuation.js';

const HOUR = 3_600_000;
type DiscoverableProvider = SandboxProvider & { discover?(sessionId: string): Promise<string[]> };
function durable(repo: SessionRepository): repo is DurableSessionRepository {
  return 'claim' in repo && 'markCreation' in repo;
}

export class SessionManager {
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly uncertainty = new Map<string, string>();
  private closed = false;
  constructor(private readonly repo: SessionRepository, private readonly provider: DiscoverableProvider, private readonly credentials: GatewayCredentials, private readonly options: { maxHours?: 1 | 4 } = {}) {
    if (options.maxHours !== undefined && options.maxHours !== 1 && options.maxHours !== 4) throw new Error('Maximum session lifetime must be one or four hours.');
  }
  get(id: string) { return this.repo.get(id); }
  list(userId?: string) { return this.repo.list(userId); }
  events(id: string) { return this.repo.events(id); }

  async create(input: CreateSessionInput, options: { id?: string } = {}): Promise<Session> {
    if (this.closed) throw new Error('Session service is shutting down.');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) throw new Error('Invalid repository name.');
    if (!input.baseBranch || input.baseBranch.startsWith('-') || /[\x00-\x20~^:?*\[\\]/.test(input.baseBranch)) throw new Error('Invalid base branch.');
    const continuation = input.continuation ? copyContinuation(input.continuation) : undefined;
    const now = Date.now();
    const id = options.id ?? randomUUID();
    if (!SESSION_UUID.test(id) || id === continuation?.sourceSessionId) throw new Error('A fresh session ID is required.');
    if (await this.repo.get(id)) throw new Error('Session ID already exists.');
    const session: Session = {
      ...input, ...(continuation ? { continuation } : {}), id, branch: `ephemeral/${id}`, state: 'provisioning',
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + HOUR).toISOString(),
      maxExpiresAt: new Date(now + (this.options.maxHours ?? 4) * HOUR).toISOString(), sandboxId: null, endedAt: null, error: null,
      cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified',
    };
    await this.repo.insert(session);
    await this.repo.event(id, 'created', 'Session requested. Provisioning an isolated sandbox.');
    this.schedule(id, owner => this.provision(id, owner));
    return session;
  }

  private schedule(id: string, operation: (owner: string) => Promise<void>): void {
    if (this.tasks.has(id) || this.closed) return;
    const task = this.withLease(id, operation).catch(async () => {
      // Never log SDK errors: they can contain request headers or credential output.
      await this.repo.event(id, 'worker_retry', 'Session operation interrupted. Durable reconciliation will retry.').catch(() => {});
    }).finally(() => this.tasks.delete(id));
    this.tasks.set(id, task);
  }

  private async withLease<T>(id: string, operation: (owner: string) => Promise<T>): Promise<T | undefined> {
    const owner = randomUUID();
    if (durable(this.repo) && !await this.repo.claim(id, owner)) return undefined;
    const timer = durable(this.repo) ? setInterval(() => {
      void (this.repo as DurableSessionRepository).renew(id, owner).catch(() => false);
    }, 10_000) : null;
    timer?.unref();
    try { return await operation(owner); }
    finally {
      if (timer) clearInterval(timer);
      if (durable(this.repo)) await this.repo.release(id, owner);
    }
  }

  private async save(session: Session, owner: string) {
    if (durable(this.repo)) await this.repo.save(session, owner);
    else await this.repo.update(session);
  }
  private async require(id: string): Promise<Session> {
    const session = await this.repo.get(id);
    if (!session) throw new Error('Session not found.');
    return session;
  }

  private async provision(id: string, owner: string) {
    let session = await this.require(id);
    if (session.state !== 'provisioning') return this.cleanup(id, owner);
    try {
      const token = await this.credentials.issue(session);
      session = await this.require(id);
      if (session.state !== 'provisioning' || Date.now() >= Date.parse(session.expiresAt)) return this.cleanup(id, owner);
      // Persist before the external request. A crashed/ambiguous create may have made a VM.
      // E2B create has a 60s request deadline; add a 2-minute cushion to its bounded TTL.
      const uncertaintyUntil = new Date(Date.parse(session.expiresAt) + 120_000).toISOString();
      if (durable(this.repo)) await this.repo.markCreation(id, owner, uncertaintyUntil);
      else this.uncertainty.set(id, uncertaintyUntil);
      const sandboxId = await this.provider.create(session, token);
      session = await this.require(id);
      session.sandboxId = sandboxId;
      // Persist the ID before ANY preparation command.
      await this.save(session, owner);
      if (session.state !== 'provisioning') return this.cleanup(id, owner);
      await this.provider.prepare(session);
      session = await this.require(id);
      if (session.state !== 'provisioning' || Date.now() >= Date.parse(session.expiresAt)) return this.cleanup(id, owner);
      session.state = 'running';
      await this.save(session, owner);
      await this.repo.event(id, 'running', 'Sandbox ready. Run codex login --device-auth for a fresh sign-in.');
    } catch (error) {
      session = await this.require(id);
      if (session.state === 'provisioning') {
        session.state = 'cleanup_pending';
        session.error = error instanceof ContinuationSourceChangedError
          ? new ContinuationSourceChangedError().message
          : 'Sandbox provisioning did not complete. Cleanup is being retried.';
        await this.save(session, owner);
        await this.repo.event(id, 'provision_failed', session.error);
      }
      await this.cleanup(id, owner);
    }
  }

  async stop(id: string): Promise<Session> {
    let session = await this.require(id);
    if (session.state === 'ended' || session.state === 'failed') return session;
    if (durable(this.repo)) await this.repo.requestStop(id);
    else { session.state = 'cleanup_pending'; await this.repo.update(session); }
    // Disable the gateway immediately, including while a provisioning command is in flight.
    await this.credentials.disable(id).catch(() => {});
    this.schedule(id, owner => this.cleanup(id, owner));
    session = await this.require(id);
    return session;
  }

  async extend(id: string, minutes: number): Promise<Session> {
    if (this.options.maxHours === 1) throw new Error('This deployment has a one-hour maximum. Extensions are disabled.');
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new Error('Extension must be between 1 and 60 minutes.');
    if (this.tasks.has(id)) throw new Error('Session operation in progress. Try again shortly.');
    let result: Session | undefined;
    const operation = this.withLease(id, async owner => {
      const session = await this.require(id);
      if (session.state !== 'running' || !session.sandboxId || Date.now() >= Date.parse(session.expiresAt)) throw new Error('Only an active, unexpired session can be extended.');
      const next = Math.min(Date.parse(session.expiresAt) + minutes * 60_000, Date.parse(session.maxExpiresAt));
      if (next <= Date.parse(session.expiresAt)) throw new Error(`This session has reached its maximum lifetime of ${(Date.parse(session.maxExpiresAt) - Date.parse(session.createdAt)) / HOUR} hours.`);
      // Persist first. A crash then cannot leave a remotely extended VM beyond the recorded deadline.
      const oldExpiry = session.expiresAt;
      session.expiresAt = new Date(next).toISOString();
      await this.save(session, owner);
      try { await this.provider.setTimeout(session.sandboxId, next - Date.now()); }
      catch {
        session.expiresAt = oldExpiry;
        await this.save(session, owner);
        throw new Error('Provider could not confirm the extension. The original deadline still applies.');
      }
      await this.repo.event(id, 'extended', `Deadline extended to ${session.expiresAt}.`);
      result = session;
    });
    this.tasks.set(id, operation.then(() => {}, () => {}));
    try { await operation; } finally { this.tasks.delete(id); }
    if (!result) throw new Error('Another worker is updating this session. Try again shortly.');
    return result;
  }

  async retryCleanup(id: string): Promise<Session> {
    const session = await this.require(id);
    if (session.state !== 'cleanup_pending') throw new Error('This session has no pending cleanup.');
    this.schedule(id, owner => this.cleanup(id, owner));
    return this.require(id);
  }

  private async cleanup(id: string, owner: string): Promise<void> {
    const session = await this.require(id);
    if (session.state === 'ended' || session.state === 'failed') return;
    session.state = 'cleanup_pending';
    await this.save(session, owner);
    const phase = async (key: 'gateway' | 'github', work: () => Promise<void>) => {
      if (session.cleanup[key] === 'confirmed') return;
      try { await work(); session.cleanup[key] = 'confirmed'; }
      catch { session.cleanup[key] = 'failed'; }
      await this.save(session, owner);
    };
    await phase('gateway', () => this.credentials.disable(id));
    await phase('github', () => this.credentials.revokeGitHub(id));
    try {
      const discovered = this.provider.discover ? await this.provider.discover(id) : [];
      const ids = [...new Set([...(session.sandboxId ? [session.sandboxId] : []), ...discovered])];
      const until = durable(this.repo) ? await this.repo.uncertaintyUntil(id) : this.uncertainty.get(id);
      let confirmed = true;
      let logoutConfirmed = true;
      let anyLive = false;
      for (const sandboxId of ids) {
        if (!await this.provider.exists(sandboxId)) continue;
        anyLive = true;
        try { logoutConfirmed = await this.provider.cleanupCodex(sandboxId) && logoutConfirmed; }
        catch { logoutConfirmed = false; }
        try { await this.provider.kill(sandboxId); }
        catch { /* Check existence below: a response can fail after successful deletion. */ }
        if (await this.provider.exists(sandboxId)) confirmed = false;
      }
      // With no recorded ID, a timed-out create can finish after the first discovery pass.
      if (!session.sandboxId && until && Date.now() < Date.parse(until)) confirmed = false;
      // TTL is a bound, not deletion evidence. Without metadata discovery an
      // ambiguous create must stay pending even after its nominal timeout.
      if (!this.provider.discover && !session.sandboxId && until) confirmed = false;
      session.cleanup.vm = confirmed ? 'confirmed' : 'pending';
      if (anyLive) session.cleanup.codex = logoutConfirmed ? 'confirmed' : confirmed ? 'not_applicable' : 'failed';
      else if (session.cleanup.codex !== 'confirmed') session.cleanup.codex = confirmed ? 'not_applicable' : 'pending';
      if (anyLive && !logoutConfirmed) await this.repo.event(id, 'codex_logout_unconfirmed', 'Codex logout was not confirmed. VM destruction removes local credentials; remote authorization revocation remains unverified.');
    } catch { session.cleanup.vm = 'failed'; }
    const complete = session.cleanup.vm === 'confirmed' && session.cleanup.gateway === 'confirmed' && session.cleanup.github === 'confirmed';
    if (complete) {
      session.state = session.error ? 'failed' : 'ended';
      session.endedAt = new Date().toISOString();
    }
    await this.save(session, owner);
    if (complete) await this.repo.event(id, 'ended', 'VM deletion and gateway/GitHub credential cleanup confirmed. Codex remote revocation remains unverified.');
  }

  async reconcile(): Promise<void> {
    if (this.closed) return;
    for (const session of await this.repo.list()) {
      if (this.tasks.has(session.id)) continue;
      if (session.state === 'provisioning') {
        // An abandoned provision is cleaned up rather than replaying credential creation.
        this.schedule(session.id, async owner => {
          const current = await this.require(session.id);
          current.error ??= 'Provisioning was interrupted. Recovering and cleaning up any sandbox.';
          current.state = 'cleanup_pending';
          await this.save(current, owner);
          await this.cleanup(current.id, owner);
        });
      } else if (session.state === 'cleanup_pending') {
        this.schedule(session.id, owner => this.cleanup(session.id, owner));
      } else if (session.state === 'running') {
        if (Date.now() >= Date.parse(session.expiresAt)) await this.stop(session.id);
        else this.schedule(session.id, async owner => {
          const current = await this.require(session.id);
          if (current.state !== 'running') return this.cleanup(current.id, owner);
          if (!current.sandboxId || !await this.provider.exists(current.sandboxId)) {
            current.state = 'cleanup_pending';
            current.error = 'Sandbox is no longer available. Cleaning up its credentials.';
            await this.save(current, owner);
            await this.cleanup(current.id, owner);
          }
        });
      }
    }
  }

  /** Server shutdown preserves active VMs; browser/server disconnection does not end a session. */
  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.tasks.values()]);
  }
}
