/** Private, local-only .env.live management. Values are data; no shell is involved. */
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import { createPrivateKey, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnv } from 'node:util';
import { isEnvironmentTemplateRef } from '../shared/environments.js';

const defaults: Record<string, string> = {
  NODE_ENV: 'production', EPHEMERAL_MODE: 'live', HOST: '127.0.0.1', PORT: '4311',
  DATA_DIR: '.data/local-live', DATABASE_URL: '', SESSION_MAX_HOURS: '1',
  PREVIEW_PUBLIC_URL: '', PREVIEW_HOST: '127.0.0.1', PREVIEW_PORT: '4312', PREVIEW_LOCAL_ONLY: '0',
  PUBLIC_URL: '', E2B_API_KEY: '', E2B_TEMPLATE_ID: '', ENVIRONMENT_PROFILES_FILE: '', GITHUB_APP_ID: '', GITHUB_APP_SLUG: '',
  GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '', GITHUB_APP_PRIVATE_KEY: '', GITHUB_APP_PRIVATE_KEY_FILE: '', ALLOWED_GITHUB_IDS: '',
};
const fields = [...Object.keys(defaults), 'ENCRYPTION_KEY'];
const required = ['PORT', 'PUBLIC_URL', 'E2B_API_KEY', 'E2B_TEMPLATE_ID', 'GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'ALLOWED_GITHUB_IDS'];
const fixed = ['NODE_ENV', 'EPHEMERAL_MODE', 'HOST', 'DATA_DIR', 'DATABASE_URL', 'SESSION_MAX_HOURS', 'PREVIEW_PUBLIC_URL'];
const environmentBlockers = ['E2B_DOMAIN', 'E2B_API_URL', 'E2B_SANDBOX_URL', 'E2B_VOLUME_API_URL', 'E2B_DEBUG', 'E2B_HTTP_VERSION', 'E2B_TEMPLATE_ALIAS', 'E2B_TEMPLATE_CODEX_VERSION', 'E2B_TEMPLATE_PNPM_VERSION', 'E2B_BASE_IMAGE'];
export class LocalConfigError extends Error { override name = 'LocalConfigError'; }
function fail(message: string): never { throw new LocalConfigError(message); }
function validatePublicUrl(value: string) {
  let valid = false;
  try { const url = new URL(value); valid = (value === url.origin || value === url.origin + '/') && url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash && !url.hostname.includes(':') && !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) && url.hostname !== 'localhost' && !url.hostname.endsWith('.localhost') && url.hostname.includes('.'); } catch { /* sanitized below */ }
  if (!valid) fail('PUBLIC_URL must be a public HTTPS origin without a path, query, or credentials');
}

function validateEnvironmentProfilesPath(value: string | undefined) {
  if (value && (value.length > 4096 || !isAbsolute(value) || resolve(value) !== value || /[\p{Cc}\p{Cf}]/u.test(value))) {
    fail('ENVIRONMENT_PROFILES_FILE must be a canonical absolute file path without control characters');
  }
}

