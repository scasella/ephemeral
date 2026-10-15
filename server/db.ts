import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { parse } from 'pg-connection-string';
import type { Database } from './contracts.js';

const CLOSE_TIMEOUT_MS = 6_000;

/** Resolve pg's environment defaults before handing a selected snapshot to the pool. */
export function postgresConnectionConfig(databaseUrl: string, env: NodeJS.ProcessEnv): pg.ClientConfig & { replication: string } {
  const fromUrl = parse(databaseUrl);
  // pg gives nonempty URL values precedence over PG* defaults. In particular,
  // its parser returns password: '' for passwordless URLs; do not let that
  // discard the selected PGPASSWORD and fall back to the global environment.
  const parameterKeys = new Set(['host', 'port', 'user', 'database', 'password', 'options', 'client_encoding', 'ssl', 'sslnegotiation',
    'application_name', 'fallback_application_name', 'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'query_timeout', 'replication']);
  const urlValues = Object.fromEntries(Object.entries(fromUrl).filter(([key, value]) => parameterKeys.has(key) && value !== '' && value !== undefined && value !== null));
  const user = fromUrl.user || env.PGUSER || pg.defaults.user || userInfo().username;
  let ssl: pg.ClientConfig['ssl'] = pg.defaults.ssl;
  switch (env.PGSSLMODE) {
    case 'disable': ssl = false; break;
    case 'prefer': case 'require': case 'verify-ca': case 'verify-full': ssl = true; break;
    case 'no-verify': ssl = { rejectUnauthorized: false }; break;
  }
  return {
    host: env.PGHOST || pg.defaults.host,
    port: Number.parseInt(env.PGPORT || String(pg.defaults.port), 10),
    user,
    database: fromUrl.database || env.PGDATABASE || pg.defaults.database || user,
    // A callback also represents an explicitly cleared password without pg
    // consulting an inherited PGPASSWORD again. Delimiters remain literal.
    password: env.PGPASSWORD || (() => ''),
    // A whitespace options string is the empty PostgreSQL options list, while
    // remaining truthy to pg's environment fallback logic.
    options: env.PGOPTIONS || pg.defaults.options || ' ',
    client_encoding: env.PGCLIENT_ENCODING || pg.defaults.client_encoding || 'utf8',
    replication: env.PGREPLICATION || 'false',
    ssl,
    sslnegotiation: (env.PGSSLNEGOTIATION || pg.defaults.sslnegotiation || 'postgres') as pg.ClientConfig['sslnegotiation'],
    ...urlValues,
  };
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Database shutdown timed out.')), CLOSE_TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timer); }
}

/** Fence new calls synchronously, and retain ownership until existing calls finish. */
function managedDatabase(
  query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>,
  close: () => Promise<void>,
  fatal?: { failed: boolean; listeners: Set<() => void> },
): Database {
  const pending = new Set<Promise<unknown>>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      if (fatal?.failed) throw new Error('Database ownership was lost. Restart the control plane.');
      if (closing) throw new Error('Database is closing.');
      const operation = query(sql, params);
      pending.add(operation);
      try { return { rows: (await operation).rows as T[] }; }
      finally { pending.delete(operation); }
    },
    ...(fatal ? { onFatal(listener: () => void) {
      fatal.listeners.add(listener);
      if (fatal.failed) listener();
      return () => { fatal.listeners.delete(listener); };
    } } : {}),
    close() {
      closing = true;
      return closePromise ??= (async () => {
        await bounded(Promise.allSettled([...pending]));
        await bounded(close());
      })();
    },
  };
}

export async function openDatabase(databaseUrl: string | undefined, dataDir: string, env?: NodeJS.ProcessEnv): Promise<Database> {
  if (databaseUrl) {
    const pool = new pg.Pool({
      max: 10, application_name: 'ephemeral-control-plane',
      connectionTimeoutMillis: 3_000, query_timeout: 5_500, statement_timeout: 5_000,
      keepAlive: true, keepAliveInitialDelayMillis: 1_000,
      ...(env ? postgresConnectionConfig(databaseUrl, env) : { connectionString: databaseUrl }),
    });
    // pg evicts an errored idle client itself. A listener prevents an unhandled
    // EventEmitter error; a replacement query client can recover normally.
    pool.on('error', () => {});
    const fatal = { failed: false, listeners: new Set<() => void>() };
    let releasing = false;
    let lockEnded = false;
    const loseOwnership = () => {
      if (releasing || fatal.failed) return;
      fatal.failed = true;
      for (const listener of fatal.listeners) {
        try { listener(); } catch { /* Notify every subscriber even if one throws. */ }
      }
    };
    let lock: pg.PoolClient | undefined;
    async function disposePool() {
      releasing = true;
      let ended = Promise.resolve();
      if (lock) {
        // Pool.release removes a client from the pool before its socket ends.
        // Wait for this session too, so close confirms ownership was released.
        if (!lockEnded) ended = new Promise<void>(resolve => { lock!.once('end', resolve); });
        lock.release(true);
      }
      await Promise.all([ended, pool.end()]);
    }
    try {
      lock = await pool.connect();
      // The dedicated lock session never returns to the idle query pool.
      lock.on('error', loseOwnership);
      lock.on('end', () => { lockEnded = true; loseOwnership(); });
      const { rows } = await lock.query('SELECT pg_try_advisory_lock(378120985) AS acquired');
      if (!rows[0]?.acquired) throw new Error('Another Ephemeral control plane holds the database lock. Run one instance.');
      if (fatal.failed) throw new Error('Database ownership was lost during initialization.');
    } catch (error) {
      await bounded(disposePool());
      throw error;
    }
    return managedDatabase((sql, params) => pool.query(sql, params), async () => {
      // Destroying the session releases its advisory lock, after application
      // calls have drained. An explicit unlock query would add another race.
      await disposePool();
    }, fatal);
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = join(dataDir, 'control-plane.lock');
  async function acquire() {
    try { return await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Never delete a potentially competing starter's newly acquired lock.
      throw new Error(`Local database lock exists at ${lockPath}. Inspect the recorded process and verify no control plane uses this directory before removing the lock and restarting.`);
    }
  }
  const lock = await acquire();
  let db: PGlite;
  try {
    await lock.writeFile(String(process.pid));
    db = new PGlite(join(dataDir, 'postgres'));
    await db.waitReady;
  }
  catch (error) { await lock.close(); await unlink(lockPath); throw error; }
  return managedDatabase((sql, params) => db.query(sql, params), async () => {
    await db.close();
    // A failed or hanging database close must leave the ownership file intact.
    await lock.close();
    await unlink(lockPath);
  });
}
