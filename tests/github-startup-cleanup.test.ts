import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createApplication } from '../server/app.js';
import { readConfig } from '../server/config.js';
import type { Database } from '../server/contracts.js';
import { GitHubAPI } from '../server/github/api.js';
import { GitGateway } from '../server/github/gateway.js';
import { createGitHubServices, type GitHubOptions } from '../server/github/index.js';
import { CredentialStore } from '../server/github/store.js';

const control = vi.hoisted(() => ({
  query: vi.fn(), close: vi.fn(), createServer: vi.fn(), chmod: vi.fn(), mkdtemp: vi.fn(), rm: vi.fn(),
  events: [] as string[],
}));
vi.mock('../server/db.js', () => ({ openDatabase: async () => ({ query: control.query, close: control.close }) }));
vi.mock('../server/infra/e2b.js', () => ({ E2BProvider: class {} }));
vi.mock('node:http', async importOriginal => ({ ...await importOriginal<typeof import('node:http')>(), createServer: control.createServer }));
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  chmod: control.chmod, mkdtemp: control.mkdtemp, rm: control.rm,
}));
vi.mock('node:crypto', async importOriginal => ({
  ...await importOriginal<typeof import('node:crypto')>(),
  randomBytes: (size: number) => Buffer.alloc(size, 7),
}));

const root = '/tmp/ep-gh-Abc123';
const key = Buffer.alloc(32, 1).toString('base64');
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
class FakeServer extends EventEmitter {
  listening = false;
  listen = vi.fn((_socket: string) => {
    this.listening = true;
    queueMicrotask(() => this.emit('listening'));
    return this;
  });
  close = vi.fn((callback: (error?: Error) => void) => {
    control.events.push('listener-close');
    this.listening = false;
    queueMicrotask(() => callback());
    return this;
  });
  closeIdleConnections = vi.fn();
  closeAllConnections = vi.fn();
}
let servers: FakeServer[];
let forgetRoot: MockInstance<CredentialStore['forgetRoot']>;
let retryRotated: MockInstance<CredentialStore['retryRotated']>;
const db: Database = { query: control.query, close: control.close };
function options(overrides: Partial<GitHubOptions> = {}): GitHubOptions {
  return {
    db, appId: 'fixture', privateKey: '', encryptionKey: key, appSlug: 'fixture',
    publicUrl: 'https://control.example.invalid', getSession: async () => null,
    pullRequests: { save: vi.fn(), list: vi.fn(async () => []) }, ...overrides,
  };
}
function application() {
  const config = { ...readConfig({ EPHEMERAL_MODE: 'preview', ENCRYPTION_KEY: key }), mode: 'live' as const };
  return createApplication(config, { shutdownTimeoutMs: 500 });
}
function gateway() {
  return new GitGateway(new CredentialStore(db, Buffer.from(key, 'base64'), new GitHubAPI('fixture', '', 'fixture')), { getSession: async () => null });
}
beforeEach(() => {
  servers = [];
  control.events.length = 0;
  control.query.mockResolvedValue({ rows: [] });
  control.close.mockImplementation(async () => { control.events.push('database-close'); });
  control.chmod.mockResolvedValue(undefined);
  control.mkdtemp.mockResolvedValue(root);
  control.rm.mockImplementation(async () => { control.events.push('root-remove'); });
  control.createServer.mockImplementation((handler: (...args: unknown[]) => void) => {
    const server = new FakeServer();
    server.on('request', handler);
    servers.push(server);
    return server as unknown as Server;
  });
  vi.spyOn(CredentialStore.prototype, 'disks').mockResolvedValue([]);
  vi.spyOn(CredentialStore.prototype, 'roots').mockResolvedValue([]);
  vi.spyOn(CredentialStore.prototype, 'recordRoot').mockImplementation(async () => { control.events.push('root-record'); });
  forgetRoot = vi.spyOn(CredentialStore.prototype, 'forgetRoot').mockImplementation(async () => { control.events.push('root-forget'); });
  retryRotated = vi.spyOn(CredentialStore.prototype, 'retryRotated').mockResolvedValue(undefined);
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network access is outside this fixture.'); }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('GitHub startup cleanup ownership', () => {
  it('registers cleanup before starting the gateway or retrying rotated tokens', async () => {
    const registered: (() => Promise<void>)[] = [];
    const registerClose = vi.fn((close: () => Promise<void>) => { registered.push(close); });
    const started = deferred();
    vi.spyOn(GitGateway.prototype, 'start').mockImplementation(async () => {
      expect(registerClose).toHaveBeenCalledOnce();
      await started.promise;
    });
    const failure = new Error('Retry failed');
    retryRotated.mockImplementation(async () => {
      expect(registerClose).toHaveBeenCalledOnce();
      throw failure;
    });
    const opening = createGitHubServices(options({ registerClose }));
    const rejected = expect(opening).rejects.toBe(failure);
    await vi.waitFor(() => expect(registerClose).toHaveBeenCalledOnce());
    expect(retryRotated).not.toHaveBeenCalled();
    started.resolve();
    await rejected;
    await registered[0]();
    expect(control.close).not.toHaveBeenCalled();
  });

  it('closes a partially started listener and root before the application releases its database', async () => {
    const failure = new Error('Socket permission setup failed');
    control.chmod.mockImplementation(async (path: string) => {
      if (path.endsWith('gate.sock')) throw failure;
    });
    const cleanup = deferred();
    forgetRoot.mockImplementation(async () => { control.events.push('root-forget-start'); await cleanup.promise; control.events.push('root-forget-finished'); });
    const opening = application();
    const rejected = expect(opening).rejects.toBe(failure);
    await vi.waitFor(() => expect(forgetRoot).toHaveBeenCalledWith(root));
    expect(servers).toHaveLength(1);
    expect(servers[0].listen).toHaveBeenCalledWith(`${root}/gate.sock`);
    expect(servers[0].close).toHaveBeenCalledOnce();
    expect(servers[0].listening).toBe(false);
    expect(control.close).not.toHaveBeenCalled();
    expect(retryRotated).not.toHaveBeenCalled();
    cleanup.resolve();
    await rejected;
    expect(control.events).toEqual(['root-record', 'listener-close', 'root-remove', 'root-forget-start', 'root-forget-finished', 'database-close']);
  });

  it('uses the registered gateway cleanup when rotated-token retry fails before services are returned', async () => {
    const failure = new Error('Rotated-token retry failed');
    retryRotated.mockRejectedValueOnce(failure);
    const cleanup = deferred();
    forgetRoot.mockImplementation(async () => { control.events.push('root-forget-start'); await cleanup.promise; control.events.push('root-forget-finished'); });
    const opening = application();
    const rejected = expect(opening).rejects.toBe(failure);
    await vi.waitFor(() => expect(forgetRoot).toHaveBeenCalledWith(root));
    expect(servers[0].close).toHaveBeenCalledOnce();
    expect(control.close).not.toHaveBeenCalled();
    cleanup.resolve();
    await rejected;
    expect(control.events).toEqual(['root-record', 'listener-close', 'root-remove', 'root-forget-start', 'root-forget-finished', 'database-close']);
  });

  it('retains database ownership when cleanup itself rejects after startup failure', async () => {
    const failure = new Error('Rotated-token retry failed');
    retryRotated.mockRejectedValueOnce(failure);
    forgetRoot.mockRejectedValueOnce(new Error('Cleanup persistence failed'));
    await expect(application()).rejects.toBe(failure);
    expect(servers[0].close).toHaveBeenCalledOnce();
    expect(control.close).not.toHaveBeenCalled();
  });

  it('cleans up failed standalone services when no application registrar owns them', async () => {
    const failure = new Error('Rotated-token retry failed');
    retryRotated.mockRejectedValueOnce(failure);
    await expect(createGitHubServices(options())).rejects.toBe(failure);
    expect(servers[0].close).toHaveBeenCalledOnce();
    expect(forgetRoot).toHaveBeenCalledWith(root);
    expect(control.close).not.toHaveBeenCalled();
  });
});

