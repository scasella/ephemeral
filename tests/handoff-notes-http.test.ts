import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { digest, seal } from '../server/auth/crypto.js';
import type { Session } from '../server/contracts.js';
const operations = vi.hoisted(() => ({ issue: vi.fn(async () => 'unused-token'), create: vi.fn(async () => 'unused-vm') }));
vi.mock('../server/github/index.js', async () => {
  const { Router } = await import('express'); const { previewCredentials } = await import('../server/preview.js');
  return { createGitHubServices: async () => ({ router: Router(), credentials: { ...previewCredentials, issue: operations.issue }, close: async () => {} }) };
});
vi.mock('../server/infra/e2b.js', async () => {
  const { PreviewProvider } = await import('../server/preview.js');
  return { E2BProvider: class extends PreviewProvider { create = operations.create; } };
});
const key = Buffer.alloc(32, 1).toString('base64');
const headers = { 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1', Cookie: 'ephemeral=note-owner' };
const fields = { nextStep: 'Inspect checkout', unresolvedIssues: 'Retry race', verification: 'Unit tests only' };

describe('handoff note owner API', () => {
  let application: Awaited<ReturnType<typeof createApplication>>, directory: string, origin: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ep-note-http-'));
    const config = readConfig({ EPHEMERAL_MODE: 'preview', DATA_DIR: directory, PUBLIC_URL: 'http://localhost:4329', ENCRYPTION_KEY: key, ALLOWED_GITHUB_IDS: '42,99' });
    application = await createApplication({ ...config, mode: 'live' });
    await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve));
    const address = application.server.address(); if (!address || typeof address === 'string') throw new Error('No server address');
    origin = `http://127.0.0.1:${address.port}`;
    for (const [cookie, owner, expires] of [['note-owner', '42', Date.now() + 3600_000], ['note-other', '99', Date.now() + 3600_000],
      ['note-expired', '42', Date.now() - 1], ['note-disallowed', '123', Date.now() + 3600_000]] as const) {
      await application.db.query('INSERT INTO browser_sessions(hash,user_id,login,avatar_url,credential,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
        [digest(cookie), owner, 'owner', '', seal('OWNER-CREDENTIAL', key), new Date(expires).toISOString()]);
    }
  }, 30_000);
  afterAll(async () => { await application?.close(); if (directory) await rm(directory, { recursive: true, force: true }); }, 30_000);
  async function insert(state: Session['state'] = 'ended', userId = '42') {
    const id = randomUUID(), now = new Date().toISOString();
    const session: Session = { id, userId, repository: 'owner/repo', repositoryId: 1, installationId: 2,
      baseBranch: 'main', branch: `ephemeral/${id}`, state, createdAt: now,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), maxExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
      sandboxId: state === 'running' ? 'existing-vm' : null, endedAt: state === 'ended' ? now : null, error: null,
      cleanup: { vm: 'not_applicable', github: 'not_applicable', gateway: 'not_applicable', codex: 'not_applicable' }, codexRemoteRevocation: 'unverified' };
    await application.repo.insert(session); return session;
  }
  const get = (id: string, extra = {}) => fetch(`${origin}/api/sessions/${id}/handoff-notes`, { headers: { ...headers, ...extra } });
  const post = (id: string, body: unknown = { expectedRevision: 0, ...fields }, extra = {}) =>
    fetch(`${origin}/api/sessions/${id}/handoff-notes`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });

  it('requires current invited identity for read and write and hides foreign/missing sessions', async () => {
    const source = await insert();
    for (const Cookie of ['', 'ephemeral=note-expired', 'ephemeral=note-disallowed']) {
      expect((await get(source.id, { Cookie })).status).toBe(401);
      expect((await post(source.id, undefined, { Cookie })).status).toBe(401);
    }
    expect((await get(source.id, { Cookie: 'ephemeral=note-other' })).status).toBe(404);
    expect((await post(source.id, undefined, { Cookie: 'ephemeral=note-other' })).status).toBe(404);
    expect((await get(randomUUID())).status).toBe(404); expect((await post(randomUUID())).status).toBe(404);
    expect((await get(source.id).then(r => r.json())).note.revision).toBe(0);
  });
  it('requires same origin and mutation verification without changing content', async () => {
    const source = await insert();
    for (const extra of [{ Origin: 'https://evil.test' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'X-Ephemeral-Request': '' }]) {
      expect((await post(source.id, undefined, extra)).status).toBe(403);
    }
    expect((await get(source.id, { Origin: 'https://evil.test' })).status).toBe(403);
    expect((await get(source.id, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await get(source.id).then(r => r.json())).note.revision).toBe(0);
  });
  it('strictly validates literal fields and bounded revisions with no partial changes', async () => {
    const source = await insert();
    expect((await post(source.id)).status).toBe(200);
    for (const body of [{}, null, [], { expectedRevision: 1, nextStep: 'Only one field' },
      { expectedRevision: -1, ...fields }, { expectedRevision: 1.5, ...fields }, { expectedRevision: '1', ...fields },
      { expectedRevision: 2147483647, ...fields }, { expectedRevision: 1, ...fields, userId: '99' },
      { expectedRevision: 1, ...fields, command: 'execute this' },
      ...['nextStep', 'unresolvedIssues', 'verification'].flatMap(field => [null, 9, 'x'.repeat(2001), '\0', '\r', '\x01', '\x0b'].map(value => ({ expectedRevision: 1, ...fields, [field]: value })))]) {
      expect((await post(source.id, body)).status, JSON.stringify(body)).toBe(400);
    }
    const unchanged = await get(source.id).then(r => r.json());
    expect(unchanged.note).toMatchObject({ revision: 1, ...fields });
  });
  it('returns a stale conflict, recovers a successful lost reply, and allows explicit owner clearing', async () => {
    const source = await insert();
    const saved = await post(source.id, { expectedRevision: 0, ...fields, nextStep: '  <b>literal</b>\r\n\tgit status  ' }).then(r => r.json());
    expect(saved.note).toMatchObject({ revision: 1, nextStep: '<b>literal</b>\n\tgit status' });
    const stale = await post(source.id, { expectedRevision: 0, ...fields, nextStep: 'Overwrite' });
    expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: 'note_revision_conflict' });
    expect(await get(source.id).then(r => r.json())).toEqual(saved);
    const cleared = await post(source.id, { expectedRevision: 1, nextStep: ' ', unresolvedIssues: '', verification: '\t\n' });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).note).toMatchObject({ revision: 2, nextStep: '', unresolvedIssues: '', verification: '' });
  });
  it('allows notes across lifecycle states and keeps content out of sessions, lists, and events', async () => {
    for (const state of ['running', 'cleanup_pending', 'ended', 'failed'] as const) {
      const source = await insert(state);
      const response = await post(source.id); expect(response.status).toBe(200);
      expect((await get(source.id).then(r => r.json())).note).toMatchObject({ revision: 1, ...fields });
      const session = await fetch(`${origin}/api/sessions/${source.id}`, { headers }).then(r => r.json());
      expect(JSON.stringify(session)).not.toContain(fields.nextStep);
      expect(JSON.stringify(await fetch(`${origin}/api/sessions`, { headers }).then(r => r.json()))).not.toContain(fields.nextStep);
      expect(await fetch(`${origin}/api/sessions/${source.id}/events`, { headers }).then(r => r.json())).toEqual([]);
      await application.repo.update({ ...source, state: 'ended', sandboxId: null });
      expect((await get(source.id).then(r => r.json())).note).toMatchObject({ revision: 1, ...fields });
    }
    expect(operations.issue).not.toHaveBeenCalled(); expect(operations.create).not.toHaveBeenCalled();
  });
  it('only exposes inherited text to the target owner and with matching persisted continuation provenance', async () => {
    const source = await insert(), target = await insert();
    await post(source.id);
    await application.handoffNotes.capture({ userId: '42', sourceSessionId: source.id, targetSessionId: target.id, sourceBranch: source.branch, commitSha: 'a'.repeat(40), expectedNoteRevision: 1 });
    expect((await get(target.id).then(r => r.json())).inherited).toBeNull();
    const provenance = { sourceSessionId: source.id, sourceBranch: source.branch, commitSha: 'a'.repeat(40), verifiedAt: new Date().toISOString() };
    await application.repo.update({ ...target, continuation: provenance });
    const inherited = (await get(target.id).then(r => r.json())).inherited;
    expect(inherited).toMatchObject({ sourceSessionId: source.id, sourceBranch: source.branch, sourceNoteRevision: 1, sourceCommitSha: 'a'.repeat(40), ...fields });
    expect((await get(target.id, { Cookie: 'ephemeral=note-other' })).status).toBe(404);
    await application.repo.update({ ...target, continuation: { ...provenance, commitSha: 'b'.repeat(40) } });
    expect((await get(target.id).then(r => r.json())).inherited).toBeNull();
    await application.repo.update({ ...target, continuation: { ...provenance, sourceBranch: 'different-branch' } });
    expect((await get(target.id).then(r => r.json())).inherited).toBeNull();
    await application.repo.update({ ...target, continuation: { ...provenance, sourceSessionId: randomUUID() } });
    expect((await get(target.id).then(r => r.json())).inherited).toBeNull();
  });
});