async function inspect(path: string, kind: 'file' | 'directory', privateMode = true) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (kind === 'file' ? !info.isFile() : !info.isDirectory())) fail('Local configuration paths must not be symlinks or special files');
  if (kind === 'file' && info.nlink !== 1) fail('Local configuration files must not have hard links');
  if (privateMode && (info.mode & 0o777) !== (kind === 'file' ? 0o600 : 0o700)) fail('Local configuration requires private directory (0700; chmod 700) and file (0600; chmod 600) permissions');
  if (privateMode && typeof process.getuid === 'function' && info.uid !== process.getuid()) fail('Local configuration must belong to the current user');
  return info;
}
async function safeAncestors(path: string) {
  const root = parse(resolve(path)).root;
  let current = root;
  for (const component of resolve(path).slice(root.length).split('/').filter(Boolean)) {
    current = join(current, component); await inspect(current, 'directory', false);
  }
}
async function privateDirectory(path: string) {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await inspect(path, 'directory');
}
async function exists(path: string) {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function requireIgnored(workspace: string) {
  // Ignore rules must come from this workspace, not user/global Git configuration.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const run = (args: string[]) => spawnSync('git', ['-c', 'core.excludesFile=/dev/null', ...args], { cwd: workspace, env, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  const discovered = run(['rev-parse', '--show-toplevel']);
  if (discovered.status === 0) {
    const tracked = run(['ls-files', '--', '.env.live', '.data']);
    if (tracked.error || tracked.status !== 0) fail('Git tracking validation is unavailable');
    if (tracked.stdout.trim()) fail('Local configuration or data is tracked by Git; remove it from the index before setup');
  }
  let temporary: string | undefined;
  try {
    let scope: string[] = [];
    if (discovered.status !== 0 || resolve(discovered.stdout.trim()) !== workspace) {
      temporary = await mkdtemp(join(tmpdir(), 'ephemeral-local-ignore-'));
      if (run(['init', '--quiet', temporary]).status !== 0) fail('Git ignore validation is unavailable');
      scope = ['--git-dir', join(temporary, '.git'), '--work-tree', workspace];
    }
    for (const target of ['.env.live', '.data/']) {
      const result = run([...scope, 'check-ignore', '--no-index', '--', target]);
      if (result.error || result.status !== 0) fail('Workspace .gitignore must exclude .env.live and .data/ before local setup');
    }
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
}
interface Assignment { key: string; start: number; end: number }
function decode(content: string): { values: Record<string, string>; assignments: Assignment[]; lines: string[] } {
  const values: Record<string, string> = Object.create(null);
  const assignments: Assignment[] = []; const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(?:#.*)?$/.test(lines[i])) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(lines[i]);
    if (!match) fail('Malformed local environment assignment');
    const key = match[1]; if (Object.hasOwn(values, key)) fail('Duplicate local environment keys must be resolved');
    const start = i; let assignment = lines[i]; const first = match[2][0];
    if (first === '"' || first === "'" || first === '`') {
      let rest = match[2].slice(1);
      while (!rest.includes(first)) {
        if (++i >= lines.length) fail('Unterminated quoted local environment value');
        rest += '\n' + lines[i]; assignment += '\n' + lines[i];
      }
      if (!/^\s*(?:#.*)?$/.test(rest.slice(rest.indexOf(first) + 1))) fail('Unsupported quoted local environment value');
    }
    const parsed = parseEnv(assignment); if (!Object.hasOwn(parsed, key)) fail('Malformed local environment assignment');
    values[key] = parsed[key]!; assignments.push({ key, start, end: i });
  }
  return { values, assignments, lines };
}
function encode(value: string) {
  if (value.includes('\0') || value.includes('\r')) fail('Unsupported local configuration value');
  for (const quote of ["'", '`', '"']) {
    if (!value.includes(quote) && !(quote === '"' && /\\[nr]/.test(value))) {
      const encoded = quote + value + quote;
      if (parseEnv('VALUE=' + encoded).VALUE === value) return encoded;
    }
  }
  return fail('Value cannot be represented safely in a dotenv file');
}
async function snapshot(workspace: string) {
  const file = join(workspace, '.env.live'); const before = await inspect(file, 'file');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size > 1024 * 1024) fail('Local configuration changed or exceeds the supported size');
    const content = await handle.readFile('utf8'); return { content, info: opened, ...decode(content) };
  } finally { await handle.close(); }
}
async function checkDefaults(values: Record<string, string>, complete = false) {
  validateEnvironmentProfilesPath(values.ENVIRONMENT_PROFILES_FILE);
  for (const key of fixed) if ((Object.hasOwn(values, key) || complete) && values[key] !== defaults[key]) fail(`Local configuration conflicts with required ${key}; resolve it explicitly`);
  if (values.PORT !== undefined && (!/^[1-9]\d*$/.test(values.PORT) || Number(values.PORT) > 65535)) fail('PORT must be a valid TCP port');
  if (Object.hasOwn(values, 'ENCRYPTION_KEY') && !/^[A-Za-z0-9+/]{43}=$/.test(values.ENCRYPTION_KEY)) fail('ENCRYPTION_KEY must contain a 32-byte base64 key; existing key was preserved');
}
async function preflight(workspace: string) {
  workspace = resolve(workspace); await safeAncestors(workspace);
  for (const dir of [join(workspace, '.data'), join(workspace, '.data/local-live')]) if (await exists(dir)) await inspect(dir, 'directory');
  if (await exists(join(workspace, '.env.live'))) await inspect(join(workspace, '.env.live'), 'file');
  await requireIgnored(workspace); return workspace;
}
async function withLock(workspace: string, operation: () => Promise<void>) {
  const lock = join(workspace, '.data/local-live/.setup.lock');
  let handle;
  try { handle = await open(lock, 'wx', 0o600); } catch { fail('Local setup is busy or its lock path is unsafe. After confirming no setup process is running, inspect and remove .data/local-live/.setup.lock, then retry; no configuration was changed'); }
  try { await operation(); } finally { await handle.close(); await rm(lock); }
}
/** Initialize once; reruns preserve every existing value, including the encryption key. */
export async function initializeLocalConfig(workspace: string): Promise<void> {
  workspace = await preflight(workspace);
  await privateDirectory(join(workspace, '.data')); await privateDirectory(join(workspace, '.data/local-live'));
  await withLock(workspace, async () => {
    const file = join(workspace, '.env.live');
    if (await exists(file)) { const current = await snapshot(workspace); await checkDefaults(current.values); if (!current.values.ENCRYPTION_KEY) fail('Existing local configuration lacks ENCRYPTION_KEY; it was preserved for explicit recovery'); return; }
    const values = { ...defaults, ENCRYPTION_KEY: randomBytes(32).toString('base64') };
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(Object.entries(values).map(([key, value]) => `${key}=${encode(value)}`).join('\n') + '\n'); await handle.sync(); } finally { await handle.close(); }
  });
}
/** Read only the selected file. Parent environment and supplemental .env are ignored. */
export async function readLocalConfig(workspace: string): Promise<Record<string, string>> {
  workspace = await preflight(workspace); const values = (await snapshot(workspace)).values;
  if (values.PUBLIC_URL) validatePublicUrl(values.PUBLIC_URL);
  return values;
}
/** Fill a known blank setting atomically; refuse different existing values and key rotation. */
export async function setLocalConfigValue(workspace: string, key: string, value: string, options: { expectedContent?: string } = {}): Promise<void> {
  if (!Object.hasOwn(defaults, key) || fixed.includes(key)) fail('This local configuration setting cannot be changed by setup');
  if (key === 'ENVIRONMENT_PROFILES_FILE') validateEnvironmentProfilesPath(value);
  if (key === 'PUBLIC_URL' && value) validatePublicUrl(value);
  if (key === 'E2B_TEMPLATE_ID' && value && !isEnvironmentTemplateRef(value)) fail('E2B_TEMPLATE_ID must contain a safe template ID or alias, optionally namespace/alias:tag; credentials are not allowed');
  if (key === 'GITHUB_APP_ID' && value && !/^[1-9]\d*$/.test(value)) fail('GITHUB_APP_ID must be a positive numeric ID');
  if (key === 'GITHUB_APP_SLUG' && value && !/^[a-z0-9][a-z0-9-]*$/.test(value)) fail('GITHUB_APP_SLUG must be a GitHub App slug');
  if (key === 'ALLOWED_GITHUB_IDS' && value && !/^\d+(?:\s*,\s*\d+)*$/.test(value)) fail('ALLOWED_GITHUB_IDS must contain numeric GitHub identities');
  if (key === 'PORT' && (!/^[1-9]\d*$/.test(value) || Number(value) > 65535)) fail('PORT must be a valid TCP port');
  const encoded = encode(value); workspace = await preflight(workspace);
  await inspect(join(workspace, '.data/local-live'), 'directory');
  await withLock(workspace, async () => {
    const before = await snapshot(workspace); await checkDefaults(before.values);
    if (options.expectedContent !== undefined && before.content !== options.expectedContent) fail('Local configuration changed during setup; no values were overwritten');
    if (key !== 'PORT' && before.values[key] && before.values[key] !== value) fail('Existing local configuration value differs; update it explicitly in the private file');
    if (before.values[key] === value) return;
    const assigned = before.assignments.find(item => item.key === key);
    if (assigned) before.lines.splice(assigned.start, assigned.end - assigned.start + 1, `${key}=${encoded}`);
    else before.lines.push(`${key}=${encoded}`);
    const staged = join(workspace, '.data/local-live', `.environment-${randomBytes(12).toString('hex')}.pending`);
    try {
      const handle = await open(staged, 'wx', 0o600);
      try { await handle.writeFile(before.lines.join('\n').replace(/\n*$/, '\n')); await handle.sync(); } finally { await handle.close(); }
      await inspect(join(workspace, '.data'), 'directory'); await inspect(join(workspace, '.data/local-live'), 'directory');
      await requireIgnored(workspace);
      const current = await snapshot(workspace);
      if (current.content !== before.content || current.info.ino !== before.info.ino || current.info.dev !== before.info.dev || current.info.mtimeMs !== before.info.mtimeMs || current.info.ctimeMs !== before.info.ctimeMs) fail('Local configuration changed during setup; no values were overwritten');
      await rename(staged, join(workspace, '.env.live'));
    } finally { await rm(staged, { force: true }); }
  });
}
/** Return missing key names; invalid local isolation, credentials, or PEMs fail without values. */
export async function validateLocalConfig(workspace: string): Promise<{ values: Record<string, string>; missing: string[] }> {
  const values = await readLocalConfig(workspace); await checkDefaults(values, true);
  const missing = required.filter(key => !values[key]?.trim());
  if (!values.ENCRYPTION_KEY) missing.push('ENCRYPTION_KEY');
  if (values.PUBLIC_URL) validatePublicUrl(values.PUBLIC_URL);
  if (values.ALLOWED_GITHUB_IDS && !/^\d+(?:\s*,\s*\d+)*$/.test(values.ALLOWED_GITHUB_IDS)) fail('ALLOWED_GITHUB_IDS must contain numeric GitHub identities');
  if (values.GITHUB_APP_ID && !/^[1-9]\d*$/.test(values.GITHUB_APP_ID)) fail('GITHUB_APP_ID must be a positive numeric ID');
  if (values.GITHUB_APP_PRIVATE_KEY && values.GITHUB_APP_PRIVATE_KEY_FILE) fail('Configure one GitHub private key source');
  let pem = values.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (values.GITHUB_APP_PRIVATE_KEY_FILE) {
    try {
      if (!isAbsolute(values.GITHUB_APP_PRIVATE_KEY_FILE)) fail('Private key path must be absolute');
      await safeAncestors(dirname(values.GITHUB_APP_PRIVATE_KEY_FILE)); await inspect(values.GITHUB_APP_PRIVATE_KEY_FILE, 'file');
      const handle = await open(values.GITHUB_APP_PRIVATE_KEY_FILE, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { pem = await handle.readFile('utf8'); } finally { await handle.close(); }
    } catch { fail('GitHub private key file must be readable, regular, private, and use an absolute path without symlinks'); }
  }
  if (!pem) missing.push('GITHUB_APP_PRIVATE_KEY');
  else { try { if (createPrivateKey(pem).asymmetricKeyType !== 'rsa') fail('Invalid key'); } catch { fail('GitHub private key must be a valid RSA PEM'); } }
  return { values, missing };
}
/** Build a minimal child environment, explicitly blocking supplemental .env configuration. */
export function localChildEnvironment(values: Record<string, string>, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  validateEnvironmentProfilesPath(values.ENVIRONMENT_PROFILES_FILE);
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT']) if (inherited[key] !== undefined) env[key] = inherited[key];
  for (const key of [...fields, ...environmentBlockers]) env[key] = fields.includes(key) ? values[key] ?? '' : '';
  return env;
}
