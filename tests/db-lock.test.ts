import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { openDatabase } from '../server/db.js';
import type { Database } from '../server/contracts.js';

const directories: string[] = [];
const databases: Database[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'ephemeral-db-lock-'));
  directories.push(path);
  return path;
}
async function open(path: string) {
  const db = await openDatabase(undefined, path);
  databases.push(db);
  return db;
}
async function close(db: Database) {
  await db.close();
  databases.splice(databases.indexOf(db), 1);
}
afterEach(async () => {
  await Promise.all(databases.splice(0).map(db => db.close()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('exclusive local database ownership', () => {
  it('allows exactly one simultaneous starter and preserves its lock', async () => {
    const path = await directory();
    const results = await Promise.allSettled([open(path), open(path)]);
    const started = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');
    expect(started).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toContain('Local database lock exists');
    expect(await readFile(join(path, 'control-plane.lock'), 'utf8')).toBe(String(process.pid));
    expect((await databases[0].query<{ value: number }>('SELECT 42 AS value')).rows[0].value).toBe(42);
  }, 30_000);

  it('releases ownership on close and reopens the persisted database', async () => {
    const path = await directory();
    const first = await open(path);
    await first.query('CREATE TABLE persisted_value (value integer)');
    await first.query('INSERT INTO persisted_value VALUES (42)');
    await close(first);
    await expect(readFile(join(path, 'control-plane.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    const reopened = await open(path);
    expect((await reopened.query<{ value: number }>('SELECT value FROM persisted_value')).rows[0].value).toBe(42);
  }, 30_000);

  it.each(['2147483647', ''])('never removes an existing stale or incomplete lock (%j)', async contents => {
    const path = await directory();
    const lockPath = join(path, 'control-plane.lock');
    await writeFile(lockPath, contents);
    const results = await Promise.allSettled([open(path), open(path)]);
    expect(results.every(result => result.status === 'rejected')).toBe(true);
    for (const result of results) if (result.status === 'rejected') expect(result.reason.message).toContain('verify no control plane');
    expect(await readFile(lockPath, 'utf8')).toBe(contents);
  });

  it('releases its lock after database initialization fails', async () => {
    const path = await directory();
    const postgresPath = join(path, 'postgres');
    await writeFile(postgresPath, 'not a database directory');
    await expect(open(path)).rejects.toThrow();
    await expect(readFile(join(path, 'control-plane.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(postgresPath);
    expect((await (await open(path)).query<{ value: number }>('SELECT 42 AS value')).rows[0].value).toBe(42);
  }, 30_000);
});

describe('Compose PostgreSQL password transport', () => {
  it.each(['dummy#fragment', 'dummy/slash', 'dummy?query', 'dummy%percent', 'dummy@at'])('preserves delimiter characters in PGPASSWORD (%s)', password => {
    const previous = process.env.PGPASSWORD;
    process.env.PGPASSWORD = password;
    try {
      const client = new pg.Client({ connectionString: 'postgresql://ephemeral@postgres:5432/ephemeral' });
      expect(client.password).toBe(password);
      expect(client.host).toBe('postgres');
      expect(client.database).toBe('ephemeral');
    } finally {
      if (previous === undefined) delete process.env.PGPASSWORD;
      else process.env.PGPASSWORD = previous;
    }
  });
});
