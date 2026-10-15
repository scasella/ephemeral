#!/usr/bin/env node
// Uses only disposable Docker resources and generated test configuration. Never loads .env.
import assert from 'node:assert/strict';
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
async function ready(label, probe) {
  const deadline = Date.now() + 90_000;
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
  check('PostgreSQL singleton rejects a second control plane', () => {
    docker(['run', '--rm', '--network', prefix, ...databaseEnv, image, ...nodeArgs(`
      import assert from 'node:assert/strict'; import { openDatabase } from './server/db.ts';
      await assert.rejects(openDatabase(process.env.DATABASE_URL, '/app/.data'), /Another Ephemeral control plane/);
    `)]);
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
  docker(['start', app]);
  await ready('same production container restarts against durable database', () =>
    docker(['exec', app, ...nodeArgs(health)], { allowFailure: true }).status === 0);
  check('restarted server shuts down cleanly', () => stopCleanly(app));
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
