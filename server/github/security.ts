import { createCipheriv, createDecipheriv, createHash, createPrivateKey, randomBytes, sign, timingSafeEqual } from 'node:crypto';

export class GitHubError extends Error {
  constructor(message: string, public status = 502, public upstreamStatus?: number) { super(message); }
}
/** HTTP rejection observed by our transport, rather than inferred from error text. */
export class GitHubRequestRejectedError extends GitHubError {}
export class InstallationTokenIssuanceError extends GitHubError {
  constructor(readonly outcome: 'not_issued' | 'unknown') {
    super(outcome === 'not_issued' ? 'GitHub rejected token issuance' : 'GitHub token issuance is uncertain');
  }
}
export function encryptionKey(value: string): Buffer {
  const key = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must encode 32 bytes (hex or base64)');
  return key;
}
export function encrypt(value: string, key: Buffer, context: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [nonce, cipher.getAuthTag(), ciphertext].map(b => b.toString('base64url')).join('.');
}
export function decrypt(value: string, key: Buffer, context: string): string {
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error('Invalid encrypted credential');
  const [nonce, tag, ciphertext] = parts.map(p => Buffer.from(p, 'base64url'));
  const cipher = createDecipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context)); cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(ciphertext), cipher.final()]).toString('utf8');
}
export const capabilityHash = (token: string): string => createHash('sha256').update(token).digest('hex');
export function equalHash(token: string, expected: string): boolean {
  const actual = Buffer.from(capabilityHash(token), 'hex'), wanted = Buffer.from(expected, 'hex');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
export function appJWT(appId: string, privateKey: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat, exp: iat + 600, iss: appId })).toString('base64url');
  const unsigned = `${head}.${payload}`;
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), createPrivateKey(privateKey)).toString('base64url')}`;
}
export function safeRepository(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) throw new GitHubError('Invalid repository', 400);
  return value;
}
