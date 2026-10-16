import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitHubLaunchReview } from '../shared/github-launch';
import { GitHubLaunch, GitHubLaunchChoice, GitHubLaunchReviewCard, GitHubLaunchSourceDetails } from './GitHubLaunch';
import { GitHubLaunchReviewLoader, githubLaunchInputError, githubLaunchReviewBlocked, githubLaunchStorageKey, readGitHubLaunchIntent, submitGitHubLaunch, validGitHubLaunchReview, type GitHubLaunchIntent } from './github-launch-state';

const now = Date.parse('2026-10-16T12:00:00Z');
const review: GitHubLaunchReview = { url: 'https://github.com/ephemeral/example-app/tree/feature/demo', repository: 'ephemeral/example-app', repositoryId: 101, installationId: 1, kind: 'branch', ref: 'feature/demo', commitSha: 'c'.repeat(40), baseBranch: 'main', checkedAt: new Date(now).toISOString(), simulated: true };
const intent: GitHubLaunchIntent = { accountKey: 'preview:owner', userId: 'owner', requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', createdAt: new Date(now).toISOString(), review };
const child = { id: 'child', userId: 'owner', repository: review.repository, repositoryId: 101, installationId: 1, baseBranch: 'main', branch: 'ephemeral/child', launchSource: review };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('GitHub URL syntax and resolved review identity', () => {
  it('supports repository, slash branch, full commit and PR URLs without executing anything', () => {
    for (const url of ['https://github.com/ephemeral/example-app', review.url, `https://github.com/ephemeral/example-app/commit/${'a'.repeat(40)}`, 'https://github.com/ephemeral/example-app/pull/1']) expect(githubLaunchInputError(url)).toBeNull();
    for (const url of ['http://github.com/a/b', 'https://github.com.evil.test/a/b', 'https://user@github.com/a/b', 'https://github.com/a/b/tree/../main', 'https://github.com/a/b/tree/%2e%2e/main', 'https://github.com/a/b?x=1', 'https://github.com/a/b#x', 'https://github.com/a/b/commit/abc123', 'https://github.com/a/b/pull/0']) expect(githubLaunchInputError(url)).toBeTruthy();
  });
  it('rejects mismatched URL kind/ref/commit/PR/repository and malformed recovery metadata', () => {
    expect(validGitHubLaunchReview(review)).toBe(true);
    const changes = [{ kind: 'repository' }, { ref: 'main' }, { repository: 'another/repository' }, { repositoryId: -1 }, { simulated: undefined }, { baseBranch: '../main' }, { commitSha: 'abc' }, { checkedAt: 'invalid' }, { checkedAt: 1 }, { repository: 42 }, { pullRequestNumber: 1 }, { url: `https://github.com/ephemeral/example-app/commit/${'a'.repeat(40)}`, kind: 'commit', ref: 'a'.repeat(40) }, { url: 'https://github.com/ephemeral/example-app/pull/1', kind: 'pull_request', pullRequestNumber: 2 }];
    for (const change of changes) expect(validGitHubLaunchReview({ ...review, ...change })).toBe(false);
  });
  it('accepts GitHub canonical repository casing while preserving case-sensitive branch refs', () => {
    expect(validGitHubLaunchReview({ ...review, url: review.url.replace('/ephemeral/example-app/', '/EPHEMERAL/Example-App/') })).toBe(true);
    expect(validGitHubLaunchReview({ ...review, ref: 'Feature/Demo' })).toBe(false);
  });
  it('expires a review and forbids mixing simulated and live sources', () => {
    expect(githubLaunchReviewBlocked(review, true, now)).toBeNull();
    expect(githubLaunchReviewBlocked(review, true, now + 60_001)).toContain('expired');
    expect(githubLaunchReviewBlocked(review, true, now - 5001)).toContain('expired');
    expect(githubLaunchReviewBlocked(review, false, now)).toContain('verified');
  });
});

describe('explicit URL review races and cancellation', () => {
  it('does not check until requested; input invalidation prevents old responses reviving a review', async () => {
    const old = deferred<unknown>(), publish = vi.fn(), request = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ...review, url: 'https://github.com/ephemeral/example-app/tree/main', ref: 'main', commitSha: 'a'.repeat(40) });
    const loader = new GitHubLaunchReviewLoader(request, publish);
    expect(request).not.toHaveBeenCalled();
    const pending = loader.review(review.url);
    loader.invalidate();
    expect(request.mock.calls[0][1].aborted).toBe(true);
    await loader.review('https://github.com/ephemeral/example-app/tree/main');
    old.resolve(review); await pending;
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ ref: 'main' }), false, '');
    expect(publish.mock.calls.some(call => call[0]?.ref === 'feature/demo')).toBe(false); loader.dispose();
  });
  it('rejects a response for a different URL and surfaces actionable errors', async () => {
    const publish = vi.fn(), loader = new GitHubLaunchReviewLoader(vi.fn().mockResolvedValue(review), publish);
    await loader.review('https://github.com/ephemeral/example-app/tree/main');
    expect(publish).toHaveBeenLastCalledWith(null, false, expect.stringContaining('invalid URL review')); loader.dispose();
    const failed = new GitHubLaunchReviewLoader(vi.fn().mockRejectedValue(new Error('Fork pull requests are not supported.')), publish);
    await failed.review(review.url); expect(publish).toHaveBeenLastCalledWith(null, false, 'Fork pull requests are not supported.'); failed.dispose();
  });
  it('bounds a hung review and fences a late successful result', async () => {
    vi.useFakeTimers(); const late = deferred<unknown>(), publish = vi.fn(), request = vi.fn().mockReturnValue(late.promise), loader = new GitHubLaunchReviewLoader(request, publish);
    const pending = loader.review(review.url); await vi.advanceTimersByTimeAsync(45_000); await pending;
    expect(request.mock.calls[0][1].aborted).toBe(true); expect(publish).toHaveBeenLastCalledWith(null, false, expect.stringContaining('timed out'));
    late.resolve(review); await Promise.resolve(); expect(publish.mock.calls.some(call => call[0] !== null)).toBe(false); loader.dispose();
  });
  it('disposes safely on cancellation, unmount, or an account change', async () => {
    const late = deferred<unknown>(), publish = vi.fn(), request = vi.fn().mockReturnValue(late.promise), loader = new GitHubLaunchReviewLoader(request, publish);
    const pending = loader.review(review.url); loader.dispose(); publish.mockClear(); late.resolve(review); await pending;
    expect(publish).not.toHaveBeenCalled(); expect(request.mock.calls[0][1].aborted).toBe(true);
    await loader.review(review.url); expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('durable account-scoped launch recovery', () => {
  it('restores only the exact account and mode and keeps old reviewed requests available for retry', () => {
    const raw = JSON.stringify(intent);
    expect(readGitHubLaunchIntent(raw, intent.accountKey, intent.userId, true)).toEqual(intent);
    expect(readGitHubLaunchIntent(raw, 'preview:other', 'other', true)).toBeNull();
    expect(readGitHubLaunchIntent(raw, 'live:owner', 'owner', false)).toBeNull();
    expect(readGitHubLaunchIntent(raw, intent.accountKey, intent.userId, false)).toBeNull();
    for (const change of [{ requestId: 'bad' }, { createdAt: 1 }, { userId: 'other' }, { review: { ...review, simulated: 'true' } }, { review: { ...review, repositoryId: 0 } }]) expect(readGitHubLaunchIntent(JSON.stringify({ ...intent, ...change }), intent.accountKey, intent.userId, true)).toBeNull();
    for (const raw of ['{', 'null', '[]', '"a"']) expect(readGitHubLaunchIntent(raw, intent.accountKey, intent.userId, true)).toBeNull();
    expect(githubLaunchStorageKey('live:owner')).not.toBe(githubLaunchStorageKey('preview:owner'));
  });
  it('retries a lost response using the exact persisted request without a duplicate intent', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('Network failed')).mockResolvedValueOnce({ ok: true, json: async () => child }); vi.stubGlobal('fetch', fetch);
    await expect(submitGitHubLaunch(intent)).rejects.toMatchObject({ definite: false });
    const restored = readGitHubLaunchIntent(JSON.stringify(intent), intent.accountKey, intent.userId, true)!;
    await expect(submitGitHubLaunch(restored)).resolves.toMatchObject({ id: 'child' });
    for (const call of fetch.mock.calls) { expect(call[0]).toBe('/api/github-launch'); expect(JSON.parse(call[1].body)).toEqual({ url: review.url, expectedCommitSha: review.commitSha, expectedBaseBranch: 'main', expectedRepositoryId: review.repositoryId, expectedInstallationId: review.installationId, requestId: intent.requestId }); }
  });
  it('treats only explicitly tagged precreation rejections as definite', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'Database error' }) }).mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'Source moved', code: 'GITHUB_LAUNCH_REJECTED' }) }).mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'Source moved', code: 'GITHUB_LAUNCH_REJECTED', outcome: 'not_created' }) }); vi.stubGlobal('fetch', fetch);
    await expect(submitGitHubLaunch(intent)).rejects.toMatchObject({ definite: false });
    await expect(submitGitHubLaunch(intent)).rejects.toMatchObject({ definite: false });
    await expect(submitGitHubLaunch(intent)).rejects.toMatchObject({ definite: true });
  });
  it('clears only explicitly confirmed precreation gateway failures and preserves generic 502 uncertainty', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({ error: 'GitHub timed out', code: 'GITHUB_LAUNCH_REJECTED', outcome: 'not_created' }) }).mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({ error: 'Gateway failed' }) }).mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({ error: 'Unconfirmed failure', code: 'GITHUB_LAUNCH_REJECTED' }) }); vi.stubGlobal('fetch', fetch);
    await expect(submitGitHubLaunch(intent)).rejects.toMatchObject({ definite: true });
    await expect(submitGitHubLaunch(intent)).rejects.toMatchObject({ definite: false });
    await expect(submitGitHubLaunch(intent)).rejects.toMatchObject({ definite: false });
  });
  it('keeps request recovery for malformed or mismatched success responses', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const change of [{ userId: 'other' }, { repository: 'other/repo' }, { baseBranch: 'develop' }, { launchSource: { ...review, commitSha: 'a'.repeat(40) } }, { launchSource: { ...review, ref: 'main' } }, { launchSource: { ...review, url: 'https://github.com/ephemeral/example-app' } }, { launchSource: { ...review, checkedAt: 'bad' } }]) {
      fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ...child, ...change }) }); await expect(submitGitHubLaunch(intent)).rejects.toMatchObject({ definite: false });
    }
  });
  it('times out without claiming the machine was not created', async () => {
    vi.useFakeTimers(); const fetch = vi.fn().mockReturnValue(new Promise(() => {})); vi.stubGlobal('fetch', fetch);
    const pending = submitGitHubLaunch(intent).catch(error => error); await vi.advanceTimersByTimeAsync(45_000);
    expect(await pending).toMatchObject({ definite: false }); expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
});

