import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChangesPreview } from './RepositoryChanges';
import { PublishedComparisonPreview } from './PublishedChanges';
import { formatReviewText, ReviewText, REVIEW_TEXT_LIMIT } from './review-text';
import type { ChangesViewState } from './repository-changes';
import type { PublishedViewState } from './published-changes';

const checkedAt = '2026-10-14T12:00:00Z', now = Date.parse(checkedAt);
function changes(path: string, oldPath: string, text: string, untracked = false): ChangesViewState {
  return { selectedPath: path, loading: false, stale: false, error: '', selectionNotice: '', latest: null, snapshot: {
    state: 'known', checkedAt, reason: null, headSha: 'a'.repeat(40), listTruncated: false,
    files: [{ path, oldPath, status: untracked ? '??' : 'RM', kind: untracked ? 'untracked' : 'tracked' }],
    selected: { path, state: 'text', text, reason: null, truncated: false },
  } };
}
function published(path: string, previousPath: string, text: string): PublishedViewState {
  return { selectedPath: path, loading: false, stale: false, error: '', selectionNotice: '', latest: null, snapshot: {
    state: 'known', checkedAt, reason: null, repository: 'owner/repo', headBranch: 'work', baseBranch: 'main',
    headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), mergeBaseSha: 'c'.repeat(40), aheadCommits: 1, behindCommits: 0,
    comparisonUrl: null, listTruncated: false,
    files: [{ path, previousPath, status: 'renamed', additions: 1, deletions: 1, changes: 2 }],
    selected: { path, state: 'patch', text, reason: null, truncated: false },
  } };
}
function button(tree: ReactNode): (() => void) | undefined {
  for (const node of Array.isArray(tree) ? tree : [tree]) {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) continue;
    if (node.type === 'button') return node.props.onClick;
    const click = button(node.props.children); if (click) return click;
  }
}
function listKey(tree: ReactNode): string | null {
  for (const node of Array.isArray(tree) ? tree : [tree]) {
    if (!isValidElement<{ children?: ReactNode }>(node)) continue;
    if (node.type === 'li') return node.key;
    const key = listKey(node.props.children); if (key) return key;
  }
  return null;
}
const markers = ['\u061C', '\u200B', '\u200C', '\u200D', '\u200E', '\u202E', '\u2066', '\u2060', '\uFEFF', '\u00AD', '\u034F', '\u00A0', '\uFE0F', '\u{E0100}', '\r'];

