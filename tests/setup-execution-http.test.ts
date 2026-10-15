import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { digest, seal } from '../server/auth/crypto.js';
import { shellQuote } from '../server/infra/git-prepare.js';
import { createLiveApplication } from './helpers/create-live-application.js';
import type { Session } from '../server/contracts.js';
import type { SetupRun } from '../server/setup.js';

// Accounts and VM transport are synthetic. The HTTP routes, controller, database,
// generated VM runner, shell command and output decoder execute their real code.
const fixture = vi.hoisted(() => ({ workspace: '', invocations: 0 }));
vi.mock('../server/auth/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/auth/index.js')>();
  return { ...actual, createAuth: async (...args: Parameters<typeof actual.createAuth>) => ({
    ...await actual.createAuth(...args), authorizeSession: async () => {},
  }) };
});
vi.mock('../server/github/index.js', async () => {
  const { Router } = await import('express');
  const { previewCredentials } = await import('../server/preview.js');
  return { createGitHubServices: async () => ({ router: Router(), credentials: previewCredentials, close: async () => {} }) };
});
vi.mock('../server/infra/e2b.js', async () => {
  const { spawn } = await import('node:child_process');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { PreviewProvider } = await import('../server/preview.js');
  const { setupRunnerSource, SetupOutputDecoder } = await import('../server/infra/setup-runner.js');
  return { E2BProvider: class extends PreviewProvider {
    async exists() { return true; }
    async runSetup(_session: Session, input: import('../server/contracts.js').SetupCommand, output: (text: string) => void, signal: AbortSignal) {
      fixture.invocations++;
      const controlDirectory = join(fixture.workspace, input.runId);
      await mkdir(controlDirectory, { mode: 0o700 });
      const decoder = new SetupOutputDecoder(output);
      const child = spawn(process.execPath, ['-e', setupRunnerSource({ command: input.command, cwd: fixture.workspace,
        controlDirectory, credentialPath: join(fixture.workspace, 'auth.json'), deadlineAt: Date.parse(input.deadlineAt) })], {
        cwd: fixture.workspace,
        env: { PATH: process.env.PATH, HOME: fixture.workspace, LANG: 'C' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const cancel = () => { void writeFile(join(controlDirectory, 'cancel'), '').catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      try {
        return await new Promise<import('../server/contracts.js').SetupCommandResult>((resolve, reject) => {
          child.once('error', reject);
          child.stderr.resume();
          child.stdout.on('data', (data: Buffer) => { try { decoder.write(data.toString('utf8')); } catch (error) { reject(error); } });
          child.once('close', code => {
            if (code !== 0) { reject(new Error('Local setup fixture runner failed.')); return; }
            try { resolve(decoder.complete()); } catch (error) { reject(error); }
          });
        });
      } finally { signal.removeEventListener('abort', cancel); }
    }
  } };
});

let application: Awaited<ReturnType<typeof createApplication>> | undefined;
let directory = '', origin = '';
const key = randomBytes(32).toString('base64'), credential = randomBytes(32).toString('hex');
const headers = { 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1', Cookie: 'ephemeral=setup-fixture-browser' };
const sessionId = 'setup-execution-http';
async function open() {
  const config = readConfig({ EPHEMERAL_MODE: 'preview', DATA_DIR: join(directory, 'database'),
    PUBLIC_URL: 'http://localhost:4327', ENCRYPTION_KEY: key, ALLOWED_GITHUB_IDS: '42' });
  application = await createLiveApplication({ ...config, mode: 'live' });
  await new Promise<void>(resolve => application!.server.listen(0, '127.0.0.1', resolve));
  const address = application.server.address();
  if (!address || typeof address === 'string') throw new Error('No local fixture listener');
  origin = `http://127.0.0.1:${address.port}`;
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ep-setup-execution-http-'));
  fixture.workspace = join(directory, 'workspace');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(fixture.workspace, { mode: 0o700 });
  await writeFile(join(fixture.workspace, 'auth.json'), JSON.stringify({ tokens: { access_token: credential } }), { mode: 0o600 });
  await open();
  await application!.db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
    [digest('setup-fixture-browser'), '42', 'owner', '', seal(randomBytes(24).toString('hex'), key), new Date(Date.now() + 3_600_000).toISOString()]);
  const session: Session = { id: sessionId, userId: '42', repository: 'owner/repo', repositoryId: 1, installationId: 2,
    baseBranch: 'main', branch: `ephemeral/${sessionId}`, state: 'running', createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), maxExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    sandboxId: 'synthetic-running-workspace', endedAt: null, error: null, codexRemoteRevocation: 'unverified',
    cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' } };
  await application!.repo.insert(session);
}, 30_000);
afterAll(async () => { await application?.close(); if (directory) await rm(directory, { recursive: true, force: true }); }, 30_000);

const request = (method = 'GET', body?: unknown, suffix = '') => fetch(`${origin}/api/sessions/${sessionId}/setup${suffix}`, {
  method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

it('retains a redacted failure head and tail through real HTTP execution, database restart and explicit retry', async () => {
  const source = `const fs=require('node:fs');const auth=JSON.parse(fs.readFileSync('auth.json','utf8'));
process.stdout.write('BEGIN INSTALL DIAGNOSTICS\\n');
process.stdout.write(('verbose build detail '+'.'.repeat(80)+'\\n').repeat(12000));
process.stdout.write('Exact credential: '+auth.tokens.access_token+'\\n');
process.stdout.write('FINAL ERROR: required fixture dependency missing\\n');
process.exitCode=7;`;
  const command = `${shellQuote(process.execPath)} -e ${shellQuote(source)}`;
  const savedResponse = await request('PUT', { label: 'Local subprocess setup', command, timeoutSeconds: 5 });
  expect(savedResponse.status).toBe(200);
  const saved = await savedResponse.json();
  expect(fixture.invocations).toBe(0);
  const start = await request('POST', { recipeVersion: saved.recipe.version }, '/runs');
  expect(start.status).toBe(202);
  let completed!: SetupRun;
  await vi.waitFor(async () => {
    const response = await request(); expect(response.status).toBe(200);
    completed = (await response.json()).run;
    expect(completed).toMatchObject({ status: 'failed', exitCode: 7, blockedUntil: null, truncated: true });
  }, { timeout: 10_000 });
  expect(completed.output).toContain('BEGIN INSTALL DIAGNOSTICS');
  expect(completed.output).toContain('FINAL ERROR: required fixture dependency missing');
  expect(completed.output).toContain('[REDACTED]');
  expect(completed.output).not.toContain(credential.slice(0, 12));
  expect(Buffer.byteLength(completed.output)).toBeLessThanOrEqual(65_536);
  expect(completed.output).not.toContain('\ufffd');
  expect(fixture.invocations).toBe(1);
  // The command has really run, and retained output survives reopening PGlite.
  expect(JSON.parse(await readFile(join(fixture.workspace, 'auth.json'), 'utf8')).tokens.access_token).toBe(credential);
  await application!.close(); application = undefined;
  await open();
  expect((await request().then(r => r.json())).run).toEqual(completed);
  expect(fixture.invocations).toBe(1);
  expect((await request('POST', { recipeVersion: saved.recipe.version }, '/runs')).status).toBe(202);
  await vi.waitFor(async () => expect((await request().then(r => r.json())).run).toMatchObject({ status: 'failed', exitCode: 7, blockedUntil: null }), { timeout: 10_000 });
  expect(fixture.invocations).toBe(2);
}, 30_000);