describe('launch review and recovery presentation', () => {
  const props = { accountKey: intent.accountKey, userId: intent.userId, now, previewMode: true, canLaunch: true, onBusyChange: vi.fn(), onCreated: vi.fn(), onClose: vi.fn(), refreshSessions: vi.fn() };
  it('offers both launch choices, an explicit review step, and a disabled launch until reviewed', () => {
    const html = renderToStaticMarkup(createElement(GitHubLaunchChoice, { ...props, children: createElement('p', null, 'Repository chooser') }));
    expect(html).toContain('Repository picker'); expect(html).toContain('Paste GitHub URL'); expect(html).toContain('Repository chooser'); expect(html).toContain('Review URL'); expect(html).toContain('class="button primary" disabled=""');
  });
  it('makes the reviewed repository, source, base, full commit, lifetime and simulation visible with keyboard focus', () => {
    const html = renderToStaticMarkup(createElement(GitHubLaunchReviewCard, { review, previewMode: true }));
    for (const text of [review.repository, review.ref, review.commitSha, 'Base branch', 'main', '1 hour', 'Simulated', 'No compute or credentials', 'tabindex="-1"']) expect(html).toContain(text);
    const details = renderToStaticMarkup(createElement(GitHubLaunchSourceDetails, { source: review })); expect(details).toContain('Original launch source'); expect(details).toContain(review.url); expect(details).toContain(review.commitSha);
  });
  it('reopens saved launch recovery, locks the picker and original URL, and allows retry despite active-machine blocking', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => JSON.stringify(intent) });
    const html = renderToStaticMarkup(createElement(GitHubLaunchChoice, { ...props, canLaunch: false, children: createElement('p', null, 'Repository chooser') }));
    expect(html).not.toContain('Repository chooser'); expect(html).toContain('A launch request is already saved.'); expect(html).toContain('Check machine list'); expect(html).toContain('Retry saved request'); expect(html).toContain('disabled="" value=');
    expect(html).toContain('class="button primary">Retry saved request');
  });
  it('blocks malformed saved requests instead of silently replacing their request ID', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => '{"requestId":"corrupted"}' });
    const html = renderToStaticMarkup(createElement(GitHubLaunch, props)); expect(html).toContain('could not be safely restored'); expect(html).toContain('class="button primary" disabled=""'); expect(html).toContain('Check machine list');
  });
});

