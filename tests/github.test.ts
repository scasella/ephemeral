import { afterEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import express from 'express';
import type { Database, Session } from '../server/contracts.js';
import { appJWT, decrypt, encrypt, encryptionKey, GitHubError } from '../server/github/security.js';
import { CredentialStore } from '../server/github/store.js';
import { GitHubAPI } from '../server/github/api.js';
import { GitGateway } from '../server/github/gateway.js';

const key = encryptionKey(Buffer.alloc(32, 3).toString('base64'));
const session = (): Session => ({ id: 'test-session', userId: 'user', repository: 'owner/repository', repositoryId: 1, installationId: 2,
  branch: 'ephemeral/test-session', baseBranch: 'main', state: 'running', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
  maxExpiresAt: new Date(Date.now() + 3600000).toISOString(), sandboxId: 'vm', endedAt: null, error: null,
  cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified' });
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
async function storage() {
  const db = new PGlite(); cleanups.push(() => db.close());
  const api = new GitHubAPI('42', 'not-needed', 'ephemeral');
  vi.spyOn(api, 'installationToken').mockResolvedValue({ token: 'SECRET-UPSTREAM-TOKEN', expires_at: new Date(Date.now() + 3600000).toISOString() });
  vi.spyOn(api, 'revoke').mockResolvedValue(undefined);
  const store = new CredentialStore(db as unknown as Database, key, api); await store.migrate();
  return { db, api, store };
}
async function git(args: string[], input?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } });
    let out = '', err = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
    child.stdin.end(input); child.on('error', reject); child.on('close', code => resolve({ code: code ?? -1, out, err }));
  });
}
async function ok(args: string[]): Promise<string> { const result = await git(args); if (result.code) throw new Error(result.err); return result.out.trim(); }
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return `http://127.0.0.1:${address.port}`;
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ep-gh-test-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const upstream = join(directory, 'upstream.git'), seed = join(directory, 'seed');
  await ok(['init', '--bare', upstream]); await ok(['--git-dir', upstream, 'config', 'http.receivepack', 'true']);
  await ok(['init', '-b', 'main', seed]); await ok(['-C', seed, 'config', 'user.name', 'Test']); await ok(['-C', seed, 'config', 'user.email', 'test@example.com']);
  await writeFile(join(seed, 'file.txt'), 'base\n'); await ok(['-C', seed, 'add', '.']); await ok(['-C', seed, 'commit', '-m', 'base']);
  await ok(['-C', seed, 'push', upstream, 'main']); await ok(['--git-dir', upstream, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  const upstreamAuthentication: string[] = [];
  const upstreamServer = createServer((req, res) => {
    const expected = `Basic ${Buffer.from('x-access-token:SECRET-UPSTREAM-TOKEN').toString('base64')}`;
    if (req.headers.authorization !== expected) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm=\"Upstream\"' }).end(); return; }
    upstreamAuthentication.push(req.headers.authorization);
    const chunks: Buffer[] = [];
    req.on('data', d => chunks.push(Buffer.from(d))); req.on('end', () => {
      const url = new URL(req.url!, 'http://localhost');
      const child = spawn('git', ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: directory, GIT_HTTP_EXPORT_ALL: '1',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'], CONTENT_LENGTH: String(Buffer.concat(chunks).length), REMOTE_USER: 'test' } });
      const output: Buffer[] = []; child.stdout.on('data', d => output.push(Buffer.from(d))); child.stderr.resume(); child.stdin.end(Buffer.concat(chunks));
      child.on('close', () => {
        const result = Buffer.concat(output), split = result.indexOf('\r\n\r\n');
        for (const header of result.subarray(0, split).toString().split('\r\n')) if (/^Content-Type:/i.test(header)) res.setHeader('Content-Type', header.slice(header.indexOf(':') + 1).trim());
        res.end(result.subarray(split + 4));
      });
    });
  });
  const upstreamURL = await listen(upstreamServer);
  const { store, api, db } = await storage();
  let current = session(); const authorize = vi.fn(async () => undefined);
  const gateway = new GitGateway(store, { getSession: async () => current, authorizeSession: authorize }); await gateway.start(); cleanups.push(() => gateway.close());
  // Replace only upstream location inside the server-owned environment; all production Git mechanics and hooks run unchanged.
  type WithAuth = { withAuth<T>(s: Session, token: string, action: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> };
  const subject = gateway as unknown as WithAuth; const original = subject.withAuth.bind(gateway);
  vi.spyOn(subject, 'withAuth').mockImplementation((s, token, action) => original(s, token, env => action({ ...env, EP_UPSTREAM: `${upstreamURL}/upstream.git` })));
  const app = express(); app.use('/gateway', gateway.router); const url = await listen(createServer(app));
  const capability = await store.issue(current), authorization = `Authorization: Basic ${Buffer.from(`x-access-token:${capability}`).toString('base64')}`;
  const work = join(directory, 'work'); const remote = `${url}/gateway/git/${current.id}.git`;
  await ok(['-c', `http.extraHeader=${authorization}`, 'clone', remote, work]);
  await ok(['-C', work, 'config', 'http.extraHeader', authorization]); await ok(['-C', work, 'config', 'user.name', 'Test']); await ok(['-C', work, 'config', 'user.email', 'test@example.com']);
  return { directory, upstream, upstreamAuthentication, work, gateway, store, api, db, remote, capability, authorize, current, setCurrent: (s: Session) => { current = s; } };
}

describe('GitHub credentials and API scope', () => {
  it('encrypts authenticated records, binds them to session context, and signs a valid App JWT', () => {
    const ciphertext = encrypt('secret', key, 'session-a'); expect(ciphertext).not.toContain('secret'); expect(decrypt(ciphertext, key, 'session-a')).toBe('secret');
    expect(() => decrypt(ciphertext, key, 'session-b')).toThrow(); expect(() => decrypt(ciphertext, Buffer.alloc(32), 'session-a')).toThrow();
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwt = appJWT('42', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 1_000_000);
    const [head, body, signature] = jwt.split('.'); expect(verify('RSA-SHA256', Buffer.from(`${head}.${body}`), publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()); expect(payload.exp - payload.iat).toBe(600); expect(payload.iss).toBe('42');
  });
  it('stores only gateway hashes and encrypted upstream tokens, disables before revocation, retries failures', async () => {
    const { db, api, store } = await storage(); const s = session(), capability = await store.issue(s);
    expect(await store.enabled(s.id, capability)).toBe(true); expect(await store.enabled(s.id, 'wrong')).toBe(false);
    await store.token(s);
    const records = JSON.stringify((await db.query('SELECT * FROM github_installation_tokens')).rows);
    const credentials = JSON.stringify((await db.query('SELECT * FROM github_gateway_credentials')).rows);
    expect(records).not.toContain('SECRET-UPSTREAM-TOKEN'); expect(credentials).not.toContain(capability);
    await store.disable(s.id); expect(await store.enabled(s.id, capability)).toBe(false);
    vi.mocked(api.revoke).mockRejectedValueOnce(new Error('offline'));
    await expect(store.revoke(s.id)).rejects.toThrow('pending');
    expect((await db.query<{ status: string }>('SELECT status FROM github_installation_tokens')).rows[0].status).toBe('revoke_pending');
    await store.revoke(s.id); expect((await db.query<{ ciphertext: string | null }>('SELECT ciphertext FROM github_installation_tokens')).rows[0].ciphertext).toBeNull();
  });
  it('retains unknown issuance uncertainty until the upstream token lifetime has passed', async () => {
    const { db, api, store } = await storage(); const s = session(); await store.issue(s);
    vi.mocked(api.installationToken).mockRejectedValueOnce(new Error('remote response lost'));
    await expect(store.token(s)).rejects.toThrow('remote response lost');
    await expect(store.token(s)).rejects.toThrow('issuance is uncertain');
    expect(api.installationToken).toHaveBeenCalledTimes(1);
    await store.disable(s.id);
    await expect(store.revoke(s.id)).rejects.toThrow('pending');
    await db.query('UPDATE github_token_issuance SET uncertainty_until=$1', [new Date(Date.now() - 1).toISOString()]);
    await expect(store.revoke(s.id)).resolves.toBeUndefined();
  });
  it('preserves issuance uncertainty when durable token storage and compensation both fail', async () => {
    const { db, api, store } = await storage(); const s = session(); await store.issue(s);
    const query = db.query.bind(db);
    vi.spyOn(db, 'query').mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('INSERT INTO github_installation_tokens')) throw new Error('database write lost');
      return query(sql, params);
    });
    vi.mocked(api.revoke).mockRejectedValueOnce(new Error('revocation unavailable'));
    await expect(store.token(s)).rejects.toThrow('database write lost'); await store.disable(s.id);
    await expect(store.revoke(s.id)).rejects.toThrow('pending');
    expect((await query('SELECT * FROM github_token_issuance')).rows).toHaveLength(1);
  });
  it('rotates expiring tokens and preserves failed old-token revocation for retry', async () => {
    const { db, api, store } = await storage(); const s = session(); await store.issue(s); await store.token(s);
    await db.query('UPDATE github_installation_tokens SET expires_at=$1', [new Date(Date.now() + 60_000).toISOString()]);
    vi.mocked(api.installationToken).mockResolvedValueOnce({ token: 'NEW-TOKEN', expires_at: new Date(Date.now() + 3600000).toISOString() });
    vi.mocked(api.revoke).mockRejectedValueOnce(new Error('offline'));
    expect(await store.token(s)).toBe('NEW-TOKEN');
    expect((await db.query<{ status: string }>('SELECT status FROM github_installation_tokens')).rows.map(r => r.status)).toContain('revoke_pending');
    await store.retryRotated(); expect((await db.query<{ status: string }>('SELECT status FROM github_installation_tokens')).rows.map(r => r.status)).not.toContain('revoke_pending');
  });
  it('lists only this App installations and repositories where this user can push', async () => {
    const api = new GitHubAPI('42', 'unused', 'ephemeral');
    const request = vi.spyOn(api, 'request').mockResolvedValueOnce({ installations: [{ id: 2, app_id: 42, app_slug: 'ephemeral', suspended_at: null }, { id: 3, app_id: 9, suspended_at: null }] })
      .mockResolvedValueOnce({ repositories: [{ id: 1, full_name: 'owner/repo', default_branch: 'main', permissions: { push: true } }, { id: 2, full_name: 'owner/read', default_branch: 'main', permissions: { push: false } }] });
    expect(await api.repositories('USER-TOKEN')).toEqual([{ id: 1, fullName: 'owner/repo', defaultBranch: 'main', installationId: 2 }]);
    expect(request).toHaveBeenLastCalledWith('/user/installations/2/repositories?per_page=100&page=1', 'USER-TOKEN');
  });
  it('scopes installation issuance to one repository and narrow permissions', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const api = new GitHubAPI('42', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'ephemeral');
    const request = vi.spyOn(api, 'request').mockResolvedValue({ token: 'a', expires_at: 'b' }); await api.installationToken(session());
    expect(request.mock.calls[0][3]).toEqual({ repository_ids: [1], permissions: { contents: 'write', pull_requests: 'write' } });
  });
});

