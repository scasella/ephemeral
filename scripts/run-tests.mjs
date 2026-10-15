import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (Number(process.versions.node.split('.')[0]) !== 24) {
  console.error('Tests require the supported Node.js 24 runtime.');
  process.exit(1);
}
const home = await mkdtemp(join(tmpdir(), 'ephemeral-test-home-'));
const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'CI', 'TERM', 'NO_COLOR', 'FORCE_COLOR']
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
Object.assign(env, { HOME: home, USERPROFILE: home, NODE_ENV: 'test', EPHEMERAL_SKIP_DOTENV: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)), 'run', ...process.argv.slice(2)],
  { cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: 'inherit' });
const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
try {
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
} finally {
  process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
  await rm(home, { recursive: true, force: true });
}
