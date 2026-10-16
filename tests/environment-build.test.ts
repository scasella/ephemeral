import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Template } from 'e2b';
import { createTemplateRecipe, parseTemplateBuildArgs, runTemplateBuild, TEMPLATE_TYPESCRIPT_VERSION } from '../sandbox/build-template.js';
import { runtimeVersions } from '../sandbox/runtime-versions.js';

afterEach(() => vi.restoreAllMocks());
describe('source-free environment build presets', () => {
  it('keeps the default recipe identical to explicit base and retains pinned runtime tools and fresh Codex login', async () => {
    expect(await Template.toJSON(createTemplateRecipe(), false)).toEqual(await Template.toJSON(createTemplateRecipe({ profile: 'base' }), false));
    for (const profile of ['base', 'node', 'python'] as const) {
      const text = JSON.stringify(await Template.toJSON(createTemplateRecipe({ profile }), false));
      for (const value of [runtimeVersions.baseImage, runtimeVersions.codex, runtimeVersions.pnpm, 'test ! -f /home/user/.codex/auth.json', 'forced_login_method']) expect(text).toContain(value);
      for (const value of ['COPY', 'git clone', '/workspace', 'auth.json\":', 'E2B_API_KEY', 'GITHUB_TOKEN']) expect(text).not.toContain(value);
    }
  });
  it('preinstalls and verifies the project-exact TypeScript version only for node', async () => {
    const project = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(TEMPLATE_TYPESCRIPT_VERSION).toBe(project.devDependencies.typescript);
    const node = JSON.stringify(await Template.toJSON(createTemplateRecipe({ profile: 'node' }), false));
    expect(node).toContain(`typescript@${TEMPLATE_TYPESCRIPT_VERSION}`); expect(node).toContain(`Version ${TEMPLATE_TYPESCRIPT_VERSION}`);
    expect(JSON.stringify(await Template.toJSON(createTemplateRecipe(), false))).not.toContain('typescript@');
  });
  it('adds Python development packages and smoke-tests isolated venv creation without removing Node/Codex', async () => {
    const python = JSON.stringify(await Template.toJSON(createTemplateRecipe({ profile: 'python' }), false));
    for (const value of ['python3-venv', 'python3-dev', 'build-essential', 'python3 -m venv', 'python -m pip --version', 'rm -rf /tmp/ephemeral-venv-check']) expect(python).toContain(value);
  });
  it.each([['--profile'], ['--profile', 'unknown'], ['--profile=node'], ['--dry-run', '--dry-run'], ['--profile', 'node', '--profile', 'base'], ['--template', 'arbitrary'], ['--tag'], ['--tag', 'latest'], ['--tag', 'default'], ['--tag', 'release;touch'], ['--tag', 'r1', '--tag', 'r2'], ['unrecognized']].map(args => ({ args })))('rejects invalid flags before provider calls: %j', async ({ args }) => {
    const build = vi.spyOn(Template, 'build');
    expect(() => parseTemplateBuildArgs(args)).toThrow();
    await expect(runTemplateBuild(args, {}, () => {})).rejects.toThrow(); expect(build).not.toHaveBeenCalled();
  });
  it('rejects newline-bearing build overrides and tag values before any provider call', async () => {
    const build = vi.spyOn(Template, 'build');
    for (const env of [{ E2B_TEMPLATE_ALIAS: 'alias\n' }, { E2B_TEMPLATE_CODEX_VERSION: '1.2.3\n' }, { E2B_TEMPLATE_PNPM_VERSION: '1.2.3\n' }]) {
      await expect(runTemplateBuild(['--dry-run'], env, () => {})).rejects.toThrow();
    }
    expect(() => parseTemplateBuildArgs(['--tag', 'v1\n'])).toThrow();
    expect(build).not.toHaveBeenCalled();
  });
  it('serializes every preset offline without credentials and includes release metadata', async () => {
    const build = vi.spyOn(Template, 'build');
    for (const profile of ['base', 'node', 'python']) {
      const log = vi.fn(); await runTemplateBuild(['--profile', profile, '--tag', 'release-oak', '--dry-run'], {}, log);
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ profile, tag: 'release-oak', recipe: expect.anything() });
    }
    expect(build).not.toHaveBeenCalled();
  });
  it('passes an explicit release tag to mocked build without configuring paid compute and retains base alias compatibility', async () => {
    const build = vi.spyOn(Template, 'build').mockResolvedValue({ templateId: 'built-template' } as Awaited<ReturnType<typeof Template.build>>);
    const log = vi.fn(); await runTemplateBuild(['--profile', 'node', '--tag', 'release-oak'], { E2B_API_KEY: 'synthetic-test-key' }, log);
    expect(build.mock.calls[0][1]).toMatchObject({ apiKey: 'synthetic-test-key', alias: 'ephemeral-node', tags: ['release-oak'] });
    expect(build.mock.calls[0][1]).not.toHaveProperty('cpuCount'); expect(build.mock.calls[0][1]).not.toHaveProperty('memoryMB');
    expect(log).toHaveBeenCalledWith('Template ready. Set E2B_TEMPLATE_ID=built-template:release-oak');
    await runTemplateBuild([], { E2B_API_KEY: 'synthetic-test-key' }, () => {});
    expect(build.mock.calls[1][1]).toMatchObject({ alias: 'ephemeral-codex' }); expect(build.mock.calls[1][1]).not.toHaveProperty('tags');
  });
  it('runs the actual dry-run CLI without a key or provider endpoint and rejects unsupported flags', () => {
    const env = { PATH: process.env.PATH, E2B_API_URL: 'http://127.0.0.1:1' };
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), 'sandbox/build-template.ts', '--profile', 'python', '--tag', 'v1', '--dry-run'], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ profile: 'python', tag: 'v1' }); expect(result.stderr).toBe('');
    const invalid = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), 'sandbox/build-template.ts', '--dry-run', '--wrong'], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 10_000 });
    expect(invalid.status).toBe(1); expect(invalid.stdout).toBe(''); expect(invalid.stderr).toContain('Use only');
  });
});
