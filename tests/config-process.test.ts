import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

async function runConfiguration(env: NodeJS.ProcessEnv) {
  const directory = await mkdtemp(join(tmpdir(), 'ephemeral-config-process-'));
  try {
    return await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)), fileURLToPath(new URL('../server/index.ts', import.meta.url))], {
        cwd: directory, env: { PATH: process.env.PATH, NODE_ENV: 'production', EPHEMERAL_SKIP_DOTENV: '0', ...env },
      });
      let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Configuration fixture timed out')); }, 5000);
      child.stdout.resume(); child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject); child.on('exit', code => { clearTimeout(timer); resolve({ code, stderr }); });
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
describe('entry point configuration diagnostics', () => {
  it.each([
    [{ EPHEMERAL_MODE: 'preview' }, 'Preview cannot run in production; configure live credentials'],
    [{ EPHEMERAL_MODE: 'live' }, 'Missing live configuration: E2B_API_KEY, E2B_TEMPLATE_ID, GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_APP_PRIVATE_KEY, ENCRYPTION_KEY, ALLOWED_GITHUB_IDS'],
    [{ PORT: 'synthetic-private-value' }, 'PORT must be a valid TCP port'],
  ])('prints only the trusted configuration message for %j', async (env, expected) => {
    const result = await runConfiguration(env); expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe(expected);
  });
  it('sanitizes filesystem failures containing private key paths', async () => {
    const result = await runConfiguration({ EPHEMERAL_MODE: 'live', GITHUB_APP_PRIVATE_KEY_FILE: '/private/synthetic-private-value/key.pem' });
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe('Ephemeral could not start or lost database ownership.');
    expect(result.stderr).not.toMatch(/synthetic-private-value|key.pem|ENOENT/);
  });
});

// This child explicitly exercises dotenv independently of the Vitest bootstrap.
it.each(['0', '1'])('honors the explicit dotenv opt-out (%s) without changing mode validation', async skip => {
  const directory = await mkdtemp(join(tmpdir(), 'ephemeral-config-dotenv-'));
  try {
    await writeFile(join(directory, '.env'), 'PORT=4391\n');
    const source = `import {readConfig} from ${JSON.stringify(fileURLToPath(new URL('../server/config.ts', import.meta.url)))};process.stdout.write(String(readConfig().port));`;
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)), '--input-type=module', '-e', source], {
        cwd: directory, env: { PATH: process.env.PATH, NODE_ENV: 'test', EPHEMERAL_SKIP_DOTENV: skip },
      });
      let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.resume();
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Configuration fixture timed out')); }, 5000);
      child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
    });
    expect(result).toEqual({ code: 0, output: skip === '1' ? '4310' : '4391' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('test bootstrap clears synthetic operator integration settings before config imports and ignores cwd dotenv', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ephemeral-test-environment-'));
  try {
    await writeFile(join(directory, '.env'), 'PORT=4392\nE2B_API_KEY=synthetic-file-only\n');
    const source = `import {readConfig} from ${JSON.stringify(fileURLToPath(new URL('../server/config.ts', import.meta.url)))};const c=readConfig();process.stdout.write(JSON.stringify({port:c.port,mode:c.mode,hasKey:!!c.e2bApiKey}));`;
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)), '--import', fileURLToPath(new URL('./test-environment.ts', import.meta.url)), '--input-type=module', '-e', source], {
        cwd: directory, env: { PATH: process.env.PATH, NODE_ENV: 'test', E2B_API_KEY: 'synthetic-env-only', EPHEMERAL_MODE: 'live', EPHEMERAL_SKIP_DOTENV: '0', PUBLIC_URL: 'https://operator.test', DATABASE_URL: 'synthetic-no-connection' },
      });
      let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.resume();
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Configuration fixture timed out')); }, 5000);
      child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
    });
    expect(result).toEqual({ code: 0, output: JSON.stringify({ port: 4310, mode: 'preview', hasKey: false }) });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
