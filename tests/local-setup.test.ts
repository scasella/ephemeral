import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertLocalPortAvailable, boundedInput, checkLocalTunnel, readOnlyGithub, runLocalSetup, type SetupDependencies } from '../scripts/local-setup.js';

function fixture(initial: Record<string, string> = {}) {
  const values: Record<string, string> = { PORT: '4316', PUBLIC_URL: 'https://fixture.example.com', ...initial };
  const output: string[] = []; const prompts: string[] = []; const answers: string[] = [];
  const deps: SetupDependencies = {
    workspace: '/synthetic/workspace', interactive: true,
    output: value => { output.push(value); }, input: vi.fn(async () => 'PRIVATE-E2B-KEY'),
    question: vi.fn(async prompt => { prompts.push(prompt); return answers.shift() ?? 'no'; }),
    initialize: vi.fn(async () => undefined), read: vi.fn(async () => ({ ...values })),
    set: vi.fn(async (_workspace, key, value) => { Object.assign(values, { [key]: value }); }),
    validate: vi.fn(async () => ({ values, missing: [] })), prerequisites: vi.fn(async () => []),
    register: vi.fn(async () => { throw new Error('Registration adapter must be explicit in a test'); }),
    open: vi.fn(), owner: vi.fn(async () => 123456), githubCheck: vi.fn(async () => undefined), tunnelCheck: vi.fn(async () => undefined),
    providerCheck: vi.fn(async () => 0), buildTemplate: vi.fn(async () => undefined), launch: vi.fn(async () => 0),
  };
  return { values, deps, output, prompts, answers };
}
const existingApp = { ALLOWED_GITHUB_IDS: '123456', GITHUB_APP_ID: '42', GITHUB_APP_SLUG: 'fixture-app', GITHUB_CLIENT_ID: 'Iv1.fixture', GITHUB_CLIENT_SECRET: 'PRIVATE-CLIENT-SECRET', GITHUB_APP_PRIVATE_KEY_FILE: '/synthetic/private.pem' };