describe('Git gateway shutdown admission and draining', () => {
  it('stops new admission and drains an admitted serialize action before removing its root', async () => {
    const subject = gateway();
    await subject.start();
    const held = deferred<number>();
    const entered = deferred();
    const active = subject.serialize('session', async () => { entered.resolve(); return held.promise; });
    await entered.promise;
    const queuedAction = vi.fn(async () => 2);
    const queued = subject.serialize('session', queuedAction);
    const queuedRejected = expect(queued).rejects.toThrow('shutting down');
    const close = subject.close();
    expect(subject.close()).toBe(close);
    await expect(subject.serialize('another', async () => 3)).rejects.toThrow('shutting down');
    await expect(subject.authorize('another', true)).rejects.toThrow('shutting down');
    await expect(subject.disable('another')).rejects.toThrow('shutting down');
    expect(servers[0].close).toHaveBeenCalledOnce();
    expect(control.rm).not.toHaveBeenCalled();
    held.resolve(42);
    await expect(active).resolves.toBe(42);
    await queuedRejected;
    await close;
    expect(queuedAction).not.toHaveBeenCalled();
    expect(control.rm).toHaveBeenCalledWith(root, { recursive: true, force: true });
    expect(forgetRoot).toHaveBeenCalledWith(root);
  });

  it('waits for an admitted hook handler after closing its listener and blocks its later authorization', async () => {
    const subject = gateway();
    const enabled = vi.spyOn(CredentialStore.prototype, 'enabled').mockResolvedValue(true);
    await subject.start();
    const body = deferred();
    const entered = deferred();
    const request = {
      method: 'POST', url: '/', headers: { authorization: `Bearer ${Buffer.alloc(32, 7).toString('hex')}` },
      async *[Symbol.asyncIterator]() { entered.resolve(); await body.promise; yield Buffer.from(JSON.stringify({ sessionId: 'session' })); },
    };
    const response = { destroyed: false, writeHead: vi.fn(), end: vi.fn() };
    response.writeHead.mockReturnValue(response);
    response.end.mockReturnValue(response);
    servers[0].emit('request', request, response);
    await entered.promise;
    const close = subject.close();
    let closed = false;
    const drained = close.then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(servers[0].listening).toBe(false);
    expect(closed).toBe(false);
    expect(control.rm).not.toHaveBeenCalled();
    body.resolve();
    await drained;
    expect(enabled).not.toHaveBeenCalled();
    expect(response.writeHead).toHaveBeenCalledWith(403);
    expect(forgetRoot).toHaveBeenCalledWith(root);
  });
});
