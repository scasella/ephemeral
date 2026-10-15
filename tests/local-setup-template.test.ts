import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fork: vi.fn(), get: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), fork: mocks.fork }));
vi.mock('e2b', async importOriginal => ({
  ...await importOriginal<typeof import('e2b')>(),
  ApiClient: class { api = { GET: mocks.get }; },
}));
import { Sandbox, Template } from 'e2b';
import { buildSetupTemplate, verifySetupTemplate } from '../scripts/local-setup-template.js';
import { checkE2bConfiguration } from '../scripts/e2b-preflight.js';
import { initializeLocalConfig, readLocalConfig, setLocalConfigValue } from '../scripts/local-setup-config.js';
import { createTemplateRecipe } from '../sandbox/build-template.js';
import { runtimeVersions } from '../sandbox/runtime-versions.js';

const secret = 'e2b_private_test_key_DO_NOT_PRINT';
let workspace: string;
let onRun: (child: EventEmitter & { kill: ReturnType<typeof vi.fn> }) => void | Promise<void>;
beforeEach(async () => {
  workspace = await mkdtemp(join(await realpath(tmpdir()), 'ephemeral-template-'));
  await writeFile(join(workspace, '.gitignore'), '.env.live\n.data/\n');
  await initializeLocalConfig(workspace);
  await setLocalConfigValue(workspace, 'E2B_API_KEY', secret);
  mocks.fork.mockReset(); mocks.get.mockReset();
  onRun = child => { child.emit('message', { type: 'setup-result', result: { templateId: 'ready-template123' } }); child.emit('exit', 0, null); };
  mocks.fork.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    queueMicrotask(() => { void onRun(child); }); return child;
  });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); await rm(workspace, { recursive: true, force: true }); });