describe('local live setup command boundary', () => {
  it('prints meaningful help without a terminal, local config, providers or build', async () => {
    const f = fixture(); f.deps.interactive = false;
    expect(await runLocalSetup(['--help'], f.deps)).toBe(0);
    expect(f.output.join('\n')).toContain('ngrok http'); expect(f.output.join('\n')).toContain('template-build --confirm-build');
    expect(f.deps.read).not.toHaveBeenCalled(); expect(f.deps.validate).not.toHaveBeenCalled(); expect(f.deps.providerCheck).not.toHaveBeenCalled();
  });
  it('reads secrets only from stdin and never includes them in output', async () => {
    const f = fixture(); expect(await runLocalSetup(['set', 'E2B_API_KEY'], f.deps)).toBe(0);
    expect(f.deps.set).toHaveBeenCalledWith('/synthetic/workspace', 'E2B_API_KEY', 'PRIVATE-E2B-KEY');
    expect(f.output.join('\n')).not.toContain('PRIVATE-E2B-KEY');
    await expect(runLocalSetup(['set', 'E2B_API_KEY', 'SECRET-IN-ARGV'], f.deps)).rejects.toThrow('Unknown or incomplete');
  });
  it('bounds piped stdin before saving and does not evaluate content', async () => {
    async function* input(value: string) { yield Buffer.from(value); }
    expect(await boundedInput(input('$(touch /tmp/do-not-execute)\n'))).toBe('$(touch /tmp/do-not-execute)');
    await expect(boundedInput(input('PRIVATE'.repeat(4000)))).rejects.toThrow('Input exceeded');
    const f = fixture(); f.deps.input = () => boundedInput(input('SECRET'.repeat(4000)));
    await expect(runLocalSetup(['set', 'E2B_API_KEY'], f.deps)).rejects.toThrow('Input exceeded');
    expect(f.deps.set).not.toHaveBeenCalled(); expect(f.output).toEqual([]);
  });
  it('only prints explicitly allowlisted public settings, while has prints no value', async () => {
    const f = fixture({ E2B_API_KEY: 'PRIVATE-E2B-KEY' });
    await expect(runLocalSetup(['get', 'E2B_API_KEY'], f.deps)).rejects.toThrow('Secret values cannot be printed');
    expect(f.deps.read).not.toHaveBeenCalled(); expect(await runLocalSetup(['has', 'E2B_API_KEY'], f.deps)).toBe(0);
    expect(await runLocalSetup(['has', 'E2B_TEMPLATE_ID'], f.deps)).toBe(1); expect(f.output).toEqual([]);
    expect(await runLocalSetup(['get', 'PORT'], f.deps)).toBe(0); expect(f.output).toEqual(['4316']);
  });
  it('refuses malformed public values without printing them', async () => {
    for (const [key, value] of [['PUBLIC_URL', 'https://user:PRIVATE@example.com'], ['E2B_TEMPLATE_ID', 'e2b_PRIVATE-API-KEY'], ['E2B_TEMPLATE_ID', 'team/sk-PRIVATE:release-1'], ['E2B_TEMPLATE_ID', 'template:ghp_PRIVATE'], ['E2B_TEMPLATE_ID', 'team/nested/template:v1'], ['E2B_TEMPLATE_ID', 'template:release..1'], ['E2B_TEMPLATE_ID', 'template:v1\n'], ['E2B_TEMPLATE_ID', 'template:v1\u200b'], ['E2B_TEMPLATE_ID', 'https://private.example/template:v1'], ['E2B_TEMPLATE_ID', '../template:v1'], ['E2B_TEMPLATE_ID', 'template:$(touch)'], ['PORT', 'PRIVATE']]) {
      const f = fixture({ [key]: value });
      await expect(runLocalSetup(['get', key], f.deps)).rejects.toThrow('malformed'); expect(f.output).toEqual([]);
    }
  });
  it('initializes without reading or replacing credentials', async () => {
    const f = fixture(); expect(await runLocalSetup(['init'], f.deps)).toBe(0);
    expect(f.deps.initialize).toHaveBeenCalledOnce(); expect(f.deps.set).not.toHaveBeenCalled();
  });
  it('makes offline doctor strictly local and describes unverified account state', async () => {
    const f = fixture(); expect(await runLocalSetup(['doctor', '--offline'], f.deps)).toBe(0);
    expect(f.deps.validate).toHaveBeenCalledOnce(); expect(f.deps.prerequisites).toHaveBeenCalledOnce();
    expect(f.deps.githubCheck).not.toHaveBeenCalled(); expect(f.deps.providerCheck).not.toHaveBeenCalled();
    expect(f.deps.buildTemplate).not.toHaveBeenCalled(); expect(f.output.join('\n')).toContain('remain unverified');
  });
  it('reports pending fields and missing build without performing provider checks', async () => {
    const f = fixture(); f.deps.validate = vi.fn(async () => ({ values: f.values, missing: ['E2B_API_KEY'] }));
    f.deps.prerequisites = vi.fn(async () => ['npm run build']);
    expect(await runLocalSetup(['doctor'], f.deps)).toBe(1);
    expect(f.output.join('\n')).toContain('E2B_API_KEY'); expect(f.output.join('\n')).toContain('npm run build');
    expect(f.deps.githubCheck).not.toHaveBeenCalled(); expect(f.deps.providerCheck).not.toHaveBeenCalled();
  });
  it('runs read-only provider adapters after complete config and never builds or launches', async () => {
    const f = fixture(); expect(await runLocalSetup(['doctor'], f.deps)).toBe(0);
    expect(f.deps.githubCheck).toHaveBeenCalledWith(f.values); expect(f.deps.providerCheck).toHaveBeenCalledWith(f.deps.workspace, f.values);
    expect(f.deps.launch).not.toHaveBeenCalled(); expect(f.deps.buildTemplate).not.toHaveBeenCalled();
    expect(f.output.join('\n')).toContain('No sandbox was created');
  });
  it('redacts raw GitHub adapter errors and fails closed on provider rejection', async () => {
    const f = fixture(); f.deps.githubCheck = vi.fn(async () => { throw new Error('Authorization: PRIVATE-TOKEN'); });
    await expect(runLocalSetup(['doctor'], f.deps)).rejects.toThrow('Read-only GitHub App check failed');
    expect(f.deps.providerCheck).not.toHaveBeenCalled(); expect(f.output.join('\n')).not.toContain('PRIVATE-TOKEN');
    f.deps.githubCheck = vi.fn(async () => undefined); f.deps.providerCheck = vi.fn(async () => 1);
    await expect(runLocalSetup(['doctor'], f.deps)).rejects.toThrow('Read-only E2B preflight failed');
  });
  it('requires explicit interactive approval before any build adapter call', async () => {
    const f = fixture(); await expect(runLocalSetup(['template-build'], f.deps)).rejects.toThrow('consumes E2B resources');
    expect(f.deps.buildTemplate).not.toHaveBeenCalled(); f.deps.interactive = false;
    await expect(runLocalSetup(['template-build', '--confirm-build'], f.deps)).rejects.toThrow('interactive terminal');
    expect(f.deps.buildTemplate).not.toHaveBeenCalled(); f.deps.interactive = true;
    expect(await runLocalSetup(['template-build', '--confirm-build'], f.deps)).toBe(0); expect(f.deps.buildTemplate).toHaveBeenCalledOnce();
  });
  it('fails start closed on incomplete config or missing dist and preserves subprocess status', async () => {
    const f = fixture(); f.deps.validate = vi.fn(async () => ({ values: f.values, missing: ['GITHUB_APP_ID'] }));
    await expect(runLocalSetup(['start'], f.deps)).rejects.toThrow('Pending configuration'); expect(f.deps.launch).not.toHaveBeenCalled();
    f.deps.validate = vi.fn(async () => ({ values: f.values, missing: [] })); f.deps.prerequisites = vi.fn(async () => ['npm run build']);
    await expect(runLocalSetup(['start'], f.deps)).rejects.toThrow('npm run build'); expect(f.deps.launch).not.toHaveBeenCalled();
    f.deps.prerequisites = vi.fn(async () => []); f.deps.launch = vi.fn(async () => 143);
    expect(await runLocalSetup(['start'], f.deps)).toBe(143); expect(f.output.join('\n')).toContain('127.0.0.1:4316');
    expect(f.deps.buildTemplate).not.toHaveBeenCalled();
  });
});