describe('URL launch environment binding', () => {
  const environment = { id: 'node', revision: 'b'.repeat(64) };
  it('persists an exact reference and never silently upgrades older saved intents', () => {
    const selected = { ...intent, environment };
    expect(readGitHubLaunchIntent(JSON.stringify(selected), intent.accountKey, intent.userId, true)).toEqual(selected);
    expect(readGitHubLaunchIntent(JSON.stringify(intent), intent.accountKey, intent.userId, true)).not.toHaveProperty('environment');
    for (const invalid of [null, {}, { ...environment, revision: 'bad' }, { ...environment, templateRef: 'injected' }]) expect(readGitHubLaunchIntent(JSON.stringify({ ...intent, environment: invalid }), intent.accountKey, intent.userId, true)).toBeNull();
  });
  it('replays the original profile revision after reload and uncertain response', async () => {
    const selected = { ...intent, environment };
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('Lost response')).mockResolvedValueOnce({ ok: true, json: async () => ({ ...child, environment }) }); vi.stubGlobal('fetch', fetch);
    await expect(submitGitHubLaunch(selected)).rejects.toMatchObject({ definite: false });
    const recovered = readGitHubLaunchIntent(JSON.stringify(selected), intent.accountKey, intent.userId, true)!;
    await expect(submitGitHubLaunch(recovered)).resolves.toMatchObject({ environment });
    expect(fetch.mock.calls.map(call => JSON.parse(call[1].body).environment)).toEqual([environment, environment]);
  });
  it('preserves recovery when a server response cannot confirm the selected environment', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const response of [undefined, { ...environment, id: 'default' }, { ...environment, revision: 'c'.repeat(64) }]) {
      fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ...child, environment: response }) });
      await expect(submitGitHubLaunch({ ...intent, environment })).rejects.toMatchObject({ definite: false });
    }
  });
  it('retains saved selection and retry access when catalog or active-machine state changes', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => JSON.stringify({ ...intent, environment }) });
    const html = renderToStaticMarkup(createElement(GitHubLaunch, { accountKey: intent.accountKey, userId: intent.userId, now, previewMode: true, canLaunch: false, onBusyChange: vi.fn(), onCreated: vi.fn(), onClose: vi.fn(), refreshSessions: vi.fn() }));
    expect(html).toContain('Retry retains this exact selection'); expect(html).toContain(environment.revision.slice(0, 12)); expect(html).not.toContain('<select'); expect(html).toContain('class="button primary">Retry saved request');
  });
});
