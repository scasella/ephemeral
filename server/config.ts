import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { previewBaseOrigin } from '../shared/preview-origin.js';

/** Only fixed validation messages and known environment names are safe to print. */
export class ConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = 'ConfigurationError'; }
}

// Load local configuration without overriding environment supplied by the operator.
// Defer filesystem failures to readConfig so the entry point can sanitize them.
let environmentLoadFailure: { error: unknown } | undefined;
try { if (process.env.EPHEMERAL_SKIP_DOTENV !== '1') process.loadEnvFile(resolve('.env')); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') environmentLoadFailure = { error }; }
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  if (environmentLoadFailure) throw environmentLoadFailure.error;
  const port = Number(env.PORT || 4310);
  const sessionMaxHours = Number(env.SESSION_MAX_HOURS || 1);
  if (sessionMaxHours !== 1 && sessionMaxHours !== 4) throw new ConfigurationError('SESSION_MAX_HOURS must be 1 (Hobby) or 4 (Pro).');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigurationError('PORT must be a valid TCP port');
  const publicUrlInput = env.PUBLIC_URL || `http://localhost:${port}`;
  // Check the raw origin before URL parsing can erase dot paths, backslashes or controls.
  if (!/^https?:\/\/[^/?#\\@\s\u0000-\u001f\u007f-\u009f]+\/?$/i.test(publicUrlInput)) throw new ConfigurationError('PUBLIC_URL must be an HTTP(S) origin');
  let url: URL;
  try { url = new URL(publicUrlInput); }
  catch { throw new ConfigurationError('PUBLIC_URL must be an HTTP(S) origin'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new ConfigurationError('PUBLIC_URL must be an HTTP(S) origin');
  const publicUrl = url.origin;
  const previewPort = Number(env.PREVIEW_PORT || 4312);
  const previewHost = env.PREVIEW_HOST || '127.0.0.1';
  const previewLocalOnly = env.PREVIEW_LOCAL_ONLY === '1';
  if (!Number.isInteger(previewPort) || previewPort < 1 || previewPort > 65535) throw new ConfigurationError('PREVIEW_PORT must be a valid TCP port');
  let previewPublicUrl: string | null = null;
  if (env.PREVIEW_PUBLIC_URL) {
    let previewUrl: URL;
    try { previewUrl = previewBaseOrigin(env.PREVIEW_PUBLIC_URL); }
    catch { throw new ConfigurationError('PREVIEW_PUBLIC_URL must be a canonical HTTPS base DNS origin (explicit local testing supports http://localhost).'); }
    if (previewUrl.protocol === 'http:' && !previewLocalOnly) throw new ConfigurationError('HTTP PREVIEW_PUBLIC_URL requires PREVIEW_LOCAL_ONLY=1.');
    if (previewUrl.hostname === url.hostname || url.hostname.endsWith(`.${previewUrl.hostname}`)) throw new ConfigurationError('PREVIEW_PUBLIC_URL must use a different DNS namespace from PUBLIC_URL');
    if (previewPort === port) throw new ConfigurationError('PREVIEW_PORT must differ from PORT');
    if (previewLocalOnly && (!['localhost', '127.0.0.1'].includes(previewHost) || previewUrl.hostname !== 'localhost' || Number(previewUrl.port || (previewUrl.protocol === 'https:' ? 443 : 80)) !== previewPort)) {
      throw new ConfigurationError('PREVIEW_LOCAL_ONLY requires a loopback listener and matching localhost base URL port');
    }
    previewPublicUrl = previewUrl.origin;
  }
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n') || (env.GITHUB_APP_PRIVATE_KEY_FILE ? readFileSync(env.GITHUB_APP_PRIVATE_KEY_FILE, 'utf8') : '');
  const values = {
    E2B_API_KEY: env.E2B_API_KEY, E2B_TEMPLATE_ID: env.E2B_TEMPLATE_ID,
    GITHUB_APP_ID: env.GITHUB_APP_ID, GITHUB_APP_SLUG: env.GITHUB_APP_SLUG,
    GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET,
    GITHUB_APP_PRIVATE_KEY: privateKey, ENCRYPTION_KEY: env.ENCRYPTION_KEY,
    ALLOWED_GITHUB_IDS: env.ALLOWED_GITHUB_IDS,
  };
  const missing = Object.entries(values).filter(([, value]) => !value).map(([key]) => key);
  const mode = env.EPHEMERAL_MODE || (missing.length ? 'preview' : 'live');
  if (!['live', 'preview'].includes(mode)) throw new ConfigurationError('EPHEMERAL_MODE must be live or preview');
  if (mode === 'live' && missing.length) throw new ConfigurationError(`Missing live configuration: ${missing.join(', ')}`);
  if (mode === 'live' && env.NODE_ENV !== 'production') throw new ConfigurationError('Live mode requires NODE_ENV=production');
  if (mode === 'live' && url.protocol !== 'https:') throw new ConfigurationError('Live mode requires HTTPS PUBLIC_URL reachable from E2B');
  if (mode === 'preview' && env.NODE_ENV === 'production') throw new ConfigurationError('Preview cannot run in production; configure live credentials');
  const encryptionKey = env.ENCRYPTION_KEY || randomBytes(32).toString('base64');
  if (Buffer.from(encryptionKey, 'base64').length !== 32) throw new ConfigurationError('ENCRYPTION_KEY must encode exactly 32 random bytes in base64');
  const allowedIds = new Set((env.ALLOWED_GITHUB_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
  if ([...allowedIds].some(id => !/^\d+$/.test(id))) throw new ConfigurationError('ALLOWED_GITHUB_IDS must contain numeric GitHub user IDs');
  return {
    mode: mode as 'live' | 'preview', port, publicUrl, secure: url.protocol === 'https:', sessionMaxHours: sessionMaxHours as 1 | 4,
    previewPublicUrl, previewPort, previewHost, previewLocalOnly,
    host: mode === 'preview' ? '127.0.0.1' : (env.HOST || '127.0.0.1'), missing,
    databaseUrl: env.DATABASE_URL, dataDir: resolve(env.DATA_DIR || '.data'),
    e2bApiKey: env.E2B_API_KEY || '', e2bTemplateId: env.E2B_TEMPLATE_ID || '',
    githubAppId: env.GITHUB_APP_ID || '', githubAppSlug: env.GITHUB_APP_SLUG || '', privateKey,
    githubClientId: env.GITHUB_CLIENT_ID || '', githubClientSecret: env.GITHUB_CLIENT_SECRET || '',
    encryptionKey, allowedIds,
  };
}
export type Config = ReturnType<typeof readConfig>;
