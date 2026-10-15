import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifest, persistRegistration, publicOrigin, startRegistration } from '../scripts/register-github-app.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(initial = 'E2B_API_KEY="existing-e2b-value"\nGITHUB_APP_ID=\nGITHUB_CLIENT_SECRET=\n') {
  const workspace = await mkdtemp(join(tmpdir(), 'ephemeral-registration-test-'));
  cleanups.push(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, '.gitignore'), '.env\n.data/\n'); await writeFile(join(workspace, '.env'), initial);
  const options = { publicUrl: 'https://ephemeral.example.com', ownerId: 123456, name: 'Ephemeral registration test', workspace };
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const registration = { id: 42, slug: 'ephemeral-registration-test', client_id: 'Iv1.test', client_secret: 'CLIENT-SECRET-PRIVATE',
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), owner: { id: 123456 }, webhook_secret: 'UNUSED-WEBHOOK-SECRET' };
  return { workspace, options, registration };
}

describe('private GitHub App registration helper', () => {
  it('requires a public HTTPS origin and declares only needed permissions', () => {
    for (const target of ['http://ephemeral.example.com', 'https://localhost', 'https://127.0.0.1', 'https://user:pass@example.com', 'https://example.com/path']) expect(() => publicOrigin(target)).toThrow();
    const result = manifest({ publicUrl: 'https://ephemeral.example.com/', ownerId: 123456, name: 'Ephemeral test' }, 'http://127.0.0.1:1234/callback');
    expect(result.public).toBe(false); expect(result.default_permissions).toEqual({ contents: 'write', pull_requests: 'write' });
    expect(result.default_events).toEqual([]); expect(result.hook_attributes.active).toBe(false);
    expect(result.callback_urls).toEqual(['https://ephemeral.example.com/auth/github/callback']);
  });
  it('saves credentials privately and fills empty fields while preserving existing unrelated config', async () => {
    const { workspace, options, registration } = await fixture(); const result = await persistRegistration(options, registration);
    const env = await readFile(join(workspace, '.env'), 'utf8');
    expect(env).toContain('E2B_API_KEY="existing-e2b-value"'); expect(env).toContain('GITHUB_APP_ID="42"');
    expect(env).toContain('GITHUB_CLIENT_SECRET="CLIENT-SECRET-PRIVATE"'); expect(env).not.toContain('BEGIN PRIVATE KEY');
    expect(await readFile(result.pemFile, 'utf8')).toBe(registration.pem);
    expect((await lstat(result.envFile)).mode & 0o777).toBe(0o600); expect((await lstat(result.pemFile)).mode & 0o777).toBe(0o600);
    expect((await lstat(result.directory)).mode & 0o777).toBe(0o700);
  });
  it('writes isolated .env.live while leaving preview .env unchanged and requires it to be ignored', async () => {
    const f = await fixture('EPHEMERAL_MODE=preview\nPUBLIC_URL=http://localhost:4310\n');
    const initial = await readFile(join(f.workspace, '.env'), 'utf8');
    const options = { ...f.options, envFile: '.env.live' as const };
    await expect(persistRegistration(options, f.registration)).rejects.toThrow('.gitignore');
    await writeFile(join(f.workspace, '.gitignore'), '.env\n.env.*\n!.env.example\n.data/\n');
    const result = await persistRegistration(options, f.registration);
    expect(result.envFile).toBe(join(f.workspace, '.env.live'));
    expect(await readFile(join(f.workspace, '.env'), 'utf8')).toBe(initial);
    expect(await readFile(result.envFile, 'utf8')).toContain('GITHUB_APP_ID="42"');
    expect((await lstat(result.envFile)).mode & 0o777).toBe(0o600);
    await expect(startRegistration({ ...f.options, envFile: '../.env' as '.env' })).rejects.toThrow('Environment output');
  });
  it('checks effective negations for both live output and private credential storage', async () => {
    const f = await fixture();
    await writeFile(join(f.workspace, '.gitignore'), '.env\n.env.live\n!.env.live\n.data/\n');
    await expect(persistRegistration({ ...f.options, envFile: '.env.live' }, f.registration)).rejects.toThrow('effectively exclude');
    await writeFile(join(f.workspace, '.gitignore'), '.env\n.env.*\n.data/\n!.data/\n');
    await expect(persistRegistration(f.options, f.registration)).rejects.toThrow('effectively exclude');
    expect(await readFile(join(f.workspace, '.env'), 'utf8')).not.toContain('CLIENT-SECRET-PRIVATE');
  });
  it('refuses already tracked live output and private storage even when matching ignore rules exist', async () => {
    const f = await fixture();
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: f.workspace, encoding: 'utf8' });
      expect(result.status).toBe(0);
    };
    await writeFile(join(f.workspace, '.gitignore'), '.env\n.env.*\n.data/\n');
    git(['init', '--quiet']); await writeFile(join(f.workspace, '.env.live'), 'GITHUB_APP_ID=\n');
    git(['add', '--force', '--', '.env.live']);
    await expect(persistRegistration({ ...f.options, envFile: '.env.live' }, f.registration)).rejects.toThrow('already tracked');
    git(['rm', '--cached', '--', '.env.live']);
    await mkdir(join(f.workspace, '.data', 'github-registration'), { recursive: true });
    await writeFile(join(f.workspace, '.data', 'github-registration', 'tracked-placeholder'), 'not a secret');
    git(['add', '--force', '--', '.data/github-registration/tracked-placeholder']);
    await expect(persistRegistration({ ...f.options, envFile: '.env.live' }, f.registration)).rejects.toThrow('already tracked');
  });
  it('refuses existing credentials and mismatched public origin before opening registration', async () => {
    const a = await fixture('GITHUB_APP_ID=existing\n'); await expect(startRegistration(a.options)).rejects.toThrow('overwrite');
    expect(await readFile(join(a.workspace, '.env'), 'utf8')).toBe('GITHUB_APP_ID=existing\n');
    const b = await fixture('PUBLIC_URL=https://different.example.com\n'); await expect(startRegistration(b.options)).rejects.toThrow('differs');
  });
  it('rejects changed config and unexpected owners without overwriting the operator config', async () => {
    const f = await fixture(); await expect(persistRegistration(f.options, { ...f.registration, owner: { id: 99 } })).rejects.toThrow('owner');
    expect(await readFile(join(f.workspace, '.env'), 'utf8')).not.toContain('CLIENT-SECRET-PRIVATE');
  });
  it('binds to loopback, validates one-use state and Host, and never returns secrets to the browser', async () => {
    const f = await fixture(); const convert = vi.fn(async () => f.registration); const service = await startRegistration(f.options, convert); cleanups.push(() => service.close());
    const url = new URL(service.url), state = url.pathname.split('/').at(-1)!;
    const form = await fetch(service.url); const html = await form.text(); expect(form.status).toBe(200); expect(html).toContain('https://github.com/settings/apps/new?state='); expect(html).not.toContain('CLIENT-SECRET-PRIVATE');
    const invalidHost = await new Promise<number>((resolve, reject) => {
      const req = request(service.url, { headers: { Host: 'malicious.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject); req.end();
    });
    expect(invalidHost).toBe(403);
    const callback = `${url.origin}/callback?code=${'a'.repeat(40)}&state=`;
    expect((await fetch(callback + 'wrong')).status).toBe(403); expect(convert).not.toHaveBeenCalled();
    const complete = await fetch(callback + state); expect(complete.status).toBe(200); expect(await complete.text()).not.toContain('CLIENT-SECRET-PRIVATE');
    expect((await service.completed).appId).toBe(42); expect(convert).toHaveBeenCalledTimes(1);
    expect((await fetch(callback + state)).status).toBe(404); expect(convert).toHaveBeenCalledTimes(1);
  });
  it('detects config changed during browser approval and retains private recovery credentials', async () => {
    const f = await fixture(); const convert = vi.fn(async () => { await writeFile(join(f.workspace, '.env'), 'E2B_API_KEY="new-operator-value"\n'); return f.registration; });
    const service = await startRegistration(f.options, convert); cleanups.push(() => service.close());
    const failure = expect(service.completed).rejects.toThrow('recovery');
    const url = new URL(service.url), state = url.pathname.split('/').at(-1)!;
    expect((await fetch(`${url.origin}/callback?code=${'a'.repeat(40)}&state=${state}`)).status).toBe(500);
    await failure; expect(await readFile(join(f.workspace, '.env'), 'utf8')).toBe('E2B_API_KEY="new-operator-value"\n');
    const { readdir } = await import('node:fs/promises'); const privateRoot = join(f.workspace, '.data', 'github-registration');
    const records = await readdir(privateRoot); expect(records).toHaveLength(1);
    expect(JSON.parse(await readFile(join(privateRoot, records[0], 'credentials.json'), 'utf8')).client_secret).toBe('CLIENT-SECRET-PRIVATE');
  });
});
