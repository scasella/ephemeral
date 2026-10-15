#!/usr/bin/env node
// Uses only disposable Docker resources and generated test configuration. Never loads .env.
import assert from 'node:assert/strict';
import { checkDockerContext } from './docker-context-check.mjs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const [image = 'ephemeral:release-candidate', postgresImage = 'postgres:17-bookworm', ...extra] = process.argv.slice(2);
if (extra.length || image.startsWith('-') || postgresImage.startsWith('-')) {
  throw new Error('Usage: node scripts/container-smoke.mjs [app-image] [postgres-image]');
}
const prefix = `ephemeral-smoke-${randomBytes(6).toString('hex')}`;
const containers = new Set();
const volumes = new Set();
let networkCreated = false;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = true; });

function docker(args, { allowFailure = false, timeout = 30_000 } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 });
  if (!allowFailure && (result.error || result.status !== 0)) {
    // Container environments below contain test values only; never inspect the host environment.
    throw new Error(`Docker ${args[0]} failed: ${result.error?.message || result.stderr || result.stdout}`);
  }
  return result;
}
const output = args => docker(args).stdout.trim();
function check(label, action) {
  if (interrupted) throw new Error('Smoke test interrupted');
  action();
  console.log(`PASS ${label}`);
}
function nodeArgs(source) { return ['node', '--import', 'tsx', '--input-type=module', '-e', source]; }
function isolated(source, args = []) {
  return docker(['run', '--rm', '--network', 'none', ...args, image, ...nodeArgs(source)]);
}
function rejected(label, args, message) {
  check(label, () => {
    const result = docker(['run', '--rm', '--network', 'none', ...args, image], { allowFailure: true });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, message);
  });
}
function volume(suffix) {
  const name = `${prefix}-${suffix}`;
  volumes.add(name);
  docker(['volume', 'create', name]);
  return name;
}
function detached(name, args) {
  containers.add(name);
  docker(['run', '--detach', '--name', name, ...args]);
}
async function ready(label, probe, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error('Smoke test interrupted');
    if (probe()) { console.log(`PASS ${label}`); return; }
    await delay(500);
  }
  throw new Error(`Timed out: ${label}`);
}
function stopCleanly(name) {
  docker(['stop', '--time', '35', name], { timeout: 45_000 });
  assert.equal(output(['inspect', '--format', '{{.State.ExitCode}}', name]), '0', `${name} must shut down cleanly`);
  assert.equal(output(['inspect', '--format', '{{.State.OOMKilled}}', name]), 'false');
}

