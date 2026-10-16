import { afterEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvironmentCatalog, EnvironmentProfile, EnvironmentRef } from '../shared/environments.js';
import type { CreateSessionInput, Database, Session, SessionRepository } from '../server/contracts.js';
import { environmentProfileRevision, loadEnvironmentCatalog } from '../server/environments.js';
import { createSessionRepository } from '../server/core/repository.js';
import { SessionNotCreatedError } from '../server/core/provisioning.js';
import { createGitHubLaunchController } from '../server/github-launch.js';
import { continuationPreview, createContinuationController } from '../server/continuation.js';
import { createHandoffNotesService } from '../server/handoff-notes.js';

const close: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of close.splice(0).reverse()) await action(); });
const sha = 'a'.repeat(40), url = 'https://github.com/owner/repo';
const catalog = () => loadEnvironmentCatalog({ mode: 'preview', templateId: '' });
const ref = (profile: EnvironmentProfile): EnvironmentRef => ({ id: profile.id, revision: profile.revision });
const source = (): Session => {
  const id = randomUUID(); return { id, userId: '42', repository: 'owner/repo', repositoryId: 1, installationId: 2, branch: `ephemeral/${id}`,
    baseBranch: 'main', state: 'ended', createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(), maxExpiresAt: new Date().toISOString(),
    sandboxId: null, endedAt: new Date().toISOString(), error: null, codexRemoteRevocation: 'unverified',
    cleanup: { vm: 'confirmed', github: 'confirmed', gateway: 'confirmed', codex: 'not_applicable' } };
};
async function fixture(kind: 'url' | 'continuation', disk = false) {
  const directory = disk ? await mkdtemp(join(tmpdir(), 'ep-env-intent-')) : undefined;
  if (directory) close.push(() => rm(directory, { recursive: true, force: true }));
  let db = new PGlite(directory), repo = await createSessionRepository(db as unknown as Database);
  close.push(() => db.close());
  const s = source(); await repo.insert(s);
  const manager = { create: vi.fn(async (input: CreateSessionInput, options?: { id?: string }): Promise<Session> => {
    const id = options!.id!, target: Session = { ...s, ...input, id, branch: `ephemeral/${id}`, state: 'provisioning', endedAt: null };
    await repo.insert(target); return target;
  }) };
  const github = {
    authorizeGitHubLaunch: vi.fn(async () => ({ id: 1, installationId: 2, fullName: 'owner/repo', defaultBranch: 'main' })),
    githubLaunchPreview: vi.fn(async () => ({ url, kind: 'repository' as const, ref: 'main', commitSha: sha, baseBranch: 'main', checkedAt: new Date().toISOString(), repository: 'owner/repo', repositoryId: 1, installationId: 2, simulated: false })),
    authorizeContinuation: vi.fn(async () => {}), continuationPreview: vi.fn(async (session: Session) => ({ ...continuationPreview(session, 'ready', null), commitSha: sha })),
  };
  let urlController: Awaited<ReturnType<typeof createGitHubLaunchController>> | undefined;
  async function controller(profiles: EnvironmentCatalog) {
    if (kind === 'url') {
      urlController = await createGitHubLaunchController(db as unknown as Database, repo, manager, github, profiles);
      const current = urlController;
      return (request: string, environment?: EnvironmentRef) => current.launch('42', 'current-oauth', url, sha, 'main', request, 1, 2, environment);
    }
    const notes = await createHandoffNotesService(db as unknown as Database, repo);
    const current = await createContinuationController(db as unknown as Database, repo, manager, github, async () => [], notes, profiles);
    return (request: string, environment?: EnvironmentRef) => current.continue(s, 'current-oauth', sha, request, 0, environment);
  }
  close.push(async () => urlController?.close());
  const profiles = catalog(), selected = profiles.profiles[1], launch = await controller(profiles);
  return { manager, github, profiles, selected, launch, controller, source: s,
    repository: () => repo, database: () => db,
    async restart(profiles: EnvironmentCatalog) {
      await urlController?.close(); await db.close(); db = new PGlite(directory);
      repo = await createSessionRepository(db as unknown as Database); return controller(profiles);
    },
    async row() { return (await db.query<{ status: string; environment: EnvironmentProfile; target_id: string }>(`SELECT * FROM ${kind === 'url' ? 'ephemeral_github_launch_requests' : 'ephemeral_continuation_requests'}`)).rows; },
  };
}

