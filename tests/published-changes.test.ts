import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../server/contracts.js';
import { GitHubAPI } from '../server/github/api.js';
import { GitHubError } from '../server/github/security.js';
import { PUBLISHED_MAX_RESPONSE_BYTES, validatePublishedChangesQuery } from '../server/github/published-changes.js';

const baseSha = 'a'.repeat(40), headSha = 'b'.repeat(40), mergeSha = 'c'.repeat(40), movedSha = 'd'.repeat(40);
const session = (): Session => ({ id: 'session', userId: '42', repository: 'owner/repo', repositoryId: 1, installationId: 2,
  branch: 'ephemeral/session', baseBranch: 'release/next', state: 'ended', createdAt: '2026-10-14T00:00:00.000Z',
  expiresAt: '2026-10-14T00:00:00.000Z', maxExpiresAt: '2026-10-14T00:00:00.000Z', sandboxId: null,
  endedAt: '2026-10-14T00:00:00.000Z', error: null,
  cleanup: { vm: 'confirmed', github: 'confirmed', gateway: 'confirmed', codex: 'not_applicable' }, codexRemoteRevocation: 'unverified' });
const file = (extra: Record<string, unknown> = {}) => ({ filename: 'src/main.ts', status: 'modified', additions: 1, deletions: 1, changes: 2,
  patch: '@@ -1 +1 @@\n-old\n+new', ...extra });
const comparison = (extra: Record<string, unknown> = {}) => ({ status: 'ahead', ahead_by: 1, behind_by: 0,
  base_commit: { sha: baseSha }, merge_base_commit: { sha: baseSha }, files: [file()], ...extra });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const pair = { expectedHeadSha: headSha, expectedBaseSha: baseSha };