describe('confirmed template setup', () => {
  it('requires literal confirmation before spawning any provider work', async () => {
    await expect(buildSetupTemplate(workspace, { confirmed: false })).rejects.toThrow('explicit confirmation');
    await expect(buildSetupTemplate(workspace, { confirmed: 'true' as unknown as boolean })).rejects.toThrow('explicit confirmation');
    expect(mocks.fork).not.toHaveBeenCalled();
  });
  it('persists only the IPC SDK result and preserves credentials and private permissions', async () => {
    const encryptionKey = (await readLocalConfig(workspace)).ENCRYPTION_KEY;
    await expect(buildSetupTemplate(workspace, { confirmed: true })).resolves.toEqual({ templateId: 'ready-template123' });
    expect(await readLocalConfig(workspace)).toMatchObject({ E2B_TEMPLATE_ID: 'ready-template123', E2B_API_KEY: secret, ENCRYPTION_KEY: encryptionKey });
    expect((await stat(join(workspace, '.env.live'))).mode & 0o777).toBe(0o600);
    expect(mocks.fork).toHaveBeenCalledTimes(1);
  });
  it('uses selected key only and clears inherited, supplemental, and selected recipe or endpoint overrides', async () => {
    vi.stubEnv('E2B_API_KEY', 'wrong-parent-key'); vi.stubEnv('E2B_API_URL', 'https://attacker.invalid');
    vi.stubEnv('NODE_OPTIONS', '--import=evil'); vi.stubEnv('HTTPS_PROXY', 'https://attacker.invalid');
    await writeFile(join(workspace, '.env'), 'E2B_API_KEY=wrong-dotenv-key\nE2B_API_URL=https://attacker.invalid\n');
    await writeFile(join(workspace, '.env.live'), (await readFile(join(workspace, '.env.live'), 'utf8')) + 'E2B_BASE_IMAGE=attacker/image\nE2B_TEMPLATE_ALIAS=attacker\nE2B_TEMPLATE_CODEX_VERSION=999.0.0\nE2B_API_URL=https://attacker.invalid\n');
    await buildSetupTemplate(workspace, { confirmed: true });
    const [, args, options] = mocks.fork.mock.calls[0];
    expect(args).toEqual(['--setup-worker', 'build', '--confirmed-build']);
    expect(JSON.stringify(args)).not.toContain(secret);
    expect(options.env).toMatchObject({ E2B_API_KEY: secret, E2B_API_URL: '', E2B_DOMAIN: '', E2B_SANDBOX_URL: '', E2B_BASE_IMAGE: '', E2B_TEMPLATE_ALIAS: '', E2B_TEMPLATE_CODEX_VERSION: '' });
    expect(options.env.NODE_OPTIONS).toBeUndefined(); expect(options.env.HTTPS_PROXY).toBeUndefined();
    expect(options.stdio).toEqual(['ignore', 'ignore', 'ignore', 'ipc']); expect(options.execArgv).toEqual(['--import', import.meta.resolve('tsx')]);
  });
  it('refuses a rebuild once an ID is configured', async () => {
    await setLocalConfigValue(workspace, 'E2B_TEMPLATE_ID', 'already-ready');
    await expect(buildSetupTemplate(workspace, { confirmed: true })).rejects.toThrow('already configured');
    expect(mocks.fork).not.toHaveBeenCalled();
  });
  it('writes a private key-free pending receipt before provider work and removes it after saving success', async () => {
    onRun = async child => {
      const path = join(workspace, '.data/local-live/template-build-pending.json');
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ status: 'pending', alias: 'ephemeral-codex' });
      expect(await readFile(path, 'utf8')).not.toContain(secret);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      child.emit('message', { type: 'setup-result', result: { templateId: 'ready-template123' } }); child.emit('exit', 0, null);
    };
    await buildSetupTemplate(workspace, { confirmed: true });
    expect(await readdir(join(workspace, '.data/local-live'))).not.toContain('template-build-pending.json');
  });
  it('blocks a second build after interruption until the user checks and explicitly clears the receipt', async () => {
    onRun = child => { child.emit('exit', 1, null); };
    await expect(buildSetupTemplate(workspace, { confirmed: true })).rejects.toThrow('receipt');
    await expect(buildSetupTemplate(workspace, { confirmed: true })).rejects.toThrow('previous template build may be pending');
    expect(mocks.fork).toHaveBeenCalledTimes(1);
    await rm(join(workspace, '.data/local-live/template-build-pending.json'));
    onRun = child => { child.emit('message', { type: 'setup-result', result: { templateId: 'recovered123' } }); child.emit('exit', 0, null); };
    await expect(buildSetupTemplate(workspace, { confirmed: true })).resolves.toEqual({ templateId: 'recovered123' });
  });
  it('suppresses raw SDK and process errors without retry or ID persistence', async () => {
    onRun = child => { child.emit('error', new Error(`Authorization: Bearer ${secret}`)); };
    const error = await buildSetupTemplate(workspace, { confirmed: true }).then<never, Error>(() => { throw new Error('Unexpected success'); }, (error: unknown) => error as Error);
    expect(error.message).toContain('dashboard'); expect(error.message).not.toContain(secret);
    expect((await readLocalConfig(workspace)).E2B_TEMPLATE_ID).toBe(''); expect(mocks.fork).toHaveBeenCalledTimes(1);
  });
  it.each(['malicious\nE2B_TEMPLATE_ID=attacker', secret, 'x'.repeat(129)])('rejects malformed or credential-bearing IPC result %s', async templateId => {
    onRun = child => { child.emit('message', { type: 'setup-result', result: { templateId } }); child.emit('exit', 0, null); };
    await expect(buildSetupTemplate(workspace, { confirmed: true })).rejects.toThrow('did not finish');
    expect((await readLocalConfig(workspace)).E2B_TEMPLATE_ID).toBe('');
  });
  it('requires a successful child exit even after receiving a valid ID', async () => {
    onRun = child => { child.emit('message', { type: 'setup-result', result: { templateId: 'partial-build' } }); child.emit('exit', 1, null); };
    await expect(buildSetupTemplate(workspace, { confirmed: true })).rejects.toThrow('did not finish');
    expect((await readLocalConfig(workspace)).E2B_TEMPLATE_ID).toBe('');
  });
  it('times out a stuck child and never retries or saves a speculative ID', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); onRun = () => {};
    const pending = buildSetupTemplate(workspace, { confirmed: true });
    // File IO uses real timers; wait until the fake child has been created.
    while (!mocks.fork.mock.calls.length) await new Promise(resolve => setImmediate(resolve));
    const assertion = expect(pending).rejects.toThrow('dashboard');
    await vi.advanceTimersByTimeAsync(20 * 60_000); await assertion;
    expect(mocks.fork).toHaveBeenCalledTimes(1); expect((await readLocalConfig(workspace)).E2B_TEMPLATE_ID).toBe('');
  });
  it('preserves a concurrent config change and saves a private key-free recovery reference', async () => {
    const before = await readFile(join(workspace, '.env.live'), 'utf8');
    onRun = async child => {
      await writeFile(join(workspace, '.env.live'), before + '# deliberate concurrent change\n');
      child.emit('message', { type: 'setup-result', result: { templateId: 'recover-ready123' } }); child.emit('exit', 0, null);
    };
    const error = await buildSetupTemplate(workspace, { confirmed: true }).then<never, Error>(() => { throw new Error('Unexpected success'); }, (error: unknown) => error as Error);
    expect(error.message).toContain('configuration changed'); expect(error.message).not.toContain(secret);
    expect(await readFile(join(workspace, '.env.live'), 'utf8')).toBe(before + '# deliberate concurrent change\n');
    const files = (await readdir(join(workspace, '.data/local-live'))).filter(name => name.startsWith('template-recovery-'));
    expect(files).toHaveLength(1);
    const path = join(workspace, '.data/local-live', files[0]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ templateId: 'recover-ready123' });
    expect((await stat(path)).mode & 0o777).toBe(0o600); expect(mocks.fork).toHaveBeenCalledTimes(1);
  });
  it('does not build when the private configuration is unsafe', async () => {
    await chmod(join(workspace, '.env.live'), 0o644);
    await expect(buildSetupTemplate(workspace, { confirmed: true })).rejects.toThrow(); expect(mocks.fork).not.toHaveBeenCalled();
  });
});

