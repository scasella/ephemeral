import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createApplication } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { digest, seal } from '../server/auth/crypto.js';
import { GitHubAPI } from '../server/github/api.js';
import type { Session } from '../server/contracts.js';
import { createLiveApplication } from './helpers/create-live-application.js';

const stubs = vi.hoisted(() => ({ authorize: vi.fn(), createPullRequest: vi.fn(), ensureShell: vi.fn() }));
vi.mock('../server/auth/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/auth/index.js')>();
  return { ...actual, createAuth: async (...args: Parameters<typeof actual.createAuth>) => ({ ...await actual.createAuth(...args), authorizeSession: stubs.authorize }) };
});
vi.mock('../server/github/index.js', async () => {
  const { Router } = await import('express'); const { previewCredentials } = await import('../server/preview.js');
  return { createGitHubServices: async () => ({ router: Router(), credentials: previewCredentials, createPullRequest: stubs.createPullRequest }) };
});
vi.mock('../server/infra/e2b.js', async () => {
  const { PreviewProvider } = await import('../server/preview.js');
  return { E2BProvider: class extends PreviewProvider { ensureShell = stubs.ensureShell; async exists() { return true; } } };
});

const key = Buffer.alloc(32, 1).toString('base64');
const headers = { 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1', Cookie: 'ephemeral=validation-owner' };
const head = 'a'.repeat(64), base = 'b'.repeat(64);
const pr = (body: string, title = 'Review changes') => ({ title, body, expectedHeadSha: head, expectedBaseSha: base });
const setup = (label: string) => ({ label, command: 'npm test', timeoutSeconds: 5 });
const byteLimit = 256 * 1024;
// Escape every string code unit, including keys, to exercise JSON's largest
// usual UTF-8 representation without changing the decoded schema values.
const escapedJson = (input: Record<string, string>) => {
  const quote = (value: string) => `"${value.split('').map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}"`;
  return `{${Object.entries(input).map(([name, value]) => `${quote(name)}:${quote(value)}`).join(',')}}`;
};

describe('JSON transport and metadata validation over actual HTTP', () => {
  let application: Awaited<ReturnType<typeof createApplication>>, directory: string, origin: string, session: Session;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ep-request-validation-'));
    const config = readConfig({ EPHEMERAL_MODE: 'preview', DATA_DIR: directory, PUBLIC_URL: 'http://localhost:4357', ENCRYPTION_KEY: key, ALLOWED_GITHUB_IDS: '42' });
    application = await createLiveApplication({ ...config, mode: 'live' });
    await new Promise<void>((resolve, reject) => {
      application.server.once('error', reject);
      application.server.listen(0, '127.0.0.1', () => { application.server.off('error', reject); resolve(); });
    });
    const address = application.server.address(); if (!address || typeof address === 'string') throw new Error('No address');
    origin = `http://127.0.0.1:${address.port}`;
    await application.db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
      [digest('validation-owner'), '42', 'owner', '', seal('private-browser-credential', key), new Date(Date.now() + 3600_000).toISOString()]);
  }, 30_000);
  afterAll(async () => { await application?.close(); if (directory) await rm(directory, { recursive: true, force: true }); }, 30_000);
  beforeEach(async () => {
    vi.clearAllMocks(); stubs.authorize.mockResolvedValue(undefined); stubs.ensureShell.mockResolvedValue('open');
    stubs.createPullRequest.mockResolvedValue({ url: 'https://github.com/owner/repo/pull/1' });
    await application.db.query("UPDATE ephemeral_sessions SET state='ended',data=jsonb_set(data,'{state}','\"ended\"'::jsonb) WHERE user_id=$1", ['42']);
    const id = randomUUID(), now = new Date().toISOString();
    session = { id, userId: '42', repository: 'owner/repo', repositoryId: 1, installationId: 2, baseBranch: 'main', branch: `ephemeral/${id}`,
      state: 'running', createdAt: now, expiresAt: new Date(Date.now() + 3600_000).toISOString(), maxExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
      sandboxId: 'synthetic-vm', endedAt: null, error: null, cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified' };
    await application.repo.insert(session);
    await application.db.query('DELETE FROM repository_setup_recipes');
  });
  const request = (suffix: string, body: string | Buffer, extra = {}, method = 'POST') => fetch(`${origin}/api/sessions/${session.id}/${suffix}`, {
    method, headers: { ...headers, ...extra }, body: typeof body === 'string' ? body : new Uint8Array(body),
  });
  const saveSetup = (label: string) => request('setup', JSON.stringify(setup(label)), {}, 'PUT');

  it('passes maximum CJK, emoji and fully escaped PR strings to the PR service unchanged', async () => {
    for (const input of [pr('界'.repeat(20_000), '界'.repeat(240)), pr('🚀'.repeat(20_000), '🚀'.repeat(240))]) {
      for (const encoded of [JSON.stringify(input), escapedJson(input)]) {
        expect(Buffer.byteLength(encoded)).toBeGreaterThan(32 * 1024);
        expect(Buffer.byteLength(encoded)).toBeLessThan(byteLimit);
        const response = await request('pull-request', encoded);
        expect(response.status).toBe(200); expect(await response.json()).toEqual({ url: 'https://github.com/owner/repo/pull/1' });
        expect(stubs.createPullRequest).toHaveBeenLastCalledWith(session, input.title, input.body, head, base);
      }
    }
    expect(stubs.createPullRequest).toHaveBeenCalledTimes(4);
  });

  it('admits a UTF-8 body at the byte cap and returns a fixed 413 one byte over it without route effects', async () => {
    const input = pr('review'), encoded = JSON.stringify(input);
    const exact = encoded + ' '.repeat(byteLimit - Buffer.byteLength(encoded));
    expect((await request('pull-request', exact)).status).toBe(200);
    stubs.createPullRequest.mockClear(); stubs.authorize.mockClear();
    const response = await request('pull-request', exact + ' ');
    expect(response.status).toBe(413); expect(await response.json()).toEqual({ error: 'JSON request body is too large' });
    expect(stubs.authorize).not.toHaveBeenCalled(); expect(stubs.createPullRequest).not.toHaveBeenCalled();
  });

  it('carries the largest escaped PR through the real API title guard and metadata validation', async () => {
    const api = new GitHubAPI('42', 'unused', 'app'), input = pr('🚀'.repeat(20_000), '🚀'.repeat(240));
    const upstream = vi.spyOn(api, 'request').mockResolvedValue({ number: 1, html_url: 'https://github.com/owner/repo/pull/1', created_at: session.createdAt,
      head: { sha: head, ref: session.branch, repo: { id: session.repositoryId } }, base: { sha: base, ref: session.baseBranch, repo: { id: session.repositoryId } } });
    stubs.createPullRequest.mockImplementation((current, title, body) => api.pullRequest(current, 'synthetic-token', title, body));
    const response = await request('pull-request', escapedJson(input));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ url: 'https://github.com/owner/repo/pull/1', headSha: head, baseSha: base });
    expect(upstream).toHaveBeenCalledExactlyOnceWith('/repos/owner/repo/pulls', 'synthetic-token', 'POST', {
      title: input.title, body: input.body, head: session.branch, base: session.baseBranch, draft: true,
    });
    await expect(api.pullRequest(session, 'synthetic-token', '🚀'.repeat(257), input.body)).rejects.toMatchObject({ status: 400 });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('bounds inflated JSON, preserves valid gzip, and sanitizes corrupt or unsupported encodings', async () => {
    const input = pr('界'.repeat(20_000));
    expect((await request('pull-request', gzipSync(JSON.stringify(input)), { 'Content-Encoding': 'gzip', 'Content-Type': 'application/json; charset="UTF-8"' })).status).toBe(200);
    expect(stubs.createPullRequest).toHaveBeenCalledWith(session, input.title, input.body, head, base);
    stubs.createPullRequest.mockClear(); stubs.authorize.mockClear();
    const oversized = await request('pull-request', gzipSync(JSON.stringify(pr('private-request-value'.repeat(byteLimit)))), { 'Content-Encoding': 'gzip' });
    expect(oversized.status).toBe(413); expect(await oversized.json()).toEqual({ error: 'JSON request body is too large' });
    const corrupt = await request('pull-request', Buffer.from('private compressed request detail'), { 'Content-Encoding': 'gzip' });
    expect(corrupt.status).toBe(400); expect(await corrupt.json()).toEqual({ error: 'Invalid JSON request body' });
    for (const extra of [{ 'Content-Encoding': 'private-encoding-detail' }, { 'Content-Type': 'application/json; charset=iso-8859-1' },
      { 'Content-Type': 'application/json; charset="UTF-16LE"' }, { 'Content-Type': 'application/json; charset=utf-32' }]) {
      const response = await request('pull-request', JSON.stringify(input), extra);
      expect(response.status).toBe(415); expect(await response.json()).toEqual({ error: 'Unsupported JSON request encoding' });
    }
    expect(stubs.authorize).not.toHaveBeenCalled(); expect(stubs.createPullRequest).not.toHaveBeenCalled();
  });

  it('returns safe 400 parse errors and retains schema limits beneath the transport cap', async () => {
    const malformed = await request('pull-request', '{"body":"private malformed input",');
    expect(malformed.status).toBe(400); expect(await malformed.json()).toEqual({ error: 'Invalid JSON request body' });
    for (const input of [pr('界'.repeat(20_001)), pr('🚀'.repeat(20_001)), pr('valid', '界'.repeat(241))]) {
      const response = await request('pull-request', JSON.stringify(input));
      expect(response.status).toBe(400); expect(await response.text()).not.toContain(input.body);
    }
    expect(stubs.authorize).not.toHaveBeenCalled(); expect(stubs.createPullRequest).not.toHaveBeenCalled();
  });

  it('rejects setup controls and unpaired surrogates before creating or replacing a saved recipe', async () => {
    const invalid = ['bad\0label', 'bad\tlabel', '\nlabel', 'label\r', 'bad\x7flabel', 'bad\u0085label', 'bad\u009flabel',
      'bad\ud800label', 'bad\udffflabel', 'bad\udfff\ud800label'];
    const response = await saveSetup(invalid[0]); expect(response.status).toBe(400);
    expect((await application.db.query('SELECT data FROM repository_setup_recipes')).rows).toHaveLength(0);
    const savedResponse = await saveSetup('Keep this recipe'); expect(savedResponse.status).toBe(200);
    const saved = (await application.db.query('SELECT data FROM repository_setup_recipes')).rows;
    stubs.authorize.mockClear();
    for (const label of [...invalid, '', '   ', 'x'.repeat(81)]) {
      const rejected = await saveSetup(label);
      expect(rejected.status, JSON.stringify(label)).toBe(400);
      expect(await rejected.text()).not.toContain('bad');
    }
    expect((await application.db.query('SELECT data FROM repository_setup_recipes')).rows).toEqual(saved);
    expect(stubs.authorize).not.toHaveBeenCalled();
    const nulCommand = await request('setup', JSON.stringify({ ...setup('Valid label'), command: 'echo\0private' }), {}, 'PUT');
    expect(nulCommand.status).toBe(400);
    expect((await application.db.query('SELECT data FROM repository_setup_recipes')).rows).toEqual(saved);
  });

  it('roundtrips trimmed Unicode setup, session and shell labels and preserves session clearing', async () => {
    const label = '準備 🚀 العربية e\u0301', padded = `  ${label}\u00a0`;
    const setupResponse = await saveSetup(padded); expect(setupResponse.status).toBe(200);
    expect((await setupResponse.json()).recipe.label).toBe(label);
    expect((await application.db.query<{ data: { label: string } }>('SELECT data FROM repository_setup_recipes')).rows[0].data.label).toBe(label);
    const sessionResponse = await request('label', JSON.stringify({ label: padded })); expect(sessionResponse.status).toBe(200);
    expect((await sessionResponse.json()).label).toBe(label); expect((await application.repo.get(session.id))?.label).toBe(label);
    const shellResponse = await request('shells', JSON.stringify({ requestId: randomUUID(), name: padded })); expect(shellResponse.status).toBe(200);
    expect((await shellResponse.json()).shells).toContainEqual(expect.objectContaining({ name: label }));
    for (const invalid of ['bad\tlabel', 'bad\u0085label', 'bad\ud800label', 'bad\udffflabel']) {
      expect((await request('label', JSON.stringify({ label: invalid }))).status).toBe(400);
      expect((await request('shells', JSON.stringify({ requestId: randomUUID(), name: invalid }))).status).toBe(400);
    }
    expect((await application.repo.get(session.id))?.label).toBe(label);
    const cleared = await request('label', JSON.stringify({ label: '   ' })); expect(cleared.status).toBe(200);
    expect((await cleared.json()).label).toBeUndefined(); expect((await application.repo.get(session.id))?.label).toBeUndefined();
  });

  it('preserves the 80-code-point limit through setup, session and shell persistence', async () => {
    const label = '🚀'.repeat(80), padded = `  ${label}  `;
    const recipe = await saveSetup(padded); expect(recipe.status).toBe(200); expect((await recipe.json()).recipe.label).toBe(label);
    expect((await request('label', JSON.stringify({ label: padded }))).status).toBe(200);
    expect((await application.repo.get(session.id))?.label).toBe(label);
    const created = await request('shells', JSON.stringify({ requestId: randomUUID(), name: padded })); expect(created.status).toBe(200);
    const shell = (await created.json()).shells.find((shell: { kind: string }) => shell.kind === 'supplemental');
    expect(shell.name).toBe(label);
    const renamed = await request(`shells/${shell.id}/name`, JSON.stringify({ name: `  ${'🌍'.repeat(80)}  ` })); expect(renamed.status).toBe(200);
    expect((await renamed.json()).shells).toContainEqual(expect.objectContaining({ id: shell.id, name: '🌍'.repeat(80) }));
    const tooLong = '🚀'.repeat(81);
    expect((await saveSetup(tooLong)).status).toBe(400);
    expect((await request('label', JSON.stringify({ label: tooLong }))).status).toBe(400);
    expect((await request(`shells/${shell.id}/name`, JSON.stringify({ name: tooLong }))).status).toBe(400);
    expect((await application.repo.get(session.id))?.label).toBe(label);
    expect((await application.db.query<{ data: { name: string } }>('SELECT data FROM session_shells WHERE id=$1', [shell.id])).rows[0].data.name).toBe('🌍'.repeat(80));
  });
});
