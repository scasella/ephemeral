import { copyResolvedEnvironmentProfile } from '../environments.js';
import { copyGitHubLaunchSource, parseGitHubLaunchUrl } from '../../shared/github-launch.js';
import { randomUUID } from 'node:crypto';
import { SessionOperationError } from './errors.js';
import type { CreateSessionInput, GatewayCredentials, SandboxProvider, Session, SessionRepository } from '../contracts.js';
import type { DurableSessionRepository } from './repository.js';
import { nextRetry, retryDue, type ReconciliationRetry } from './reconciliation.js';
import { SandboxCreationError, SessionNotCreatedError, type CreationAttempt } from './provisioning.js';
import { ContinuationSourceChangedError, copyContinuation, SESSION_UUID } from './continuation.js';

const HOUR = 3_600_000;
type DiscoverableProvider = SandboxProvider & { discover?(sessionId: string): Promise<string[]> };
function durable(repo: SessionRepository): repo is DurableSessionRepository {
  return 'claim' in repo && 'markCreation' in repo;
}

export class SessionManager {
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly uncertainty = new Map<string, string>();
  private readonly attempts = new Map<string, CreationAttempt>();
  private readonly resourceHints = new Map<string, string>();
  private readonly retries = new Map<string, ReconciliationRetry>();
  private closed = false;
  constructor(private readonly repo: SessionRepository, private readonly provider: DiscoverableProvider, private readonly credentials: GatewayCredentials, private readonly options: { maxHours?: 1 | 4; now?: () => number } = {}) {
    if (options.maxHours !== undefined && options.maxHours !== 1 && options.maxHours !== 4) throw new SessionOperationError('Maximum session lifetime must be one or four hours.');
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  get(id: string) { return this.repo.get(id); }
  list(userId?: string) { return this.repo.list(userId); }
  events(id: string) { return this.repo.events(id); }

  async create(input: CreateSessionInput, options: { id?: string } = {}): Promise<Session> {
    if (this.closed) throw new SessionNotCreatedError('Session service is shutting down.');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) throw new SessionNotCreatedError('Invalid repository name.');
    if (!input.baseBranch || input.baseBranch.startsWith('-') || /[\x00-\x20~^:?*\[\\]/.test(input.baseBranch)) throw new SessionNotCreatedError('Invalid base branch.');
    let continuation: Session['continuation'];
    try { continuation = input.continuation ? copyContinuation(input.continuation) : undefined; }
    catch { throw new SessionNotCreatedError('Invalid continuation reference.'); }
    let launchSource: Session['launchSource'];
    try {
      launchSource = input.launchSource ? copyGitHubLaunchSource(input.launchSource) : undefined;
      if (launchSource && (continuation || launchSource.baseBranch !== input.baseBranch ||
        parseGitHubLaunchUrl(launchSource.url).repository.toLowerCase() !== input.repository.toLowerCase())) throw new Error();
    } catch { throw new SessionNotCreatedError('Invalid GitHub launch source.'); }
    let environment: Session['environment'];
    try { environment = input.environment === undefined ? undefined : copyResolvedEnvironmentProfile(input.environment); }
    catch { throw new SessionNotCreatedError('Invalid environment profile.'); }
    const now = this.now();
    const id = options.id ?? randomUUID();
    if (!SESSION_UUID.test(id) || id === continuation?.sourceSessionId) throw new SessionNotCreatedError('A fresh session ID is required.');
    if (await this.repo.get(id)) throw new SessionNotCreatedError('Session ID already exists.');
    if (this.closed) throw new SessionNotCreatedError('Session service is shutting down.');
    const session: Session = {
      ...input, ...(continuation ? { continuation } : {}), ...(launchSource ? { launchSource } : {}), ...(environment ? { environment } : {}), id, branch: `ephemeral/${id}`, state: 'provisioning',
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
    // A lost lease or database failure cannot authorize an unfenced event write.
    // Provider retry state is recorded inside the owning operation instead.
    const task = this.withLease(id, operation).catch(() => {}).finally(() => this.tasks.delete(id));
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
  private async retryState(id: string): Promise<ReconciliationRetry | null> {
    return durable(this.repo) ? this.repo.getRetryState(id) : this.retries.get(id) ?? null;
  }
  private async saveRetry(id: string, owner: string, value: ReconciliationRetry | null): Promise<void> {
    if (durable(this.repo)) await this.repo.setRetryState(id, owner, value);
    else if (value) this.retries.set(id, value);
    else this.retries.delete(id);
  }
  private async deferRetry(id: string, owner: string, state: ReconciliationRetry['state']): Promise<void> {
    const previous = await this.retryState(id);
    await this.saveRetry(id, owner, nextRetry(previous, state, this.now()));
    // Health probe failures are quiet. Pending cleanup gets one transition per
    // retry episode, regardless of how many attempts reconciliation makes.
    if (state === 'cleanup' && previous?.state !== 'cleanup') {
      await this.recordEvent(id, owner, 'cleanup_retry', 'Cleanup is incomplete. Automatic retries will continue with a bounded delay.', 'cleanup_pending');
    }
  }
  private async clearRetry(id: string, owner: string): Promise<void> {
    if (await this.retryState(id)) await this.saveRetry(id, owner, null);
  }
  private async recordEvent(id: string, owner: string, kind: string, message: string, expectedState?: Session['state']): Promise<void> {
    if (durable(this.repo)) await this.repo.eventUnderLease(id, owner, kind, message, expectedState);
    else await this.repo.event(id, kind, message);
  }
  private async require(id: string): Promise<Session> {
    const session = await this.repo.get(id);
    if (!session) throw new SessionOperationError('Session not found.');
    return session;
  }

  private async provision(id: string, owner: string) {
    let session = await this.require(id);
    if (session.state !== 'provisioning') return this.cleanup(id, owner);
    let creationStarted = false;
    let createdRecorded = false;
    let returnedId: string | undefined;
    try {
      const token = await this.credentials.issue(session);
      session = await this.require(id);
      if (session.state !== 'provisioning' || this.now() >= Date.parse(session.expiresAt)) return this.cleanup(id, owner);
      // Persist before the external request. A crashed/ambiguous create may have made a VM.
      // E2B create has a 60s request deadline; add a 2-minute cushion to its bounded TTL.
      const uncertaintyUntil = new Date(Date.parse(session.expiresAt) + 120_000).toISOString();
      if (durable(this.repo)) await this.repo.beginCreationAttempt(id, owner, uncertaintyUntil);
      else {
        if (this.attempts.has(id)) throw new SessionOperationError('Sandbox creation was already attempted.');
        this.uncertainty.set(id, uncertaintyUntil);
        this.attempts.set(id, { status: 'pending', reason: 'request_started', sandboxId: null, uncertaintyUntil, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      }
      creationStarted = true;
      const sandboxId = returnedId = await this.provider.create(session, token);
      this.resourceHints.set(id, sandboxId);
      if (durable(this.repo)) await this.repo.recordCreationOutcome(id, owner, { status: 'created', reason: 'resource_created', sandboxId });
      else Object.assign(this.attempts.get(id)!, { status: 'created', reason: 'resource_created', sandboxId });
      createdRecorded = true;
      session = await this.require(id);
      session.sandboxId = sandboxId;
      // Persist the ID before ANY preparation command.
      await this.save(session, owner);
      if (session.state !== 'provisioning') return this.cleanup(id, owner);
      await this.provider.prepare(session);
      session = await this.require(id);
      if (session.state !== 'provisioning' || this.now() >= Date.parse(session.expiresAt)) return this.cleanup(id, owner);
      session.state = 'running';
      await this.save(session, owner);
      await this.recordEvent(id, owner, 'running', 'Sandbox ready. Run codex login --device-auth for a fresh sign-in.');
    } catch (error) {
      if (creationStarted && !createdRecorded) {
        const knownId = returnedId ?? (error instanceof SandboxCreationError ? error.knownSandboxId : undefined);
        if (knownId) this.resourceHints.set(id, knownId);
        const status = error instanceof SandboxCreationError ? error.outcome : 'unknown';
        const reason = returnedId ? 'resource_record_failed' : error instanceof SandboxCreationError ? error.reason : 'request_uncertain';
        if (durable(this.repo)) await this.repo.recordCreationOutcome(id, owner, { status, reason, sandboxId: knownId }).catch(() => {});
        else Object.assign(this.attempts.get(id)!, { status, reason, sandboxId: knownId ?? null });
      }
      session = await this.require(id);
      if (session.state === 'provisioning') {
        session.state = 'cleanup_pending';
        session.error = error instanceof ContinuationSourceChangedError
          ? new ContinuationSourceChangedError().message
          : 'Sandbox provisioning did not complete. Cleanup is being retried.';
        await this.save(session, owner);
        await this.recordEvent(id, owner, 'provision_failed', session.error);
      }
      await this.cleanup(id, owner);
    }
  }

  async stop(id: string): Promise<Session> {
    if (this.closed) throw new SessionOperationError('Session service is shutting down.');
    let session = await this.require(id);
    if (session.state === 'ended' || session.state === 'failed') return session;
    if (durable(this.repo)) await this.repo.requestStop(id);
    else { session.state = 'cleanup_pending'; this.retries.delete(id); await this.repo.update(session); }
    // Disable the gateway immediately, including while a provisioning command is in flight.
    await this.credentials.disable(id).catch(() => {});
    this.schedule(id, owner => this.cleanup(id, owner));
    session = await this.require(id);
    return session;
  }

  async extend(id: string, minutes: number, beforeExtend?: (session: Session) => Promise<void>): Promise<Session> {
    if (this.closed) throw new SessionOperationError('Session service is shutting down.');
    if (this.options.maxHours === 1) throw new SessionOperationError('This deployment has a one-hour maximum. Extensions are disabled.');
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new SessionOperationError('Extension must be between 1 and 60 minutes.');
    if (this.tasks.has(id)) throw new SessionOperationError('Session operation in progress. Try again shortly.');
    let result: Session | undefined;
    const operation = this.withLease(id, async owner => {
      let session = await this.require(id);
      if (session.state !== 'running' || !session.sandboxId || this.now() >= Date.parse(session.expiresAt)) throw new SessionOperationError('Only an active, unexpired session can be extended.');
      if (beforeExtend) {
        const identity = (value: Session) => JSON.stringify([value.id, value.userId, value.repository, value.repositoryId, value.installationId,
          value.branch, value.baseBranch, value.createdAt, value.sandboxId, value.expiresAt, value.maxExpiresAt, value.continuation, value.launchSource]);
        const reviewed = identity(session);
        await beforeExtend(structuredClone(session));
        session = await this.require(id);
        if (session.state !== 'running' || !session.sandboxId || this.now() >= Date.parse(session.expiresAt) || identity(session) !== reviewed) {
          throw new SessionOperationError('Session changed during authorization. Try again.');
        }
      }
      const next = Math.min(Date.parse(session.expiresAt) + minutes * 60_000, Date.parse(session.maxExpiresAt));
      if (next <= Date.parse(session.expiresAt)) throw new SessionOperationError('This session has reached its maximum lifetime of 4 hours.');
      // Persist first. A crash then cannot leave a remotely extended VM beyond the recorded deadline.
      const oldExpiry = session.expiresAt;
      session.expiresAt = new Date(next).toISOString();
      await this.save(session, owner);
      try { await this.provider.setTimeout(session.sandboxId, next - this.now()); }
      catch {
        session.expiresAt = oldExpiry;
        await this.save(session, owner);
        throw new SessionOperationError('Provider could not confirm the extension. The original deadline still applies.');
      }
      await this.recordEvent(id, owner, 'extended', `Deadline extended to ${session.expiresAt}.`);
      result = session;
    });
    this.tasks.set(id, operation.then(() => {}, () => {}));
    try { await operation; } finally { this.tasks.delete(id); }
    if (!result) throw new SessionOperationError('Another worker is updating this session. Try again shortly.');
    return result;
  }

  async retryCleanup(id: string): Promise<Session> {
    if (this.closed) throw new SessionOperationError('Session service is shutting down.');
    const session = await this.require(id);
    if (session.state !== 'cleanup_pending') throw new SessionOperationError('This session has no pending cleanup.');
    this.schedule(id, owner => this.cleanup(id, owner));
    return this.require(id);
  }

  private async cleanup(id: string, owner: string): Promise<void> {
    const session = await this.require(id);
    if (session.state === 'ended' || session.state === 'failed') return;
    const previousCodex = session.cleanup.codex;
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
      const attempt = durable(this.repo) ? await this.repo.creationAttempt(id) : this.attempts.get(id);
      const hint = this.resourceHints.get(id);
      const ids = [...new Set([session.sandboxId, attempt?.sandboxId, hint, ...discovered].filter((value): value is string => !!value))];
      const until = attempt?.uncertaintyUntil ?? (durable(this.repo) ? await this.repo.uncertaintyUntil(id) : this.uncertainty.get(id));
      const unresolvedCreate = attempt ? attempt.status === 'pending' || attempt.status === 'unknown' : !session.sandboxId && !!until;
      let confirmed = true;
      let logoutConfirmed = true;
      let anyLive = false;
      for (const sandboxId of ids) {
        if (!await this.provider.exists(sandboxId)) continue;
        anyLive = true;
        try { logoutConfirmed = await this.provider.cleanupCodex(sandboxId, session) && logoutConfirmed; }
        catch { logoutConfirmed = false; }
        try { await this.provider.kill(sandboxId); }
        catch { /* Check existence below: a response can fail after successful deletion. */ }
        if (await this.provider.exists(sandboxId)) confirmed = false;
      }
      // With no recorded ID, a timed-out create can finish after the first discovery pass.
      if (unresolvedCreate && until && this.now() < Date.parse(until)) confirmed = false;
      // TTL is a bound, not deletion evidence. Without metadata discovery an
      // ambiguous create must stay pending even after its nominal timeout.
      if (!this.provider.discover && unresolvedCreate) confirmed = false;
      session.cleanup.vm = confirmed ? 'confirmed' : 'pending';
      if (anyLive) session.cleanup.codex = logoutConfirmed ? 'confirmed' : confirmed ? 'not_applicable' : 'failed';
      else if (session.cleanup.codex !== 'confirmed') session.cleanup.codex = confirmed ? 'not_applicable' : 'pending';
      if (anyLive && !logoutConfirmed && previousCodex !== 'failed') await this.recordEvent(id, owner, 'codex_logout_unconfirmed', 'Codex logout was not confirmed. VM destruction removes local credentials; remote authorization revocation remains unverified.');
    } catch { session.cleanup.vm = 'failed'; }
    const complete = session.cleanup.vm === 'confirmed' && session.cleanup.gateway === 'confirmed' && session.cleanup.github === 'confirmed';
    if (complete) {
      session.state = session.error ? 'failed' : 'ended';
      session.endedAt = new Date(this.now()).toISOString();
    }
    await this.save(session, owner);
    if (complete) {
      await this.clearRetry(id, owner);
      await this.recordEvent(id, owner, 'ended', 'VM deletion and gateway/GitHub credential cleanup confirmed. Codex remote revocation remains unverified.');
    } else await this.deferRetry(id, owner, 'cleanup');
  }

  /** Operator recovery waits for this exact target and never interrupts an active worker. */
  async reconcileOne(id: string): Promise<Session> {
    if (this.closed) throw new SessionOperationError('Session service is shutting down.');
    if (this.tasks.has(id)) throw new SessionOperationError('Session operation is already in progress.');
    const target = await this.require(id);
    if (target.state !== 'provisioning' && target.state !== 'cleanup_pending') throw new SessionOperationError('Only abandoned provisioning or pending cleanup can be reconciled.');
    // Recheck after the read; an in-process create may have scheduled its worker meanwhile.
    if (this.closed) throw new SessionOperationError('Session service is shutting down.');
    if (this.tasks.has(id)) throw new SessionOperationError('Session operation is already in progress.');
    const work = this.withLease(id, async owner => {
      const current = await this.require(id);
      if (current.state !== 'provisioning' && current.state !== 'cleanup_pending') throw new SessionOperationError('Session is no longer eligible for reconciliation.');
      if (current.state === 'provisioning') {
        current.error ??= 'Provisioning was interrupted. Recovering and cleaning up any sandbox.';
        current.state = 'cleanup_pending';
        await this.save(current, owner);
      }
      await this.cleanup(id, owner);
      return this.require(id);
    });
    this.tasks.set(id, work.then(() => {}, () => {}));
    try {
      const result = await work;
      if (!result) throw new SessionOperationError('Another worker holds this session lease.');
      return result;
    } finally { this.tasks.delete(id); }
  }

  async reconcile(): Promise<void> {
    if (this.closed) return;
    const sessions = durable(this.repo) ? await this.repo.listActive() : await this.repo.list();
    for (const session of sessions) {
      if (this.closed) return;
      // Expiry is independent of health retry timing and immediately disables
      // the gateway through the same stop path used by an explicit request.
      if (session.state === 'running' && this.now() >= Date.parse(session.expiresAt)) {
        await this.stop(session.id);
        continue;
      }
      if (this.tasks.has(session.id)) continue;
      if (session.state !== 'provisioning' && session.state !== 'cleanup_pending' && session.state !== 'running') continue;
      const state = session.state === 'running' ? 'health' : 'cleanup';
      if (!retryDue(await this.retryState(session.id), state, this.now())) continue;
      this.schedule(session.id, async owner => {
        let current = await this.require(session.id);
        if (current.state === 'ended' || current.state === 'failed') return;
        if (current.state === 'running' && this.now() >= Date.parse(current.expiresAt)) {
          if (durable(this.repo)) await this.repo.requestStop(current.id);
          else { current.state = 'cleanup_pending'; this.retries.delete(current.id); await this.repo.update(current); }
          await this.credentials.disable(current.id).catch(() => {});
          return this.cleanup(current.id, owner);
        }
        const retryKind = current.state === 'running' ? 'health' : 'cleanup';
        if (!retryDue(await this.retryState(current.id), retryKind, this.now())) return;
        if (current.state === 'provisioning') {
          // Never replay creation after an ambiguous or interrupted request.
          current.error ??= 'Provisioning was interrupted. Recovering and cleaning up any sandbox.';
          current.state = 'cleanup_pending';
          await this.save(current, owner);
          return this.cleanup(current.id, owner);
        }
        if (current.state === 'cleanup_pending') return this.cleanup(current.id, owner);
        let exists: boolean;
        try { exists = !!current.sandboxId && await this.provider.exists(current.sandboxId); }
        catch {
          current = await this.require(session.id);
          if (current.state !== 'running') return this.cleanup(current.id, owner);
          if (this.now() >= Date.parse(current.expiresAt)) {
            await this.stop(current.id);
            return this.cleanup(current.id, owner);
          }
          // A failed probe says nothing about deletion. Retain the running
          // state and persist only a bounded, sanitized retry schedule.
          await this.deferRetry(current.id, owner, 'health');
          return;
        }
        current = await this.require(session.id);
        if (current.state !== 'running') return this.cleanup(current.id, owner);
        if (this.now() >= Date.parse(current.expiresAt)) {
          await this.stop(current.id);
          return this.cleanup(current.id, owner);
        }
        if (!exists) {
          current.state = 'cleanup_pending';
          current.error = 'Sandbox is no longer available. Cleaning up its credentials.';
          await this.save(current, owner);
          await this.cleanup(current.id, owner);
        } else await this.clearRetry(current.id, owner);
      });
    }
  }

  /** Server shutdown preserves active VMs; browser/server disconnection does not end a session. */
  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.tasks.values()]);
  }
}
