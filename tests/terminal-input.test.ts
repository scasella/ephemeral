import { afterEach, describe, expect, it, vi } from 'vitest';
import { terminalInput, TERMINAL_FRAME_BYTES, TERMINAL_QUEUE_BYTES } from '../server/terminal-input.js';

function fixture() {
  const connection = { write: vi.fn(async (_data: string) => {}), resize: vi.fn(async (_cols: number, _rows: number) => {}), disconnect: vi.fn(async () => {}) };
  const ack = vi.fn(), fail = vi.fn(), tasks: Promise<void>[] = [];
  const input = terminalInput({ connection: () => connection, allowed: async () => true, ack, fail, track: task => { tasks.push(task); } });
  const send = (data: string, sequence?: number) => input.receive(JSON.stringify({ type: 'input', data, sequence }));
  return { input, send, connection, ack, fail, tasks };
}
afterEach(() => vi.useRealTimers());
describe('bounded terminal input', () => {
  it('batches typing behind a delayed SDK write, acknowledges only completion and preserves resize/Unicode order', async () => {
    vi.useFakeTimers(); const f = fixture(); let finish!: () => void;
    f.connection.write.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    f.send('first', 1); await vi.advanceTimersByTimeAsync(8);
    for (let i = 0; i < 500; i++) f.send(i % 2 ? '😀' : 'é', i + 2);
    f.input.receive(JSON.stringify({ type: 'resize', cols: 100, rows: 40 })); f.send('after', 502);
    await vi.advanceTimersByTimeAsync(150);
    expect(f.connection.write).toHaveBeenCalledTimes(1); expect(f.ack).not.toHaveBeenCalled(); expect(f.fail).not.toHaveBeenCalled();
    finish(); await Promise.all(f.tasks);
    expect(f.connection.write.mock.calls.map(call => call[0])).toEqual(['first', 'é😀'.repeat(250), 'after']);
    expect(f.connection.resize).toHaveBeenCalledWith(100, 40);
    expect(f.connection.write.mock.invocationCallOrder[1]).toBeLessThan(f.connection.resize.mock.invocationCallOrder[0]);
    expect(f.connection.resize.mock.invocationCallOrder[0]).toBeLessThan(f.connection.write.mock.invocationCallOrder[2]);
    expect(f.ack.mock.calls).toEqual([[5, 1], [1500, 501], [5, 502]]);
  });
  it('accepts a long paste as bounded frames with finite remote calls and exact byte accounting', async () => {
    vi.useFakeTimers(); const f = fixture(), chunk = '😀'.repeat(8192);
    for (let i = 1; i <= 6; i++) f.send(chunk, i);
    await vi.advanceTimersByTimeAsync(8); await Promise.all(f.tasks);
    expect(f.connection.write).toHaveBeenCalledTimes(6); expect(f.connection.write.mock.calls.map(call => call[0]).join('')).toBe(chunk.repeat(6));
    expect(f.ack.mock.calls.reduce((sum, call) => sum + call[0], 0)).toBe(Buffer.byteLength(chunk) * 6);
    expect(f.fail).not.toHaveBeenCalled();
  });
  it('explicitly rejects invalid, oversized, duplicate-sequence and overbudget input without remote execution', async () => {
    vi.useFakeTimers();
    for (const raw of ['invalid', '{"type":"input","data":1}', '{"type":"input","data":"\\ud800"}', JSON.stringify({ type: 'input', data: '😀'.repeat(8193) }), JSON.stringify({ type: 'input', data: 'x'.repeat(TERMINAL_FRAME_BYTES + 1) }), '{"type":"resize","cols":0,"rows":0}']) {
      const f = fixture(); f.input.receive(raw); await vi.advanceTimersByTimeAsync(8);
      expect(f.fail).toHaveBeenCalledTimes(1); expect(f.connection.write).not.toHaveBeenCalled();
    }
    const duplicate = fixture(); duplicate.send('x', 1); duplicate.send('x', 1); expect(duplicate.fail).toHaveBeenCalledOnce();
    const full = fixture(); for (let i = 0; i <= TERMINAL_QUEUE_BYTES / TERMINAL_FRAME_BYTES; i++) full.send('x'.repeat(TERMINAL_FRAME_BYTES));
    expect(full.fail).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(8); expect(full.connection.write).not.toHaveBeenCalled();
  });
  it('cancels scheduled and pending-authority input on close and never retries uncertain writes', async () => {
    vi.useFakeTimers(); const f = fixture(); f.send('cancelled'); f.input.close(); await vi.advanceTimersByTimeAsync(8); expect(f.connection.write).not.toHaveBeenCalled();
    const failed = fixture(); failed.connection.write.mockRejectedValueOnce(new Error('secret-provider-detail')); failed.send('uncertain'); failed.send('must not retry');
    await vi.advanceTimersByTimeAsync(8); await Promise.all(failed.tasks);
    expect(failed.connection.write).toHaveBeenCalledOnce(); expect(failed.fail).toHaveBeenCalledWith('Terminal input failed. Reconnect to retry.'); expect(failed.ack).not.toHaveBeenCalled();
  });
});
