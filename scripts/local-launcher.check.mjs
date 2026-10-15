import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { localEnvironment } from './run-local.mjs';

test('local launch cannot inherit live mode, remote storage or an exposed listener', () => {
  const env = localEnvironment('/fixture', 4311, {NODE_ENV: 'production', EPHEMERAL_MODE: 'live', HOST: '0.0.0.0',
    DATABASE_URL: 'postgresql://remote/real', DATA_DIR: '/real', PUBLIC_URL: 'https://real.example', PREVIEW_PUBLIC_URL: 'https://viewer.example', SESSION_MAX_HOURS: '4'});
  assert.equal(env.EPHEMERAL_MODE, 'preview'); assert.equal(env.NODE_ENV, 'development');
  assert.equal(env.HOST, '127.0.0.1'); assert.equal(env.PUBLIC_URL, 'http://localhost:4311');
  assert.equal(env.DATABASE_URL, ''); assert.equal(env.PREVIEW_PUBLIC_URL, '');
  assert.equal(env.DATA_DIR, '/fixture/.data/local-preview'); assert.equal(env.SESSION_MAX_HOURS, '1');
});

test('integration credentials are removed and dotenv cannot restore the application credential fields', () => {
  const env = localEnvironment('/fixture', 4310, {E2B_API_KEY: 'synthetic', GITHUB_APP_PRIVATE_KEY_FILE: '/private-key',
    GITHUB_CLIENT_SECRET: 'synthetic', OPENAI_API_KEY: 'synthetic', CODEX_HOME: '/account', GH_TOKEN: 'synthetic',
    ENCRYPTION_KEY: 'synthetic', ALLOWED_GITHUB_IDS: '123456', PATH: '/bin'});
  for (const key of ['E2B_API_KEY', 'E2B_TEMPLATE_ID', 'GITHUB_APP_PRIVATE_KEY_FILE', 'GITHUB_APP_PRIVATE_KEY',
    'GITHUB_CLIENT_SECRET', 'GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_CLIENT_ID', 'ENCRYPTION_KEY', 'ALLOWED_GITHUB_IDS']) assert.equal(env[key], '');
  for (const key of ['OPENAI_API_KEY', 'CODEX_HOME', 'GH_TOKEN']) assert.equal(env[key], undefined);
  assert.equal(env.PATH, '/bin');
});

test('invalid ports are rejected before launching a server', () => {
  for (const port of [0, -1, 65536, 1.5, NaN]) assert.throws(() => localEnvironment('/fixture', port));
});

test('Node dotenv loading cannot re-enable live configuration in the local child', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ephemeral-local-launch-check-'));
  try {
    await writeFile(join(dir, '.env'), 'EPHEMERAL_MODE=live\nDATABASE_URL=postgresql://remote/real\nGITHUB_APP_PRIVATE_KEY_FILE=/absent-synthetic-key\nE2B_API_KEY=synthetic\n', {mode: 0o600});
    const keys = ['EPHEMERAL_MODE', 'DATABASE_URL', 'GITHUB_APP_PRIVATE_KEY_FILE', 'E2B_API_KEY'];
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `process.loadEnvFile('.env'); console.log(JSON.stringify(${JSON.stringify(keys)}.map(key=>process.env[key])));`],
      {cwd: dir, env: localEnvironment(dir, 4310, {}), encoding: 'utf8', timeout: 10_000});
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), ['preview', '', '', '']);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
