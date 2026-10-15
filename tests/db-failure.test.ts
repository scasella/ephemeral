import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { openDatabase } from '../server/db.js';

const embedded = vi.hoisted(() => ({
  waitReady: Promise.resolve(), query: vi.fn(), close: vi.fn(),
}));
vi.mock('@electric-sql/pglite', () => ({ PGlite: function () { return embedded; } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class LockClient extends EventEmitter {
  query = vi.fn(async () => ({ rows: [{ acquired: true }] }));
  release = vi.fn(() => { this.emit('end'); });
}
class Pool extends EventEmitter {
  lock = new LockClient();
  connect = vi.fn(async () => this.lock);
  query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [{ value: 42 }] }));
  end = vi.fn(async () => {});
}
let pool: Pool;
let constructor: ReturnType<typeof vi.spyOn>;
const directories: string[] = [];
beforeEach(() => {
  pool = new Pool();
  constructor = vi.spyOn(pg, 'Pool').mockImplementation(function () { return pool as unknown as pg.Pool; });
  embedded.query.mockResolvedValue({ rows: [] });
  embedded.close.mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const url = 'postgresql://example.invalid/ephemeral';
describe('PostgreSQL connection failure handling', () => {
  it('configures finite connection/query/statement limits and TCP keepalive', async () => {
    const db = await openDatabase(url, 'unused');
    expect(constructor).toHaveBeenCalledWith(expect.objectContaining({
      connectionString: url,
      connectionTimeoutMillis: 3000, query_timeout: 5500, statement_timeout: 5000,
      keepAlive: true, keepAliveInitialDelayMillis: 1000,
    }));
    expect(constructor.mock.calls[0][0]).not.toHaveProperty('ssl');
    await db.close();
  });

  it('handles an idle pool error and permits query-client recovery without fatal notification', async () => {
    const db = await openDatabase(url, 'unused');
    const fatal = vi.fn();
    db.onFatal!(fatal);
    expect(() => pool.emit('error', new Error('idle backend terminated'), new EventEmitter())).not.toThrow();
    expect((await db.query<{ value: number }>('SELECT 42 AS value')).rows[0].value).toBe(42);
    expect(fatal).not.toHaveBeenCalled();
    await db.close();
  });

  it.each(['error', 'end'])('permanently rejects calls after singleton connection %s', async event => {
    const db = await openDatabase(url, 'unused');
    const fatal = vi.fn();
    db.onFatal!(fatal);
    pool.lock.emit(event, new Error('private network diagnostic'));
    pool.lock.emit('error', new Error('second event'));
    expect(fatal).toHaveBeenCalledTimes(1);
    await expect(db.query('SELECT 1')).rejects.toThrow('Database ownership was lost');
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    db.onFatal!(late);
    expect(late).toHaveBeenCalledTimes(1);
    await db.close();
    expect(pool.lock.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('allows fatal listeners to unsubscribe and isolates listener exceptions', async () => {
    const db = await openDatabase(url, 'unused');
    const unsubscribed = vi.fn();
    db.onFatal!(unsubscribed)();
    db.onFatal!(() => { throw new Error('subscriber'); });
    const fatal = vi.fn();
    db.onFatal!(fatal);
    expect(() => pool.lock.emit('error', new Error('disconnected'))).not.toThrow();
    expect(unsubscribed).not.toHaveBeenCalled();
    expect(fatal).toHaveBeenCalledTimes(1);
    await db.close();
  });

  it('drains existing queries before destroying lock ownership and fences new calls immediately', async () => {
    const db = await openDatabase(url, 'unused');
    const result = deferred<{ rows: { value: number }[] }>();
    pool.query.mockReturnValueOnce(result.promise);
    const query = db.query('SELECT 42');
    const close = db.close();
    expect(db.close()).toBe(close);
    await expect(db.query('SELECT 1')).rejects.toThrow('Database is closing');
    expect(pool.lock.release).not.toHaveBeenCalled();
    result.resolve({ rows: [{ value: 42 }] });
    await query;
    await close;
    expect(pool.lock.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('bounds a hung drain and retains the singleton session until process termination', async () => {
    vi.useFakeTimers();
    const db = await openDatabase(url, 'unused');
    const result = deferred<{ rows: { value: number }[] }>();
    pool.query.mockReturnValueOnce(result.promise);
    const query = db.query('SELECT 42');
    const close = db.close();
    const rejected = expect(close).rejects.toThrow('Database shutdown timed out');
    await vi.advanceTimersByTimeAsync(6000);
    await rejected;
    expect(pool.lock.release).not.toHaveBeenCalled();
    expect(pool.end).not.toHaveBeenCalled();
    result.resolve({ rows: [] });
    await query;
    expect(pool.lock.release).not.toHaveBeenCalled();
  });

  it('bounds a hung pool shutdown and makes close idempotent after ownership was drained', async () => {
    vi.useFakeTimers();
    const db = await openDatabase(url, 'unused');
    pool.end.mockReturnValueOnce(new Promise<void>(() => {}));
    const close = db.close();
    const rejected = expect(close).rejects.toThrow('Database shutdown timed out');
    await vi.advanceTimersByTimeAsync(6000);
    await rejected;
    expect(db.close()).toBe(close);
    expect(pool.lock.release).toHaveBeenCalledTimes(1);
  });

  it('waits for the singleton session to end even when pool shutdown resolves first', async () => {
    const db = await openDatabase(url, 'unused');
    pool.lock.release.mockImplementationOnce(() => {});
    let closed = false;
    const close = db.close().then(() => { closed = true; });
    await vi.waitFor(() => { expect(pool.end).toHaveBeenCalledTimes(1); });
    expect(closed).toBe(false);
    pool.lock.emit('end');
    await close;
    expect(closed).toBe(true);
  });

  it.each(['connect', 'query', 'contention', 'loss'])('cleans up pool after startup failure (%s)', async failure => {
    if (failure === 'connect') pool.connect.mockRejectedValueOnce(new Error('connect failed'));
    if (failure === 'query') pool.lock.query.mockRejectedValueOnce(new Error('query failed'));
    if (failure === 'contention') pool.lock.query.mockResolvedValueOnce({ rows: [{ acquired: false }] });
    if (failure === 'loss') pool.lock.query.mockImplementationOnce(async () => {
      pool.lock.emit('end');
      return { rows: [{ acquired: true }] };
    });
    await expect(openDatabase(url, 'unused')).rejects.toThrow();
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(pool.lock.release).toHaveBeenCalledTimes(failure === 'connect' ? 0 : 1);
  });

  it('bounds cleanup when pool shutdown hangs after a failed connection attempt', async () => {
    vi.useFakeTimers();
    pool.connect.mockRejectedValueOnce(new Error('connection failed'));
    pool.end.mockReturnValueOnce(new Promise<void>(() => {}));
    const opening = openDatabase(url, 'unused');
    const rejected = expect(opening).rejects.toThrow('Database shutdown timed out');
    await vi.advanceTimersByTimeAsync(6000);
    await rejected;
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('does not report intentional singleton-session destruction as a fatal loss', async () => {
    const db = await openDatabase(url, 'unused');
    const fatal = vi.fn();
    db.onFatal!(fatal);
    await db.close();
    expect(fatal).not.toHaveBeenCalled();
  });
});

describe('PGlite ownership during failed shutdown', () => {
  async function local() {
    const path = await mkdtemp(join(tmpdir(), 'ephemeral-db-failure-'));
    directories.push(path);
    return { path, db: await openDatabase(undefined, path) };
  }

  it('keeps the lock until embedded close confirms completion', async () => {
    const { path, db } = await local();
    const finished = deferred<void>();
    embedded.close.mockReturnValueOnce(finished.promise);
    const close = db.close();
    expect(await readFile(join(path, 'control-plane.lock'), 'utf8')).toBe(String(process.pid));
    await expect(db.query('SELECT 1')).rejects.toThrow('Database is closing');
    finished.resolve();
    await close;
    await expect(readFile(join(path, 'control-plane.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains the lock when embedded close fails', async () => {
    const { path, db } = await local();
    embedded.close.mockRejectedValueOnce(new Error('cannot flush'));
    await expect(db.close()).rejects.toThrow('cannot flush');
    expect(await readFile(join(path, 'control-plane.lock'), 'utf8')).toBe(String(process.pid));
    await expect(openDatabase(undefined, path)).rejects.toThrow('Local database lock exists');
  });

  it('retains the lock until a hanging embedded close eventually confirms safety', async () => {
    const { path, db } = await local();
    vi.useFakeTimers();
    const finished = deferred<void>();
    embedded.close.mockReturnValueOnce(finished.promise);
    const close = db.close();
    const rejected = expect(close).rejects.toThrow('Database shutdown timed out');
    await vi.advanceTimersByTimeAsync(6000);
    await rejected;
    expect(await readFile(join(path, 'control-plane.lock'), 'utf8')).toBe(String(process.pid));
    finished.resolve();
    // Completing safe close may now release ownership, even after the caller's
    // deadline. It must never release it while embedded work could still run.
    await vi.waitFor(async () => {
      await expect(readFile(join(path, 'control-plane.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('retains the lock throughout a hung embedded query and bounded drain failure', async () => {
    const { path, db } = await local();
    vi.useFakeTimers();
    const finished = deferred<{ rows: unknown[] }>();
    embedded.query.mockReturnValueOnce(finished.promise);
    const query = db.query('INSERT INTO durable_state VALUES (1)');
    const close = db.close();
    const rejected = expect(close).rejects.toThrow('Database shutdown timed out');
    await vi.advanceTimersByTimeAsync(6000);
    await rejected;
    expect(embedded.close).not.toHaveBeenCalled();
    expect(await readFile(join(path, 'control-plane.lock'), 'utf8')).toBe(String(process.pid));
    finished.resolve({ rows: [] });
    await query;
    expect(await readFile(join(path, 'control-plane.lock'), 'utf8')).toBe(String(process.pid));
  });
});
