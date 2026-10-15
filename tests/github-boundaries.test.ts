import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { createServer, request, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database, Session } from '../server/contracts.js';
import { GitGateway } from '../server/github/gateway.js';
import { CredentialStore } from '../server/github/store.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const makeSession = (id: string, userId = 'alice'): Session => ({ id, userId, repository: 'owner/repo', repositoryId: 1, installationId: 2,
  branch: `ephemeral/${id}`, baseBranch: 'main', state: 'running', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  maxExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), sandboxId: 'vm', endedAt: null, error: null,
  cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified' });
const authorization = (cap: string) => `Basic ${Buffer.from(`x-access-token:${cap}`).toString('base64')}`;
async function fixture() {
  const db = new PGlite(); cleanups.push(() => db.close());
  const api = { installationToken: vi.fn(async () => ({ token: 'UPSTREAM-BOUNDARY-SECRET', expires_at: new Date(Date.now() + 3_600_000).toISOString() })), revoke: vi.fn(async () => {}) };
  const store = new CredentialStore(db as unknown as Database, Buffer.alloc(32, 7), api); await store.migrate();
  const sessions = new Map(['target', 'same-user', 'other-user'].map(id => [id, makeSession(id, id === 'other-user' ? 'bob' : 'alice')]));
  const capabilities = new Map<string, string>(); for (const [id, session] of sessions) capabilities.set(id, await store.issue(session));
  const gateway = new GitGateway(store, { getSession: async id => sessions.get(id) ?? null }); cleanups.push(() => gateway.close());
  // Passive observation of the real admission path: rejected traffic must never
  // enqueue a Git action, request an installation token, or spawn Git.
  const serialize = vi.spyOn(gateway, 'serialize');
  const token = vi.spyOn(store, 'token');
  const command = vi.spyOn(gateway as unknown as { command(...args: unknown[]): Promise<Buffer> }, 'command')
    .mockRejectedValue(new Error('Unexpected Git subprocess after admission rejection'));
  const app = express(); app.use('/gateway', gateway.router);
  const server: Server = createServer(app);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected local TCP listener');
  const remote = `http://127.0.0.1:${address.port}/gateway/git/target.git`;
  return { db, api, store, sessions, capabilities, gateway, serialize, token, command, remote };
}

// Chunked HTTP uses a reused 64 KiB block, keeping test allocation independent
// of the production 32 MiB limit while exercising its actual wire boundary.
async function post(remote: string, cap: string, mode: 'header' | 'stream') {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(`${remote}/git-upload-pack`, { method: 'POST', headers: { Authorization: authorization(cap),
      'Content-Type': 'application/x-git-upload-pack-request', ...(mode === 'header' ? { 'Content-Length': String(33 * 1024 * 1024) } : {}) } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => body += chunk); res.on('end', () => { req.destroy(); resolve({ status: res.statusCode!, body }); });
    });
    req.on('error', reject);
    if (mode === 'header') req.flushHeaders();
    else {
      const block = Buffer.alloc(64 * 1024); let remaining = 33 * 16;
      const send = () => { while (remaining-- > 0) if (!req.write(block)) { req.once('drain', send); return; } req.end(); };
      send();
    }
  });
}

describe('gateway security admission over HTTP', () => {
  it.each(['same-user', 'other-user'])('rejects the %s capability on a different session before queueing, minting, or Git', async source => {
    const f = await fixture();
    for (const endpoint of ['/info/refs?service=git-upload-pack', '/info/refs?service=git-receive-pack']) {
      const response = await fetch(f.remote + endpoint, { headers: { Authorization: authorization(f.capabilities.get(source)!) } });
      expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'Invalid or disabled gateway credential' });
    }
    expect(f.serialize).not.toHaveBeenCalled(); expect(f.token).not.toHaveBeenCalled(); expect(f.api.installationToken).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled();
  });

  it.each(['header', 'stream'] as const)('returns 413 for oversized %s bodies before minting or Git', async mode => {
    const f = await fixture(); const response = await post(f.remote, f.capabilities.get('target')!, mode);
    expect(response.status).toBe(413); expect(response.body).toContain('Git request exceeds the body limit');
    expect(f.token).not.toHaveBeenCalled(); expect(f.api.installationToken).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled();
  });

  it('returns 429 at the per-session queue bound before minting or Git while other sessions retain admission', async () => {
    const f = await fixture(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const occupied = Array.from({ length: 8 }, () => f.gateway.serialize('target', () => gate));
    try {
      const response = await fetch(f.remote + '/info/refs?service=git-upload-pack', { headers: { Authorization: authorization(f.capabilities.get('target')!) } });
      expect(response.status).toBe(429); expect(await response.json()).toEqual({ error: 'Too many simultaneous Git requests' });
      await expect(f.gateway.serialize('same-user', async () => 'independent admission')).resolves.toBe('independent admission');
      expect(f.token).not.toHaveBeenCalled(); expect(f.api.installationToken).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled();
    } finally { release(); await Promise.all(occupied); }
  });
});

