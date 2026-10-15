import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublishedChanges, PublishedComparisonPreview } from './PublishedChanges';
import { emptyPublishedView, publishedChangesRequestUrl, publishedComparisonUrl, PublishedChangesLoader, publishedReviewReady, reducePublished, requestPublishedChanges, validatePublishedChanges, type PublishedChanges as Comparison, type PublishedViewState } from './published-changes';

const checkedAt = '2026-10-14T12:00:00Z', now = Date.parse(checkedAt);
const pair = { headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) };
const value: Comparison = { state: 'known', checkedAt, reason: null, repository: 'owner/repo', headBranch: 'ephemeral/session', baseBranch: 'main', ...pair, mergeBaseSha: 'c'.repeat(40), aheadCommits: 2, behindCommits: 1, comparisonUrl: `https://github.com/owner/repo/compare/${pair.baseSha}...${pair.headSha}`, listTruncated: false, files: [{ path: 'src/file.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, changes: 2 }], selected: null };
function selected(path = 'src/file.ts', text = '+new\n-old'): Comparison { return { ...value, files: [{ ...value.files[0], path }], selected: { path, state: 'patch', text, truncated: false, reason: null } }; }
function loaded(snapshot = value, path: string | null = null) { return reducePublished(reducePublished(emptyPublishedView, { type: 'start', path }), { type: 'result', path, value: snapshot }); }
function markup(state: PublishedViewState, clock = now) { return renderToStaticMarkup(createElement(PublishedComparisonPreview, { state, now: clock, unavailable: false, onSelect: () => {} })); }
function deferred() { let resolve!: (value: Comparison) => void; const promise = new Promise<Comparison>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('published response contract', () => {
  it('accepts exact commits, bounded patch, statuses, rename and no_changes', () => {
    expect(validatePublishedChanges(value, null)).toBe(value);
    const rename = selected('space ?#%&<file>.ts'); rename.files[0] = { ...rename.files[0], status: 'renamed', previousPath: 'old file.ts' };
    expect(validatePublishedChanges(rename, rename.files[0].path, pair)).toBe(rename);
    for (const state of ['unavailable', 'too_large'] as const) expect(validatePublishedChanges({ ...selected(), selected: { ...selected().selected!, state, text: null, truncated: true } }, 'src/file.ts', pair).selected?.state).toBe(state);
    expect(validatePublishedChanges({ ...value, state: 'no_changes', aheadCommits: 0, files: [] }, null).state).toBe('no_changes');
  });
  it('rejects malformed counts, duplicate paths, unsafe paths and oversized bytes', () => {
    for (const candidate of [null, {}, { ...value, headSha: 'bad' }, { ...value, mergeBaseSha: null }, { ...value, aheadCommits: -1 }, { ...value, checkedAt: 'bad' }, { ...value, files: Array.from({ length: 201 }, () => value.files[0]) }, { ...value, files: [value.files[0], value.files[0]] }, { ...value, files: [{ ...value.files[0], changes: 99 }] }]) expect(() => validatePublishedChanges(candidate, null)).toThrow('could not be verified');
    for (const path of ['/root', '../x', 'a/../x', 'a//x', 'C:thing', 'a\nb', 'a\0b', '😀'.repeat(1025)]) expect(() => validatePublishedChanges({ ...value, files: [{ ...value.files[0], path }] }, null)).toThrow();
    expect(() => validatePublishedChanges(selected('src/file.ts', '😀'.repeat(16385)), 'src/file.ts', pair)).toThrow();
    expect(() => validatePublishedChanges({ ...value, state: 'unknown' }, null)).toThrow();
    expect(() => validatePublishedChanges({ ...selected(), selected: { ...selected().selected!, state: 'unavailable' } }, 'src/file.ts', pair)).toThrow();
  });
  it('pins both commits and never trusts arbitrary comparison URLs', () => {
    expect(publishedComparisonUrl(value)).toBe(value.comparisonUrl);
    for (const comparisonUrl of ['javascript:alert(1)', 'https://github.com/evil/repo/compare/x', 'https://evil.test', `${value.comparisonUrl}?redirect=evil`]) expect(() => validatePublishedChanges({ ...value, comparisonUrl }, null)).toThrow();
    expect(() => validatePublishedChanges(selected(), 'src/file.ts', { ...pair, headSha: 'd'.repeat(40) })).toThrow();
    expect(() => validatePublishedChanges(selected(), 'src/file.ts', { ...pair, baseSha: 'd'.repeat(40) })).toThrow();
    expect(() => validatePublishedChanges(selected('other'), 'src/file.ts', pair)).toThrow();
    expect(() => validatePublishedChanges(selected(), null)).toThrow();
    expect(() => publishedChangesRequestUrl('id', 'src/file.ts')).toThrow('Refresh review');
  });
  it('encodes opaque paths with both expected SHAs in a read-only bounded GET', async () => {
    const path = 'space ?#&%"<name>.ts';
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(selected(path)))); vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal; await requestPublishedChanges('session/id', path, pair, signal);
    const [url, options] = fetch.mock.calls[0]; const query = new URL(url, 'https://test').searchParams;
    expect(url).toContain('session%2Fid'); expect(query.get('path')).toBe(path); expect(query.get('expectedHeadSha')).toBe(pair.headSha); expect(query.get('expectedBaseSha')).toBe(pair.baseSha); expect(options.signal).toBe(signal); expect(options.method).toBeUndefined();
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...selected(path), baseSha: 'd'.repeat(40) })));
    await expect(requestPublishedChanges('id', path, pair, signal)).rejects.toThrow('could not be verified');
    fetch.mockResolvedValueOnce(new Response('x'.repeat(2 * 1024 * 1024 + 1)));
    await expect(requestPublishedChanges('id', null, null, signal)).rejects.toThrow('response limit');
    fetch.mockResolvedValueOnce(new Response('{bad'));
    await expect(requestPublishedChanges('id', null, null, signal)).rejects.toThrow('could not be verified');
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Published head or base moved', code: 'published_review_changed' }), { status: 409 }));
    await expect(requestPublishedChanges('id', 'src/file.ts', pair, signal)).rejects.toThrow('moved');
  });
});

