import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import type { Database } from './contracts.js';

export async function openDatabase(databaseUrl: string | undefined, dataDir: string): Promise<Database> {
  if (databaseUrl) {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
    const lock = await pool.connect();
    const { rows } = await lock.query('SELECT pg_try_advisory_lock(378120985) AS acquired');
    if (!rows[0]?.acquired) { lock.release(); await pool.end(); throw new Error('Another Ephemeral control plane holds the database lock. Run one instance.'); }
    return {
      async query<T>(sql: string, params: unknown[] = []) { return { rows: (await pool.query(sql, params)).rows as T[] }; },
      async close() { await lock.query('SELECT pg_advisory_unlock(378120985)'); lock.release(); await pool.end(); },
    };
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = join(dataDir, 'control-plane.lock');
  async function acquire() {
    try { return await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A stale-file check followed by unlink can delete a competing starter's
      // newly acquired lock. Leave every existing lock in place and fail closed.
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
  return { async query<T>(sql: string, params: unknown[] = []) { return { rows: (await db.query<T>(sql, params)).rows }; }, async close() { await db.close(); await lock.close(); await unlink(lockPath); } };
}
