import { expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database, Session } from '../server/contracts.js';
import { GitAnchors } from '../server/github/anchors.js';

it('retains exact clone provenance and completion through an actual database close and reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ep-anchor-db-'));
  let db = new PGlite(directory);
  const session: Session = { id: 'durable-anchor', userId: 'user', createdAt: '2026-10-15T00:00:00.000Z',
    repository: 'owner/repository', repositoryId: 1, installationId: 2, branch: 'ephemeral/durable-anchor', baseBranch: 'main',
    state: 'running', expiresAt: '2026-10-15T01:00:00.000Z', maxExpiresAt: '2026-10-15T01:00:00.000Z',
    sandboxId: null, endedAt: null, error: null, codexRemoteRevocation: 'unverified',
    cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' } };
  try {
    let anchors = new GitAnchors(db as unknown as Database); await anchors.migrate();
    const first = 'a'.repeat(40), competing = 'b'.repeat(40);
    expect(await anchors.capture(session, first)).toBe(first);
    await db.close();
    db = new PGlite(directory); anchors = new GitAnchors(db as unknown as Database); await anchors.migrate();
    expect(await anchors.get(session)).toBe(first);
    expect(await anchors.cloneComplete(session)).toBe(false);
    expect(await anchors.capture(session, competing)).toBe(first);
    await anchors.complete(session); await db.close();
    db = new PGlite(directory); anchors = new GitAnchors(db as unknown as Database); await anchors.migrate();
    expect(await anchors.get(session)).toBe(first);
    expect(await anchors.cloneComplete(session)).toBe(true);
    await expect(anchors.capture({ ...session, installationId: 3 }, competing)).rejects.toThrow('session identity');
    expect(await anchors.get(session)).toBe(first);
  } finally { await db.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