describe('human GitHub setup with synthetic adapters', () => {
  it('requires a terminal before reading configuration or opening account UI', async () => {
    const f = fixture(); f.deps.interactive = false;
    await expect(runLocalSetup(['github'], f.deps)).rejects.toThrow('interactive terminal');
    expect(f.deps.initialize).not.toHaveBeenCalled(); expect(f.deps.open).not.toHaveBeenCalled();
  });
  it('retains an existing App and resumes only the selected-repository installation step', async () => {
    const f = fixture(existingApp); f.answers.push('yes'); expect(await runLocalSetup(['github'], f.deps)).toBe(0);
    expect(f.deps.register).not.toHaveBeenCalled(); expect(f.deps.set).not.toHaveBeenCalled();
    expect(f.deps.open).toHaveBeenCalledWith('https://github.com/apps/fixture-app/installations/new');
    expect(f.output.join('\n')).not.toContain('PRIVATE-CLIENT-SECRET');
  });
  it('does not recreate an incomplete existing App and gives recovery guidance', async () => {
    const f = fixture({ ALLOWED_GITHUB_IDS: '123456', GITHUB_APP_ID: '42' });
    await expect(runLocalSetup(['github'], f.deps)).rejects.toThrow('incomplete and were preserved');
    expect(f.deps.register).not.toHaveBeenCalled(); expect(f.deps.set).not.toHaveBeenCalled();
  });
  it('looks up the username, confirms the numeric owner, and leaves declined creation resumable', async () => {
    const f = fixture(); f.answers.push('fixture-user', 'yes', 'no');
    await expect(runLocalSetup(['github'], f.deps)).rejects.toThrow('creation pending');
    expect(f.deps.owner).toHaveBeenCalledWith('fixture-user'); expect(f.values).toHaveProperty('ALLOWED_GITHUB_IDS', '123456');
    expect(f.deps.register).not.toHaveBeenCalled(); expect(f.deps.open).not.toHaveBeenCalled();
  });
  it('does not save an identity without approval and accepts a numeric ID without lookup', async () => {
    const f = fixture(); f.answers.push('123456', 'no');
    await expect(runLocalSetup(['github'], f.deps)).rejects.toThrow('Owner approval pending');
    expect(f.deps.owner).not.toHaveBeenCalled(); expect(f.deps.set).not.toHaveBeenCalled();
  });
  it('uses the stable live target and existing registration helper, then closes its listener', async () => {
    const f = fixture(); f.answers.push('123456', 'yes', 'yes', 'yes'); const close = vi.fn(async () => undefined);
    const result = { envFile: '/synthetic/.env.live', pemFile: '/synthetic/private.pem', directory: '/synthetic/recovery', installUrl: 'https://github.com/apps/fixture-app/installations/new', appId: 42, slug: 'fixture-app' };
    f.deps.register = vi.fn(async () => {
      Object.assign(f.values, existingApp);
      return { url: 'http://127.0.0.1:12345/register/synthetic-state', completed: Promise.resolve(result), close };
    });
    expect(await runLocalSetup(['github'], f.deps)).toBe(0);
    expect(f.deps.register).toHaveBeenCalledWith({ workspace: f.deps.workspace, envFile: '.env.live', publicUrl: f.values.PUBLIC_URL, ownerId: 123456 });
    expect(close).toHaveBeenCalledOnce(); expect(f.output.join('\n')).not.toContain('PRIVATE-CLIENT-SECRET');
  });
  it('closes an unsuccessful registration listener and reports private recovery guidance without raw errors', async () => {
    const f = fixture({ ALLOWED_GITHUB_IDS: '123456' }); f.answers.push('yes'); const close = vi.fn(async () => undefined);
    f.deps.register = vi.fn(async () => ({ url: 'http://127.0.0.1:12345/register/synthetic-state', completed: Promise.reject(new Error('PRIVATE-REGISTRATION-RESPONSE')), close }));
    await expect(runLocalSetup(['github'], f.deps)).rejects.toThrow('.data/github-registration recovery files');
    expect(close).toHaveBeenCalledOnce(); expect(f.output.join('\n')).not.toContain('PRIVATE-REGISTRATION-RESPONSE');
  });
  it('honestly reports pending installation without clearing saved credentials', async () => {
    const f = fixture(existingApp); f.answers.push('no');
    await expect(runLocalSetup(['github'], f.deps)).rejects.toThrow('installation pending');
    expect(f.values.GITHUB_CLIENT_SECRET).toBe('PRIVATE-CLIENT-SECRET'); expect(f.deps.set).not.toHaveBeenCalled();
  });
});



