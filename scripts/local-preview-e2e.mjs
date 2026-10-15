import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.some(arg => !['--check', '--browser'].includes(arg)) || args.length > 1) {
  console.error('Usage: node scripts/local-preview-e2e.mjs [--check|--browser]');
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const control = await mkdtemp(join(tmpdir(), 'ephemeral-preview-controller-'));
// Deliberately do not pass account credentials, NODE_OPTIONS, or operator config to the test runner.
const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'scripts/fixtures/local-preview-vitest.config.ts', 'tests/local-preview-e2e.test.ts'], {
  cwd: root,
  detached: true,
  env: { PATH: process.env.PATH, LANG: 'C', NODE_ENV: 'test',
    EPHEMERAL_LOCAL_PREVIEW_BROWSER: args[0] === '--browser' ? '1' : '0', EPHEMERAL_LOCAL_PREVIEW_CONTROL_DIR: control },
  stdio: 'inherit',
});
const stop = () => { void writeFile(join(control, 'stop'), '').catch(() => {}); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  process.exitCode = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', code => done(code ?? 1)); });
} finally {
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  await rm(control, { recursive: true, force: true });
}