describe('published request scope and review freshness', () => {
  it('coalesces an identical pair, aborts different base/head selection, and rejects late responses', async () => {
    const old = deferred(), next = deferred(), publish = vi.fn(); let firstSignal!: AbortSignal;
    const request = vi.fn().mockImplementationOnce((_, __, signal) => { firstSignal = signal; return old.promise; }).mockImplementationOnce(() => next.promise);
    const loader = new PublishedChangesLoader(request, publish);
    const first = loader.refresh('src/file.ts', pair); expect(loader.refresh('src/file.ts', pair)).toBe(first); await Promise.resolve();
    const second = loader.refresh('src/file.ts', { ...pair, baseSha: 'd'.repeat(40) }); await first; expect(firstSignal.aborted).toBe(true);
    next.resolve(selected()); await second; old.resolve(selected('late')); await Promise.resolve();
    expect(publish.mock.calls.filter(([action]) => action.type === 'result')).toHaveLength(1); loader.dispose();
  });
  it('disposes hung transports and fences account/session changes', async () => {
    const publish = vi.fn(), loader = new PublishedChangesLoader(() => new Promise(() => {}), publish);
    const run = loader.refresh(null); await Promise.resolve(); loader.dispose(); await run;
    expect(publish.mock.calls.map(([action]) => action.type)).toEqual(['start']);
    for (const scopeChange of ['account', 'session']) {
      let scope = 'current'; const pending = deferred(), output = vi.fn();
      const scoped = new PublishedChangesLoader(() => pending.promise, output, () => scope === 'current');
      const read = scoped.refresh(null); await Promise.resolve(); scope = scopeChange; pending.resolve(value); await read;
      expect(output.mock.calls.map(([action]) => action.type)).toEqual(['start']); scoped.dispose();
    }
  });
  it('times out, hides prior patch on failures or invalidation, and requires a fresh comparison', async () => {
    vi.useFakeTimers(); const publish = vi.fn(); const loader = new PublishedChangesLoader(() => new Promise(() => {}), publish);
    const run = loader.refresh(null); await vi.advanceTimersByTimeAsync(60_000); await run;
    expect(publish).toHaveBeenLastCalledWith({ type: 'failure', message: expect.stringContaining('timed out') }); loader.dispose();
    const prior = loaded(selected(), 'src/file.ts');
    for (const type of ['failure', 'invalidate'] as const) { const stale = reducePublished(prior, { type, message: 'Head or base changed; refresh' }); expect(stale.snapshot?.selected).toBeNull(); expect(stale.snapshot?.files).toEqual(value.files); expect(stale.stale).toBe(true); expect(publishedReviewReady(stale, now)).toBe(false); }
    expect(publishedReviewReady(prior, now)).toBe(true); expect(publishedReviewReady(prior, now + 60_001)).toBe(false); expect(publishedReviewReady(prior, now - 6000)).toBe(false);
    expect(publishedReviewReady(loaded({ ...value, state: 'no_changes', files: [] }), now)).toBe(false);
  });
  it('refresh unpins the old selection and removed files cannot retain patches', () => {
    const prior = loaded(selected(), 'src/file.ts'), refresh = reducePublished(prior, { type: 'start', path: null });
    expect(refresh.selectedPath).toBeNull(); expect(refresh.snapshot?.selected).toBeNull();
    const removed = reducePublished(prior, { type: 'result', path: 'src/file.ts', value: { ...value, state: 'no_changes', files: [] } });
    expect(removed.selectedPath).toBeNull(); expect(removed.snapshot?.selected).toBeNull(); expect(removed.selectionNotice).toContain('no longer');
  });
});