describe('explicit tunnel health verification using synthetic fetch', () => {
  const values = { PORT: '4316', PUBLIC_URL: 'https://fixture.example.com', E2B_API_KEY: 'PRIVATE-KEY', GITHUB_CLIENT_SECRET: 'PRIVATE-CLIENT' };
  const healthy = () => new Response(JSON.stringify({ status: 'ok', mode: 'live' }), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  it('checks the selected local port and exact public origin without credentials, redirects or cookies', async () => {
    const request = vi.fn(async () => healthy()); await checkLocalTunnel(values, request);
    expect(request.mock.calls).toHaveLength(2);
    const calls = request.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(call => call[0])).toEqual(['http://127.0.0.1:4316/healthz', 'https://fixture.example.com/healthz']);
    for (const [, init] of calls) {
      expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' } });
      expect(init.signal).toBeInstanceOf(AbortSignal); expect(JSON.stringify(init)).not.toContain('PRIVATE');
    }
  });
  it.each([
    () => new Response('{"status":"ok","mode":"preview"}', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('<html>ngrok login</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('{"status":"ok","mode":"live","other":true}', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('x'.repeat(1025), { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('{"status":"ok","mode":"live"}', { status: 401, headers: { 'Content-Type': 'application/json' } }),
    () => new Response('not json', { headers: { 'Content-Type': 'application/json' } }),
    () => { throw new Error('PRIVATE-NETWORK-DETAIL'); },
    () => { throw new DOMException('PRIVATE-TIMEOUT-DETAIL', 'TimeoutError'); },
  ])('rejects incorrect modes, HTML, extra fields, oversized/non-JSON bodies, HTTP errors and network/timeouts', async response => {
    const request = vi.fn(async () => response()); await expect(checkLocalTunnel(values, request)).rejects.toThrow('Local health check failed');
    expect(request).toHaveBeenCalledOnce();
  });
  it('reports a public tunnel failure separately after local live health passes', async () => {
    const request = vi.fn().mockResolvedValueOnce(healthy()).mockRejectedValueOnce(new Error('PRIVATE-REDIRECT-DETAIL'));
    await expect(checkLocalTunnel(values, request)).rejects.toThrow('Public tunnel health check failed');
  });
  it('runs only on explicit request and never calls provider checks, build or launch', async () => {
    const f = fixture(); expect(await runLocalSetup(['tunnel-check'], f.deps)).toBe(0);
    expect(f.deps.tunnelCheck).toHaveBeenCalledWith(f.values); expect(f.deps.providerCheck).not.toHaveBeenCalled();
    expect(f.deps.githubCheck).not.toHaveBeenCalled(); expect(f.deps.launch).not.toHaveBeenCalled(); expect(f.deps.buildTemplate).not.toHaveBeenCalled();
    expect(f.output.join('\n')).toContain('remain unverified');
  });
});

describe('read-only GitHub response validation', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const values = { ...existingApp, GITHUB_APP_PRIVATE_KEY: pem.replaceAll('\n', '\\n'), GITHUB_APP_PRIVATE_KEY_FILE: '', ALLOWED_GITHUB_IDS: ' 123456 , 98765 ' };
  const app = { id: 42, slug: 'fixture-app', permissions: { contents: 'write', pull_requests: 'write' } };
  const installation = { account: { id: 123456 }, repository_selection: 'selected', suspended_at: null, permissions: { contents: 'write', pull_requests: 'write' } };
  it('accepts only read-only App and installation GET paths and normalizes escaped PEM/owner whitespace', async () => {
    const paths: string[] = [];
    await readOnlyGithub(values, async (path, token) => { paths.push(path); expect(token.split('.')).toHaveLength(3); return path === '/app' ? app : [installation]; });
    expect(paths).toEqual(['/app', '/app/installations?per_page=100&page=1']);
  });
  it('rejects an App with incomplete permissions even when its identity matches', async () => {
    await expect(readOnlyGithub(values, async () => ({ ...app, permissions: { contents: 'read', pull_requests: 'write' } }))).rejects.toThrow('requires Contents and Pull requests write');
  });
  it.each([
    { ...installation, permissions: { contents: 'read', pull_requests: 'write' } },
    { ...installation, permissions: { contents: 'write', pull_requests: 'read' } },
    { ...installation, repository_selection: 'all' },
    { ...installation, account: { id: 444 } },
    { ...installation, suspended_at: '2026-01-01' },
  ])('rejects an installation without the correct owner, repository scope and permissions', async candidate => {
    await expect(readOnlyGithub(values, async path => path === '/app' ? app : [candidate])).rejects.toThrow('selected-repository installation');
  });
});

describe('wizard static and local process checks', () => {
  it('shows help without a TTY and refuses noninteractive account flows', () => {
    const script = resolve('scripts/setup-local.sh');
    const help = spawnSync('bash', [script, '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0); expect(help.stdout).toContain('Rerun to resume');
    const noTTY = spawnSync('bash', [script], { encoding: 'utf8', input: '' });
    expect(noTTY.status).toBe(1); expect(noTTY.stderr).toContain('interactive terminal');
  });
  it('passes bash parsing and keeps staged writes on stdin with tracing disabled', async () => {
    const source = await readFile('scripts/setup-local.sh', 'utf8'); const stages = source.slice(source.indexOf('# STAGES:'));
    expect(spawnSync('bash', ['-n', 'scripts/setup-local.sh']).status).toBe(0);
    expect(stages).toContain('set +x'); expect(stages).toContain('printf \'%s\' "$2" | setup_backend set "$1"');
    expect(stages).not.toMatch(/\b(?:write_env|set_secret|set_var)\b/);
    expect(stages).toContain('--inspect=false --log=false');
    expect(stages).toContain('pending "Template setup is pending');
  });
  it('reports a busy loopback port without attempting to terminate another process', async () => {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('test listener unavailable');
      await expect(assertLocalPortAvailable(address.port)).rejects.toThrow(`port ${address.port} is unavailable`);
      expect(server.listening).toBe(true);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
