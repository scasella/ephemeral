import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
export function same(a: string, b: string) { return timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b))); }
export function seal(value: string, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  cipher.setAAD(Buffer.from('ephemeral:auth:v1'));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(b => b.toString('base64url')).join('.');
}
export function unseal(value: string, key: string): string {
  const [iv, tag, ciphertext] = value.split('.').map(s => Buffer.from(s, 'base64url'));
  if (!iv || !tag || !ciphertext) throw new Error('Invalid encrypted credential');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  decipher.setAAD(Buffer.from('ephemeral:auth:v1')); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