describe('published comparison presentation', () => {
  it('keeps scope and check age visible while exact current commits are disclosed on demand', () => {
    const html = markup(loaded(selected(), 'src/file.ts'));
    const details = html.slice(html.indexOf('<details'), html.indexOf('</details>') + 10);
    expect(details).toContain('<summary>Exact commits and comparison details');
    expect(details).not.toContain('open=""');
    expect(details).toContain(pair.headSha); expect(details).toContain(pair.baseSha); expect(details).toContain(value.mergeBaseSha);
    expect(details).toContain('Open this exact commit comparison on GitHub');
    const visible = html.replace(details, '');
    expect(visible).toContain('local-only commits are excluded'); expect(visible).toContain(`dateTime="${checkedAt}"`); expect(visible).toContain('+new');
    const stale = markup(loaded(selected(), 'src/file.ts'), now + 60_001);
    expect(stale).toContain('<details class="published-provenance" open="">');
    expect(stale.indexOf('current published work is unconfirmed')).toBeLessThan(stale.indexOf('<details'));
    expect(stale).not.toContain('+new');
  });
  it('asks users to wait during the initial check and explains the hidden patch', () => {
    const html = markup(reducePublished(emptyPublishedView, { type: 'start', path: null }));
    expect(html).toContain('Checking published contribution…'); expect(html).toContain('Wait for the check to finish'); expect(html).toContain('patch stays hidden until the current comparison is confirmed');
    expect(html).not.toContain('Refresh review'); expect(html).not.toContain('Select a'); expect(html).not.toContain('Prior comparison'); expect(html).not.toContain('role="alert"');
  });
  it('keeps dated commit provenance during refresh while deferring retry and selection hints', () => {
    const prior = loaded(selected(), 'src/file.ts');
    const refreshing = reducePublished(prior, { type: 'start', path: null });
    expect(refreshing.selectionNotice).toContain('Select a file again');
    const html = markup(refreshing);
    expect(html).toContain('Refreshing the published comparison…'); expect(html).toContain('Wait for the check to finish'); expect(html).toContain('Prior comparison'); expect(html).toContain(`dateTime="${checkedAt}"`);
    expect(html).toContain(pair.headSha); expect(html).toContain(pair.baseSha); expect(html).toContain(value.mergeBaseSha); expect(html).toContain('2 ahead'); expect(html).toContain('1 behind'); expect(html).toContain('Previously observed published files'); expect(html).toContain('disabled=""');
    expect(html).not.toContain('+new'); expect(html).not.toContain('Published file patch'); expect(html).not.toContain('Refresh review'); expect(html).not.toContain('Select a file again'); expect(html).not.toContain('role="alert"');
    const complete = markup(reducePublished(refreshing, { type: 'result', path: null, value }));
    expect(complete).toContain('Select a file again'); expect(complete).not.toContain('Wait for the check'); expect(complete).not.toContain('Prior comparison');
  });
  it('gives waiting guidance during file revalidation and reveals only the completed patch', () => {
    const checking = reducePublished(loaded(selected(), 'src/file.ts'), { type: 'start', path: 'src/file.ts' });
    const html = markup(checking);
    expect(html).toContain('Rechecking the reviewed commits and loading this file’s published patch…'); expect(html).toContain('Wait for the check to finish'); expect(html).toContain('patch is hidden until the current comparison is confirmed'); expect(html).toContain('Prior comparison'); expect(html).toContain('disabled=""');
    expect(html).not.toContain('+new'); expect(html).not.toContain('Published file patch'); expect(html).not.toContain('Refresh review'); expect(html).not.toContain('Select a');
    const complete = markup(reducePublished(checking, { type: 'result', path: 'src/file.ts', value: selected('src/file.ts', '+confirmed') }));
    expect(complete).toContain('+confirmed'); expect(complete).toContain('Published file patch'); expect(complete).not.toContain('Wait for the check'); expect(complete).not.toContain('Prior comparison');
  });
  it('offers refresh only after an aged or failed check and preserves the prior observation', () => {
    const prior = loaded(selected(), 'src/file.ts');
    for (const state of [prior, reducePublished(prior, { type: 'failure', message: 'The reviewed head moved. Refresh review to try again.' })]) {
      const html = markup(state, now + 60_001);
      expect(html).toContain('Prior comparison'); expect(html).toContain('Refresh review to confirm the current branches'); expect(html).toContain('Refresh review to continue'); expect(html).toContain(`dateTime="${checkedAt}"`); expect(html).toContain(pair.headSha); expect(html).toContain(pair.baseSha); expect(html).toContain('disabled=""');
      expect(html).not.toContain('+new'); expect(html).not.toContain('Wait for the check');
    }
    const failed = markup(reducePublished(prior, { type: 'failure', message: 'The reviewed head moved. Refresh review to try again.' }));
    expect(failed).toContain('role="alert"'); expect(failed).toContain('The reviewed head moved');
    const initialFailure = markup(reducePublished(emptyPublishedView, { type: 'failure', message: 'Published comparison timed out. Refresh review to try again.' }));
    expect(initialFailure).toContain('role="alert"'); expect(initialFailure).toContain('timed out'); expect(initialFailure).toContain('Refresh review'); expect(initialFailure).not.toContain('Published comparison</p>');
  });
  it('keeps current known and no-change results distinct from checks and failures', () => {
    const known = markup(loaded());
    expect(known).toContain('Select a published file'); expect(known).toContain('Published comparison'); expect(known).not.toContain('Prior comparison'); expect(known).not.toContain('Wait for the check'); expect(known).not.toContain('Refresh review'); expect(known).not.toContain('role="alert"'); expect(known).not.toContain('disabled=""');
    const unchanged = markup(loaded({ ...value, state: 'no_changes', files: [], aheadCommits: 0 }));
    expect(unchanged).toContain('No published file changes were found at this check'); expect(unchanged).toContain('No published patch to review at this check'); expect(unchanged).toContain(pair.headSha); expect(unchanged).toContain(pair.baseSha);
    expect(unchanged).not.toContain('Select a'); expect(unchanged).not.toContain('Prior comparison'); expect(unchanged).not.toContain('Wait for the check'); expect(unchanged).not.toContain('role="alert"');
  });
  it('escapes every repository controlled path and patch while showing exact commits and counts', () => {
    const malicious = selected('<img src=x onerror=alert(1)>.ts', '<script>alert(1)</script>\n+https://evil.test'); malicious.files[0] = { ...malicious.files[0], previousPath: 'old<svg>.ts', status: 'renamed' };
    const html = markup(loaded(malicious, malicious.files[0].path));
    expect(html).toContain('&lt;img'); expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).not.toContain('<img '); expect(html).toContain('From: old&lt;svg&gt;'); expect(html).toContain(pair.headSha); expect(html).toContain(pair.baseSha); expect(html).toContain(value.mergeBaseSha); expect(html).toContain('2 ahead'); expect(html).toContain('1 behind'); expect(html).toContain('aria-pressed="true"'); expect(html).toContain('tabindex="0"');
  });
  it('marks aging lists as prior, hides old patches, and labels partial or missing patches honestly', () => {
    const prior = loaded(selected(), 'src/file.ts'), stale = markup(prior, now + 60_001);
    expect(stale).toContain('Prior comparison'); expect(stale).not.toContain('+new'); expect(stale).toContain('disabled=""');
    const partial = selected(); partial.listTruncated = true; partial.selected!.truncated = true;
    const html = markup(loaded(partial, 'src/file.ts')); expect(html).toContain('200 files'); expect(html).toContain('GitHub returned a partial patch'); expect(html).not.toContain('truncated at 64 KiB'); expect(html).toContain('exact commit comparison');
    const missing = selected(); missing.selected = { ...missing.selected!, state: 'unavailable', text: null, truncated: true };
    expect(markup(loaded(missing, 'src/file.ts'))).toContain('does not establish that the file is binary');
  });
  it('shows preview unavailable with no repository inspection even for ended machines', () => {
    const session = { id: 'id', userId: 'owner', repository: 'owner/repo', branch: 'ephemeral/session', baseBranch: 'main', state: 'ended' } as Parameters<typeof PublishedChanges>[0]['session'];
    const html = renderToStaticMarkup(createElement(PublishedChanges, { session, preview: true, now, accountKey: 'owner' }));
    expect(html).toContain('No GitHub repository is inspected'); expect(html).toContain('after this machine ends'); expect(html).toContain('local-only commits are excluded'); expect(html).toContain('Changes shows uncommitted files only'); expect(html).toContain('disabled=""');
  });
});
