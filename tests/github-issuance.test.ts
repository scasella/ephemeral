import { afterEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database, Session } from '../server/contracts.js';
import { GitHubAPI } from '../server/github/api.js';
import { CredentialStore } from '../server/github/store.js';
import { encrypt, GitHubError } from '../server/github/security.js';

const key = Buffer.alloc(32, 7);
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const session = (id = 'test-session'): Session => ({ id, userId: 'owner', repository: 'owner/repo', repositoryId: 1, installationId: 2,
  branch: `ephemeral/${id}`, baseBranch: 'main', state: 'running', createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(), maxExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  sandboxId: 'vm', endedAt: null, error: null, cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified' });
const expiry = () => new Date(Date.now() + 3_600_000).toISOString();
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(persistent = false) {
  const directory = persistent ? await mkdtemp(join(tmpdir(), 'ep-issuance-')) : undefined;
  if (directory) cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const db = new PGlite(directory); let closed = false;
  cleanups.push(() => closed ? Promise.resolve() : db.close());
  const api = new GitHubAPI('42', privateKey, 'test-app');
  const revoke = vi.spyOn(api, 'revoke').mockResolvedValue(undefined);
  const store = new CredentialStore(db as unknown as Database, key, api); await store.migrate();
  const s = session(); await store.issue(s);
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ token: 'test-upstream-token', expires_at: expiry() }), { status: 201 }));
  vi.stubGlobal('fetch', fetcher);
  return { db, api, revoke, store, s, fetcher, directory, close: async () => { await db.close(); closed = true; } };
}

