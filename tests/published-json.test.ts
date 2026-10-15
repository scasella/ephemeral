import { describe, expect, it } from 'vitest';
import { OVERSIZED_PUBLISHED_PATCH, PUBLISHED_MAX_METADATA_BYTES, PUBLISHED_MAX_WIRE_BYTES,
  PublishedJsonProjection, type PublishedJsonKind } from '../server/github/published-json.js';

function parse(text: string, selectedPath?: string, fragment = 17, kind: PublishedJsonKind = 'comparison') {
  const parser = new PublishedJsonProjection(kind, { wire: PUBLISHED_MAX_WIRE_BYTES, metadata: PUBLISHED_MAX_METADATA_BYTES }, selectedPath);
  for (let i = 0; i < text.length; i += fragment) parser.write(text.slice(i, i + fragment));
  return parser.finish() as Record<string, unknown>;
}

describe('bounded published JSON projection', () => {
  it('projects only trusted metadata and the selected bounded patch regardless of key order', () => {
    const result = parse(JSON.stringify({ status: 'ahead', ahead_by: 1, behind_by: 0, html_url: 'untrusted',
      base_commit: { sha: 'a'.repeat(40), message: 'ignored' }, merge_base_commit: { sha: 'b'.repeat(40) },
      files: [{ patch: 'other secret', filename: 'other', status: 'modified' },
        { patch: '+日本語😀\n-previous', filename: 'selected', additions: 1, deletions: 1, changes: 2 }],
      commits: [{ commit: { message: 'ignored commit' } }] }), 'selected', 1);
    expect(result).toEqual({ status: 'ahead', ahead_by: 1, behind_by: 0,
      base_commit: { sha: 'a'.repeat(40) }, merge_base_commit: { sha: 'b'.repeat(40) }, files: [
        { filename: 'other', status: 'modified' }, { filename: 'selected', patch: '+日本語😀\n-previous', additions: 1, deletions: 1, changes: 2 }] });
    expect(JSON.stringify(result)).not.toMatch(/secret|untrusted|ignored/);
  });
  it('discards multi-megabyte unrequested patches and marks oversized selected patches', () => {
    const text = JSON.stringify({ files: [{ patch: '界'.repeat(800_000), filename: 'other' },
      { patch: '😀'.repeat(16_385), filename: 'selected' }] });
    const result = parse(text, 'selected', 16_384);
    expect(result.files).toEqual([{ filename: 'other' }, { filename: 'selected', patch: OVERSIZED_PUBLISHED_PATCH }]);
  });
  it('drops every candidate when no file is requested, including malformed missing filenames', () => {
    expect(parse(JSON.stringify({ files: Array.from({ length: 300 }, () => ({ patch: 'x'.repeat(65_536) })) }), undefined, 16_384).files)
      .toEqual(Array.from({ length: 300 }, () => ({})));
  });
  it('rejects a second selected file before accumulating duplicate patch candidates', () => {
    const parser = new PublishedJsonProjection('comparison', { wire: PUBLISHED_MAX_WIRE_BYTES, metadata: PUBLISHED_MAX_METADATA_BYTES }, 'selected');
    parser.write('{"files":[{"filename":"selected","patch":"' + 'x'.repeat(65_536) + '"},');
    expect(() => parser.write('{"patch":"' + 'x'.repeat(65_536) + '","filename":"selected"}')).toThrow('Duplicate selected file');
  });
  it('accepts exactly 64KiB of decoded UTF8 patch, including escaped astral pairs and escaped keys', () => {
    expect(parse('{"fi\\u006ces":[{"filen\\u0061me":"selected","pa\\u0074ch":"\\ud83d\\ude00' + 'x'.repeat(65_532) + '"}]}', 'selected', 1).files)
      .toEqual([{ filename: 'selected', patch: '😀' + 'x'.repeat(65_532) }]);
  });
  it.each([
    '{"status":"ahead","st\\u0061tus":"behind"}',
    '{"files":[{"filename":"one","filename":"two"}]}',
    '{"files":[{"patch":"one","pa\\u0074ch":"two"}]}',
    '{"ignored":{"key":1,"key":2}}',
    '{"files":[{"patch":"bad\\q"}]}',
    '{"files":[{"patch":"bad\nraw-control"}]}',
    '{"files":[{"patch":"\\ud800"}]}',
    '{"files":[{"patch":"\\udc00"}]}',
    '{"ignored":"\\ud800x"}',
    '{"ignored":"\\ud800\\ud800"}',
    '{"ignored":"' + '\ud800' + '"}',
    '{"files":[{"patch":"' + 'x'.repeat(65_537) + '\\ud800"}]}',
    '{"files":[{"patch":"' + 'x'.repeat(65_537) + '\\q"}]}',
    '{"status":"ahead",}', '{"files":[1,]}', '{"ahead_by":01}', '{"ahead_by":1.}',
    '{"ahead_by":1e}', '{"ignored":tru}', '{"ignored":true false}', '{"files":[]}{"files":[]}',
    '{"files":[{"filename":"selected","patch":"valid"}]',
    '{"files":[]', '{"files":[', '{"files":', '{"files":"incomplete', '', '\ufeff{}',
  ])('rejects ambiguous, malformed, or incomplete JSON (%s)', text => {
    expect(() => parse(text, 'selected', 7)).toThrow();
  });
  it('validates escaped controls even in ignored strings and preserves legitimate JSON escapes', () => {
    expect(parse('{"files":[{"filename":"selected","patch":"\\\"\\\\\\/\\b\\f\\n\\r\\t\\u0000"}]}', 'selected', 1).files)
      .toEqual([{ filename: 'selected', patch: '"\\/\b\f\n\r\t\0' }]);
  });
  it('bounds unknown strings, keys, object members, arrays, nesting, and cumulative metadata', () => {
    for (const text of [JSON.stringify({ ignored: 'x'.repeat(65_537) }), JSON.stringify({ ['x'.repeat(257)]: 1 }),
      JSON.stringify(Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`k${i}`, i]))),
      JSON.stringify({ ignored: Array(2_001).fill(null) }),
      '{"ignored":' + '['.repeat(32) + '0' + ']'.repeat(32) + '}',
      JSON.stringify({ files: Array.from({ length: 301 }, (_, i) => ({ filename: `file-${i}` })) }),
      JSON.stringify({ ignored: Array(33).fill('x'.repeat(65_536)) })]) {
      expect(() => parse(text, undefined, 16_384)).toThrow();
    }
  });
  it('bounds token counts even for deeply discarded metadata', () => {
    const text = JSON.stringify({ ignored: Array.from({ length: 60 }, () => Array(1_700).fill(0)) });
    expect(() => parse(text)).toThrow();
  });
  it('projects exact repository and ref identity without provider URLs or extra objects', () => {
    expect(parse('{"id":1,"full_name":"owner/repo","html_url":"evil"}', undefined, 1, 'repository'))
      .toEqual({ id: 1, full_name: 'owner/repo' });
    expect(parse('{"ref":"refs/heads/main","object":{"sha":"abc","type":"commit","url":"evil"}}', undefined, 1, 'ref'))
      .toEqual({ ref: 'refs/heads/main', object: { sha: 'abc', type: 'commit' } });
  });
});
