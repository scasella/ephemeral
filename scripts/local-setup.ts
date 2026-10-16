import { spawn, spawnSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { createServer } from 'node:net';
import {
  initializeLocalConfig, readLocalConfig, setLocalConfigValue, validateLocalConfig, localChildEnvironment, LocalConfigError,
} from './local-setup-config.js';
import { SetupTemplateError, verifySetupTemplate } from './local-setup-template.js';
import { startRegistration, publicOrigin, type RegistrationOptions } from './register-github-app.js';
import { GitHubAPI } from '../server/github/api.js';
import { appJWT } from '../server/github/security.js';
import { isEnvironmentTemplateRef } from '../shared/environments.js';

const publicKeys = new Set(['PORT', 'PUBLIC_URL', 'GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'ALLOWED_GITHUB_IDS', 'E2B_TEMPLATE_ID']);
const githubKeys = ['GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'];
export const localSetupHelp = `Local live setup (Node 24, Git, npm dependencies required)
  bash scripts/setup-local.sh           Guided interactive first run; resume by rerunning
  npm run setup:local -- init           Create or retain ignored private .env.live
  npm run setup:local -- set KEY        Read one value from bounded stdin; never overwrite
  npm run setup:local -- get KEY        Print an allowlisted nonsecret value
  npm run setup:local -- has KEY        Exit 0 when a value exists, 1 when absent
  npm run setup:local -- github         Interactive account lookup, App creation and installation
  npm run setup:local -- template-build --confirm-build
                                       Explicitly consume E2B resources to build the template
  npm run setup:local -- doctor [--offline]
                                       Validate config/build; online uses read-only provider checks
  npm run setup:local -- tunnel-check   After start, verify local and public live health (no credentials)
  npm run setup:local -- start          Start production on the selected loopback PORT (default 4311)
Keep ngrok running in a second terminal:
  ngrok http http://127.0.0.1:4311 --inspect=false --log=false
Set PUBLIC_URL once. A changed origin requires reconciling sessions and explicitly updating
both private configuration and the GitHub App callback; setup refuses to replace it.
Missing build: npm run build. Pending credentials: rerun the guided wizard.
Local checks do not establish hosted acceptance or fresh Codex device authentication.`;

class SetupError extends Error {}
type Values = Record<string, string>;
export interface SetupDependencies {
  workspace: string;
  interactive: boolean;
  output(message: string): void;
  input(): Promise<string>;
  question(prompt: string): Promise<string>;
  initialize(workspace: string): Promise<unknown>;
  read(workspace: string): Promise<Values>;
  set(workspace: string, key: string, value: string): Promise<unknown>;
  validate(workspace: string): Promise<{ values: Values; missing: string[] }>;
  prerequisites(workspace: string): Promise<string[]>;
  register(options: RegistrationOptions): ReturnType<typeof startRegistration>;
  open(url: string): void;
  owner(username: string): Promise<number>;
  githubCheck(values: Values): Promise<void>;
  tunnelCheck(values: Values): Promise<void>;
  providerCheck(workspace: string, values: Values): Promise<number>;
  buildTemplate(workspace: string): Promise<unknown>;
  launch(workspace: string, values: Values): Promise<number>;
}

export async function boundedInput(input: AsyncIterable<Uint8Array | string>, limit = 16_384): Promise<string> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk); length += bytes.length;
    if (length > limit) throw new SetupError('Input exceeded the supported size; no value was saved.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}
function openBrowser(url: string) {
  const platform = process.platform;
  if (platform === 'darwin') spawnSync('open', [url], { stdio: 'ignore' });
  else if (platform === 'win32') spawnSync('explorer.exe', [url], { stdio: 'ignore' });
  else spawnSync('xdg-open', [url], { stdio: 'ignore' });
}
async function prerequisites(workspace: string) {
  const missing: string[] = [];
  if (Number(process.versions.node.split('.')[0]) !== 24) missing.push('Node 24');
  if (spawnSync('git', ['--version'], { stdio: 'ignore' }).status !== 0) missing.push('Git');
  for (const [path, label] of [['node_modules/tsx/package.json', 'npm ci'], ['dist/index.html', 'npm run build']]) {
    try { await access(join(workspace, path)); } catch { missing.push(label); }
  }
  return missing;
}
// Only named runtime variables from .env.live are supplied by localChildEnvironment.
// The server still uses its TypeScript entry point; production serves the built dist frontend.
export function spawnLocalChild(workspace: string, values: Values, args: string[], inheritOutput = true): Promise<number> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd: workspace, env: localChildEnvironment(values), stdio: inheritOutput ? 'inherit' : 'ignore' });
    const interrupt = () => child.kill('SIGINT'); const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    const cleanup = () => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); };
    child.once('error', () => { cleanup(); reject(new SetupError('Local subprocess could not start. Check Node 24 and npm ci.')); });
    child.once('exit', (code, signal) => { cleanup(); done(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)); });
  });
}
export async function assertLocalPortAvailable(port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SetupError('Select a valid local PORT before starting.');
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new SetupError(`Local loopback port ${port} is unavailable. Stop its existing process or explicitly choose another PORT, then update the tunnel command.`)));
    probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(new SetupError('Local port check failed.')) : resolve()));
  });
}
/** Health requests send no cookies, authorization, API key or provider credentials. */
export async function checkLocalTunnel(values: Values, request: typeof fetch = fetch): Promise<void> {
  const port = publicValue('PORT', values.PORT ?? '');
  const origin = publicValue('PUBLIC_URL', values.PUBLIC_URL ?? '');
  for (const [label, url] of [['Local', `http://127.0.0.1:${port}/healthz`], ['Public tunnel', `${origin}/healthz`]]) {
    try {
      const response = await request(url, { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (response.status !== 200 || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) throw new Error();
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > 1024) { void reader.cancel().catch(() => {}); throw new Error(); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const health = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      if (!health || typeof health !== 'object' || Array.isArray(health) || Object.keys(health).sort().join(',') !== 'mode,status' ||
        (health as { status?: unknown }).status !== 'ok' || (health as { mode?: unknown }).mode !== 'live') throw new Error();
    } catch {
      throw new SetupError(`${label} health check failed. Start npm run live and the matching ngrok tunnel, then rerun tunnel-check. Expected HTTP 200 application/json with exactly status=ok and mode=live; redirects, HTML, oversized responses and timeouts do not pass.`);
    }
  }
}
export async function readOnlyGithub(values: Values, request?: (path: string, token: string) => Promise<unknown>) {
  const key = values.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n') || await readFile(values.GITHUB_APP_PRIVATE_KEY_FILE, 'utf8');
  const api = new GitHubAPI(values.GITHUB_APP_ID, key, values.GITHUB_APP_SLUG);
  const jwt = appJWT(values.GITHUB_APP_ID, key);
  const read = request ?? ((path: string, token: string) => api.request(path, token));
  type Permissions = { contents?: string; pull_requests?: string };
  const app = await read('/app', jwt) as { id: number; slug: string; permissions?: Permissions };
  if (String(app.id) !== values.GITHUB_APP_ID || app.slug !== values.GITHUB_APP_SLUG) throw new SetupError('GitHub App metadata does not match the selected configuration.');
  if (app.permissions?.contents !== 'write' || app.permissions.pull_requests !== 'write') throw new SetupError('GitHub App requires Contents and Pull requests write permissions. Review the existing App settings.');
  const owners = new Set(values.ALLOWED_GITHUB_IDS.split(',').map(value => value.trim()));
  let found = false;
  for (let page = 1; page <= 100; page++) {
    const installations = await read(`/app/installations?per_page=100&page=${page}`, jwt) as { account: { id: number } | null; repository_selection: string; suspended_at: string | null; permissions?: Permissions }[];
    for (const installation of installations) {
      if (!installation.suspended_at && owners.has(String(installation.account?.id)) && installation.repository_selection === 'selected' && installation.permissions?.contents === 'write' && installation.permissions.pull_requests === 'write') found = true;
    }
    if (installations.length < 100) break;
    if (page === 100) throw new SetupError('GitHub installation listing exceeded the supported limit.');
  }
  if (!found) throw new SetupError('GitHub selected-repository installation for an allowlisted owner is pending. Complete installation in App settings, then rerun doctor.');
}
function defaults(): SetupDependencies {
  return {
    workspace: process.cwd(), interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    output: message => console.log(message), input: () => {
      if (process.stdin.isTTY) throw new SetupError('set reads from a pipe. Use bash scripts/setup-local.sh for hidden credential entry.');
      return boundedInput(process.stdin);
    },
    question: async prompt => { const reader = createInterface({ input: process.stdin, output: process.stdout }); try { return await reader.question(prompt); } finally { reader.close(); } },
    initialize: initializeLocalConfig, read: readLocalConfig, set: setLocalConfigValue, validate: validateLocalConfig,
    prerequisites, register: startRegistration, open: openBrowser,
    owner: async username => {
      if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(username)) throw new SetupError('Supply a valid GitHub username or positive numeric owner ID.');
      const response = await fetch(`https://api.github.com/users/${encodeURIComponent(username)}`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Ephemeral-local-setup' }, redirect: 'error', signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new SetupError('GitHub username lookup failed. Rerun and enter your numeric GitHub owner ID.');
      const user = await response.json() as { id: number };
      if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new SetupError('GitHub did not return a valid numeric owner ID.');
      return user.id;
    },
    githubCheck: readOnlyGithub, tunnelCheck: checkLocalTunnel,
    providerCheck: async workspace => { const report = await verifySetupTemplate(workspace); console.log(JSON.stringify(report, null, 2)); return report.ok ? 0 : 1; },
    buildTemplate: async workspace => (await import('./local-setup-template.js')).buildSetupTemplate(workspace, { confirmed: true }),
    launch: async (workspace, values) => { await assertLocalPortAvailable(Number(values.PORT)); return spawnLocalChild(workspace, values, ['--import', 'tsx', 'server/index.ts']); },
  };
}
function publicValue(key: string, value: string): string {
  const valid = key === 'PORT' ? /^[1-9]\d*$/.test(value) && Number(value) <= 65535 :
    key === 'GITHUB_APP_ID' ? /^[1-9]\d*$/.test(value) :
    key === 'GITHUB_APP_SLUG' ? /^[a-z0-9][a-z0-9-]{0,99}$/.test(value) :
    key === 'ALLOWED_GITHUB_IDS' ? /^\d+(?:\s*,\s*\d+)*$/.test(value) :
    key === 'E2B_TEMPLATE_ID' ? isEnvironmentTemplateRef(value) : key === 'PUBLIC_URL';
  if (!valid) throw new SetupError('Public configuration value is malformed; inspect the selected key privately. Its value was not printed.');
  if (key === 'PUBLIC_URL') { try { return publicOrigin(value); } catch { throw new SetupError('PUBLIC_URL is malformed; inspect it privately. Its value was not printed.'); } }
  return value;
}
function requireInteractive(deps: SetupDependencies) {
  if (!deps.interactive) throw new SetupError('This step requires an interactive terminal. Run bash scripts/setup-local.sh yourself; credentials and account approval cannot be scripted.');
}
async function github(deps: SetupDependencies) {
  requireInteractive(deps);
  await deps.initialize(deps.workspace);
  let values = await deps.read(deps.workspace);
  if (!values.PUBLIC_URL) throw new SetupError('PUBLIC_URL is missing. Complete the tunnel stage first.');
  const origin = publicOrigin(values.PUBLIC_URL);
  let ownerId: number;
  if (values.ALLOWED_GITHUB_IDS) {
    if (!/^\d+$/.test(values.ALLOWED_GITHUB_IDS)) throw new SetupError('The guided setup requires one numeric owner ID. Review existing ALLOWED_GITHUB_IDS privately; it was preserved.');
    ownerId = Number(values.ALLOWED_GITHUB_IDS);
  } else {
    const answer = (await deps.question('GitHub username (looked up publicly) or numeric owner ID: ')).trim();
    ownerId = /^\d+$/.test(answer) ? Number(answer) : await deps.owner(answer);
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new SetupError('Supply a positive numeric GitHub owner ID.');
    deps.output(`Allowlisted GitHub owner ID: ${ownerId}. Verify this is your account.`);
    if ((await deps.question('Save this owner ID? Type yes: ')).trim().toLowerCase() !== 'yes') throw new SetupError('Owner approval pending; rerun github to resume.');
    await deps.set(deps.workspace, 'ALLOWED_GITHUB_IDS', String(ownerId));
  }
  const anyCredential = [...githubKeys, 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY_FILE'].some(key => values[key]);
  if (!anyCredential) {
    deps.output(`Create a private GitHub App for owner ${ownerId}, callback ${origin}/auth/github/callback. Review Contents and Pull requests write permissions on GitHub.`);
    if ((await deps.question('Continue to GitHub App review and creation? Type yes: ')).trim().toLowerCase() !== 'yes') throw new SetupError('GitHub App creation pending; saved configuration remains resumable.');
    const service = await deps.register({ workspace: deps.workspace, envFile: '.env.live', publicUrl: origin, ownerId });
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => { abort = () => { void service.close(); reject(new SetupError('GitHub registration interrupted. Inspect App settings and private recovery files before retrying.')); }; });
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try {
      deps.output(`Review the local registration form: ${service.url}`); deps.open(service.url);
      try { await Promise.race([service.completed, stopped]); } catch (error) {
        if (error instanceof SetupError) throw error;
        throw new SetupError('GitHub registration did not finish. Inspect GitHub App settings and ignored .data/github-registration recovery files before retrying; existing configuration was retained.');
      }
    } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); await service.close(); }
    values = await deps.read(deps.workspace);
  }
  if (githubKeys.some(key => !values[key]) || !(values.GITHUB_APP_PRIVATE_KEY || values.GITHUB_APP_PRIVATE_KEY_FILE)) throw new SetupError('GitHub credentials are incomplete and were preserved. Inspect private recovery files or App settings; do not recreate the App blindly.');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(values.GITHUB_APP_SLUG)) throw new SetupError('GitHub App slug is invalid; review private configuration.');
  const url = `https://github.com/apps/${values.GITHUB_APP_SLUG}/installations/new`;
  deps.output(`Install the App on Only select repositories → your dedicated disposable fixture only: ${url}`);
  deps.open(url);
  if ((await deps.question('Have you approved installation on selected fixture repositories in GitHub? Type yes: ')).trim().toLowerCase() !== 'yes') throw new SetupError('GitHub installation pending. Credentials were retained; rerun github to resume installation.');
  deps.output('GitHub creation/installation acknowledged. Run doctor to verify read-only App access; repository access and live acceptance remain to be tested.');
}