try {
  await checkDockerContext();
  console.log(`Testing ${image}; resources use prefix ${prefix}`);
  console.log(output(['image', 'inspect', '--format', '{{.Id}} {{.Os}}/{{.Architecture}}', image]));
  check('packaged modules, Node 24, UID/GID 1000, private umask and clean image', () => {
    isolated(`
      import assert from 'node:assert/strict';
      import { existsSync } from 'node:fs';
      import { execFileSync } from 'node:child_process';
      await import('./shared/preview-origin.ts');
      await import('./server/app.ts');
      assert.match(process.version, /^v24\\./);
      assert.equal(process.getuid(), 1000); assert.equal(process.getgid(), 1000);
      assert.equal(process.umask(), 0o077);
      for (const path of ['dist/index.html', '/usr/bin/tini', '/usr/sbin/gosu']) assert.ok(existsSync(path), path);
      for (const path of ['.env', '.env.live', '.git']) assert.ok(!existsSync(path), path);
      assert.match(execFileSync('git', ['--version'], { encoding: 'utf8' }), /^git version /);
    `);
  });
  const disk = volume('disk');
  // Keep the seed nonempty: Docker otherwise copies image ownership back into an empty volume.
  docker(['run', '--rm', '--network', 'none', '--entrypoint', 'sh', '--mount', `source=${disk},target=/app/.data`, image,
    '-c', 'touch /app/.data/root-marker && chown 0:0 /app/.data /app/.data/root-marker && chmod 700 /app/.data']);
  check('root-owned mounted disk repaired and writes remain private', () => {
    isolated(`
      import assert from 'node:assert/strict';
      import { statSync, writeFileSync } from 'node:fs';
      const dir = statSync('/app/.data'); assert.equal(dir.uid, 1000); assert.equal(dir.mode & 0o777, 0o700);
      assert.equal(statSync('/app/.data/root-marker').uid, 1000);
      writeFileSync('/app/.data/smoke-marker', 'persisted');
      assert.equal(statSync('/app/.data/smoke-marker').mode & 0o777, 0o600);
    `, ['--mount', `source=${disk},target=/app/.data`]);
  });
  check('volume survives replacement container; explicit non-root launch works', () => {
    isolated(`
      import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
      assert.equal(process.getuid(), 1000); assert.equal(readFileSync('/app/.data/smoke-marker', 'utf8'), 'persisted');
    `, ['--user', '1000:1000', '--mount', `source=${disk},target=/app/.data`]);
  });
  check('embedded database opens, persists, closes and reopens on mounted disk', () => {
    const args = ['--mount', `source=${disk},target=/app/.data`];
    isolated(`
      import { openDatabase } from './server/db.ts';
      const db = await openDatabase(undefined, '/app/.data/embedded');
      try { await db.query('CREATE TABLE smoke (value text NOT NULL)'); await db.query("INSERT INTO smoke VALUES ('durable')"); }
      finally { await db.close(); }
    `, args);
    isolated(`
      import assert from 'node:assert/strict'; import { openDatabase } from './server/db.ts';
      const db = await openDatabase(undefined, '/app/.data/embedded');
      try { assert.equal((await db.query('SELECT value FROM smoke')).rows[0].value, 'durable'); }
      finally { await db.close(); }
    `, args);
  });
  check('packaged operator recovery help runs without configuration or network', () => {
    const result = docker(['run', '--rm', '--network', 'none', image, 'node', '--import', 'tsx', 'scripts/session-recovery.ts', '--help']);
    assert.match(result.stdout, /Local operator recovery/);
  });
  check('offline operator inspection preserves uncertainty and refuses a competing database owner', () => {
    isolated(`
      import assert from 'node:assert/strict';
      import { spawnSync } from 'node:child_process';
      import { openDatabase } from './server/db.ts';
      import { createSessionRepository } from './server/core/repository.ts';
      const id = 'ef000000-0000-4000-8000-000000000001';
      const db = await openDatabase(undefined, '/app/.data/live');
      const repo = await createSessionRepository(db);
      await repo.insert({ id, userId: 'operator-fixture', repository: 'fixture/repo', repositoryId: 1, installationId: 2,
        baseBranch: 'main', branch: 'ephemeral/' + id, state: 'provisioning', sandboxId: null,
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now()+3600000).toISOString(),
        maxExpiresAt: new Date(Date.now()+3600000).toISOString(), endedAt: null,
        error: 'fixture-private-detail', cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' },
        codexRemoteRevocation: 'unverified' });
      await repo.claim(id, 'fixture');
      await repo.beginCreationAttempt(id, 'fixture', new Date(Date.now()+3720000).toISOString());
      await repo.release(id, 'fixture');
      const args = ['--import', 'tsx', 'scripts/session-recovery.ts', 'inspect', '--session', id, '--mode', 'live'];
      const locked = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 20000 });
      assert.equal(locked.status, 1); assert.deepEqual(JSON.parse(locked.stderr), { error: 'ownership_unavailable' });
      await db.close();
      const inspected = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 20000 });
      assert.equal(inspected.status, 0, inspected.stderr);
      const info = JSON.parse(inspected.stdout);
      assert.equal(info.sessionId, id); assert.equal(info.creationAttempt.status, 'pending');
      assert.ok(info.blockers.includes('sandbox_creation_uncertain'));
      assert.equal(info.codexRemoteRevocation, 'unverified');
      assert.ok(!inspected.stdout.includes('fixture-private-detail'));
      const reopened = await openDatabase(undefined, '/app/.data/live');
      assert.equal((await (await createSessionRepository(reopened)).get(id)).state, 'provisioning');
      assert.equal((await reopened.query('SELECT status FROM ephemeral_creation_attempts WHERE session_id=$1', [id])).rows[0].status, 'pending');
      await reopened.close();
    `, ['--mount', `source=${disk},target=/app/.data`]);
  });
  rejected('noncanonical DATA_DIR rejected', ['--env', 'DATA_DIR=/tmp/other'], /Container DATA_DIR must be/);
  check('symlink mount destination rejected', () => {
    const result = docker(['run', '--rm', '--network', 'none', '--entrypoint', 'sh', image, '-c',
      'rmdir /app/.data && ln -s /tmp /app/.data && exec /usr/local/bin/ephemeral-entrypoint node -e "process.exit(0)"'], { allowFailure: true });
    assert.equal(result.error, undefined); assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing a symlink/);
  });
  const unwritable = volume('unwritable');
  docker(['run', '--rm', '--network', 'none', '--entrypoint', 'sh', '--mount', `source=${unwritable},target=/app/.data`, image,
    '-c', 'touch /app/.data/root-marker && chown 0:0 /app/.data /app/.data/root-marker && chmod 700 /app/.data']);
  rejected('unwritable non-root disk rejected with recovery guidance',
    ['--user', '1000:1000', '--mount', `source=${unwritable},target=/app/.data`], /must be writable by node/);
  rejected('production simulation rejected', ['--env', 'EPHEMERAL_MODE=preview'], /Preview cannot run in production/);
  rejected('incomplete live configuration rejected', ['--env', 'EPHEMERAL_MODE=live'], /Missing live configuration/);

  if (docker(['image', 'inspect', postgresImage], { allowFailure: true }).status !== 0) {
    console.log(`Pulling ${postgresImage} for the disposable local database`);
    docker(['pull', postgresImage], { timeout: 180_000 });
  }
  console.log(output(['image', 'inspect', '--format', '{{.Id}} {{.Os}}/{{.Architecture}}', postgresImage]));
  docker(['network', 'create', '--internal', prefix]); networkCreated = true;
  assert.equal(output(['network', 'inspect', '--format', '{{.Internal}}', prefix]), 'true');
  const database = `${prefix}-postgres`;
  const sql = source => output(['exec', database, 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
    '-U', 'ephemeral', '-d', 'ephemeral', '-c', source]);
  // This key identifies only this fixture's control-plane owner. Never terminate
  // arbitrary database sessions: the dedicated owner is separate from the pool.
  const ownershipLock = `l.locktype = 'advisory' AND l.classid = 0 AND l.objid = 378120985
    AND l.objsubid = 1 AND l.granted AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
  const ownerPids = `SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE ${ownershipLock} AND a.application_name = 'ephemeral-control-plane'`;
  const idlePoolPids = `SELECT a.pid FROM pg_stat_activity a
    WHERE a.datname = current_database() AND a.application_name = 'ephemeral-control-plane'
      AND a.state = 'idle' AND a.pid <> pg_backend_pid()
      AND NOT EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND ${ownershipLock})`;
  const password = `${randomBytes(18).toString('hex')}#/?%@:+!`;
  const postgresDisk = volume('postgres');
  detached(database, ['--network', prefix, '--mount', `source=${postgresDisk},target=/var/lib/postgresql/data`,
    '--env', 'POSTGRES_DB=ephemeral', '--env', 'POSTGRES_USER=ephemeral', '--env', `POSTGRES_PASSWORD=${password}`, postgresImage]);
  await ready('PostgreSQL ready on isolated network with no host ports', () =>
    docker(['exec', database, 'pg_isready', '-U', 'ephemeral'], { allowFailure: true }).status === 0);
  const databaseEnv = ['--env', `DATABASE_URL=postgresql://ephemeral@${database}:5432/ephemeral`, '--env', `PGPASSWORD=${password}`];
  const appEnv = [...databaseEnv, '--env', 'EPHEMERAL_MODE=live', '--env', 'PUBLIC_URL=https://container-smoke.invalid',
    '--env', 'E2B_API_KEY=container-smoke-unused', '--env', 'E2B_TEMPLATE_ID=container-smoke-unused',
    '--env', 'GITHUB_APP_ID=1', '--env', 'GITHUB_APP_SLUG=container-smoke-unused', '--env', 'GITHUB_CLIENT_ID=container-smoke-unused',
    '--env', 'GITHUB_CLIENT_SECRET=container-smoke-unused', '--env', 'GITHUB_APP_PRIVATE_KEY=container-smoke-unused',
    '--env', `ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`, '--env', 'ALLOWED_GITHUB_IDS=1'];
  const appDisk = volume('app');
  const app = `${prefix}-app`;
  detached(app, ['--network', prefix, '--mount', `source=${appDisk},target=/app/.data`, ...appEnv, image]);
  const health = `const r = await fetch('http://127.0.0.1:4310/healthz', {signal: AbortSignal.timeout(2000)}); if (!r.ok || (await r.json()).mode !== 'live') process.exit(1);`;
  await ready('production server migrates and starts against real PostgreSQL', () =>
    docker(['exec', app, ...nodeArgs(health)], { allowFailure: true }).status === 0);
  check('PostgreSQL event cursors preserve microseconds and retry metadata stays lease-fenced', () => {
    docker(['exec', app, ...nodeArgs(String.raw`
      import assert from 'node:assert/strict';
      import { Client } from 'pg';
      import { createSessionRepository } from './server/core/repository.ts';
      const client = new Client({connectionString: process.env.DATABASE_URL, password: process.env.PGPASSWORD,
        application_name: 'ephemeral-pagination-smoke', statement_timeout: 5000});
      await client.connect();
      try {
        // Keep fixtures invisible to the running reconciler and roll them back.
        await client.query('BEGIN');
        const db = {query: (sql, params) => client.query(sql, params), close: async () => {}};
        const repo = await createSessionRepository(db);
        const id = 'postgres-pagination-fixture';
        const s = {id, userId: id, repository: 'fixture/repository', repositoryId: 1, installationId: 1,
          baseBranch: 'main', branch: 'ephemeral/' + id, state: 'running', createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600000).toISOString(), maxExpiresAt: new Date(Date.now() + 3600000).toISOString(),
          sandboxId: 'synthetic-workspace', endedAt: null, error: null,
          cleanup: {vm:'pending',github:'pending',gateway:'pending',codex:'pending'}, codexRemoteRevocation:'unverified'};
        await repo.insert(s);
        await repo.insert({...s, id:id+'-ended', userId:id+'-ended', state:'ended'});
        assert.deepEqual((await repo.listActive()).map(row => row.id), [id]);
        await client.query("INSERT INTO ephemeral_session_events(id,session_id,at,kind,message) SELECT $1 || '-' || lpad(n::text,4,'0'),$1,'2026-10-14T00:00:00.123000Z'::timestamptz + n * INTERVAL '1 microsecond','fixture',n::text FROM generate_series(1,151) n", [id]);
        const seen = [];
        let before;
        do {
          const page = await repo.eventPage(id, {limit:17, ...(before ? {before} : {})});
          assert.ok(page.events.length <= 17);
          seen.push(...page.events.map(event => event.id));
          before = page.nextCursor;
        } while (before);
        assert.equal(seen.length, 151); assert.equal(new Set(seen).size, 151);
        const first = await repo.eventPage(id, {limit:17});
        assert.equal(JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString()).at, '2026-10-14T00:00:00.123135Z');
        await assert.rejects(repo.eventPage(id+'-ended', {before:first.nextCursor}), /Invalid session event pagination/);
        await assert.rejects(repo.eventPage(id, {limit:101}), /Invalid session event pagination/);
        assert.equal(await repo.claim(id, 'fixture-owner'), true);
        const retry = {state:'health',attempts:2,nextAt:new Date(Date.now()+10000).toISOString()};
        await repo.setRetryState(id, 'fixture-owner', retry);
        assert.deepEqual(await repo.getRetryState(id), retry);
        await assert.rejects(repo.setRetryState(id, 'wrong-owner', null), /lease/);
        await client.query("UPDATE ephemeral_sessions SET lease_until=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=$1", [id]);
        await assert.rejects(repo.setRetryState(id, 'fixture-owner', null), /lease/);
        assert.deepEqual(await repo.getRetryState(id), retry);
        await repo.requestStop(id);
        assert.equal(await repo.getRetryState(id), null);
      } finally {
        await client.query('ROLLBACK'); await client.end();
      }
    `)]);
  });
  check('production HTML, built assets, security headers and unauthenticated fences', () => {
    docker(['exec', app, ...nodeArgs(String.raw`
      import assert from 'node:assert/strict';
      const base = 'http://127.0.0.1:4310';
      const html = await fetch(base); assert.equal(html.status, 200);
      assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
      assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      const source = await html.text(); const asset = source.match(/src="(\/assets\/[^"\s]+\.js)"/);
      assert.ok(asset, 'built JS entry');
      const js = await fetch(base + asset[1]); assert.equal(js.status, 200);
      assert.match(js.headers.get('content-type'), /javascript/); assert.ok((await js.text()).length > 100);
      const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
      assert.equal(bootstrap.user, null); assert.equal(bootstrap.mode, 'live'); assert.equal(bootstrap.configured, true);
      assert.equal((await fetch(base + '/api/sessions')).status, 401);
      assert.equal((await fetch(base + '/api/sessions', {method: 'POST'})).status, 403);
      assert.equal((await fetch(base + '/api/sessions', {headers: {Origin: 'https://other.invalid'}})).status, 403);
    `)]);
    assert.equal(output(['inspect', '--format', '{{json .HostConfig.PortBindings}}', app]), '{}');
  });
  check('production JSON limits and OAuth admission stay bounded against PostgreSQL', () => {
    docker(['exec', app, ...nodeArgs(String.raw`
      import assert from 'node:assert/strict';
      import { Client } from 'pg';
      const base = 'http://127.0.0.1:4310';
      const headers = {'content-type': 'application/json', 'x-ephemeral-request': '1'};
      const payload = JSON.stringify({title: '😀'.repeat(240), body: '😀'.repeat(20_000),
        expectedHeadSha: 'a'.repeat(64), expectedBaseSha: 'b'.repeat(64)})
        .replace(/[\u007f-\uffff]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
      assert.ok(Buffer.byteLength(payload) > 240_000 && Buffer.byteLength(payload) < 256 * 1024);
      const post = (body, extra = {}) => fetch(base + '/api/sessions/fixture/pull-request',
        {method: 'POST', headers: {...headers, ...extra}, body});
      assert.equal((await post(payload)).status, 401, 'maximum escaped PR reaches authentication');
      const oversized = await post(' '.repeat(256 * 1024) + '{}');
      assert.equal(oversized.status, 413);
      assert.deepEqual(await oversized.json(), {error: 'JSON request body is too large'});
      assert.equal((await post('{broken')).status, 400);
      assert.equal((await post('{}', {'content-type': 'application/json; charset=utf-16le'})).status, 415);
      for (let index = 0; index < 10; index++) {
        const response = await fetch(base + '/auth/github', {redirect: 'manual'});
        assert.equal(response.status, 302);
        assert.equal(new URL(response.headers.get('location')).origin, 'https://github.com');
        await response.arrayBuffer();
      }
      const denied = await fetch(base + '/auth/github', {redirect: 'manual',
        headers: {'x-forwarded-for': '203.0.113.1', forwarded: 'for=198.51.100.1'}});
      assert.equal(denied.status, 429);
      assert.ok(Number(denied.headers.get('retry-after')) > 0);
      assert.equal(denied.headers.get('set-cookie'), null);
      assert.equal(await denied.text(), 'Too many sign-in requests. Try again later.');
      const client = new Client({connectionString: process.env.DATABASE_URL, password: process.env.PGPASSWORD,
        application_name: 'ephemeral-admission-smoke', statement_timeout: 5000});
      await client.connect();
      try {
        assert.equal(Number((await client.query('SELECT count(*) AS n FROM oauth_states')).rows[0].n), 10);
        const indexes = (await client.query("SELECT indexname FROM pg_indexes WHERE tablename IN ('oauth_states','browser_sessions')")).rows.map(row => row.indexname);
        assert.ok(indexes.includes('oauth_states_expiry') && indexes.includes('browser_sessions_expiry'));
      } finally { await client.end(); }
    `)]);
  });
  check('PostgreSQL singleton rejects a second control plane', () => {
    docker(['run', '--rm', '--network', prefix, ...databaseEnv, image, ...nodeArgs(`
      import assert from 'node:assert/strict'; import { openDatabase } from './server/db.ts';
      await assert.rejects(openDatabase(process.env.DATABASE_URL, '/app/.data'), /Another Ephemeral control plane/);
    `)]);
  });
  const startedAt = output(['inspect', '--format', '{{.State.StartedAt}}', app]);
  let terminatedPoolPids;
  check('only idle pooled application backends are terminated; advisory owner remains', () => {
    // Readiness executes SELECT 1 through the live application's query pool.
    docker(['exec', app, ...nodeArgs(health)]);
    const owners = sql(ownerPids).split('\n').filter(Boolean);
    assert.equal(owners.length, 1, 'exactly one fixture advisory owner');
    const killed = sql(`SELECT pid, pg_terminate_backend(pid) FROM (${idlePoolPids}) AS idle`)
      .split('\n').filter(Boolean);
    assert.ok(killed.length > 0, 'at least one idle pooled backend must be exercised');
    terminatedPoolPids = killed.map(row => {
      assert.match(row, /^\d+\|t$/);
      return row.split('|')[0];
    });
    assert.ok(!terminatedPoolPids.includes(owners[0]), 'held advisory connection must survive');
    assert.equal(sql(ownerPids), owners[0]);
  });
  await ready('idle-pool connection loss preserves the process and health SELECT 1 recovers', () => {
    if (docker(['exec', app, ...nodeArgs(health)], { allowFailure: true }).status !== 0) return false;
    const idle = sql(idlePoolPids).split('\n').filter(Boolean);
    return idle.some(pid => !terminatedPoolPids.includes(pid));
  }, 15_000);
  check('idle-pool recovery keeps the same running application container', () => {
    assert.equal(output(['inspect', '--format', '{{.State.Running}}', app]), 'true');
    assert.equal(output(['inspect', '--format', '{{.State.StartedAt}}', app]), startedAt);
  });
  check('SIGTERM traverses tini and privilege drop; server exits zero', () => stopCleanly(app));
  check('PostgreSQL lock released; delimiter password reaches pg unmodified', () => {
    docker(['run', '--rm', '--network', prefix, ...databaseEnv, image, ...nodeArgs(`
      import assert from 'node:assert/strict'; import { openDatabase } from './server/db.ts';
      const db = await openDatabase(process.env.DATABASE_URL, '/app/.data');
      try { assert.equal((await db.query('SELECT current_user AS name')).rows[0].name, 'ephemeral'); }
      finally { await db.close(); }
    `)]);
  });
  check('operator env-file overrides stale inherited PostgreSQL credentials and TLS defaults', () => {
    docker(['run', '--rm', '--network', prefix, ...databaseEnv, image, ...nodeArgs(String.raw`
      import assert from 'node:assert/strict';
      import { randomUUID } from 'node:crypto';
      import { mkdtemp, writeFile, rm } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { spawnSync } from 'node:child_process';
      import { openDatabase } from './server/db.ts';
      import { createSessionRepository } from './server/core/repository.ts';
      const id = randomUUID(), dir = await mkdtemp(join(tmpdir(), 'operator-config-'));
      const config = join(dir, 'operator.env'), selectedPassword = process.env.PGPASSWORD;
      const db = await openDatabase(process.env.DATABASE_URL, '/app/.data');
      try {
        const repo = await createSessionRepository(db), at = new Date().toISOString();
        await repo.insert({id, userId:id, repository:'fixture/repository', repositoryId:1, installationId:1,
          branch:'ephemeral/'+id, baseBranch:'main', state:'ended', createdAt:at, expiresAt:at, maxExpiresAt:at,
          endedAt:at, sandboxId:null, error:null, cleanup:{vm:'confirmed', github:'confirmed', gateway:'confirmed', codex:'confirmed'},
          codexRemoteRevocation:'unverified'});
      } finally { await db.close(); }
      try {
        await writeFile(config, 'DATABASE_URL=' + process.env.DATABASE_URL + '\nPGPASSWORD=' + JSON.stringify(selectedPassword) +
          '\nPGSSLMODE=disable\nPGSSLNEGOTIATION=postgres\n', {mode:0o600});
        const result = spawnSync(process.execPath, ['--import','tsx','scripts/session-recovery.ts','inspect','--session',id,'--env-file',config], {
          env:{...process.env, DATABASE_URL:'postgresql://stale@invalid.invalid/wrong', PGPASSWORD:'stale-synthetic-password',
            PGSSLMODE:'require', PGSSLNEGOTIATION:'direct'}, encoding:'utf8', timeout:20000});
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, 'selected operator configuration must authenticate to the disposable PostgreSQL fixture');
        assert.equal(result.stderr, '');
        assert.equal(JSON.parse(result.stdout).sessionId, id);
        assert.equal(JSON.parse(result.stdout).state, 'ended');
        for (const value of [selectedPassword, 'stale-synthetic-password', process.env.DATABASE_URL]) {
          assert.ok(!result.stdout.includes(value) && !result.stderr.includes(value), 'operator output must not disclose configuration');
        }
      } finally { await rm(dir, {recursive:true, force:true}); }
    `)]);
  });
  docker(['start', app]);
  await ready('same production container restarts against durable database', () =>
    docker(['exec', app, ...nodeArgs(health)], { allowFailure: true }).status === 0);
  check('restarted server shuts down cleanly', () => stopCleanly(app));

  docker(['start', app]);
  await ready('production server ready for advisory-owner termination regression', () =>
    docker(['exec', app, ...nodeArgs(health)], { allowFailure: true }).status === 0);
  check('only the fixture advisory-lock owning backend is terminated', () => {
    const owners = sql(ownerPids).split('\n').filter(Boolean);
    assert.equal(owners.length, 1, 'exactly one fixture advisory owner');
    assert.match(owners[0], /^\d+$/);
    assert.equal(sql(`SELECT pg_terminate_backend(pid) FROM (${ownerPids}) AS owner`), 't');
  });
  let fatalState;
  await ready('advisory ownership loss exits within the application shutdown bound', () => {
    const result = docker(['inspect', '--format', '{{json .State}}', app], { timeout: 2_000 });
    fatalState = JSON.parse(result.stdout);
    return fatalState.Running === false;
  }, 35_000);
  check('ownership loss exits nonzero with sanitized controlled diagnostics', () => {
    assert.equal(fatalState.ExitCode, 1, 'controlled fatal exit code');
    assert.equal(fatalState.OOMKilled, false);
    assert.equal(fatalState.Error, '');
    const result = docker(['logs', app]);
    const logs = result.stdout + result.stderr;
    assert.match(logs, /Database ownership was lost; shutting down\./);
    assert.doesNotMatch(logs, /Unhandled|node:events|(?:^|\n)\s+at .+:\d+:\d+|terminating connection due to administrator command/);
    for (const credential of [password, encodeURIComponent(password), 'postgresql://', 'container-smoke-unused']) {
      assert.ok(!logs.includes(credential), 'runtime logs must not include database or integration credentials');
    }
    assert.equal(sql(ownerPids), '', 'terminated process must leave no advisory owner');
  });
  check('replacement control plane acquires singleton and executes SELECT after ownership loss', () => {
    docker(['run', '--rm', '--network', prefix, ...databaseEnv, image, ...nodeArgs(`
      import assert from 'node:assert/strict'; import { openDatabase } from './server/db.ts';
      const db = await openDatabase(process.env.DATABASE_URL, '/app/.data');
      try { assert.equal((await db.query('SELECT 1 AS value')).rows[0].value, 1); }
      finally { await db.close(); }
    `)]);
  });
  docker(['start', app]);
  await ready('production application restarts successfully after advisory ownership loss', () =>
    docker(['exec', app, ...nodeArgs(health)], { allowFailure: true }).status === 0);
  check('application recovered from ownership loss shuts down cleanly', () => stopCleanly(app));
} catch (error) {
  console.error(error.message);
  for (const name of containers) {
    const result = docker(['logs', '--tail', '30', name], { allowFailure: true });
    console.error(`${name}:\n${result.stdout}${result.stderr}`);
  }
  process.exitCode = 1;
} finally {
  let cleanupFailed = false;
  for (const name of containers) {
    if (docker(['rm', '--force', '--volumes', name], { allowFailure: true }).status !== 0) cleanupFailed = true;
  }
  for (const name of volumes) {
    if (docker(['volume', 'rm', name], { allowFailure: true }).status !== 0) cleanupFailed = true;
  }
  if (networkCreated && docker(['network', 'rm', prefix], { allowFailure: true }).status !== 0) cleanupFailed = true;
  if (cleanupFailed) { console.error(`Cleanup incomplete; inspect resources beginning ${prefix}`); process.exitCode = 1; }
  else console.log('PASS disposable containers, volumes and network removed');
}
