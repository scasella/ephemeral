import { describe, expect, it } from 'vitest';
import { createSetupOutputBuffer } from '../server/setup-output.js';

describe('bounded sanitized setup output', () => {
  it('keeps short output intact and preserves a head and final tail after repeated huge writes', () => {
    const buffer = createSetupOutputBuffer();
    buffer.write('initial command\n');
    expect(buffer.snapshot()).toEqual({ output: 'initial command\n', truncated: false });
    for (let i = 0; i < 3; i++) buffer.write('verbose line\n'.repeat(200_000));
    buffer.write('FINAL: installation failed\n');
    const snapshot = buffer.snapshot();
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.output.startsWith('initial command\n')).toBe(true);
    expect(snapshot.output).toContain('omitted middle');
    expect(snapshot.output.endsWith('FINAL: installation failed\n')).toBe(true);
    expect(Buffer.byteLength(snapshot.output)).toBeLessThanOrEqual(65536);
  });
  it('respects byte limits and surrogate boundaries across writes and internal batches', () => {
    const buffer = createSetupOutputBuffer(1024);
    buffer.write('start ' + '😀'.repeat(1023) + '\ud83d');
    buffer.write('\ude00' + '😀'.repeat(10) + ' final');
    const snapshot = buffer.snapshot();
    expect(snapshot.output).not.toContain('\ufffd');
    expect(snapshot.output.startsWith('start ')).toBe(true);
    expect(snapshot.output.endsWith(' final')).toBe(true);
    expect(Buffer.byteLength(snapshot.output)).toBeLessThanOrEqual(1024);
    for (const limit of [0, 1, 2, 3, 8, 50]) {
      const tiny = createSetupOutputBuffer(limit); tiny.write('😀'.repeat(20));
      expect(Buffer.byteLength(tiny.snapshot().output)).toBeLessThanOrEqual(limit);
    }
  });
});