type Options = {
  comparison?: unknown; base?: unknown; head?: unknown; finalBase?: unknown; finalHead?: unknown;
  baseStatus?: number; headStatus?: number; finalBaseStatus?: number; finalHeadStatus?: number;
  compareResponse?: () => Response | Promise<Response>; repository?: unknown;
};
function fixture(options: Options = {}) {
  const api = new GitHubAPI('42', 'private-key-must-never-be-used', 'app'), s = session();
  const repositories = vi.spyOn(api, 'repositories').mockResolvedValue([{ id: 1, installationId: 2, fullName: 'owner/repo', defaultBranch: 'main' }]);
  const installationToken = vi.spyOn(api, 'installationToken');
  let baseReads = 0, headReads = 0;
  const baseRef = { ref: `refs/heads/${s.baseBranch}`, object: { type: 'commit', sha: baseSha } };
  const headRef = { ref: `refs/heads/${s.branch}`, object: { type: 'commit', sha: headSha } };
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/repos/owner/repo') return json(options.repository ?? { id: 1, full_name: 'owner/repo' });
    if (path === `/repos/owner/repo/git/ref/heads/${encodeURIComponent(s.baseBranch)}`) {
      baseReads++;
      return json(baseReads > 1 ? options.finalBase ?? options.base ?? baseRef : options.base ?? baseRef,
        baseReads > 1 ? options.finalBaseStatus ?? options.baseStatus ?? 200 : options.baseStatus ?? 200);
    }
    if (path === `/repos/owner/repo/git/ref/heads/${encodeURIComponent(s.branch)}`) {
      headReads++;
      return json(headReads > 1 ? options.finalHead ?? options.head ?? headRef : options.head ?? headRef,
        headReads > 1 ? options.finalHeadStatus ?? options.headStatus ?? 200 : options.headStatus ?? 200);
    }
    if (path.startsWith('/repos/owner/repo/compare/')) return options.compareResponse ? options.compareResponse() : json(options.comparison ?? comparison());
    throw new Error(`Unexpected network path: ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return { api, s, repositories, installationToken, fetcher };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('published GitHub comparison', () => {
  it('reads a pushed ended session using current OAuth GETs and exact base/head, with a locally built pinned link', async () => {
    const f = fixture();
    const result = await f.api.publishedChanges(f.s, 'CURRENT-OAUTH', { ...pair, path: 'src/main.ts' });
    expect(result).toMatchObject({ state: 'known', repository: 'owner/repo', baseBranch: 'release/next', headBranch: 'ephemeral/session',
      headSha, baseSha, mergeBaseSha: baseSha, aheadCommits: 1, behindCommits: 0, listTruncated: false,
      comparisonUrl: `https://github.com/owner/repo/compare/${baseSha}...${headSha}`,
      selected: { path: 'src/main.ts', state: 'patch', text: '@@ -1 +1 @@\n-old\n+new', truncated: false, reason: null } });
    expect(result.files).toEqual([{ path: 'src/main.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, changes: 2 }]);
    expect(Number.isFinite(Date.parse(result.checkedAt))).toBe(true);
    expect(f.repositories.mock.calls).toEqual([['CURRENT-OAUTH', expect.any(AbortSignal)], ['CURRENT-OAUTH', expect.any(AbortSignal)]]);
    expect(f.repositories.mock.invocationCallOrder[0]).toBeLessThan(f.fetcher.mock.invocationCallOrder[0]);
    expect(f.installationToken).not.toHaveBeenCalled();
    expect(f.fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.github.com/repos/owner/repo',
      'https://api.github.com/repos/owner/repo/git/ref/heads/release%2Fnext',
      'https://api.github.com/repos/owner/repo/git/ref/heads/ephemeral%2Fsession',
      `https://api.github.com/repos/owner/repo/compare/${baseSha}...${headSha}?per_page=1&page=1`,
      'https://api.github.com/repos/owner/repo/git/ref/heads/release%2Fnext',
      'https://api.github.com/repos/owner/repo/git/ref/heads/ephemeral%2Fsession',
    ]);
    for (const [, init] of f.fetcher.mock.calls) {
      expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('error'); expect(init?.body).toBeUndefined();
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer CURRENT-OAUTH', Accept: 'application/vnd.github+json' });
    }
  });
  it('uses the three-dot merge base when histories diverged, without replacing the fixed selected target base', async () => {
    const f = fixture({ comparison: comparison({ status: 'diverged', ahead_by: 2, behind_by: 3, merge_base_commit: { sha: mergeSha },
      html_url: 'https://evil.example/secret', files: [file({ filename: 'folder/space # + 日本語\\name.ts', status: 'renamed', previous_filename: 'old/name.ts' })] }) });
    const result = await f.api.publishedChanges(f.s, 'oauth', { ...pair, path: 'folder/space # + 日本語\\name.ts' });
    expect(result).toMatchObject({ state: 'known', baseSha, headSha, mergeBaseSha: mergeSha, aheadCommits: 2, behindCommits: 3,
      comparisonUrl: `https://github.com/owner/repo/compare/${baseSha}...${headSha}` });
    expect(result.files[0]).toMatchObject({ path: 'folder/space # + 日本語\\name.ts', previousPath: 'old/name.ts', status: 'renamed' });
    expect(JSON.stringify(result)).not.toContain('evil.example');
  });
  it('normalizes exact SHA256 commit IDs returned in uppercase', async () => {
    const base = 'A'.repeat(64), head = 'B'.repeat(64);
    const f = fixture({ base: { ref: 'refs/heads/release/next', object: { type: 'commit', sha: base } },
      head: { ref: 'refs/heads/ephemeral/session', object: { type: 'commit', sha: head } },
      comparison: comparison({ base_commit: { sha: base }, merge_base_commit: { sha: base } }) });
    expect(await f.api.publishedChanges(f.s, 'oauth', { expectedBaseSha: base, expectedHeadSha: head })).toMatchObject({ state: 'known',
      baseSha: base.toLowerCase(), headSha: head.toLowerCase(), mergeBaseSha: base.toLowerCase(),
      comparisonUrl: `https://github.com/owner/repo/compare/${base.toLowerCase()}...${head.toLowerCase()}` });
  });
  it.each([
    { status: 'identical', ahead_by: 0, behind_by: 0 },
    { status: 'behind', ahead_by: 0, behind_by: 2 },
    { status: 'ahead', ahead_by: 1, behind_by: 0 },
  ])('returns no changes for an empty PR comparison %j', async counts => {
    const f = fixture({ comparison: comparison({ ...counts, files: [] }) });
    expect(await f.api.publishedChanges(f.s, 'oauth', { ...pair, path: 'src/main.ts' })).toMatchObject({ state: 'no_changes', files: [], selected: null });
    expect(f.fetcher).toHaveBeenCalledTimes(6);
  });
  it('marks absent head unpublished and absent selected base unavailable, without requesting comparison content', async () => {
    const absentHead = fixture({ headStatus: 404 });
    expect(await absentHead.api.publishedChanges(absentHead.s, 'oauth')).toMatchObject({ state: 'unpublished', headSha: null, files: [], selected: null });
    expect(absentHead.fetcher).toHaveBeenCalledTimes(3);
    const absentBase = fixture({ baseStatus: 404 });
    expect(await absentBase.api.publishedChanges(absentBase.s, 'oauth')).toMatchObject({ state: 'unavailable', baseSha: null, files: [], selected: null });
    expect(absentBase.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(['head', 'base'] as const)('rejects a %s missing or moved since the last reviewed pair before compare', async rail => {
    const f = fixture(rail === 'head' ? { head: { ref: 'refs/heads/ephemeral/session', object: { type: 'commit', sha: movedSha } } } :
      { base: { ref: 'refs/heads/release/next', object: { type: 'commit', sha: movedSha } } });
    await expect(f.api.publishedChanges(f.s, 'oauth', pair)).rejects.toMatchObject({ status: 409, code: 'published_review_changed' });
    expect(f.fetcher.mock.calls.some(([url]) => String(url).includes('/compare/'))).toBe(false);
    const missing = fixture(rail === 'head' ? { headStatus: 404 } : { baseStatus: 404 });
    await expect(missing.api.publishedChanges(missing.s, 'oauth', pair)).rejects.toMatchObject({ status: 409, code: 'published_review_changed' });
  });
  it.each(['head', 'base'] as const)('discards all content if the %s changes or disappears while reading', async rail => {
    const ref = { ref: rail === 'head' ? 'refs/heads/ephemeral/session' : 'refs/heads/release/next', object: { type: 'commit', sha: movedSha } };
    const f = fixture(rail === 'head' ? { finalHead: ref } : { finalBase: ref });
    await expect(f.api.publishedChanges(f.s, 'oauth', { ...pair, path: 'src/main.ts' })).rejects.toMatchObject({ status: 409, code: 'published_review_changed' });
    const missing = fixture(rail === 'head' ? { finalHeadStatus: 404 } : { finalBaseStatus: 404 });
    await expect(missing.api.publishedChanges(missing.s, 'oauth')).rejects.toMatchObject({ status: 409, code: 'published_review_changed' });
  });
  it('refreshes without an expected pair to acquire the current commit IDs', async () => {
    const f = fixture({ head: { ref: 'refs/heads/ephemeral/session', object: { type: 'commit', sha: movedSha } } });
    expect(await f.api.publishedChanges(f.s, 'oauth')).toMatchObject({ state: 'known', headSha: movedSha });
    expect(String(f.fetcher.mock.calls[3][0])).toContain(`${baseSha}...${movedSha}`);
  });
  it.each([
    { base_commit: { sha: headSha } }, { merge_base_commit: { sha: 'invalid' } }, { ahead_by: -1 },
    { behind_by: Number.MAX_SAFE_INTEGER + 1 }, { status: 'diverged' }, { files: null },
    { files: [file(), file()] }, { files: [file({ filename: '../secret' })] },
    { files: [file({ previous_filename: '/secret' })] }, { files: [file({ status: 'renamed' })] },
    { files: [file({ status: 'made_up' })] }, { files: [file({ additions: 1.1 })] },
    { files: [file({ deletions: Number.MAX_SAFE_INTEGER, additions: 1, changes: Number.MAX_SAFE_INTEGER })] },
    { files: [file({ changes: 100 })] },
  ])('returns an empty safe failure for malformed comparison %j', async extra => {
    const f = fixture({ comparison: comparison(extra) });
    expect(await f.api.publishedChanges(f.s, 'oauth')).toMatchObject({ state: 'unknown', headSha: null, baseSha: null, files: [], selected: null });
  });
  it.each([
    { ref: 'refs/heads/prefix', object: { type: 'commit', sha: baseSha } },
    { ref: 'refs/heads/release/next', object: { type: 'tree', sha: baseSha } },
    { ref: 'refs/heads/release/next', object: { type: 'commit', sha: 'not-a-sha' } },
  ])('rejects malformed and nonexact refs %j', async base => {
    const f = fixture({ base });
    expect(await f.api.publishedChanges(f.s, 'oauth')).toMatchObject({ state: 'unknown', files: [], selected: null });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([201, 300])('returns at most 200 files and explicit list truncation from %i files', async total => {
    const f = fixture({ comparison: comparison({ files: Array.from({ length: total }, (_, i) => file({ filename: `src/${i}.ts` })) }) });
    const result = await f.api.publishedChanges(f.s, 'oauth', { ...pair, path: 'src/200.ts' });
    expect(result.files).toHaveLength(200); expect(result.listTruncated).toBe(true);
    expect(result.selected).toMatchObject({ state: 'unavailable', text: null, truncated: true });
  });
  it('accepts exactly 200 files as a complete list, rejects >300 remote files', async () => {
    const f = fixture({ comparison: comparison({ files: Array.from({ length: 200 }, (_, i) => file({ filename: `src/${i}.ts` })) }) });
    expect(await f.api.publishedChanges(f.s, 'oauth')).toMatchObject({ state: 'known', listTruncated: false });
    const tooMany = fixture({ comparison: comparison({ files: Array.from({ length: 301 }, (_, i) => file({ filename: `src/${i}.ts` })) }) });
    expect(await tooMany.api.publishedChanges(tooMany.s, 'oauth')).toMatchObject({ state: 'unknown', files: [] });
  });
  it.each([undefined, null, '', '\0private'])('does not claim a missing patch is definitely binary (%j)', async patch => {
    const f = fixture({ comparison: comparison({ files: [file({ patch })] }) });
    const result = await f.api.publishedChanges(f.s, 'oauth', { ...pair, path: 'src/main.ts' });
    expect(result).toMatchObject({ state: 'known', selected: { state: 'unavailable', text: null, truncated: true } });
    expect(result.selected?.reason).toContain('may be binary');
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('marks partial patch counts, enforces the UTF8 64KiB bound, and never returns other patches', async () => {
    const partial = fixture({ comparison: comparison({ files: [file({ patch: '@@ -1 +1 @@\n+new' }), file({ filename: 'other', patch: 'SECRET-OTHER-PATCH' })] }) });
    const result = await partial.api.publishedChanges(partial.s, 'oauth', { ...pair, path: 'src/main.ts' });
    expect(result.selected).toMatchObject({ state: 'patch', truncated: true });
    expect(JSON.stringify(result)).not.toContain('SECRET-OTHER-PATCH');
    const tooLarge = fixture({ comparison: comparison({ files: [file({ patch: '界'.repeat(22_000) })] }) });
    expect(await tooLarge.api.publishedChanges(tooLarge.s, 'oauth', { ...pair, path: 'src/main.ts' })).toMatchObject({ state: 'known',
      selected: { state: 'too_large', text: null, truncated: true } });
    const exact = fixture({ comparison: comparison({ files: [file({ patch: '+'.padEnd(65_536, 'x'), deletions: 0, changes: 1 })] }) });
    expect((await exact.api.publishedChanges(exact.s, 'oauth', { ...pair, path: 'src/main.ts' })).selected?.text).toHaveLength(65_536);
  });
  it('bounds streaming bytes without Content-Length and cancels oversized content before parsing', async () => {
    const cancelled = vi.fn();
    const f = fixture({ compareResponse: () => new Response(new ReadableStream({
      start(stream) { stream.enqueue(new Uint8Array(PUBLISHED_MAX_RESPONSE_BYTES + 1)); }, cancel: cancelled,
    })) });
    const result = await f.api.publishedChanges(f.s, 'oauth');
    expect(result).toMatchObject({ state: 'unknown', files: [], selected: null, headSha: null });
    expect(result.reason).toContain('2 MiB'); expect(cancelled).toHaveBeenCalled();
    expect(f.fetcher).toHaveBeenCalledTimes(4);
    expect((f.fetcher.mock.calls[3][1]?.signal as AbortSignal).aborted).toBe(true);
  });
  it('rejects an oversized advertised length without buffering and hides upstream bodies', async () => {
    const cancel = vi.fn();
    const f = fixture({ compareResponse: () => new Response(new ReadableStream({ cancel }), { headers: { 'content-length': String(PUBLISHED_MAX_RESPONSE_BYTES + 1) } }) });
    expect(await f.api.publishedChanges(f.s, 'oauth')).toMatchObject({ state: 'unknown', files: [] }); expect(cancel).toHaveBeenCalled();
    const failed = fixture({ compareResponse: () => json({ secret: 'Bearer OAuth-private-body' }, 500) });
    expect(JSON.stringify(await failed.api.publishedChanges(failed.s, 'oauth'))).not.toContain('OAuth-private-body');
  });
  it('rejects malformed UTF8 JSON without retaining any patch content', async () => {
    const f = fixture({ compareResponse: () => new Response(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])) });
    expect(await f.api.publishedChanges(f.s, 'oauth')).toMatchObject({ state: 'unknown', files: [], selected: null });
  });
  it.each([{ id: 9, installationId: 2, fullName: 'owner/repo' }, { id: 1, installationId: 3, fullName: 'owner/repo' },
    { id: 1, installationId: 2, fullName: 'other/repo' }])('authorizes current account and App identity before content (%j)', async mismatch => {
    const f = fixture(); f.repositories.mockResolvedValue([{ ...mismatch, defaultBranch: 'main' }]);
    await expect(f.api.publishedChanges(f.s, 'oauth')).rejects.toMatchObject({ status: 403, code: 'published_review_forbidden' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('rejects revocation during content reads and changed repository ID', async () => {
    const f = fixture(); f.repositories.mockResolvedValueOnce([{ id: 1, installationId: 2, fullName: 'owner/repo', defaultBranch: 'main' }]).mockResolvedValueOnce([]);
    await expect(f.api.publishedChanges(f.s, 'oauth', { ...pair, path: 'src/main.ts' })).rejects.toMatchObject({ status: 403 });
    const moved = fixture({ repository: { id: 99, full_name: 'owner/repo' } });
    await expect(moved.api.publishedChanges(moved.s, 'oauth')).rejects.toMatchObject({ status: 403 });
    expect(moved.fetcher).toHaveBeenCalledTimes(1);
  });
  it('reads current user/App installation and repository grants through OAuth before any private content', async () => {
    const f = fixture(); f.repositories.mockRestore();
    const contentFetch = f.fetcher.getMockImplementation()!;
    const events: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      events.push(path);
      expect(init?.method).toBe('GET'); expect(init?.headers).toMatchObject({ Authorization: 'Bearer CURRENT-OAUTH' });
      if (path === '/user/installations') return json({ installations: [{ id: 2, app_id: 42, app_slug: 'app', suspended_at: null }] });
      if (path === '/user/installations/2/repositories') return json({ repositories: [{ id: 1, full_name: 'owner/repo', default_branch: 'main', permissions: { push: true } }] });
      return contentFetch(url, init);
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await f.api.publishedChanges(f.s, 'CURRENT-OAUTH')).toMatchObject({ state: 'known' });
    expect(events).toEqual(['/user/installations', '/user/installations/2/repositories', '/repos/owner/repo',
      '/repos/owner/repo/git/ref/heads/release%2Fnext', '/repos/owner/repo/git/ref/heads/ephemeral%2Fsession',
      `/repos/owner/repo/compare/${baseSha}...${headSha}`, '/user/installations', '/user/installations/2/repositories',
      '/repos/owner/repo/git/ref/heads/release%2Fnext', '/repos/owner/repo/git/ref/heads/ephemeral%2Fsession']);
    expect(f.installationToken).not.toHaveBeenCalled();
  });
  it('never exposes OAuth/provider errors and propagates safe forbidden errors', async () => {
    const f = fixture(); f.repositories.mockRejectedValueOnce(new Error('private-token-body'));
    expect(JSON.stringify(await f.api.publishedChanges(f.s, 'oauth'))).not.toContain('private-token-body');
    f.repositories.mockRejectedValueOnce(new GitHubError('private-token-body', 403, 401));
    await expect(f.api.publishedChanges(f.s, 'oauth')).rejects.toMatchObject({ status: 403, message: 'Repository is no longer accessible to this account and App installation.' });
    const upstream = fixture({ compareResponse: () => json({ secret: 'private-token-body' }, 403) });
    await expect(upstream.api.publishedChanges(upstream.s, 'oauth')).rejects.toMatchObject({ status: 403, message: 'GitHub access is no longer available to this account.' });
  });
  it('honors caller cancellation and stops content before refs/compare when authorization completes late', async () => {
    const f = fixture(), controller = new AbortController();
    let finish!: () => void;
    vi.spyOn(f.api, 'authorizeContinuation').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.api.publishedChanges(f.s, 'oauth', {}, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ state: 'unknown', files: [], selected: null });
    finish(); await Promise.resolve(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('enforces the whole-operation 20s deadline even while authorization remains pending', async () => {
    vi.useFakeTimers();
    const f = fixture(); vi.spyOn(f.api, 'authorizeContinuation').mockImplementation(() => new Promise(() => {}));
    const pending = f.api.publishedChanges(f.s, 'oauth');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toMatchObject({ state: 'unknown', files: [] }); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('cancels a stalled comparison response stream at the total deadline', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const f = fixture({ compareResponse: () => new Response(new ReadableStream({ cancel })) });
    const pending = f.api.publishedChanges(f.s, 'oauth');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toMatchObject({ state: 'unknown', files: [], selected: null });
    expect(cancel).toHaveBeenCalled(); expect(f.fetcher).toHaveBeenCalledTimes(4);
  });
  it('aborts an in-flight authorization fetch and never proceeds to repository/ref content', async () => {
    const api = new GitHubAPI('42', 'unused', 'app'), controller = new AbortController();
    const aborted = vi.fn();
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal!.addEventListener('abort', () => { aborted(); reject(new Error('aborted secret-token')); }, { once: true });
    }));
    vi.stubGlobal('fetch', fetcher);
    const pending = api.publishedChanges(session(), 'oauth', {}, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ state: 'unknown', files: [], selected: null });
    expect(aborted).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toContain('/user/installations?');
    expect((fetcher.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
  });
  it('stops authorization pagination if cancellation arrives with a listing response', async () => {
    const api = new GitHubAPI('42', 'unused', 'app'), controller = new AbortController();
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => {
      controller.abort();
      return json({ installations: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, app_id: 42, app_slug: 'app', suspended_at: null })) });
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await api.publishedChanges(session(), 'oauth', {}, controller.signal)).toMatchObject({ state: 'unknown', files: [] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('published query validation', () => {
  it('normalizes SHAs while preserving repository paths as exact strings', () => {
    expect(validatePublishedChangesQuery({ ...pair, expectedHeadSha: headSha.toUpperCase(), path: 'space #/日本語+name.ts' })).toEqual({ ...pair, path: 'space #/日本語+name.ts' });
    expect(validatePublishedChangesQuery({})).toEqual({});
  });
  it.each([
    { path: 'src/main.ts' }, { expectedHeadSha: headSha }, { ...pair, path: '../secret' }, { ...pair, path: '/secret' },
    { ...pair, path: 'C:\\secret' }, { ...pair, path: 'a//b' }, { ...pair, path: 'a/./b' },
    { ...pair, path: 'a\nb' }, { ...pair, path: 'a\u0085b' }, { ...pair, path: '界'.repeat(1400) },
    { ...pair, path: '\ud800' }, { ...pair, expectedBaseSha: 'main' }, { ...pair, extra: 'unexpected' },
  ])('rejects unpinned or invalid selections %j', query => {
    expect(() => validatePublishedChangesQuery(query)).toThrow(expect.objectContaining({ status: 400, code: 'invalid_published_query' }));
  });
});