function corrupt(value: string, component: number) {
  const parts = value.split('.'); const bytes = Buffer.from(parts[component], 'base64url'); bytes[0] ^= 1;
  parts[component] = bytes.toString('base64url'); return parts.join('.');
}
describe('durable GitHub ciphertext boundaries', () => {
  it('rejects transplanted installation ciphertext and every modified AEAD component before returning a token', async () => {
    const f = await fixture(), session = f.sessions.get('target')!; await f.store.token(session);
    const row = (await f.db.query<{ id: string; ciphertext: string }>('SELECT id,ciphertext FROM github_installation_tokens')).rows[0];
    for (let component = 0; component < 3; component++) {
      await f.db.query('UPDATE github_installation_tokens SET ciphertext=$1 WHERE id=$2', [corrupt(row.ciphertext, component), row.id]);
      await expect(f.store.token(session)).rejects.toThrow();
    }
    await f.db.query('UPDATE github_installation_tokens SET ciphertext=$1,session_id=$2 WHERE id=$3', [row.ciphertext, 'same-user', row.id]);
    await expect(f.store.token(f.sessions.get('same-user')!)).rejects.toThrow();
    expect(f.api.installationToken).toHaveBeenCalledTimes(1);
    await f.db.query('UPDATE github_installation_tokens SET session_id=$1 WHERE id=$2', ['target', row.id]);
    await expect(f.store.token(session)).resolves.toBe('UPSTREAM-BOUNDARY-SECRET');
  });

  it('keeps a transplanted or tampered fallback revocation handle pending across a fresh store', async () => {
    const f = await fixture(), session = f.sessions.get('target')!, query = f.db.query.bind(f.db);
    const writes = vi.spyOn(f.db, 'query').mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('INSERT INTO github_installation_tokens')) throw new Error('normal token storage unavailable');
      return query(sql, params);
    });
    f.api.revoke.mockRejectedValue(new Error('revocation unavailable'));
    await expect(f.store.token(session)).rejects.toThrow('normal token storage unavailable'); writes.mockRestore();
    const row = (await f.db.query<{ id: string; ciphertext: string }>('SELECT id,ciphertext FROM github_token_issuance_attempts')).rows[0];
    expect(row.ciphertext).not.toContain('UPSTREAM-BOUNDARY-SECRET'); f.api.revoke.mockClear();
    const reopened = new CredentialStore(f.db as unknown as Database, Buffer.alloc(32, 7), f.api); await reopened.migrate();
    for (let component = 0; component < 3; component++) {
      await f.db.query('UPDATE github_token_issuance_attempts SET ciphertext=$1 WHERE id=$2', [corrupt(row.ciphertext, component), row.id]);
      await expect(reopened.revoke('target')).rejects.toThrow('pending');
    }
    await f.db.query('UPDATE github_token_issuance_attempts SET ciphertext=$1,session_id=$2 WHERE id=$3', [row.ciphertext, 'same-user', row.id]);
    await expect(reopened.revoke('same-user')).rejects.toThrow('pending');
    expect(f.api.revoke).not.toHaveBeenCalled();
    expect((await reopened.issuanceStatus('same-user')).attempts[0].status).toBe('revoke_pending');
    await f.db.query('UPDATE github_token_issuance_attempts SET session_id=$1 WHERE id=$2', ['target', row.id]);
    f.api.revoke.mockResolvedValue(); await reopened.revoke('target');
    expect(f.api.revoke).toHaveBeenCalledWith('UPSTREAM-BOUNDARY-SECRET');
    expect((await reopened.issuanceStatus('target')).attempts[0].status).toBe('revoked');
  });
});