describe('shared recipe and read-only checks', () => {
  it('serializes the same pinned, clean-auth recipe without copying workspace files', async () => {
    const recipe = await Template.toJSON(createTemplateRecipe(), false);
    const serialized = JSON.stringify(recipe);
    for (const value of [runtimeVersions.baseImage, runtimeVersions.codex, runtimeVersions.pnpm, 'python3', 'tmux', 'git', 'test ! -f /home/user/.codex/auth.json']) expect(serialized).toContain(value);
    expect(serialized).not.toContain(secret); expect(serialized).not.toContain(workspace);
    expect(serialized).not.toContain('COPY');
  });
  it('passes a bounded read-only report through the isolated worker', async () => {
    const report = { ok: true, checks: [{ name: 'template-readiness', status: 'pass', message: 'Template is ready.' }] };
    onRun = child => { child.emit('message', { type: 'setup-result', result: report }); child.emit('exit', 0, null); };
    await expect(verifySetupTemplate(workspace)).resolves.toEqual(report);
    expect(mocks.fork.mock.calls[0][1]).toEqual(['--setup-worker', 'verify']);
  });
  it('refuses direct internal worker invocation without IPC before any provider mutation', async () => {
    const { spawnSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), join(process.cwd(), 'scripts/local-setup-template.ts'), '--setup-worker', 'build', '--confirmed-build'], {
      env: { E2B_API_KEY: secret, E2B_API_URL: 'http://127.0.0.1:1' }, encoding: 'utf8', timeout: 5000, maxBuffer: 4096,
    });
    expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toBe('');
  });
  it('runs the real isolated child and reports a missing saved key before any provider request', async () => {
    const content = await readFile(join(workspace, '.env.live'), 'utf8');
    await writeFile(join(workspace, '.env.live'), content.replace(secret, ''));
    const original = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    mocks.fork.mockImplementation(original.fork);
    const report = await verifySetupTemplate(workspace);
    expect(report.ok).toBe(false);
    expect(report.checks.at(-1)).toMatchObject({ name: 'configuration', status: 'fail', message: 'E2B_API_KEY is missing.' });
  });
  it('reuses SDK account, template access, and readiness checks without starting a sandbox', async () => {
    const list = vi.spyOn(Sandbox, 'list').mockReturnValue({ nextItems: vi.fn().mockResolvedValue([]) } as unknown as ReturnType<typeof Sandbox.list>);
    const create = vi.spyOn(Sandbox, 'create');
    mocks.get.mockResolvedValue({ response: new Response('', { status: 200 }), data: [{ templateID: 'custom123', names: ['chosen'], aliases: [], cpuCount: 2, memoryMB: 512 }] });
    const tags = vi.spyOn(Template, 'getTags').mockResolvedValue([{ tag: 'default', buildId: 'build123' }] as Awaited<ReturnType<typeof Template.getTags>>);
    const status = vi.spyOn(Template, 'getBuildStatus').mockResolvedValue({ status: 'ready' } as Awaited<ReturnType<typeof Template.getBuildStatus>>);
    const report = await checkE2bConfiguration({ E2B_API_KEY: secret, E2B_TEMPLATE_ID: 'chosen', PUBLIC_URL: 'https://control.example.test' });
    expect(report.ok).toBe(true); expect(list).toHaveBeenCalledWith(expect.objectContaining({ apiKey: secret, retries: 0, requestTimeoutMs: 15_000 }));
    expect(tags).toHaveBeenCalled(); expect(status).toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });
  it('turns invalid credentials and provider errors into static resumable guidance', async () => {
    vi.spyOn(Sandbox, 'list').mockImplementation(() => { throw new Error(`headers=${secret}`); });
    const report = await checkE2bConfiguration({ E2B_API_KEY: secret, E2B_TEMPLATE_ID: 'missing', PUBLIC_URL: 'https://control.example.test' });
    expect(report.ok).toBe(false); expect(JSON.stringify(report)).not.toContain(secret);
    expect(report.checks.at(-1)).toMatchObject({ name: 'account-access', status: 'fail' });
  });
});