describe('durable installation-token issuance outcomes', () => {
  it('finishes signing and request validation before any fetch or uncertainty marker', async () => {
    const f = await fixture();
    const badKey = new CredentialStore(f.db as unknown as Database, key, new GitHubAPI('42', 'invalid-key', 'test-app'));
    await expect(badKey.token(f.s)).rejects.toThrow('prepared');
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(await badKey.issuanceStatus(f.s.id)).toMatchObject({ uncertaintyUntil: null, attempts: [{ status: 'not_issued', reason: 'request_not_sent' }] });
    await expect(f.store.token({ ...f.s, repositoryId: NaN })).rejects.toThrow('prepared');
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('records the durable claim before POST and records a completed historical outcome', async () => {
    const f = await fixture();
    f.fetcher.mockImplementation(async () => {
      expect((await f.store.issuanceStatus(f.s.id)).attempts).toMatchObject([{ status: 'uncertain', reason: 'request_uncertain' }]);
      return new Response(JSON.stringify({ token: 'test-upstream-token', expires_at: expiry() }), { status: 201 });
    });
    expect(await f.store.token(f.s)).toBe('test-upstream-token');
    const diagnostics = await f.store.issuanceStatus(f.s.id);
    expect(diagnostics).toMatchObject({ uncertaintyUntil: null, attempts: [{ status: 'issued', reason: 'token_recorded' }] });
    expect(JSON.stringify(diagnostics)).not.toContain('test-upstream-token');
    expect(JSON.stringify(diagnostics)).not.toMatch(/ciphertext|token_id/);
    expect((await f.db.query<{ ciphertext: string | null }>('SELECT ciphertext FROM github_token_issuance_attempts')).rows[0].ciphertext).toBeNull();
  });

  it.each([400, 401, 403, 404, 422, 429])('clears uncertainty only for trusted definitive HTTP %s rejection', async status => {
    const f = await fixture(); f.fetcher.mockResolvedValue(new Response('{}', { status }));
    await expect(f.store.token(f.s)).rejects.toThrow('rejected');
    expect(await f.store.issuanceStatus(f.s.id)).toMatchObject({ uncertaintyUntil: null, attempts: [{ status: 'not_issued', reason: 'request_rejected' }] });
    await expect(f.store.revoke(f.s.id)).resolves.toBeUndefined();
  });

  it.each([408, 409, 418, 500, 503])('retains uncertainty for HTTP %s without a second mint', async status => {
    const f = await fixture(); f.fetcher.mockResolvedValue(new Response('{}', { status }));
    await expect(f.store.token(f.s)).rejects.toThrow('uncertain');
    await expect(new CredentialStore(f.db as unknown as Database, key, f.api).token(f.s)).rejects.toThrow('uncertain');
    await expect(f.store.revoke(f.s.id)).rejects.toThrow('pending');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect((await f.store.issuanceStatus(f.s.id)).attempts).toMatchObject([{ status: 'uncertain', reason: 'request_uncertain' }]);
  });

  it.each(['lost response', 'timeout', 'malformed JSON', 'missing token'])('preserves ambiguous %s and prevents duplicate issuance', async failure => {
    const f = await fixture();
    if (failure === 'malformed JSON') f.fetcher.mockResolvedValue(new Response('{', { status: 201 }));
    else if (failure === 'missing token') f.fetcher.mockResolvedValue(new Response(JSON.stringify({ expires_at: expiry() }), { status: 201 }));
    else f.fetcher.mockRejectedValue(failure === 'timeout' ? new DOMException('private diagnostic', 'TimeoutError') : new Error('private diagnostic'));
    await expect(f.store.token(f.s)).rejects.toThrow();
    await expect(f.store.token(f.s)).rejects.toThrow('uncertain');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect((await f.store.issuanceStatus(f.s.id)).uncertaintyUntil).not.toBeNull();
    expect(JSON.stringify(await f.store.issuanceStatus(f.s.id))).not.toContain('private diagnostic');
  });

  it.each(['not-a-date', '2000-01-01T00:00:00.000Z'])('retains an encrypted handle and conservative expiry for invalid grant expiry %s', async invalidExpiry => {
    const f = await fixture(); f.fetcher.mockResolvedValue(new Response(JSON.stringify({ token: 'invalid-expiry-token', expires_at: invalidExpiry }), { status: 201 }));
    f.revoke.mockRejectedValue(new Error('offline'));
    await expect(f.store.token(f.s)).rejects.toThrow('invalid');
    expect(f.revoke).toHaveBeenCalledWith('invalid-expiry-token');
    const row = (await f.db.query<{ ciphertext: string; expires_at: string; status: string }>('SELECT * FROM github_token_issuance_attempts')).rows[0];
    expect(row.status).toBe('revoke_pending'); expect(row.ciphertext).not.toContain('invalid-expiry-token');
    expect(Date.parse(row.expires_at)).toBeGreaterThan(Date.now() + 64 * 60_000);
    await expect(f.store.revoke(f.s.id)).rejects.toThrow('pending');
    f.revoke.mockResolvedValue(undefined);
    await expect(f.store.revoke(f.s.id)).resolves.toBeUndefined();
    expect((await f.store.issuanceStatus(f.s.id)).attempts[0].status).toBe('revoked');
  });

  it('recovers the encrypted handle after token-table write and revocation failure across a durable restart', async () => {
    const f = await fixture(true); const query = f.db.query.bind(f.db);
    vi.spyOn(f.db, 'query').mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('INSERT INTO github_installation_tokens')) throw new Error('token storage unavailable');
      return query(sql, params);
    });
    f.revoke.mockRejectedValue(new Error('offline'));
    await expect(f.store.token(f.s)).rejects.toThrow('token storage unavailable');
    const pending = (await query<{ ciphertext: string }>('SELECT ciphertext FROM github_token_issuance_attempts')).rows[0];
    expect(pending.ciphertext).toBeTruthy(); expect(pending.ciphertext).not.toContain('test-upstream-token');
    await f.close(); const reopened = new PGlite(f.directory); cleanups.push(() => reopened.close());
    f.revoke.mockResolvedValue(undefined);
    const restarted = new CredentialStore(reopened as unknown as Database, key, f.api); await restarted.migrate();
    await expect(restarted.token(f.s)).rejects.toThrow('uncertain');
    await restarted.disable(f.s.id); await restarted.revoke(f.s.id);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(await restarted.issuanceStatus(f.s.id)).toMatchObject({ uncertaintyUntil: null, attempts: [{ status: 'revoked' }] });
  });

  it('keeps unknown issuance when both encrypted-handle writes and revocation fail', async () => {
    const f = await fixture(); const query = f.db.query.bind(f.db);
    vi.spyOn(f.db, 'query').mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('UPDATE github_token_issuance_attempts SET ciphertext=')) throw new Error('handle write unavailable');
      return query(sql, params);
    });
    f.revoke.mockRejectedValue(new Error('offline'));
    await expect(f.store.token(f.s)).rejects.toThrow('handle write unavailable');
    await expect(f.store.token(f.s)).rejects.toThrow('uncertain');
    await expect(f.store.revoke(f.s.id)).rejects.toThrow('pending');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it('fences concurrent stores with one durable claim and revokes a grant after concurrent disable', async () => {
    const f = await fixture(); let release!: () => void; let started!: () => void;
    const arrived = new Promise<void>(resolve => { started = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    f.fetcher.mockImplementation(async () => { started(); await barrier; return new Response(JSON.stringify({ token: 'late-token', expires_at: expiry() }), { status: 201 }); });
    const first = f.store.token(f.s); await arrived;
    const second = new CredentialStore(f.db as unknown as Database, key, f.api);
    await expect(second.token(f.s)).rejects.toThrow('uncertain');
    await second.disable(f.s.id); release();
    await expect(first).rejects.toThrow('disabled');
    expect(f.fetcher).toHaveBeenCalledTimes(1); expect(f.revoke).toHaveBeenCalledWith('late-token');
    expect((await f.store.issuanceStatus(f.s.id)).attempts[0].status).toBe('revoked');
  });

  it('settles a verified revocation immediately after transient marker-clear failures', async () => {
    const f = await fixture(); const query = f.db.query.bind(f.db); let failClear = true;
    vi.spyOn(f.db, 'query').mockImplementation(async (sql: string, params?: unknown[]) => {
      if (failClear && sql.startsWith('DELETE FROM github_token_issuance')) throw new Error('marker clear unavailable');
      return query(sql, params);
    });
    f.revoke.mockRejectedValueOnce(new Error('remote unavailable'));
    await expect(f.store.token(f.s)).rejects.toThrow('marker clear unavailable');
    await f.store.disable(f.s.id);
    await expect(f.store.revoke(f.s.id)).rejects.toThrow();
    expect((await f.store.issuanceStatus(f.s.id)).attempts[0].status).toBe('revoked');
    expect((await f.store.issuanceStatus(f.s.id)).uncertaintyUntil).not.toBeNull();
    failClear = false;
    await expect(f.store.revoke(f.s.id)).resolves.toBeUndefined();
    expect((await f.store.issuanceStatus(f.s.id)).uncertaintyUntil).toBeNull();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([400, 408, 500])('does not trust a synthetic generic GitHubError with status %s as nonissuance proof', async status => {
    const f = await fixture();
    const legacy = { installationToken: vi.fn().mockRejectedValue(new GitHubError('synthetic-secret', 502, status)), revoke: f.revoke };
    const store = new CredentialStore(f.db as unknown as Database, key, legacy);
    await expect(store.token(f.s)).rejects.toThrow();
    await expect(store.token(f.s)).rejects.toThrow('uncertain');
    expect(legacy.installationToken).toHaveBeenCalledTimes(1);
    expect((await store.issuanceStatus(f.s.id)).uncertaintyUntil).not.toBeNull();
  });

  it('does not claim cleanup for an unexpired token row missing its revocation handle', async () => {
    const f = await fixture();
    await f.db.query("INSERT INTO github_installation_tokens(id,session_id,ciphertext,expires_at,status) VALUES('missing',$1,NULL,$2,'active')", [f.s.id, expiry()]);
    await expect(f.store.revoke(f.s.id)).rejects.toThrow('pending');
    expect(f.revoke).not.toHaveBeenCalled();
    expect((await f.db.query<{ status: string }>("SELECT status FROM github_installation_tokens WHERE id='missing'")).rows[0].status).toBe('revoke_pending');
  });

  it('binds fallback ciphertext to the original session and never skips malformed legacy expiry', async () => {
    const f = await fixture(); f.fetcher.mockResolvedValue(new Response(JSON.stringify({ token: 'bound-token', expires_at: 'invalid' }), { status: 201 }));
    f.revoke.mockRejectedValue(new Error('offline')); await expect(f.store.token(f.s)).rejects.toThrow();
    await f.db.query('UPDATE github_token_issuance_attempts SET session_id=$1', ['other-session']);
    f.revoke.mockClear().mockResolvedValue(undefined);
    await expect(f.store.revoke('other-session')).rejects.toThrow('pending'); expect(f.revoke).not.toHaveBeenCalled();
    await f.db.query("INSERT INTO github_installation_tokens(id,session_id,ciphertext,expires_at,status) VALUES('legacy',$1,$2,'not-a-date','active')", ['legacy-session', encrypt('legacy-token', key, 'github:legacy:legacy-session')]);
    f.revoke.mockRejectedValue(new Error('offline'));
    await expect(f.store.revoke('legacy-session')).rejects.toThrow('pending'); expect(f.revoke).toHaveBeenCalledWith('legacy-token');
    expect((await f.db.query<{ ciphertext: string }>("SELECT ciphertext FROM github_installation_tokens WHERE id='legacy'")).rows[0].ciphertext).toBeTruthy();
  });
});
