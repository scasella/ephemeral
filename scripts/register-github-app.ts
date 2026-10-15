import { createPrivateKey, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const credentialKeys = ['GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY_FILE'];
export interface RegistrationOptions {
  publicUrl: string; ownerId: number; name?: string; workspace?: string; envFile?: '.env' | '.env.live';
}
interface AppRegistration {
  id: number; slug: string; client_id: string; client_secret: string; pem: string;
  owner: { id: number }; webhook_secret?: string;
}
const escapeHTML = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export function publicOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.includes(':') || !url.hostname.includes('.')) {
    throw new Error('Supply a public HTTPS origin without a path, credentials, or query');
  }
  return url.origin;
}
export function manifest(options: RegistrationOptions, redirectUrl: string) {
  const origin = publicOrigin(options.publicUrl);
  const name = options.name ?? `Ephemeral pilot ${randomBytes(4).toString('hex')}`;
  if (name.length < 1 || name.length > 34 || /[\r\n]/.test(name)) throw new Error('App name must contain 1–34 characters');
  return { name, url: origin, description: 'Private Ephemeral coding sessions with a server-enforced Git branch gateway.',
    public: false, redirect_url: redirectUrl, callback_urls: [`${origin}/auth/github/callback`],
    hook_attributes: { url: `${origin}/github/webhook-disabled`, active: false },
    default_permissions: { contents: 'write', pull_requests: 'write' }, default_events: [], request_oauth_on_install: false,
  };
}
async function regularFile(file: string): Promise<boolean> {
  try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Configuration path must be a regular file'); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function envAssignments(content: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    if (result.has(match[1])) throw new Error('Duplicate environment keys must be resolved before registration');
    const value = match[2].trim(); result.set(match[1], value === '""' || value === "''" || value.startsWith('#') ? '' : value);
  }
  return result;
}
async function privateDirectory(workspace: string): Promise<string> {
  const dataRoot = join(workspace, '.data');
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(dataRoot)).isSymbolicLink()) throw new Error('Private data directory cannot be a symlink');
  const privateRoot = join(dataRoot, 'github-registration');
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(privateRoot)).isSymbolicLink()) throw new Error('Private credential directory cannot be a symlink');
  await chmod(privateRoot, 0o700);
  return privateRoot;
}
async function requireIgnoredSecrets(workspace: string, envName: string): Promise<void> {
  const gitEnv: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_CONFIG_COUNT: undefined };
  const run = (args: string[]) => spawnSync('git', ['-c', 'core.excludesFile=/dev/null', ...args], {
    cwd: workspace, env: gitEnv, encoding: 'utf8', timeout: 5_000, maxBuffer: 65_536,
  });
  const discovered = run(['rev-parse', '--show-toplevel']);
  let temporary: string | undefined;
  let scope: string[] = [];
  try {
    if (discovered.status !== 0) {
      // Evaluate the workspace's actual .gitignore with Git even before git init,
      // without creating a repository or changing files inside that workspace.
      temporary = await mkdtemp(join(tmpdir(), 'ephemeral-ignore-check-'));
      if (run(['init', '--quiet', temporary]).status !== 0) throw new Error('Git ignore validation is unavailable');
      scope = ['--git-dir', join(temporary, '.git'), '--work-tree', workspace];
    } else {
      const tracked = run(['ls-files', '--', envName, '.data/github-registration']);
      if (tracked.status !== 0 || tracked.error) throw new Error('Git tracking validation is unavailable');
      if (tracked.stdout.trim()) throw new Error('Credential output is already tracked by Git; remove it from the index before registration');
    }
    for (const target of [envName, '.data/github-registration/']) {
      const result = run([...scope, 'check-ignore', '--no-index', '--', target]);
      if (result.status !== 0 || result.error) throw new Error(`Workspace .gitignore must effectively exclude ${envName} and .data/github-registration before registration`);
    }
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
}
async function preflight(options: RegistrationOptions): Promise<{ envFile: string; content: string }> {
  publicOrigin(options.publicUrl);
  if (!Number.isSafeInteger(options.ownerId) || options.ownerId <= 0) throw new Error('Supply the numeric GitHub owner ID');
  const envName = options.envFile ?? '.env';
  if (!['.env', '.env.live'].includes(envName)) throw new Error('Environment output must be .env or .env.live in the workspace');
  const workspace = resolve(options.workspace ?? process.cwd()); const envFile = join(workspace, envName);
  const content = await regularFile(envFile) ? await readFile(envFile, 'utf8') : '';
  const assigned = envAssignments(content);
  if (credentialKeys.some(key => assigned.get(key))) throw new Error('Existing GitHub credentials detected; registration refuses to overwrite them');
  const target = assigned.get('PUBLIC_URL');
  if (target && target !== options.publicUrl && target !== `"${options.publicUrl}"` && target !== `'${options.publicUrl}'`) throw new Error('Existing PUBLIC_URL differs from the registration target; update it explicitly first');
  await requireIgnoredSecrets(workspace, envName);
  await privateDirectory(workspace);
  return { envFile, content };
}
async function privateFile(file: string, content: string): Promise<void> {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
}
export async function persistRegistration(options: RegistrationOptions, registration: AppRegistration, prepared?: { envFile: string; content: string }) {
  const before = prepared ?? await preflight(options);
  const privateRoot = await privateDirectory(resolve(options.workspace ?? process.cwd()));
  const directory = await mkdtemp(join(privateRoot, 'app-')); await chmod(directory, 0o700);
  // Persist the one-time exchange first. A later configuration failure must not lose these credentials.
  await privateFile(join(directory, 'credentials.json'), JSON.stringify(registration, null, 2) + '\n');
  if (!Number.isSafeInteger(registration.id) || registration.id <= 0 || registration.owner?.id !== options.ownerId ||
    !/^[a-z0-9][a-z0-9-]*$/.test(registration.slug) || !/^[A-Za-z0-9_.-]+$/.test(registration.client_id) ||
    !registration.client_secret || /[\r\n]/.test(registration.client_secret)) {
    throw new Error('Returned App owner or configuration is invalid; credentials retained privately for recovery');
  }
  const parsedKey = createPrivateKey(registration.pem);
  if (parsedKey.asymmetricKeyType !== 'rsa') throw new Error('Returned App key is invalid; credentials retained privately for recovery');
  const pemFile = join(directory, 'private-key.pem'); await privateFile(pemFile, registration.pem);
  const current = await regularFile(before.envFile) ? await readFile(before.envFile, 'utf8') : '';
  if (current !== before.content) throw new Error('Configuration changed during registration; credentials retained privately for recovery');
  const values: Record<string, string> = { GITHUB_APP_ID: String(registration.id), GITHUB_APP_SLUG: registration.slug,
    GITHUB_CLIENT_ID: registration.client_id, GITHUB_CLIENT_SECRET: registration.client_secret, GITHUB_APP_PRIVATE_KEY_FILE: pemFile,
    ...(!envAssignments(current).get('PUBLIC_URL') ? { PUBLIC_URL: publicOrigin(options.publicUrl) } : {}),
  };
  const lines = current.split(/\r?\n/); const remaining = new Set(Object.keys(values));
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(lines[i]);
    if (match && remaining.has(match[1])) { lines[i] = `${match[1]}=${JSON.stringify(values[match[1]])}`; remaining.delete(match[1]); }
  }
  if (lines.length === 1 && lines[0] === '') lines.pop();
  for (const key of remaining) lines.push(`${key}=${JSON.stringify(values[key])}`);
  // Temporary files stay under the ignored private directory instead of a plaintext unignored workspace file.
  const staged = join(directory, 'environment.pending');
  await privateFile(staged, lines.join('\n').replace(/\n*$/, '\n'));
  // A second check narrows the window for an unrelated config writer. The helper never runs concurrent deploy edits.
  if ((await regularFile(before.envFile) ? await readFile(before.envFile, 'utf8') : '') !== current) throw new Error('Configuration changed; credentials retained privately for recovery');
  await rename(staged, before.envFile); await chmod(before.envFile, 0o600);
  return { envFile: before.envFile, pemFile, directory, installUrl: `https://github.com/apps/${registration.slug}/installations/new`, appId: registration.id, slug: registration.slug };
}
async function exchange(code: string): Promise<AppRegistration> {
  const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST', headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Ephemeral-registration' },
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  if (response.status !== 201) throw new Error(`GitHub manifest conversion failed (${response.status}); inspect App settings for recovery`);
  const body = await response.text(); if (body.length > 64 * 1024) throw new Error('GitHub registration response exceeded the supported limit');
  return JSON.parse(body) as AppRegistration;
}
export async function startRegistration(options: RegistrationOptions, convert: (code: string) => Promise<AppRegistration> = exchange) {
  const prepared = await preflight(options); const state = randomBytes(32).toString('base64url');
  let consumed = false, finished = false;
  let complete!: (value: Awaited<ReturnType<typeof persistRegistration>>) => void;
  let fail!: (reason: Error) => void;
  const completed = new Promise<Awaited<ReturnType<typeof persistRegistration>>>((resolve, reject) => { complete = resolve; fail = reject; });
  let origin = '', appManifest: ReturnType<typeof manifest>;
  const respond = (res: ServerResponse, status: number, text: string, html = false) => {
    res.writeHead(status, { 'Content-Type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; form-action https://github.com; base-uri 'none'; frame-ancestors 'none'" }); res.end(text);
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.headers.host !== new URL(origin).host || req.method !== 'GET') { respond(res, 403, 'Unsupported registration request'); return; }
      const url = new URL(req.url ?? '/', origin);
      if (url.pathname === `/register/${state}` && !consumed) {
        respond(res, 200, `<!doctype html><html><head><meta charset="utf-8"><title>Register Ephemeral</title></head><body><h1>Register private Ephemeral App</h1><p>GitHub owner ID: ${options.ownerId}. App: ${escapeHTML(appManifest.name)}. Target: ${escapeHTML(publicOrigin(options.publicUrl))}.</p><p>Repository permissions: Contents write and Pull requests write. Webhooks disabled. Installation remains a separate step.</p><form action="https://github.com/settings/apps/new?state=${state}" method="post"><input type="hidden" name="manifest" value="${escapeHTML(JSON.stringify(appManifest))}"><button type="submit">Review registration on GitHub</button></form></body></html>`, true); return;
      }
      if (url.pathname !== '/callback' || consumed || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1) { respond(res, 404, 'Registration route unavailable'); return; }
      const supplied = Buffer.from(url.searchParams.get('state') ?? ''), expected = Buffer.from(state);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { respond(res, 403, 'Invalid registration state'); return; }
      const code = url.searchParams.get('code') ?? '';
      if (!/^[A-Za-z0-9_-]{20,200}$/.test(code)) { respond(res, 400, 'Invalid registration code'); return; }
      consumed = true;
      try {
        const result = await persistRegistration(options, await convert(code), prepared);
        finished = true; clearTimeout(timer);
        respond(res, 200, `GitHub App registration saved privately. Install it on selected repositories: ${result.installUrl}\n`);
        complete(result);
      } catch {
        finished = true; clearTimeout(timer);
        respond(res, 500, 'Registration could not finish safely. Inspect private recovery files and GitHub App settings; do not repeat the exchange.\n');
        fail(new Error('Registration failed; inspect ignored .data/github-registration recovery files and GitHub App settings'));
      }
    })().catch(() => respond(res, 500, 'Registration request failed'));
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Loopback listener unavailable');
  origin = `http://127.0.0.1:${address.port}`;
  try { appManifest = manifest(options, `${origin}/callback`); } catch (error) { server.close(); throw error; }
  const timer = setTimeout(() => { if (!finished) { finished = true; consumed = true; fail(new Error('Registration timed out after 30 minutes')); } server.close(); }, 30 * 60_000);
  const close = async () => { clearTimeout(timer); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  return { url: `${origin}/register/${state}`, completed, close };
}
async function main() {
  const args = process.argv.slice(2); const values = new Map<string, string>();
  if (args.includes('--help')) { console.log('Usage: node --import tsx scripts/register-github-app.ts --public-url https://your-public-origin --owner-id 123456 [--name "Unique App name"] [--env-file .env.live]'); return; }
  for (let i = 0; i < args.length; i += 2) { if (!['--public-url', '--owner-id', '--name', '--env-file'].includes(args[i]) || !args[i + 1]) throw new Error('Unknown or incomplete registration argument; use --help'); values.set(args[i], args[i + 1]); }
  const options: RegistrationOptions = { publicUrl: values.get('--public-url') ?? '', ownerId: Number(values.get('--owner-id')), name: values.get('--name'), envFile: (values.get('--env-file') ?? '.env') as RegistrationOptions['envFile'] };
  const service = await startRegistration(options);
  const stop = () => { void service.close().finally(() => process.exit(1)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    console.log(`Open the local registration form: ${service.url}`);
    console.log('Confirm the account and permissions on GitHub before creating the App. This helper does not install it.');
    const result = await service.completed;
    console.log(`Saved private configuration: ${result.envFile}\nPrivate key: ${result.pemFile}\nInstall on selected repositories: ${result.installUrl}`);
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await service.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(() => { console.error('GitHub App registration stopped. Check configuration and ignored private recovery files; no secret values were logged.'); process.exitCode = 1; });