describe('Unicode-safe review text', () => {
  it('marks bidi, hidden controls, misleading spaces and isolated joiners/selectors visibly', () => {
    for (const character of markers) {
      const value = formatReviewText(`a${character}b`);
      expect(value.suspicious).toBe(true);
      expect(value.text).not.toContain(character);
      expect(value.text).toContain(`U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
    }
  });
  it('preserves ordinary international words, accents, joined scripts and emoji and source formatting', () => {
    for (const text of ['café 日本語 العربية שלום हिन्दी 😀', 'e\u0301', 'می\u200Cروم', 'क्\u200Dष', '👩\u200D💻', '👩🏽\u200D💻', '❤️', '漢\u{E0100}', 'ᠠ\u180B', 'first\n\tsecond\r\n']) {
      expect(formatReviewText(text)).toEqual({ text, suspicious: false, truncated: false });
    }
  });
  it('marks filename identity whitespace while preserving ordinary source formatting', () => {
    for (const whitespace of ['\n', '\r\n', '\t']) {
      const name = `a${whitespace}b.txt`, display = formatReviewText(name, 'identity');
      expect(display.suspicious).toBe(true); expect(display.text).not.toContain(whitespace);
      for (const character of whitespace) expect(display.text).toContain(`⟦U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟧`);
      expect(formatReviewText(name, 'text')).toEqual({ text: name, suspicious: false, truncated: false });
    }
    for (const name of [' leading.txt', 'trailing.txt ', 'two  spaces.txt']) {
      expect(formatReviewText(name, 'identity').suspicious).toBe(true);
      expect(formatReviewText(name, 'identity').text).toContain('⟦U+0020⟧');
      expect(formatReviewText(name, 'text')).toEqual({ text: name, suspicious: false, truncated: false });
    }
    expect(formatReviewText('ordinary space.txt', 'identity')).toEqual({ text: 'ordinary space.txt', suspicious: false, truncated: false });
  });
  it('keeps output and DOM bounded for a worst-case 64 KiB preview and oversized caller input', () => {
    const start = performance.now(), source = '\u200B'.repeat(REVIEW_TEXT_LIMIT);
    const display = formatReviewText(source);
    expect(display.text.length).toBeLessThanOrEqual(REVIEW_TEXT_LIMIT * 12);
    const html = renderToStaticMarkup(createElement(ReviewText, { text: source }));
    expect(html.match(/<span/g)).toHaveLength(1);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(formatReviewText(source + 'overflow').truncated).toBe(true);
    expect(renderToStaticMarkup(createElement(ReviewText, { text: source + 'overflow' }))).toContain('Display truncated');
  });
});

describe('review display surfaces', () => {
  for (const kind of ['Changes diff', 'Changes untracked', 'Published patch'] as const) {
    it(`${kind}: warns and marks list path, rename origin, selected heading and content`, () => {
      for (const character of markers) {
        const path = `file${character}name.ts`, old = `old${character}name.ts`, text = `+content${character}text`;
        const props = { now, unavailable: false, onSelect: () => {} };
        const html = kind === 'Published patch'
          ? renderToStaticMarkup(createElement(PublishedComparisonPreview, { ...props, state: published(path, old, text) }))
          : renderToStaticMarkup(createElement(ChangesPreview, { ...props, state: changes(path, old, text, kind === 'Changes untracked') }));
        expect(html).not.toContain(character);
        expect(html.match(/Unicode review warning/g)).toHaveLength(4);
        expect(html.match(/⟦U\+[A-F0-9]+⟧/g)).toHaveLength(4);
      }
    });
    it(`${kind}: selection callback receives the exact opaque path and markup stays inert`, () => {
      const path = 'src/\u202E<img src=x onerror=alert(1)>.ts', callback = vi.fn();
      const props = { now, unavailable: false, onSelect: callback };
      const tree = kind === 'Published patch'
        ? PublishedComparisonPreview({ ...props, state: published(path, 'old\u200B<script>', '+<script>alert(1)</script>\u2066') })
        : ChangesPreview({ ...props, state: changes(path, 'old\u200B<script>', '+<script>alert(1)</script>\u2066', kind === 'Changes untracked') });
      expect(listKey(tree)).toBe(path);
      button(tree)?.(); expect(callback).toHaveBeenCalledExactlyOnceWith(path);
      const html = renderToStaticMarkup(tree);
      expect(html).toContain('&lt;img'); expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('<img '); expect(html).not.toContain('<script>'); expect(html).not.toContain('\u202E');
      expect(html).toContain('aria-pressed="true"');
    });
    it(`${kind}: makes newline/tab names explicit without changing source formatting or selection`, () => {
      for (const whitespace of ['\n', '\r\n', '\t']) {
        const path = `file${whitespace}name.ts`, old = `old${whitespace}name.ts`, text = '+first\n\tsecond\r\n', callback = vi.fn();
        const props = { now, unavailable: false, onSelect: callback };
        const tree = kind === 'Published patch'
          ? PublishedComparisonPreview({ ...props, state: published(path, old, text) })
          : ChangesPreview({ ...props, state: changes(path, old, text, kind === 'Changes untracked') });
        expect(listKey(tree)).toBe(path); button(tree)?.(); expect(callback).toHaveBeenCalledExactlyOnceWith(path);
        const html = renderToStaticMarkup(tree), content = html.slice(html.indexOf('<pre'), html.indexOf('</pre>'));
        expect(html.match(/Unicode review warning/g)).toHaveLength(3);
        expect(html).not.toContain(path); expect(html).not.toContain(old);
        for (const character of whitespace) {
          const marker = `⟦U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟧`;
          expect(html.split(marker)).toHaveLength(4);
        }
        expect(content).toContain(text); expect(content).not.toContain('Unicode review warning'); expect(content).not.toContain('⟦U+');
      }
    });
    it(`${kind}: ordinary international text is displayed intact without warning`, () => {
      const path = '日本語/می\u200Cروم-👩\u200D💻.ts', props = { now, unavailable: false, onSelect: () => {} };
      const html = kind === 'Published patch'
        ? renderToStaticMarkup(createElement(PublishedComparisonPreview, { ...props, state: published(path, 'café', '+שלום\n\tالعربية\r\n') }))
        : renderToStaticMarkup(createElement(ChangesPreview, { ...props, state: changes(path, 'café', '+שלום\n\tالعربية\r\n', kind === 'Changes untracked') }));
      expect(html).toContain(path); expect(html).not.toContain('Unicode review warning'); expect(html).toContain('+שלום');
    });
  }
  it('labels the comparison provenance supplied by the inspector for text previews', () => {
    const state = changes('file', 'old', '+text'); state.snapshot!.selected!.reason = 'Raw UTF-8 byte comparison; filters are not applied.';
    const html = renderToStaticMarkup(createElement(ChangesPreview, { state, now, unavailable: false, onSelect: () => {} }));
    expect(html).toContain('Raw UTF-8 byte comparison; filters are not applied.');
  });
  it('marks identity whitespace in published repository and branch provenance', () => {
    const state = published('file', 'old', '+first\n\tsecond\r\n');
    state.snapshot!.repository = 'owner/rep\no'; state.snapshot!.headBranch = 'wo\trk'; state.snapshot!.baseBranch = 'ma\r\nin';
    const html = renderToStaticMarkup(createElement(PublishedComparisonPreview, { state, now, unavailable: false, onSelect: () => {} }));
    expect(html.match(/Unicode review warning/g)).toHaveLength(3);
    expect(html).toContain('owner/rep⟦U+000A⟧o'); expect(html).toContain('wo⟦U+0009⟧rk'); expect(html).toContain('ma⟦U+000D⟧⟦U+000A⟧in');
    expect(html).toContain('+first\n\tsecond\r\n');
  });
  it('also marks repository and branch provenance in the published view', () => {
    const state = published('file', 'old', '+text');
    state.snapshot!.repository = 'owner/rep\u200Bo'; state.snapshot!.headBranch = 'wo\u202Erk'; state.snapshot!.baseBranch = 'ma\u2066in';
    const html = renderToStaticMarkup(createElement(PublishedComparisonPreview, { state, now, unavailable: false, onSelect: () => {} }));
    expect(html.match(/Unicode review warning/g)).toHaveLength(3);
    expect(html).not.toMatch(/[\u200B\u202E\u2066]/u);
  });
});
