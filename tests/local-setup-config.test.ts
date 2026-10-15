import { afterEach, describe, expect, it } from 'vitest';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { initializeLocalConfig, localChildEnvironment, readLocalConfig, setLocalConfigValue, validateLocalConfig } from '../scripts/local-setup-config.js';

const workspaces: string[] = [];
afterEach(async () => { await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function workspace(ignored = true) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'ephemeral-config-test-'))); workspaces.push(path);
  if (ignored) await writeFile(join(path, '.gitignore'), '.env.live\n.data/\n');
  return path;
}
async function rewrite(path: string, content: string) { await writeFile(join(path, '.env.live'), content, { mode: 0o600 }); }
function git(path: string, args: string[]) { const result = spawnSync('git', args, { cwd: path, encoding: 'utf8' }); if (result.status !== 0) throw new Error('Test Git command failed'); }

describe('private local configuration', () => {
  it('initializes an archive privately, independently of cloud environment and unrelated files; reruns preserve key and values', async () => {
    const path = await workspace(); await writeFile(join(path, '.env'), 'DATABASE_URL=external\n');
    await initializeLocalConfig(path); const before = await readFile(join(path, '.env.live'), 'utf8');
    const values = await readLocalConfig(path);
    expect(values).toMatchObject({ NODE_ENV: 'production', EPHEMERAL_MODE: 'live', HOST: '127.0.0.1', PORT: '4311', DATA_DIR: '.data/local-live', DATABASE_URL: '', PREVIEW_PUBLIC_URL: '', SESSION_MAX_HOURS: '1' });
    expect(Buffer.from(values.ENCRYPTION_KEY, 'base64')).toHaveLength(32);
    await initializeLocalConfig(path); expect(await readFile(join(path, '.env.live'), 'utf8')).toBe(before);
    expect(await readFile(join(path, '.env'), 'utf8')).toBe('DATABASE_URL=external\n');
    expect((await lstat(join(path, '.env.live'))).mode & 0o777).toBe(0o600);
    for (const dir of ['.data', '.data/local-live']) expect((await lstat(join(path, dir))).mode & 0o777).toBe(0o700);
    expect(await readdir(path)).not.toContain('.git');
  });
  it('requires workspace ignore rules before creating data and checks tracked paths', async () => {
    const path = await workspace(false);
    await expect(initializeLocalConfig(path)).rejects.toThrow('gitignore');
    expect(await readdir(path)).toEqual([]);
    await writeFile(join(path, '.gitignore'), '.env.live\n.data/\n'); git(path, ['init', '--quiet']);
    await writeFile(join(path, '.env.live'), 'SECRET=not-a-real-secret\n', { mode: 0o600 });
    git(path, ['add', '--force', '.env.live']);
    await expect(initializeLocalConfig(path)).rejects.toThrow('tracked');
  });
  it('checks all .data paths for tracking and handles nested archive ignore rules independently', async () => {
    const path = await workspace(); git(path, ['init', '--quiet']);
    await mkdir(join(path, '.data'), { mode: 0o700 }); await writeFile(join(path, '.data', 'tracked'), 'fixture'); git(path, ['add', '--force', '.data/tracked']);
    await expect(initializeLocalConfig(path)).rejects.toThrow('tracked');
    const nested = join(path, 'archive'); await mkdir(nested);
    await expect(initializeLocalConfig(nested)).rejects.toThrow('gitignore');
  });
  it('rejects symlink directories and files without touching targets', async () => {
    for (const target of ['.data', '.env.live']) {
      const path = await workspace(); const outside = await workspace();
      const destination = target === '.data' ? outside : join(outside, 'secret');
      if (target !== '.data') await writeFile(destination, 'keep', { mode: 0o600 });
      await symlink(destination, join(path, target));
      await expect(initializeLocalConfig(path)).rejects.toThrow('symlink');
      if (target !== '.data') expect(await readFile(destination, 'utf8')).toBe('keep');
    }
    const path = await workspace(); await mkdir(join(path, '.data'), { mode: 0o700 });
    await symlink(await workspace(), join(path, '.data/local-live'));
    await expect(initializeLocalConfig(path)).rejects.toThrow('symlink');
  });
  it('rejects unsafe permissions rather than silently changing files or directories', async () => {
    const path = await workspace(); await initializeLocalConfig(path);
    await chmod(join(path, '.env.live'), 0o644);
    await expect(readLocalConfig(path)).rejects.toThrow('permissions');
    await chmod(join(path, '.env.live'), 0o600); await chmod(join(path, '.data'), 0o755);
    await expect(initializeLocalConfig(path)).rejects.toThrow('permissions');
    expect((await lstat(join(path, '.data'))).mode & 0o777).toBe(0o755);
  });
  it('preserves existing key and refuses conflicting isolation settings or missing keys', async () => {
    const path = await workspace(); await initializeLocalConfig(path);
    const original = await readFile(join(path, '.env.live'), 'utf8');
    for (const [from, to] of [["HOST='127.0.0.1'", "HOST='0.0.0.0'"], ["DATA_DIR='.data/local-live'", "DATA_DIR='.data'"], ["DATABASE_URL=''", "DATABASE_URL='postgres://private'"], ["PREVIEW_PUBLIC_URL=''", "PREVIEW_PUBLIC_URL='http://localhost:4312'"]]) {
      const changed = original.replace(from, to); await rewrite(path, changed);
      await expect(initializeLocalConfig(path)).rejects.toThrow('conflicts'); expect(await readFile(join(path, '.env.live'), 'utf8')).toBe(changed);
    }
    await rewrite(path, original.replace(/^ENCRYPTION_KEY=.*\n/m, ''));
    await expect(initializeLocalConfig(path)).rejects.toThrow('lacks ENCRYPTION_KEY');
  });
  it('reads duplicate assignments strictly, including multiline and export syntax', async () => {
    const path = await workspace(); await initializeLocalConfig(path);
    const original = await readFile(join(path, '.env.live'), 'utf8');
    await rewrite(path, original + "export E2B_API_KEY='do-not-print-this'\n");
    await expect(readLocalConfig(path)).rejects.toThrow('Duplicate');
    await rewrite(path, original + "EXTRA='one\ntwo'\nEXTRA='three'\n");
    await expect(readLocalConfig(path)).rejects.toThrow('Duplicate');
    await rewrite(path, original + 'bad syntax\n'); await expect(readLocalConfig(path)).rejects.toThrow('Malformed');
  });
  it('writes literal special characters and PEM paths with spaces as dotenv data', async () => {
    const path = await workspace(); await initializeLocalConfig(path);
    const literal = `key $HOME $(touch nope) # 'double" \\n literal\nsecond line`;
    await setLocalConfigValue(path, 'E2B_API_KEY', literal);
    expect((await readLocalConfig(path)).E2B_API_KEY).toBe(literal);
    expect(parseEnv(await readFile(join(path, '.env.live'), 'utf8')).E2B_API_KEY).toBe(literal);
    const pemPath = join(path, 'private key.pem');
    await setLocalConfigValue(path, 'GITHUB_APP_PRIVATE_KEY_FILE', pemPath);
    expect((await readLocalConfig(path)).GITHUB_APP_PRIVATE_KEY_FILE).toBe(pemPath);
    expect(await readdir(path)).not.toContain('nope');
  });
  it('never rotates key or overwrites existing credentials, allows explicit port selection, preserves comments', async () => {
    const path = await workspace(); await initializeLocalConfig(path);
    await rewrite(path, (await readFile(join(path, '.env.live'), 'utf8')) + '# private comment\nUNRELATED=keep\n');
    const key = (await readLocalConfig(path)).ENCRYPTION_KEY;
    await setLocalConfigValue(path, 'E2B_API_KEY', 'first');
    await expect(setLocalConfigValue(path, 'E2B_API_KEY', 'second')).rejects.toThrow('differs');
    await expect(setLocalConfigValue(path, 'ENCRYPTION_KEY', 'replacement')).rejects.toThrow('cannot');
    await expect(setLocalConfigValue(path, 'NODE_OPTIONS', '--inspect')).rejects.toThrow('cannot');
    await setLocalConfigValue(path, 'PORT', '4316'); await initializeLocalConfig(path);
    expect((await readLocalConfig(path)).PORT).toBe('4316');
    await expect(setLocalConfigValue(path, 'PORT', '70000')).rejects.toThrow('valid TCP');
    expect((await readLocalConfig(path)).ENCRYPTION_KEY).toBe(key);
    expect(await readFile(join(path, '.env.live'), 'utf8')).toContain('# private comment\nUNRELATED=keep');
  });
  it('guards concurrent setters and expected-content conflicts without lost updates', async () => {
    const path = await workspace(); await initializeLocalConfig(path);
    const original = await readFile(join(path, '.env.live'), 'utf8');
    const results = await Promise.allSettled([setLocalConfigValue(path, 'E2B_API_KEY', 'a'), setLocalConfigValue(path, 'E2B_API_KEY', 'b')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(['a', 'b']).toContain((await readLocalConfig(path)).E2B_API_KEY);
    await expect(setLocalConfigValue(path, 'E2B_TEMPLATE_ID', 'new-template', { expectedContent: original })).rejects.toThrow('changed');
    expect((await readLocalConfig(path)).E2B_TEMPLATE_ID).toBe('');
    expect(await readdir(join(path, '.data/local-live'))).toEqual([]);
  });
  it('rejects secret-bearing URLs before persistence or public reads and validates public IDs', async () => {
    const path = await workspace(); await initializeLocalConfig(path);
    const original = await readFile(join(path, '.env.live'), 'utf8');
    for (const url of ['https://operator:DO_NOT_ECHO@fixture.example', 'http://fixture.example', 'https://localhost', 'https://fixture.example?token=DO_NOT_ECHO', ' https://fixture.example']) {
      try { await setLocalConfigValue(path, 'PUBLIC_URL', url); throw new Error('Expected URL rejection'); } catch (error) { expect(String(error)).not.toContain('DO_NOT_ECHO'); expect(String(error)).toContain('HTTPS'); }
      expect(await readFile(join(path, '.env.live'), 'utf8')).toBe(original);
    }
    for (const [key, value] of [['E2B_TEMPLATE_ID', 'e2b_DO_NOT_ECHO'], ['GITHUB_APP_ID', 'not-numeric'], ['GITHUB_APP_SLUG', 'not a slug'], ['ALLOWED_GITHUB_IDS', 'username']]) await expect(setLocalConfigValue(path, key, value)).rejects.toThrow();
    await rewrite(path, original.replace(/^PUBLIC_URL=''/m, "PUBLIC_URL='https://user:DO_NOT_ECHO@fixture.example'"));
    try { await readLocalConfig(path); throw new Error('Expected public read rejection'); } catch (error) { expect(String(error)).not.toContain('DO_NOT_ECHO'); expect(String(error)).toContain('HTTPS'); }
  });
  it('rejects linked files and active setup locks', async () => {
    const path = await workspace(); await initializeLocalConfig(path);
    await link(join(path, '.env.live'), join(path, 'linked-env'));
    await expect(readLocalConfig(path)).rejects.toThrow('hard links');
    await rm(join(path, 'linked-env'));
    await writeFile(join(path, '.data/local-live/.setup.lock'), '', { mode: 0o600 });
    await expect(setLocalConfigValue(path, 'E2B_API_KEY', 'new')).rejects.toThrow('busy');
    expect((await readLocalConfig(path)).E2B_API_KEY).toBe('');
  });
  it('reports missing names without secrets; validates RSA PEM files and origins', async () => {
    const path = await workspace(); await initializeLocalConfig(path);
    const { missing } = await validateLocalConfig(path);
    expect(missing).toContain('PUBLIC_URL'); expect(missing).toContain('GITHUB_APP_PRIVATE_KEY');
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const pemPath = join(path, 'private key.pem'); await writeFile(pemPath, pem, { mode: 0o600 });
    for (const [key, value] of Object.entries({ PUBLIC_URL: 'https://fixture.example', E2B_API_KEY: 'secret-fixture', E2B_TEMPLATE_ID: 'template', GITHUB_APP_ID: '123', GITHUB_APP_SLUG: 'fixture', GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret-fixture', ALLOWED_GITHUB_IDS: '123', GITHUB_APP_PRIVATE_KEY_FILE: pemPath })) await setLocalConfigValue(path, key, value);
    expect((await validateLocalConfig(path)).missing).toEqual([]);
    await chmod(pemPath, 0o644); await expect(validateLocalConfig(path)).rejects.toThrow('private');
    await chmod(pemPath, 0o600); await writeFile(pemPath, 'VERY_PRIVATE_INVALID_KEY');
    try { await validateLocalConfig(path); throw new Error('Expected rejection'); } catch (error) { expect(String(error)).not.toContain('VERY_PRIVATE_INVALID_KEY'); expect(String(error)).toContain('RSA PEM'); }
    await rewrite(path, (await readFile(join(path, '.env.live'), 'utf8')).replace("PUBLIC_URL='https://fixture.example'", "PUBLIC_URL='https://private-user:private-password@fixture.example'"));
    try { await validateLocalConfig(path); throw new Error('Expected rejection'); } catch (error) { expect(String(error)).not.toContain('private-password'); expect(String(error)).toContain('HTTPS'); }
  });
  it('constructs child environment solely from selection and minimum platform state, blocks .env supplements', () => {
    const values = { PORT: '4316', E2B_API_KEY: 'selected', DATABASE_URL: '', GITHUB_APP_PRIVATE_KEY_FILE: '/private/key with spaces.pem' };
    const env = localChildEnvironment(values, { PATH: '/tools', HOME: '/home/operator', LANG: 'en_US.UTF-8', DATABASE_URL: 'cloud', E2B_API_KEY: 'cloud', NODE_OPTIONS: '--require inject', E2B_DOMAIN: 'cloud', OPENAI_API_KEY: 'cloud', HTTPS_PROXY: 'cloud' });
    expect(env).toMatchObject({ PATH: '/tools', HOME: '/home/operator', LANG: 'en_US.UTF-8', PORT: '4316', E2B_API_KEY: 'selected', DATABASE_URL: '', GITHUB_APP_PRIVATE_KEY: '', E2B_DOMAIN: '', E2B_API_URL: '', E2B_SANDBOX_URL: '', E2B_BASE_IMAGE: '', PREVIEW_PUBLIC_URL: '', DATA_DIR: '' });
    for (const key of ['NODE_OPTIONS', 'OPENAI_API_KEY', 'HTTPS_PROXY']) expect(env).not.toHaveProperty(key);
    const supplemented = { ...parseEnv('DATABASE_URL=cloud\nPREVIEW_PUBLIC_URL=https://cloud.example\nGITHUB_APP_PRIVATE_KEY=cloud\nE2B_API_URL=https://cloud.example'), ...env };
    expect(supplemented.DATABASE_URL).toBe(''); expect(supplemented.GITHUB_APP_PRIVATE_KEY).toBe(''); expect(supplemented.E2B_API_URL).toBe('');
  });
});
