import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { previewBaseOrigin } from '../shared/preview-origin.js';

// Load local configuration without overriding environment supplied by the operator.
try { process.loadEnvFile(resolve('.env')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const port = Number(env.PORT || 4310);
  const sessionMaxHours = Number(env.SESSION_MAX_HOURS || 1);
  if (sessionMaxHours !== 1 && sessionMaxHours !== 4) throw new Error('SESSION_MAX_HOURS must be 1 (Hobby) or 4 (Pro).');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port');
  const publicUrl = (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '');
  const url = new URL(publicUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('PUBLIC_URL must be an HTTP(S) origin');
  const previewPort = Number(env.PREVIEW_PORT || 4312);
  const previewHost = env.PREVIEW_HOST || '127.0.0.1';
  const previewLocalOnly = env.PREVIEW_LOCAL_ONLY === '1';
  if (!Number.isInteger(previewPort) || previewPort < 1 || previewPort > 65535) throw new Error('PREVIEW_PORT must be a valid TCP port');
  let previewPublicUrl: string | null = null;
  if (env.PREVIEW_PUBLIC_URL) {
    let previewUrl: URL;
    try { previewUrl = previewBaseOrigin(env.PREVIEW_PUBLIC_URL); }
    catch { throw new Error('PREVIEW_PUBLIC_URL must be a canonical HTTPS base DNS origin (explicit local testing supports http://localhost).'); }
    if (previewUrl.protocol === 'http:' && !previewLocalOnly) throw new Error('HTTP PREVIEW_PUBLIC_URL requires PREVIEW_LOCAL_ONLY=1.');
    if (previewUrl.hostname === url.hostname || url.hostname.endsWith(`.${previewUrl.hostname}`)) throw new Error('PREVIEW_PUBLIC_URL must use a different DNS namespace from PUBLIC_URL');
    if (previewPort === port) throw new Error('PREVIEW_PORT must differ from PORT');
    if (previewLocalOnly && (!['localhost', '127.0.0.1'].includes(previewHost) || previewUrl.hostname !== 'localhost' || Number(previewUrl.port || (previewUrl.protocol === 'https:' ? 443 : 80)) !== previewPort)) {
      throw new Error('PREVIEW_LOCAL_ONLY requires a loopback listener and matching localhost base URL port');
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
  if (!['live', 'preview'].includes(mode)) throw new Error('EPHEMERAL_MODE must be live or preview');
  if (mode === 'live' && missing.length) throw new Error(`Missing live configuration: ${missing.join(', ')}`);
  if (mode === 'live' && url.protocol !== 'https:') throw new Error('Live mode requires HTTPS PUBLIC_URL reachable from E2B');
  if (mode === 'preview' && env.NODE_ENV === 'production') throw new Error('Preview cannot run in production; configure live credentials');
  const encryptionKey = env.ENCRYPTION_KEY || randomBytes(32).toString('base64');
  if (Buffer.from(encryptionKey, 'base64').length !== 32) throw new Error('ENCRYPTION_KEY must encode exactly 32 random bytes in base64');
  const allowedIds = new Set((env.ALLOWED_GITHUB_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
  if ([...allowedIds].some(id => !/^\d+$/.test(id))) throw new Error('ALLOWED_GITHUB_IDS must contain numeric GitHub user IDs');
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
