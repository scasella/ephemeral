import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/app.js';
import { createLiveApplication } from './helpers/create-live-application.js';
import { createFileOperationGate } from '../server/file-operations.js';
import { FileOperationError } from '../server/workspace-files.js';
import { readConfig } from '../server/config.js';
import { digest, seal } from '../server/auth/crypto.js';
import type { Session } from '../server/contracts.js';
import type { WorkspaceFile } from '../shared/workspace-files.js';

const stubs = vi.hoisted(() => ({ authorize: vi.fn(), list: vi.fn(), read: vi.fn(), write: vi.fn() }));
vi.mock('../server/auth/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/auth/index.js')>();
  return { ...actual, createAuth: async (...args: Parameters<typeof actual.createAuth>) => ({ ...await actual.createAuth(...args), authorizeSession: stubs.authorize }) };
});
vi.mock('../server/github/index.js', async () => {
  const { Router } = await import('express'); const { previewCredentials } = await import('../server/preview.js');
  return { createGitHubServices: async () => ({ router: Router(), credentials: previewCredentials, close: async () => {} }) };
});
vi.mock('../server/infra/e2b.js', async () => {
  const { PreviewProvider } = await import('../server/preview.js');
  return { E2BProvider: class extends PreviewProvider { listFiles = stubs.list; readFile = stubs.read; writeFile = stubs.write; async exists() { return true; } } };
});
const key = Buffer.alloc(32, 1).toString('base64');
const headers = { Cookie: 'ephemeral=changes-owner' };
const known: WorkspaceFile = { path: 'src/example.ts', content: 'hello\n', version: 'a'.repeat(64), simulation: false };
describe('workspace file HTTP boundaries', () => {
  let application: Awaited<ReturnType<typeof createApplication>>, preview: Awaited<ReturnType<typeof createApplication>>;
  let directory: string, origin: string, previewOrigin: string;
  let clock: ReturnType<typeof vi.spyOn>;
  beforeAll(async () => {
    clock = vi.spyOn(Date, 'now');
    directory = await mkdtemp(join(tmpdir(), 'ep-files-http-'));
    const config = readConfig({ EPHEMERAL_MODE: 'preview', DATA_DIR: directory, PUBLIC_URL: 'http://localhost:4355', ENCRYPTION_KEY: key, ALLOWED_GITHUB_IDS: '42,99' });
    application = await createLiveApplication({ ...config, mode: 'live' }, { fileOperationTimeoutMs: 250 });
    preview = await createApplication(config);
    for (const app of [application, preview]) await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const url = (app: typeof application) => { const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('No address'); return `http://127.0.0.1:${address.port}`; };
    origin = url(application); previewOrigin = url(preview);
    for (const [cookie, expires] of [['changes-owner', Date.now() + 3600_000], ['expired-changes-owner', Date.now() - 100]] as const) {
      await application.db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
        [digest(cookie), '42', 'owner', '', seal('credential', key), new Date(expires).toISOString()]);
    }
    await application.db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
      [digest('changes-other'), '99', 'other', '', seal('credential', key), new Date(Date.now() + 3600_000).toISOString()]);
    await application.db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
      [digest('files-uninvited'), '100', 'uninvited', '', seal('credential', key), new Date(Date.now() + 3600_000).toISOString()]);
  }, 30_000);
  afterAll(async () => { await application?.close(); await preview?.close(); if (directory) await rm(directory, { recursive: true, force: true }); clock.mockRestore(); }, 30_000);
  beforeEach(async () => {
    vi.clearAllMocks(); stubs.authorize.mockReset().mockResolvedValue(undefined); stubs.read.mockReset().mockResolvedValue(known); stubs.write.mockReset().mockImplementation(async (_session, input) => ({ path: input.path, content: input.content, version: known.version, simulation: false })); stubs.list.mockReset().mockImplementation(async (_session, path) => ({ path, entries: [], truncated: false, simulation: false }));
    clock.mockReturnValue(Date.now() + 60_000);
    await application.db.query('UPDATE browser_sessions SET expires_at=$2 WHERE hash=$1', [digest('changes-owner'), new Date(Date.now() + 3600_000).toISOString()]);
  });
  async function saved(changes: Partial<Session> = {}, app = application) {
    const id = randomUUID(), now = new Date().toISOString();
    const session: Session = { id, userId: '42', repository: 'owner/repo', repositoryId: 1, installationId: 2, baseBranch: 'main', branch: `ephemeral/${id}`,
      state: 'running', createdAt: now, expiresAt: new Date(Date.now() + 3600_000).toISOString(), maxExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
      sandboxId: 'fake-vm', endedAt: null, error: null, cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified', ...changes };
    await app.db.query("UPDATE ephemeral_sessions SET state='ended',data=jsonb_set(data,'{state}','\"ended\"'::jsonb) WHERE user_id=$1", [session.userId]);
    await app.repo.insert(session); return session;
  }
  const request = (id: string, query = '?path=src%2Fexample.ts', extra = {}, base = origin, endpoint = 'file') => fetch(`${base}/api/sessions/${id}/${endpoint}${query}`, { headers: { ...headers, ...extra } });
  const put = (id: string, body: unknown = { ...known, simulation: undefined, version: undefined, expectedVersion: known.version }, extra = {}, base = origin) => fetch(`${base}/api/sessions/${id}/file`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1', ...extra }, body: JSON.stringify(body) });
  it('lists root and nested folders, reads files, and saves conditional and create-only writes', async () => {
    const s = await saved();
    expect((await request(s.id, '', {}, origin, 'files')).status).toBe(200);
    expect(stubs.list).toHaveBeenLastCalledWith(s, '');
    expect((await request(s.id, '?path=src', {}, origin, 'files')).status).toBe(200);
    expect(stubs.list).toHaveBeenLastCalledWith(s, 'src');
    const response = await request(s.id); expect(await response.json()).toEqual(known); expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await put(s.id)).status).toBe(200);
    expect(stubs.write).toHaveBeenLastCalledWith(s, { path: known.path, content: known.content, expectedVersion: known.version });
    expect((await put(s.id, { path: 'new.txt', content: '', expectedVersion: null })).status).toBe(200);
    expect(stubs.write).toHaveBeenLastCalledWith(s, { path: 'new.txt', content: '', expectedVersion: null });
    expect(stubs.authorize).toHaveBeenCalledTimes(10);
  });
  it('requires identity, ownership, allowlist, origin and mutation intent before any provider call', async () => {
    const s = await saved();
    for (const Cookie of ['', 'ephemeral=expired-changes-owner', 'ephemeral=files-uninvited']) expect((await request(s.id, undefined, { Cookie })).status).toBe(401);
    expect((await request(s.id, undefined, { Cookie: 'ephemeral=changes-other' })).status).toBe(404);
    expect((await request(randomUUID())).status).toBe(404);
    for (const extra of [{ Origin: 'https://evil.test' }, { 'Sec-Fetch-Site': 'cross-site' }]) expect((await request(s.id, undefined, extra)).status).toBe(403);
    expect((await put(s.id, undefined, { 'X-Ephemeral-Request': '' })).status).toBe(403);
    expect(stubs.authorize).not.toHaveBeenCalled(); expect(stubs.read).not.toHaveBeenCalled(); expect(stubs.write).not.toHaveBeenCalled();
  });
  it('rejects missing, duplicate, unknown and unsafe paths and write query keys', async () => {
    const s = await saved();
    for (const query of ['', '?other=1', '?path=x&path=y', '?path[]=x', '?path=x&extra=y',
      ...['', '../secret', '/etc/passwd', 'src/../x', './src', 'src//x', 'src/', '.git/config', 'src/.git/x', 'a\\b', 'a\0b', 'C:/x', 'é'.repeat(513), Array(34).fill('x').join('/')].map(path => `?path=${encodeURIComponent(path)}`)]) {
      const response = await request(s.id, query); expect(response.status, query).toBe(400); expect(response.headers.get('cache-control')).toBe('no-store');
    }
    const response = await fetch(`${origin}/api/sessions/${s.id}/file?path=x`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1' }, body: JSON.stringify({ path: 'x', content: '', expectedVersion: null }) });
    expect(response.status).toBe(400); expect(stubs.authorize).not.toHaveBeenCalled(); expect(stubs.read).not.toHaveBeenCalled();
  });
  it('strictly validates write shapes, UTF8 size, binary contents and JSON transport', async () => {
    const s = await saved();
    for (const body of [{}, [], null, { path: 'x', content: '' }, { path: 'x', content: '', expectedVersion: 'a'.repeat(40) },
      { path: 'x', content: '', expectedVersion: null, extra: true }, { path: '../x', content: '', expectedVersion: null }]) expect((await put(s.id, body)).status).toBe(400);
    expect((await put(s.id, { path: 'x', content: 'é'.repeat(65537), expectedVersion: null })).status).toBe(413);
    expect((await put(s.id, { path: 'x', content: 'binary\0', expectedVersion: null })).status).toBe(415);
    const bad = await fetch(`${origin}/api/sessions/${s.id}/file`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1' }, body: '{secret' });
    expect(bad.status).toBe(400); expect(await bad.text()).not.toContain('secret');
    expect(stubs.write).not.toHaveBeenCalled();
  });
  it('accepts a maximally escaped valid-size file and rejects oversized transport', async () => {
    const s = await saved();
    const escaped = JSON.stringify({ path: 'x', content: '', expectedVersion: null }).replace('"content":""', '"content":"' + '\\u0061'.repeat(131072) + '"');
    const send = (body: string) => fetch(`${origin}/api/sessions/${s.id}/file`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1' }, body });
    expect((await send(escaped)).status).toBe(200); expect(stubs.write.mock.calls[0][1].content.length).toBe(131072);
    const tooLarge = await send(' '.repeat(820000)); expect(tooLarge.status).toBe(413); expect(tooLarge.headers.get('cache-control')).toBe('no-store');
  });
  it('refuses ended, expired, invalid-expiry and replaced workspaces', async () => {
    for (const changes of [{ state: 'ended' as const }, { state: 'provisioning' as const }, { expiresAt: 'invalid' }, { maxExpiresAt: 'invalid' }, { maxExpiresAt: new Date(Date.now() - 1).toISOString() }, { expiresAt: new Date(Date.now() - 1).toISOString() }, { sandboxId: null }]) {
      const s = await saved(changes); expect((await request(s.id)).status).toBe(503);
    }
    const s = await saved(); stubs.authorize.mockImplementationOnce(async () => { await application.repo.update({ ...s, sandboxId: 'new' }); });
    expect((await put(s.id)).status).toBe(503); expect(stubs.read).not.toHaveBeenCalled(); expect(stubs.write).not.toHaveBeenCalled();
  });
  it('sanitizes authorization and provider errors and returns safe conflict/binary/size status', async () => {
    const s = await saved(); stubs.authorize.mockRejectedValueOnce(new Error('Bearer SECRET'));
    const denied = await request(s.id); expect(denied.status).toBe(403); expect(await denied.text()).not.toContain('SECRET'); expect(stubs.read).not.toHaveBeenCalled();
    stubs.read.mockRejectedValueOnce(new Error('SDK SECRET /etc/private')); const failed = await request(s.id); expect(failed.status).toBe(503); expect(await failed.text()).not.toContain('SECRET');
    for (const [status, code] of [[409, 'conflict'], [415, 'binary'], [413, 'too_large']] as const) {
      stubs.write.mockRejectedValueOnce(new FileOperationError(status, code)); const response = await put(s.id); expect(response.status).toBe(status); expect(await response.json()).toMatchObject({ code });
    }
  });
  it('discards content and reports unknown save outcome if final access fails', async () => {
    const s = await saved(); stubs.authorize.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked SECRET'));
    const read = await request(s.id); expect(read.status).toBe(403); expect(await read.text()).not.toContain('hello');
    stubs.authorize.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked SECRET'));
    const write = await put(s.id); expect(write.status).toBe(403); expect(await write.json()).toMatchObject({ code: 'access_denied', outcome: 'unknown' });
    stubs.authorize.mockResolvedValue(undefined); stubs.write.mockRejectedValueOnce(new Error('SDK SECRET'));
    const unknown = await put(s.id); expect(unknown.status).toBe(503); expect(await unknown.json()).toMatchObject({ code: 'outcome_unknown', outcome: 'unknown' });
  });
  it('rechecks current browser credentials and lifecycle after operations and final authorization', async () => {
    for (const phase of ['provider', 'authorization'] as const) {
      const s = await saved();
      const end = async () => { await application.repo.update({ ...s, state: 'ended' }); return known; };
      if (phase === 'provider') stubs.read.mockImplementationOnce(end);
      else stubs.authorize.mockResolvedValueOnce(undefined).mockImplementationOnce(end);
      const response = await request(s.id); expect(response.status).toBe(503); expect(await response.text()).not.toContain('hello');
    }
    const s = await saved(); stubs.read.mockImplementationOnce(async () => { await application.db.query('UPDATE browser_sessions SET credential=$2 WHERE hash=$1', [digest('changes-owner'), seal('rotated', key)]); return known; });
    const response = await request(s.id); expect(response.status).toBe(401); expect(await response.text()).not.toContain('hello');
  });
  it('rejects invalid provider results without leaking file contents or unsafe entries', async () => {
    const s = await saved();
    for (const result of [{ ...known, path: 'other' }, { ...known, simulation: true }, { ...known, version: 'bad' }, { ...known, content: 'SECRET\0' }]) {
      stubs.read.mockResolvedValueOnce(result); const response = await request(s.id); expect(response.status).toBe(503); expect(await response.text()).not.toContain('SECRET');
    }
    stubs.list.mockResolvedValueOnce({ path: '', entries: [{ path: '../SECRET', name: 'SECRET', kind: 'file' }], truncated: false, simulation: false });
    const directory = await request(s.id, '', {}, origin, 'files'); expect(directory.status).toBe(503); expect(await directory.text()).not.toContain('SECRET');
    stubs.write.mockRejectedValueOnce(new FileOperationError(503, 'unavailable'));
    expect(await put(s.id).then(response => response.json())).toMatchObject({ code: 'unavailable', outcome: 'unknown' });
  });
  it('clearly labels simulated preview files and skips real GitHub access', async () => {
    const s = await saved({ userId: 'preview-user' }, preview);
    const listing = await request(s.id, '', {}, previewOrigin, 'files'); expect(listing.status).toBe(200); expect(await listing.json()).toMatchObject({ simulation: true });
    const read = await request(s.id, '?path=README.md', {}, previewOrigin); expect(read.status).toBe(200);
    const file = await read.json() as WorkspaceFile; expect(file.simulation).toBe(true);
    const updated = await put(s.id, { path: file.path, content: 'Edited in preview\n', expectedVersion: file.version }, {}, previewOrigin);
    expect(updated.status).toBe(200); expect(await updated.json()).toMatchObject({ content: 'Edited in preview\n', simulation: true });
    const stale = await put(s.id, { path: file.path, content: 'stale', expectedVersion: file.version }, {}, previewOrigin); expect(stale.status).toBe(409);
    const created = await put(s.id, { path: 'new.txt', content: 'New simulated file', expectedVersion: null }, {}, previewOrigin); expect(created.status).toBe(200);
    expect((await put(s.id, { path: 'new.txt', content: 'collision', expectedVersion: null }, {}, previewOrigin)).status).toBe(409);
    expect(await request(s.id, '?path=new.txt', {}, previewOrigin).then(response => response.json())).toMatchObject({ content: 'New simulated file', simulation: true });
    expect(stubs.authorize).not.toHaveBeenCalled(); expect(stubs.list).not.toHaveBeenCalled();
  });
  it('bounds pending requests and preserves admission until timed-out underlying work settles', async () => {
    const s = await saved(); let complete!: (value: WorkspaceFile) => void;
    stubs.write.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const first = put(s.id); await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    const busy = await request(s.id); expect(busy.status).toBe(429); expect(busy.headers.get('retry-after')).toBe('1');
    const timeout = await first; expect(timeout.status).toBe(503); expect(await timeout.json()).toMatchObject({ code: 'outcome_unknown', outcome: 'unknown' });
    expect((await request(s.id)).status).toBe(429);
    complete(known); await new Promise(resolve => setTimeout(resolve, 20)); expect((await request(s.id)).status).toBe(200);
  });
  it('drains a pending provider operation before releasing database ownership at shutdown', async () => {
    const s = await saved(); let complete!: (value: WorkspaceFile) => void;
    stubs.read.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const requestResult = request(s.id).catch(() => null);
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    let closed = false; const closing = application.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); expect(closed).toBe(false);
    complete(known); await closing; await requestResult; expect(closed).toBe(true);
  });
});

it('bounds file admission globally, per session, per user, bookkeeping and closure', () => {
  const gate = createFileOperationGate(() => 1);
  const releases = Array.from({ length: 4 }, (_, i) => gate.acquire(`owner-${i}`, `session-${i}`));
  expect(releases.every(Boolean)).toBe(true); expect(gate.acquire('fifth', 'fifth')).toBeNull(); expect(gate.acquire('owner-0', 'session-0')).toBeNull(); releases.forEach(release => release!());
  const burst = createFileOperationGate(() => 1);
  for (let i = 0; i < 32; i++) burst.acquire('owner', 'session')!();
  expect(burst.acquire('owner', 'session')).toBeNull();
  for (let i = 1; i < 256; i++) burst.acquire(`owner-${i}`, 'session')!();
  expect(burst.acquire('new-owner', 'session')).toBeNull();
  gate.close(); expect(gate.acquire('owner', 'session')).toBeNull();
});
