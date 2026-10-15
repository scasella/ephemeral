import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { createAuth, isSameOrigin, cookies } from '../server/auth/index.js';
import { digest, seal, unseal } from '../server/auth/crypto.js';
import { readConfig } from '../server/config.js';
import type { Database } from '../server/contracts.js';

const key = randomBytes(32).toString('base64');
describe('credential protection and browser boundary', () => {
  it('encrypts credentials with authenticated encryption and rejects modification', () => {
    const encrypted = seal('upstream-secret', key);
    expect(encrypted).not.toContain('upstream-secret');
    expect(unseal(encrypted, key)).toBe('upstream-secret');
    const parts = encrypted.split('.'); const ciphertext = Buffer.from(parts[2], 'base64url'); ciphertext[0] ^= 1; parts[2] = ciphertext.toString('base64url');
    expect(() => unseal(parts.join('.'), key)).toThrow();
    expect(() => unseal(encrypted, randomBytes(32).toString('base64'))).toThrow();
  });
  it('rejects cross-site browser requests and accepts only same origin', () => {
    expect(isSameOrigin({ headers: { origin: 'https://evil.test' } }, 'https://ephemeral.test')).toBe(false);
    expect(isSameOrigin({ headers: { origin: 'https://ephemeral.test', 'sec-fetch-site': 'same-origin' } }, 'https://ephemeral.test')).toBe(true);
    expect(isSameOrigin({ headers: { 'sec-fetch-site': 'cross-site' } }, 'https://ephemeral.test')).toBe(false);
    expect(isSameOrigin({ headers: { origin: 'null' } }, 'https://ephemeral.test')).toBe(false);
  });
  it('keeps equal signs within cookie values', () => expect(cookies({ headers: { cookie: 'a=hello==; b=world' } })).toEqual({ a: 'hello==', b: 'world' }));
  it('fails closed for production preview and missing live configuration', () => {
    expect(() => readConfig({ NODE_ENV: 'production' })).toThrow(/Preview/);
    expect(() => readConfig({ EPHEMERAL_MODE: 'live' })).toThrow(/Missing/);
    expect(() => readConfig({ ENCRYPTION_KEY: 'weak' })).toThrow(/32/);
  });
});
describe('persisted browser sessions', () => {
  const pg = new PGlite();
  const db: Database = { async query<T>(sql: string, params: unknown[] = []) { return { rows: (await pg.query<T>(sql, params)).rows }; }, close: () => pg.close() };
  let auth: Awaited<ReturnType<typeof createAuth>>;
  const config = readConfig({ ENCRYPTION_KEY: key, ALLOWED_GITHUB_IDS: '42' });
  beforeAll(async () => { await pg.waitReady; auth = await createAuth(db, config); });
  afterAll(() => pg.close());
  it('requires an unexpired session AND a currently invited numeric user ID', async () => {
    const add = (value: string, userId: string, expiry: string) => db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [digest(value), userId, 'developer', '', seal('github-secret', key), expiry]);
    await add('valid', '42', new Date(Date.now() + 60000).toISOString());
    await add('uninvited', '99', new Date(Date.now() + 60000).toISOString());
    await add('expired', '42', new Date(Date.now() - 60000).toISOString());
    const request = (value: string) => ({ headers: { cookie: `ephemeral=${value}` } }) as Request;
    expect((await auth.read(request('valid')))?.id).toBe('42');
    expect(await auth.read(request('uninvited'))).toBeNull();
    expect(await auth.read(request('expired'))).toBeNull();
    expect(await auth.read(request('made-up'))).toBeNull();
    config.allowedIds.delete('42');
    expect(await auth.read(request('valid'))).toBeNull();
  });
});