/** Dependency injection is available to unit tests only through this imported function, never CLI flags or environment. */
export async function runLocalSetup(args: string[], injected: Partial<SetupDependencies> = {}): Promise<number> {
  const deps = { ...defaults(), ...injected };
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === 'help') { deps.output(localSetupHelp); return 0; }
  if (command === 'init' && !rest.length) { await deps.initialize(deps.workspace); deps.output('Private .env.live initialized or retained. Existing values were preserved.'); return 0; }
  if (command === 'set' && rest.length === 1) {
    await deps.set(deps.workspace, rest[0], await deps.input()); deps.output(`Saved ${rest[0]}.`); return 0;
  }
  if ((command === 'get' || command === 'has') && rest.length === 1) {
    if (!publicKeys.has(rest[0]) && command === 'get') throw new SetupError('get supports only PORT, PUBLIC_URL, GITHUB_APP_ID, GITHUB_APP_SLUG, ALLOWED_GITHUB_IDS and E2B_TEMPLATE_ID. Secret values cannot be printed.');
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(rest[0])) throw new SetupError('Invalid configuration key.');
    const values = await deps.read(deps.workspace);
    if (command === 'get' && values[rest[0]]) deps.output(publicValue(rest[0], values[rest[0]]));
    return values[rest[0]] ? 0 : 1;
  }
  if (command === 'github' && !rest.length) { await github(deps); return 0; }
  if (command === 'template-build' && rest.length === 1 && rest[0] === '--confirm-build') {
    requireInteractive(deps);
    deps.output('Building the fixed E2B alias ephemeral-codex may consume provider resources and update its default tag. Reuse an existing compatible template if this alias is already in use.');
    deps.output('This may take several minutes. If interrupted, check the E2B dashboard and private template-build-pending.json receipt before retrying.');
    await deps.buildTemplate(deps.workspace); deps.output('Template build saved privately. Run doctor to verify readiness.'); return 0;
  }
  if (command === 'template-build') throw new SetupError('Template build consumes E2B resources. Use template-build --confirm-build in an interactive terminal after approving that cost.');
  if (command === 'doctor' && (rest.length === 0 || (rest.length === 1 && rest[0] === '--offline'))) {
    const { values, missing } = await deps.validate(deps.workspace);
    const prerequisitesMissing = await deps.prerequisites(deps.workspace);
    if (missing.length) deps.output(`Pending configuration: ${missing.join(', ')}. Rerun bash scripts/setup-local.sh.`);
    if (prerequisitesMissing.length) deps.output(`Pending prerequisites: ${prerequisitesMissing.join(', ')}.`);
    if (missing.length || prerequisitesMissing.length) return 1;
    deps.output('Private config and build prerequisites passed.');
    if (rest[0] === '--offline') { deps.output('Offline only: provider credentials, installation, tunnel reachability and live acceptance remain unverified.'); return 0; }
    try { await deps.githubCheck(values); } catch (error) { throw new SetupError(error instanceof SetupError ? error.message : 'Read-only GitHub App check failed. Review App credentials and selected-repository installation; no installation token was created.'); }
    deps.output('Read-only GitHub App and selected-repository installation checks passed; no installation token was created.');
    if (await deps.providerCheck(deps.workspace, values) !== 0) throw new SetupError('Read-only E2B preflight failed. Review account/template readiness and rerun doctor.');
    deps.output('Read-only provider checks passed. No sandbox was created. Complete fresh VM authentication and the documented live acceptance separately.'); return 0;
  }
  if (command === 'tunnel-check' && !rest.length) {
    const values = await deps.read(deps.workspace); await deps.tunnelCheck(values);
    deps.output('Local and public tunnel live health passed without sending credentials. GitHub sign-in, VM access and live acceptance remain unverified.'); return 0;
  }
  if (command === 'start' && !rest.length) {
    const { values, missing } = await deps.validate(deps.workspace);
    if (missing.length) throw new SetupError(`Pending configuration: ${missing.join(', ')}. Run the setup wizard before start.`);
    const absent = await deps.prerequisites(deps.workspace);
    if (absent.length) throw new SetupError(`Pending prerequisites: ${absent.join(', ')}. Build with npm run build before start.`);
    deps.output(`Starting local live production control plane on 127.0.0.1:${values.PORT}. Keep the tunnel running; use its HTTPS URL in the browser.`);
    return deps.launch(deps.workspace, values);
  }
  throw new SetupError('Unknown or incomplete setup command. Use --help for commands and next steps.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runLocalSetup(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    // Never report raw provider, filesystem, credential or parser errors.
    console.error(error instanceof SetupError || error instanceof LocalConfigError || error instanceof SetupTemplateError ? error.message : 'Local setup stopped safely. Review prerequisites and private .env.live configuration; existing credentials were preserved. Rerun the wizard to resume.');
    process.exitCode = 1;
  });
}