describe('real Git smart HTTP gateway', () => {
  it('anchors a new continuation branch to its reviewed source after main advances while retaining ref and ancestry restrictions', async () => {
    const f = await fixture();
    const sourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const sourceBranch = `ephemeral/${sourceId}`;
    const base = await ok(['-C', f.work, 'rev-parse', 'HEAD']);
    await ok(['-C', f.work, 'checkout', '-b', sourceBranch]);
    await writeFile(join(f.work, 'file.txt'), 'published source\n'); await ok(['-C', f.work, 'commit', '-am', 'published source']);
    const reviewed = await ok(['-C', f.work, 'rev-parse', 'HEAD']);
    await ok(['-C', f.work, 'push', f.upstream, `HEAD:refs/heads/${sourceBranch}`]);
    await ok(['-C', f.work, 'checkout', 'main']);
    await writeFile(join(f.work, 'file.txt'), 'advanced main\n'); await ok(['-C', f.work, 'commit', '-am', 'advance main']);
    await ok(['-C', f.work, 'push', f.upstream, 'main']);
    const advancedMain = await ok(['-C', f.work, 'rev-parse', 'HEAD']);
    f.setCurrent({ ...f.current, continuation: { sourceSessionId: sourceId, sourceBranch, commitSha: reviewed, verifiedAt: new Date().toISOString() } });
    await ok(['-C', f.work, 'checkout', '-b', f.current.branch, base]);
    const unrelated = await git(['-C', f.work, 'push', 'origin', `HEAD:refs/heads/${f.current.branch}`]);
    expect(unrelated.code).not.toBe(0);
    expect((await git(['--git-dir', f.upstream, 'show-ref', '--verify', `refs/heads/${f.current.branch}`])).code).not.toBe(0);
    await ok(['-C', f.work, 'reset', '--hard', reviewed]);
    await writeFile(join(f.work, 'file.txt'), 'continued work\n'); await ok(['-C', f.work, 'commit', '-am', 'continued work']);
    const continued = await ok(['-C', f.work, 'rev-parse', 'HEAD']);
    const sourcePush = await git(['-C', f.work, 'push', 'origin', `HEAD:refs/heads/${sourceBranch}`]);
    expect(sourcePush.code).not.toBe(0);
    await ok(['-C', f.work, 'push', 'origin', `HEAD:refs/heads/${f.current.branch}`]);
    expect(await ok(['--git-dir', f.upstream, 'rev-parse', f.current.branch])).toBe(continued);
    expect(await ok(['--git-dir', f.upstream, 'rev-parse', sourceBranch])).toBe(reviewed);
    expect(await ok(['--git-dir', f.upstream, 'rev-parse', 'main'])).toBe(advancedMain);
  }, 60_000);

  it('clones, pushes the assigned branch to upstream, and rejects multi-ref, deletion, tags, and force pushes', async () => {
    const f = await fixture(); expect(f.upstreamAuthentication.length).toBeGreaterThan(0); const main = await ok(['--git-dir', f.upstream, 'rev-parse', 'main']);
    await ok(['-C', f.work, 'checkout', '-b', f.current.branch]); await writeFile(join(f.work, 'file.txt'), 'session\n');
    await ok(['-C', f.work, 'commit', '-am', 'session']); const commit = await ok(['-C', f.work, 'rev-parse', 'HEAD']);
    await ok(['-C', f.work, 'push', 'origin', `HEAD:refs/heads/${f.current.branch}`]);
    expect(await ok(['--git-dir', f.upstream, 'rev-parse', f.current.branch])).toBe(commit);
    expect(await ok(['--git-dir', f.upstream, 'rev-parse', 'main'])).toBe(main);
    await writeFile(join(f.work, 'file.txt'), 'next\n'); await ok(['-C', f.work, 'commit', '-am', 'next']);
    const multi = await git(['-C', f.work, 'push', 'origin', `HEAD:refs/heads/${f.current.branch}`, 'HEAD:refs/heads/main']);
    expect(multi.code).not.toBe(0); expect(await ok(['--git-dir', f.upstream, 'rev-parse', f.current.branch])).toBe(commit); expect(await ok(['--git-dir', f.upstream, 'rev-parse', 'main'])).toBe(main);
    expect((await git(['-C', f.work, 'push', 'origin', `:refs/heads/${f.current.branch}`])).code).not.toBe(0);
    expect((await git(['-C', f.work, 'push', 'origin', 'HEAD:refs/tags/malicious'])).code).not.toBe(0);
    expect((await git(['-C', f.work, 'push', '--force', 'origin', `main:refs/heads/${f.current.branch}`])).code).not.toBe(0);
    expect(await ok(['--git-dir', f.upstream, 'rev-parse', f.current.branch])).toBe(commit);
  }, 60_000);
  it('propagates upstream push rejection to the git client', async () => {
    const f = await fixture(); await writeFile(join(f.upstream, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    await ok(['-C', f.work, 'checkout', '-b', f.current.branch]);
    const result = await git(['-C', f.work, 'push', 'origin', `HEAD:refs/heads/${f.current.branch}`]);
    expect(result.code).not.toBe(0); expect(result.err).toContain('upstream push rejected');
    expect((await git(['--git-dir', f.upstream, 'rev-parse', `refs/heads/${f.current.branch}`])).code).not.toBe(0);
  }, 60_000);
  it('denies expired and disabled credentials and refreshed user authorization; rejects route traversal', async () => {
    const f = await fixture(); const headers = { Authorization: `Basic ${Buffer.from(`x-access-token:${f.capability}`).toString('base64')}` };
    const discovery = `${f.remote}/info/refs?service=git-upload-pack`;
    f.setCurrent({ ...f.current, state: 'provisioning' });
    expect((await fetch(discovery, { headers })).status).toBe(200);
    expect((await fetch(`${f.remote}/info/refs?service=git-receive-pack`, { headers })).status).toBe(403);
    f.setCurrent({ ...f.current, expiresAt: new Date(Date.now() - 1).toISOString() }); expect((await fetch(discovery, { headers })).status).toBe(403);
    f.setCurrent(f.current); f.authorize.mockRejectedValueOnce(new GitHubError('User repository access revoked', 403)); expect((await fetch(discovery, { headers })).status).toBe(403);
    await f.gateway.disable(f.current.id); expect((await fetch(discovery, { headers })).status).toBe(401);
    expect((await fetch(`${f.remote}/%2e%2e/config`, { headers })).status).toBe(404);
    expect((await f.store.disks()).length).toBe(0);
  }, 60_000);
});