describe.each(['url', 'continuation'] as const)('durable %s environment selection', kind => {
  it('persists the selected trusted snapshot and replays the same target, with immutable selection presence', async () => {
    const f = await fixture(kind), request = randomUUID(), selected = ref(f.selected);
    const target = await f.launch(request, selected);
    expect(target.environment).toEqual(f.selected); expect((await f.row())[0].environment).toEqual(f.selected);
    expect((await f.launch(request, selected)).id).toBe(target.id);
    for (const changed of [undefined, ref(f.profiles.profiles[0]), { ...selected, revision: 'f'.repeat(64) }]) {
      await expect(f.launch(request, changed)).rejects.toMatchObject({ status: 409, code: undefined, outcome: undefined });
    }
    expect(f.manager.create).toHaveBeenCalledTimes(1);
  });
  it('rejects unknown, stale and injected profiles before reserving or creating, so a corrected selection can use the same UUID', async () => {
    const f = await fixture(kind), request = randomUUID();
    for (const bad of [{ id: 'removed', revision: f.selected.revision }, { ...ref(f.selected), revision: 'f'.repeat(64) },
      { ...ref(f.selected), templateRef: 'attacker:v1' }, f.selected, null]) {
      await expect(f.launch(request, bad as EnvironmentRef)).rejects.toMatchObject({ status: 409, outcome: 'not_created', code: kind === 'url' ? 'GITHUB_LAUNCH_REJECTED' : 'CONTINUATION_REJECTED' });
      expect(await f.row()).toHaveLength(0); expect(f.manager.create).not.toHaveBeenCalled();
    }
    expect((await f.launch(request, ref(f.selected))).environment).toEqual(f.selected);
  });
  it('recovers original persisted target after actual database restart and removal from the catalog, after current authorization', async () => {
    const f = await fixture(kind, true), request = randomUUID(), selected = ref(f.selected);
    const target = await f.launch(request, selected);
    const reopened = await f.restart({ defaultId: 'default', profiles: [] });
    expect(await reopened(request, selected)).toEqual(target); expect(f.manager.create).toHaveBeenCalledTimes(1);
    const authorization = kind === 'url' ? f.github.authorizeGitHubLaunch : f.github.authorizeContinuation;
    expect(authorization).toHaveBeenCalled(); authorization.mockRejectedValueOnce(new Error('Access revoked'));
    await expect(reopened(request, selected)).rejects.toThrow('Access revoked');
  });
  it('keeps an ambiguous absent target creating after restart/catalog removal and never creates a replacement', async () => {
    const f = await fixture(kind, true), request = randomUUID(), selected = ref(f.selected);
    f.manager.create.mockRejectedValueOnce(new Error('Unknown insert outcome'));
    await expect(f.launch(request, selected)).rejects.toThrow();
    const [original] = await f.row(); expect(original.status).toBe('creating');
    const reopened = await f.restart({ defaultId: 'default', profiles: [] });
    const error = await reopened(request, selected).catch((error: unknown) => error);
    expect(error).toMatchObject({ status: 409 }); expect(error).not.toHaveProperty('outcome'); expect(error).not.toHaveProperty('code');
    expect(await f.row()).toEqual([original]); expect(f.manager.create).toHaveBeenCalledTimes(1);
  });
  it('keeps a reserved original selection when the same catalog ID changes and resumes only when that exact snapshot is allowed', async () => {
    const f = await fixture(kind), request = randomUUID(), selected = ref(f.selected);
    f.manager.create.mockRejectedValueOnce(new SessionNotCreatedError('An active session exists'));
    await expect(f.launch(request, selected)).rejects.toMatchObject({ status: 409, outcome: 'not_created' });
    const [original] = await f.row(); expect(original.status).toBe('reserved');
    const changed = { ...f.selected, templateRef: 'preview-node:v2' };
    changed.revision = environmentProfileRevision(changed);
    const reopened = await f.controller({ defaultId: 'default', profiles: [changed] });
    await expect(reopened(request, selected)).rejects.toMatchObject({ status: 409 });
    expect(await f.row()).toEqual([original]); expect(f.manager.create).toHaveBeenCalledTimes(1);
    const restored = await f.controller(f.profiles), target = await restored(request, selected);
    expect(target.id).toBe(original.target_id); expect(target.environment).toEqual(f.selected);
  });
  it('reuses the same snapshot after an ambiguous create and does not downgrade uncertainty on a later proven preinsert error', async () => {
    const f = await fixture(kind), request = randomUUID(), selected = ref(f.selected);
    f.manager.create.mockRejectedValueOnce(new Error('Unknown insert outcome')).mockRejectedValueOnce(new SessionNotCreatedError('An active session exists'));
    await expect(f.launch(request, selected)).rejects.toThrow();
    const [original] = await f.row();
    await expect(f.launch(request, selected)).rejects.toMatchObject({ status: 409, outcome: undefined });
    expect(await f.row()).toEqual([original]);
    expect((await f.launch(request, selected)).environment).toEqual(f.selected);
    expect(f.manager.create.mock.calls.every(([input, options]) => input.environment?.revision === selected.revision && options!.id === original.target_id)).toBe(true);
  });
  it('recovers a committed insert with a lost acknowledgement and refuses environment tampering', async () => {
    const f = await fixture(kind), request = randomUUID(), selected = ref(f.selected), originalCreate = f.manager.create.getMockImplementation()!;
    f.manager.create.mockImplementationOnce(async (input, options) => { await originalCreate(input, options); throw new Error('Lost acknowledgement'); });
    const target = await f.launch(request, selected); expect(target.environment).toEqual(f.selected);
    await f.repository().update({ ...target, environment: f.profiles.profiles[0] });
    await expect(f.launch(request, selected)).rejects.toMatchObject({ status: 409 });
    expect(f.manager.create).toHaveBeenCalledTimes(1);
  });
  it('preserves legacy absence and refuses to add an explicit default to an old intent', async () => {
    const f = await fixture(kind), request = randomUUID(); const target = await f.launch(request);
    expect(target).not.toHaveProperty('environment'); expect((await f.row())[0].environment).toBeNull();
    const reopened = await f.controller({ defaultId: 'default', profiles: [] });
    expect((await reopened(request)).id).toBe(target.id);
    await expect(reopened(request, ref(f.profiles.profiles[0]))).rejects.toMatchObject({ status: 409 });
  });
});
