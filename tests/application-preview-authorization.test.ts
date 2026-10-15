import { describe, expect, it, vi } from 'vitest';
import { createPreviewAuthorizationCache } from '../server/application-preview-authorization.js';
import type { Session } from '../server/contracts.js';
const session = { id: 'session', userId: 'owner', repository: 'owner/repo', repositoryId: 1, installationId: 2, sandboxId: 'vm' } as Session;
describe('bounded private preview repository permission cache', () => {
  it('shares pending verification, expires successful results within ten seconds and revokes them', async () => {
    let now = 100, complete!: () => void;
    const authorize = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; })).mockResolvedValue(undefined);
    const cache = createPreviewAuthorizationCache(authorize, 60_000, () => now);
    const first = cache.authorize(session, 'hash'), second = cache.authorize(session, 'hash'); await Promise.resolve(); expect(authorize).toHaveBeenCalledTimes(1);
    complete(); await Promise.all([first, second]); await cache.authorize(session, 'hash'); expect(authorize).toHaveBeenCalledTimes(1);
    now += 10_001; await cache.authorize(session, 'hash'); expect(authorize).toHaveBeenCalledTimes(2);
    cache.revoke(session.id); await cache.authorize(session, 'hash'); expect(authorize).toHaveBeenCalledTimes(3);
  });
  it('scopes results to the exact browser, owner, session, repository, installation and sandbox', async () => {
    const authorize = vi.fn().mockResolvedValue(undefined), cache = createPreviewAuthorizationCache(authorize);
    await cache.authorize(session, 'first'); await cache.authorize(session, 'second');
    for (const changes of [{ userId: 'other' }, { id: 'other' }, { repository: 'owner/other' }, { repositoryId: 9 }, { installationId: 9 }, { sandboxId: 'replacement' }]) await cache.authorize({ ...session, ...changes }, 'first');
    expect(authorize).toHaveBeenCalledTimes(8);
  });
  it('never caches failure and caps retained entries at 256', async () => {
    const authorize = vi.fn().mockRejectedValueOnce(new Error('revoked')).mockResolvedValue(undefined), cache = createPreviewAuthorizationCache(authorize);
    await expect(cache.authorize(session, 'failed')).rejects.toThrow('revoked'); await cache.authorize(session, 'failed'); expect(authorize).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 256; i++) await cache.authorize({ ...session, id: `session-${i}` }, 'hash');
    await cache.authorize(session, 'failed'); expect(authorize).toHaveBeenCalledTimes(259);
  });
});
