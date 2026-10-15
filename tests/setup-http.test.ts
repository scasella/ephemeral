import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/app.js';
import { createLiveApplication } from './helpers/create-live-application.js';
import { readConfig } from '../server/config.js';
import { digest, seal } from '../server/auth/crypto.js';
import type { Session } from '../server/contracts.js';

const stubs = vi.hoisted(() => ({ authorize: vi.fn(), run: vi.fn() }));
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
  return { E2BProvider: class extends PreviewProvider { runSetup = stubs.run; async exists() { return true; } } };
});

const headers = { 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1', Cookie: 'ephemeral=owner-browser' };
const input = { label: 'Setup and test', command: 'npm ci && npm test', timeoutSeconds: 5 };

describe('repository setup HTTP boundary', () => {
  let application: Awaited<ReturnType<typeof createApplication>>, directory: string, origin: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ep-setup-http-'));
    const key = Buffer.alloc(32, 1).toString('base64');
    const config = readConfig({ EPHEMERAL_MODE: 'preview', DATA_DIR: directory, PUBLIC_URL: 'http://localhost:4327', ENCRYPTION_KEY: key, ALLOWED_GITHUB_IDS: '42,99' });
    application = await createLiveApplication({ ...config, mode: 'live' });
    await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve));
    const address = application.server.address(); if (!address || typeof address === 'string') throw new Error('No server address'); origin = `http://127.0.0.1:${address.port}`;
    await application.db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
      [digest('owner-browser'), '42', 'owner', '', seal('test-credential', key), new Date(Date.now() + 3600_000).toISOString()]);
    await application.db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
      [digest('second-browser'), '99', 'second', '', seal('test-credential', key), new Date(Date.now() + 3600_000).toISOString()]);
  }, 30_000);
  afterAll(async () => { await application?.close(); await rm(directory, { recursive: true, force: true }); }, 30_000);
  beforeEach(() => { stubs.authorize.mockReset().mockResolvedValue(undefined); stubs.run.mockReset().mockResolvedValue({ status: 'succeeded', exitCode: 0 }); });
  async function insert(id: string, changes: Partial<Session> = {}) {
    const s: Session = { id, userId: '42', repository: 'owner/repo', repositoryId: 1, installationId: 2, baseBranch: 'main', branch: `ephemeral/${id}`, state: 'running',
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(), maxExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      sandboxId: `preview-${id}`, endedAt: null, error: null, cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified', ...changes };
    await application.db.query("UPDATE ephemeral_sessions SET state='ended',data=jsonb_set(data,'{state}','\"ended\"'::jsonb) WHERE user_id=$1", [s.userId]);
    await application.repo.insert(s); return s;
  }
  const request = (id: string, method = 'GET', body?: unknown, extra = {}, suffix = '') => fetch(`${origin}/api/sessions/${id}/setup${suffix}`, { method, headers: { ...headers, ...extra }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

  it('requires authenticated ownership for reads, saves, runs and cancellation', async () => {
    const s = await insert('foreign', { userId: '99' });
    expect((await request(s.id, 'GET', undefined, { Cookie: '' })).status).toBe(401);
    expect((await request(s.id)).status).toBe(404);
    expect((await request(s.id, 'PUT', input)).status).toBe(404);
    expect((await request(s.id, 'POST', { recipeVersion: '00000000-0000-4000-8000-000000000000' }, {}, '/runs')).status).toBe(404);
    expect((await request(s.id, 'POST', {}, {}, '/runs/00000000-0000-4000-8000-000000000000/cancel')).status).toBe(404);
    expect(stubs.authorize).not.toHaveBeenCalled(); expect(stubs.run).not.toHaveBeenCalled();
  });

  it('enforces same origin, verification header, strict schemas, and bounded command/timeout fields', async () => {
    const s = await insert('validation');
    expect((await request(s.id, 'PUT', input, { Origin: 'https://evil.test' })).status).toBe(403);
    expect((await request(s.id, 'PUT', input, { 'X-Ephemeral-Request': '' })).status).toBe(403);
    for (const body of [{ ...input, timeoutSeconds: 0 }, { ...input, timeoutSeconds: 601 }, { ...input, timeoutSeconds: 5.5 }, { ...input, command: '' },
      { ...input, command: 'x'.repeat(8193) }, { ...input, command: 'echo\0private' }, { ...input, unknown: true }, []]) expect((await request(s.id, 'PUT', body)).status).toBe(400);
    expect(stubs.authorize).not.toHaveBeenCalled(); expect(stubs.run).not.toHaveBeenCalled();
  });

  it('saves only on explicit request, rejects stale reviewed versions, and exposes a retained completed run', async () => {
    const s = await insert('http-success');
    const saved = await request(s.id, 'PUT', input).then(r => r.json()); expect(saved).toMatchObject({ recipe: input, run: null, mode: 'live' }); expect(stubs.run).not.toHaveBeenCalled();
    const changed = await request(s.id, 'PUT', { ...input, command: 'npm test' }).then(r => r.json());
    expect((await request(s.id, 'POST', { recipeVersion: saved.recipe.version }, {}, '/runs')).status).toBe(409);
    const started = await request(s.id, 'POST', { recipeVersion: changed.recipe.version }, {}, '/runs'); expect(started.status).toBe(202);
    await vi.waitFor(async () => expect((await request(s.id).then(r => r.json())).run?.status).toBe('succeeded'));
    await application.repo.update({ ...s, state: 'ended' });
    const retained = await request(s.id).then(r => r.json()); expect(retained.run.recipe.command).toBe('npm test'); expect(retained.run.exitCode).toBe(0);
    expect((await request(s.id, 'PUT', input)).status).toBe(409);
    expect((await request(s.id, 'POST', { recipeVersion: changed.recipe.version }, {}, '/runs')).status).toBe(409);
  });

  it('projects only redacted retained output while a split credential is in flight and after clipping', async () => {
    const s = await insert('http-redaction'), secret = randomBytes(32).toString('hex');
    let emit!: (text: string) => void, finish!: () => void;
    stubs.run.mockImplementationOnce((_session, _input, onOutput) => {
      emit = onOutput; return new Promise(resolve => { finish = () => resolve({ status: 'succeeded', exitCode: 0 }); });
    });
    const saved = await request(s.id, 'PUT', input).then(r => r.json());
    expect((await request(s.id, 'POST', { recipeVersion: saved.recipe.version }, {}, '/runs')).status).toBe(202);
    await vi.waitFor(() => expect(emit).toBeTypeOf('function'));
    emit('safe progress\n{"id_token":"' + secret.slice(0, 18));
    let projection: { run: { output: string; truncated: boolean; recipe: { command: string } } };
    await vi.waitFor(async () => {
      projection = await request(s.id).then(r => r.json());
      expect(projection.run.output.includes('safe progress')).toBe(true);
    }, { timeout: 5000 });
    expect(JSON.stringify(projection!).includes(secret.slice(0, 8))).toBe(false);
    emit('\x1b['); emit('0m' + secret.slice(18) + '"}\n');
    emit('x'.repeat(65520) + '\n{"refresh_token":"' + secret.slice(0, 14));
    emit(secret.slice(14) + '"}\n'); emit('final failure detail without newline'); finish();
    await vi.waitFor(async () => expect((await request(s.id).then(r => r.json())).run?.status).toBe('succeeded'));
    projection = await request(s.id).then(r => r.json());
    const stored = await application.db.query<{ data: { output: string } }>('SELECT data FROM session_setup_runs WHERE session_id=$1', [s.id]);
    expect(JSON.stringify(projection).includes(secret.slice(0, 8))).toBe(false);
    expect(stored.rows[0]!.data.output.includes(secret.slice(0, 8))).toBe(false);
    expect(projection.run.truncated).toBe(true);
    expect(Buffer.byteLength(projection.run.output)).toBeLessThanOrEqual(65536);
    expect(projection.run.output).toContain('safe progress');
    expect(projection.run.output).toContain('final failure detail without newline');
    expect(stored.rows[0]!.data.output).toBe(projection.run.output);
    expect(projection.run.recipe.command).toBe(input.command);
  });

  it('persists authorization failure before invocation and permits an explicit retry of that saved version', async () => {
    const s = await insert('http-prelaunch-retry');
    const saved = await request(s.id, 'PUT', input).then(r => r.json());
    stubs.authorize.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('private authorization detail'));
    const started = await request(s.id, 'POST', { recipeVersion: saved.recipe.version }, {}, '/runs');
    expect(started.status).toBe(202);
    await vi.waitFor(async () => expect((await request(s.id).then(r => r.json())).run?.status).toBe('failed'));
    const failed = await request(s.id).then(r => r.json());
    expect(failed.run).toMatchObject({ reason: 'authorization_failed', invocationStarted: false, blockedUntil: null, startedAt: null, exitCode: null });
    expect(failed.run.error).not.toContain('private authorization detail');
    expect(stubs.run).not.toHaveBeenCalled();
    const retry = await request(s.id, 'POST', { recipeVersion: saved.recipe.version }, {}, '/runs');
    expect(retry.status).toBe(202);
    await vi.waitFor(async () => expect((await request(s.id).then(r => r.json())).run?.status).toBe('succeeded'));
    const completed = await request(s.id).then(r => r.json());
    expect(completed.run.id).not.toBe(failed.run.id);
    expect(completed.run.recipe.version).toBe(saved.recipe.version);
    expect(stubs.run).toHaveBeenCalledTimes(1);
  });

  it('lets another session start while repository authorization is pending for one session', async () => {
    const first = await insert('http-queue-first');
    const second = await insert('http-queue-second', { userId: '99' });
    const secondHeaders = { Cookie: 'ephemeral=second-browser' };
    const savedFirst = await request(first.id, 'PUT', input).then(r => r.json());
    const savedSecond = await request(second.id, 'PUT', input, secondHeaders).then(r => r.json());
    let release!: () => void;
    const authorization = new Promise<void>(resolve => { release = resolve; });
    stubs.authorize.mockImplementation(async (s: Session) => { if (s.id === first.id) await authorization; });
    const pending = request(first.id, 'POST', { recipeVersion: savedFirst.recipe.version }, {}, '/runs');
    await vi.waitFor(() => expect(stubs.authorize).toHaveBeenCalledWith(expect.objectContaining({ id: first.id })));
    let secondResponse: Response | undefined;
    const independent = request(second.id, 'POST', { recipeVersion: savedSecond.recipe.version }, secondHeaders, '/runs').then(response => { secondResponse = response; });
    try {
      await vi.waitFor(() => expect(secondResponse?.status).toBe(202));
      await vi.waitFor(() => expect(stubs.run).toHaveBeenCalledWith(expect.objectContaining({ id: second.id }), expect.anything(), expect.any(Function), expect.any(AbortSignal)));
    } finally {
      release();
      await independent;
      expect((await pending).status).toBe(202);
    }
    await vi.waitFor(async () => expect((await request(first.id).then(r => r.json())).run?.status).toBe('succeeded'));
    await vi.waitFor(async () => expect((await request(second.id, 'GET', undefined, secondHeaders).then(r => r.json())).run?.status).toBe('succeeded'));
  });

  it('records an explicit user cancellation separately from stopping the machine', async () => {
    async function startAbortable(id: string) {
      const s = await insert(id);
      stubs.run.mockImplementationOnce((_session, _input, onOutput, signal: AbortSignal) => new Promise(resolve => {
        signal.addEventListener('abort', () => { onOutput('termination confirmed\n'); resolve({ status: 'cancelled', exitCode: null }); }, { once: true });
      }));
      const saved = await request(s.id, 'PUT', input).then(r => r.json());
      const started = await request(s.id, 'POST', { recipeVersion: saved.recipe.version }, {}, '/runs').then(r => r.json());
      await vi.waitFor(async () => expect((await request(s.id).then(r => r.json())).run?.status).toBe('running'));
      return { s, runId: started.run.id };
    }
    const user = await startAbortable('http-user-cancel');
    expect((await request(user.s.id, 'POST', {}, {}, `/runs/${user.runId}/cancel`)).status).toBe(200);
    await vi.waitFor(async () => expect((await request(user.s.id).then(r => r.json())).run?.status).toBe('cancelled'));
    const cancelled = await request(user.s.id).then(r => r.json());
    expect(cancelled.run).toMatchObject({ reason: 'user_cancelled', invocationStarted: true, blockedUntil: null, output: 'termination confirmed\n' });

    const ended = await startAbortable('http-session-stop');
    expect((await fetch(`${origin}/api/sessions/${ended.s.id}/stop`, { method: 'POST', headers, body: '{}' })).status).toBe(200);
    await vi.waitFor(async () => expect((await request(ended.s.id).then(r => r.json())).run?.finishedAt).toBeTruthy());
    expect((await request(ended.s.id).then(r => r.json())).run).toMatchObject({ status: 'interrupted', reason: 'session_ended', invocationStarted: true, blockedUntil: null });
  });

  it('retains the execution hold when provider completion is unknown and does not replay on status reads', async () => {
    const s = await insert('http-unconfirmed');
    const saved = await request(s.id, 'PUT', input).then(r => r.json());
    stubs.run.mockRejectedValueOnce(new Error('private transport failure'));
    expect((await request(s.id, 'POST', { recipeVersion: saved.recipe.version }, {}, '/runs')).status).toBe(202);
    await vi.waitFor(async () => expect((await request(s.id).then(r => r.json())).run?.status).toBe('interrupted'));
    const unknown = await request(s.id).then(r => r.json());
    expect(unknown.run).toMatchObject({ reason: 'completion_unconfirmed', invocationStarted: true });
    expect(Date.parse(unknown.run.blockedUntil)).toBeGreaterThan(Date.now());
    expect(unknown.run.error).not.toContain('private transport failure');
    expect((await request(s.id, 'POST', { recipeVersion: saved.recipe.version }, {}, '/runs')).status).toBe(409);
    expect((await request(s.id).then(r => r.json())).run.id).toBe(unknown.run.id);
    expect(stubs.run).toHaveBeenCalledTimes(1);
  });

  it('refuses access loss and lifecycle changes during authorization without launching a command', async () => {
    const s = await insert('auth-race'); const saved = await request(s.id, 'PUT', input).then(r => r.json());
    stubs.authorize.mockRejectedValueOnce(new Error('Repository access denied'));
    expect((await request(s.id, 'POST', { recipeVersion: saved.recipe.version }, {}, '/runs')).status).toBe(409);
    stubs.authorize.mockImplementationOnce(async () => { await application.repo.update({ ...s, state: 'ended' }); });
    expect((await request(s.id, 'POST', { recipeVersion: saved.recipe.version }, {}, '/runs')).status).toBe(409);
    expect(stubs.run).not.toHaveBeenCalled(); expect((await request(s.id).then(r => r.json())).run).toBeNull();
  });
});
