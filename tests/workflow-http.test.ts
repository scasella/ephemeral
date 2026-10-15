import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { createPullRequestRepository } from '../server/github/pull-requests.js';
import type { Session } from '../server/contracts.js';

describe('work and PR endpoint ownership and lifecycle', () => {
  let application: Awaited<ReturnType<typeof createApplication>>, directory: string, origin: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ep-work-http-test-'));
    application = await createApplication(readConfig({ EPHEMERAL_MODE: 'preview', DATA_DIR: directory, PORT: '4320' }));
    await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve));
    const address = application.server.address(); if (!address || typeof address === 'string') throw new Error('No server address');
    origin = `http://127.0.0.1:${address.port}`;
  }, 30000);
  afterAll(async () => { await application?.close(); await rm(directory, { recursive: true, force: true }); }, 30000);
  async function insert(id: string, userId = 'preview-user', state: Session['state'] = 'ended') {
    const session: Session = { id, userId, repository: 'owner/repo', repositoryId: 1, installationId: 2, branch: `ephemeral/${id}`, baseBranch: 'main', state,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), maxExpiresAt: new Date(Date.now() + 3600000).toISOString(),
      sandboxId: null, endedAt: state === 'ended' ? new Date().toISOString() : null, error: null,
      cleanup: { vm: 'not_applicable', github: 'not_applicable', gateway: 'not_applicable', codex: 'not_applicable' }, codexRemoteRevocation: 'unverified' };
    await application.repo.insert(session); return session;
  }
  it('checks ownership for all read and create endpoints', async () => {
    const session = await insert('foreign', 'someone-else');
    for (const suffix of ['work-status', 'pull-request-preview', 'pull-requests']) expect((await fetch(`${origin}/api/sessions/${session.id}/${suffix}`)).status).toBe(404);
    expect((await fetch(`${origin}/api/sessions/${session.id}/pull-request`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1' }, body: JSON.stringify({ title: 'test' }) })).status).toBe(404);
  });
  it('returns honest unavailable status in preview without generating a PR', async () => {
    const session = await insert('preview-provisioning', 'preview-user', 'provisioning');
    const status = await fetch(`${origin}/api/sessions/${session.id}/work-status`).then(r => r.json());
    expect(status).toMatchObject({ state: 'unavailable', dirtyFiles: null, remoteSha: null });
    const preview = await fetch(`${origin}/api/sessions/${session.id}/pull-request-preview`).then(r => r.json());
    expect(preview).toMatchObject({ state: 'unavailable', headSha: null, aheadCommits: null });
    expect(await fetch(`${origin}/api/sessions/${session.id}/pull-requests`).then(r => r.json())).toEqual([]);
  });
  it('retains authorized links when ended while work inspection stays unavailable', async () => {
    const session = await insert('ended-with-pr');
    const records = await createPullRequestRepository(application.db);
    const pr = { url: 'https://github.com/owner/repo/pull/7', number: 7, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), headBranch: session.branch, baseBranch: 'main', createdAt: new Date().toISOString() };
    await records.save(session.id, pr);
    expect(await fetch(`${origin}/api/sessions/${session.id}/pull-requests`).then(r => r.json())).toEqual([pr]);
    expect((await fetch(`${origin}/api/sessions/${session.id}/work-status`).then(r => r.json())).state).toBe('unavailable');
  });
});
