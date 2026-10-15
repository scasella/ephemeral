import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INPUT_BUFFER_BYTES, INPUT_CHUNK_BYTES, splitTerminalInput, TerminalAttachment } from './terminal-connection';

class FakeSocket {
  readyState = 0;
  bufferedAmount = 0;
  onopen: WebSocket['onopen'] = null;
  onmessage: WebSocket['onmessage'] = null;
  onclose: WebSocket['onclose'] = null;
  onerror: WebSocket['onerror'] = null;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; });
  asSocket() { return this as unknown as WebSocket; }
  open() { this.readyState = 1; this.onopen?.call(this.asSocket(), new Event('open')); }
  message(value: object) { this.onmessage?.call(this.asSocket(), new MessageEvent('message', { data: JSON.stringify(value) })); }
  disconnect() { this.readyState = 3; this.onclose?.call(this.asSocket(), new CloseEvent('close')); }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const createSocket = vi.fn(() => { const socket = new FakeSocket(); sockets.push(socket); return socket.asSocket(); });
  const state = vi.fn(); const output = vi.fn(); const ready = vi.fn();
  const attachment = new TerminalAttachment(createSocket, state, output, ready);
  attachment.connect();
  return { attachment, sockets, createSocket, state, output, ready };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('terminal attachment recovery', () => {
  it('displays early output but enables input and resize only after explicit ready', () => {
    const { attachment, sockets, state, output, ready } = setup(); const socket = sockets[0];
    expect(attachment.input('before open')).toBe(false);
    socket.open(); socket.message({ type: 'output', data: 'Signing in…' });
    expect(state).toHaveBeenLastCalledWith({ phase: 'attaching' });
    expect(output).toHaveBeenCalledWith('Signing in…'); expect(ready).not.toHaveBeenCalled();
    expect(attachment.input('early command')).toBe(false); expect(attachment.resize(100, 30)).toBe(false);
    expect(socket.send).not.toHaveBeenCalled();
    socket.message({ type: 'ready' });
    expect(state).toHaveBeenLastCalledWith({ phase: 'connected' }); expect(ready).toHaveBeenCalledTimes(1);
    expect(attachment.input('new command')).toBe(true);
    vi.advanceTimersByTime(8);
    expect(socket.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: 'input', data: 'new command', sequence: 1 }));
    attachment.dispose();
  });

  it('reconnects only the attachment and drops unavailable input without replay', () => {
    const { attachment, sockets, state } = setup(); const first = sockets[0];
    first.open(); first.message({ type: 'ready' }); attachment.input('first command');
    attachment.connect(true);
    expect(first.close).toHaveBeenCalledTimes(1); expect(state).toHaveBeenLastCalledWith({ phase: 'reconnecting', message: expect.stringContaining('will not be replayed') });
    expect(attachment.input('discard this')).toBe(false);
    const second = sockets[1]; second.open(); expect(attachment.input('also discard')).toBe(false);
    second.message({ type: 'ready' });
    expect(second.send).not.toHaveBeenCalled();
    attachment.input('fresh command');
    vi.advanceTimersByTime(8);
    expect(second.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: 'input', data: 'fresh command', sequence: 1 }));
    attachment.dispose();
  });

  it('ignores old socket events even when their handlers were already queued', () => {
    const { attachment, sockets, state, output, ready } = setup(); const first = sockets[0]; first.open();
    const lateMessage = first.onmessage!; const lateClose = first.onclose!; const lateOpen = first.onopen!;
    attachment.connect(true);
    first.readyState = 1;
    lateOpen.call(first.asSocket(), new Event('open'));
    lateMessage.call(first.asSocket(), new MessageEvent('message', { data: '{"type":"ready"}' }));
    lateMessage.call(first.asSocket(), new MessageEvent('message', { data: '{"type":"output","data":"old output"}' }));
    lateClose.call(first.asSocket(), new CloseEvent('close'));
    expect(state).toHaveBeenLastCalledWith({ phase: 'reconnecting' });
    expect(output).not.toHaveBeenCalled(); expect(ready).not.toHaveBeenCalled();
    expect(attachment.input('too early')).toBe(false); attachment.dispose();
  });

  it.each([false, true])('bounds a stuck connection or provider attachment (socket open: %s)', async open => {
    vi.useFakeTimers(); const { attachment, sockets, state, createSocket } = setup();
    if (open) sockets[0].open();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state).toHaveBeenLastCalledWith({ phase: 'error', message: expect.stringContaining('timed out') });
    expect(sockets[0].close).toHaveBeenCalledTimes(1); expect(attachment.input('discard')).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000); expect(createSocket).toHaveBeenCalledTimes(1);
    attachment.connect(true); sockets[1].open(); sockets[1].message({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(20_000); expect(state).toHaveBeenLastCalledWith({ phase: 'connected' });
    attachment.dispose();
  });

  it('removes input readiness after a disconnect and permits a manual retry', () => {
    const { attachment, sockets, state } = setup(); sockets[0].open(); sockets[0].message({ type: 'ready' });
    sockets[0].disconnect();
    expect(state).toHaveBeenLastCalledWith({ phase: 'disconnected', message: expect.stringContaining('Reconnect') });
    expect(attachment.input('discard')).toBe(false);
    attachment.connect(true); sockets[1].open(); sockets[1].message({ type: 'ready' });
    expect(attachment.input('retry command')).toBe(true); attachment.dispose();
  });

  it('ignores all events after cleanup and cancels its timeout', async () => {
    vi.useFakeTimers(); const { attachment, sockets, state, output, ready, createSocket } = setup();
    const socket = sockets[0]; socket.open(); const lateMessage = socket.onmessage!; const lateClose = socket.onclose!;
    attachment.dispose(); const count = state.mock.calls.length;
    socket.readyState = 1;
    lateMessage.call(socket.asSocket(), new MessageEvent('message', { data: '{"type":"ready"}' }));
    lateMessage.call(socket.asSocket(), new MessageEvent('message', { data: '{"type":"output","data":"late"}' }));
    lateClose.call(socket.asSocket(), new CloseEvent('close'));
    await vi.advanceTimersByTimeAsync(30_000); attachment.connect(true);
    expect(state).toHaveBeenCalledTimes(count); expect(output).not.toHaveBeenCalled(); expect(ready).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledTimes(1); expect(socket.onmessage).toBeNull();
    expect(attachment.input('discard')).toBe(false); expect(createSocket).toHaveBeenCalledTimes(1);
  });
});

const sent = (socket: FakeSocket): { type: string; data?: string; cols?: number; bytes?: number; sequence?: number }[] => socket.send.mock.calls.map(([frame]) => JSON.parse(frame));
const ack = (socket: FakeSocket, bytes: number) => socket.message({ type: 'input-ack', bytes, sequence: sent(socket).filter(message => message.type === 'input').at(-1)?.sequence });
const byteLength = (data: string) => new TextEncoder().encode(data).length;
function connected() { const value = setup(); value.sockets[0].open(); value.sockets[0].message({ type: 'ready' }); return { ...value, socket: value.sockets[0] }; }

describe('bounded terminal input', () => {
  it('batches normal typing within eight milliseconds and preserves resize ordering behind provider acknowledgement', () => {
    const { attachment, socket } = connected();
    for (const key of 'hello') attachment.input(key);
    expect(socket.send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(8);
    expect(sent(socket)).toEqual([{ type: 'input', data: 'hello', sequence: 1 }]);
    attachment.resize(100, 30); attachment.input('world'); attachment.resize(120, 40);
    vi.advanceTimersByTime(200);
    expect(socket.send).toHaveBeenCalledTimes(1);
    ack(socket, 5);
    expect(sent(socket)).toEqual([{ type: 'input', data: 'hello', sequence: 1 }, { type: 'resize', cols: 100, rows: 30 }, { type: 'input', data: 'world', sequence: 2 }]);
    ack(socket, 5);
    expect(sent(socket).at(-1)).toEqual({ type: 'resize', cols: 120, rows: 40 });
    attachment.dispose();
  });

  it('reconstructs a long bracketed Unicode paste exactly through delayed provider ACKs with one frame in flight', () => {
    const { attachment, socket } = connected();
    const paste = '\x1b[200~' + '🙂漢字é\n\u0000'.repeat(9000) + '\x1b[201~';
    expect(byteLength(paste)).toBeGreaterThan(64 * 1024);
    expect(attachment.input(paste)).toBe(true);
    vi.advanceTimersByTime(8);
    let reconstructed = '';
    let count = 0;
    while (reconstructed.length < paste.length) {
      const message = sent(socket).at(-1)!;
      const data = message.data!;
      expect(message.type).toBe('input');
      expect(byteLength(data)).toBeLessThanOrEqual(INPUT_CHUNK_BYTES);
      expect(byteLength(socket.send.mock.calls.at(-1)![0])).toBeLessThan(64 * 1024);
      expect(new TextDecoder().decode(new TextEncoder().encode(data)) === data).toBe(true);
      reconstructed += data; ++count;
      vi.advanceTimersByTime(150);
      expect(socket.send).toHaveBeenCalledTimes(count);
      ack(socket, byteLength(data));
    }
    expect(reconstructed).toBe(paste);
    expect(socket.send).toHaveBeenCalledTimes(count);
    attachment.dispose();
  });

  it('handles UTF-8 chunk boundaries and surrogate halves delivered in separate callbacks', () => {
    const data = 'a'.repeat(INPUT_CHUNK_BYTES - 1) + '😀' + '\x1b[200~🙂\x1b[201~';
    const chunks = splitTerminalInput(data);
    expect(chunks.join('')).toBe(data);
    expect(chunks.every(chunk => byteLength(chunk) <= INPUT_CHUNK_BYTES && (new TextDecoder().decode(new TextEncoder().encode(chunk)) === chunk))).toBe(true);
    const { attachment, socket } = connected();
    attachment.input('\ud83d'); vi.advanceTimersByTime(8);
    expect(socket.send).not.toHaveBeenCalled();
    attachment.input('\ude00'); vi.advanceTimersByTime(8);
    expect(sent(socket)).toEqual([{ type: 'input', data: '😀', sequence: 1 }]);
    ack(socket, 4);
    vi.advanceTimersByTime(30_001);
    expect(socket.close).not.toHaveBeenCalled();
    attachment.dispose();
  });

  it('rejects an incomplete character interrupted by resize immediately without reordering or waiting for timeout', () => {
    const { attachment, socket, state } = connected();
    attachment.input('\ud83d');
    expect(attachment.resize(100, 30)).toBe(false);
    expect(state).toHaveBeenLastCalledWith({ phase: 'error', message: expect.stringContaining('Incomplete Unicode input was rejected before resizing') });
    expect(attachment.input('\ude00')).toBe(false);
    vi.advanceTimersByTime(30_001);
    expect(socket.send).not.toHaveBeenCalled();
    attachment.dispose();
  });

  it('rejects malformed Unicode visibly instead of replacing surrogate data silently', () => {
    for (const invalid of ['\ude00', '\ud83dx', '\ud83d\ud83d']) {
      const { attachment, socket, state } = connected();
      expect(attachment.input(invalid)).toBe(false);
      expect(state).toHaveBeenLastCalledWith({ phase: 'error', message: expect.stringContaining('Unicode terminal input was rejected') });
      vi.advanceTimersByTime(8);
      expect(socket.send).not.toHaveBeenCalled(); attachment.dispose();
    }
  });

  it('rejects huge clipboard values before allocating an encoded copy', () => {
    const { attachment, state } = connected();
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    expect(attachment.input('x'.repeat(INPUT_BUFFER_BYTES + 1))).toBe(false);
    expect(encode).not.toHaveBeenCalled();
    expect(state).toHaveBeenLastCalledWith({ phase: 'error', message: expect.stringContaining('rejected') });
    encode.mockRestore(); attachment.dispose();
  });

  it('coalesces high latency typing instead of overflowing the server message queue', () => {
    const { attachment, socket } = connected();
    let typed = '';
    for (let batch = 0; batch < 4; ++batch) {
      for (let key = 0; key < 100; ++key) { attachment.input('x'); typed += 'x'; vi.advanceTimersByTime(2); }
      const previous = sent(socket).at(-1)!;
      ack(socket, byteLength(previous.data!));
    }
    let acknowledged = 4;
    while (sent(socket).length > acknowledged) {
      const next = sent(socket)[acknowledged++];
      ack(socket, byteLength(next.data!));
    }
    expect(sent(socket).map(message => message.data || '').join('')).toBe(typed);
    expect(socket.send.mock.calls.length).toBeLessThan(10);
    attachment.dispose();
  });

  it('rejects overflow visibly, discards queued input, and never replays it on a replacement socket', () => {
    const { attachment, socket, sockets, state } = connected();
    attachment.input('x'); vi.advanceTimersByTime(8);
    attachment.input('q'.repeat(INPUT_BUFFER_BYTES - 1));
    expect(attachment.input('one more')).toBe(false);
    expect(state).toHaveBeenLastCalledWith({ phase: 'error', message: expect.stringMatching(/buffer is full.*rejected.*will not be replayed/) });
    attachment.connect(true); sockets[1].open(); sockets[1].message({ type: 'ready' });
    vi.advanceTimersByTime(50);
    expect(sockets[1].send).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledTimes(1);
    attachment.dispose();
  });

  it('ignores queued old ACKs and discards queued input on socket replacement and disposal', () => {
    const { attachment, socket, sockets, state } = connected();
    attachment.input('old'); vi.advanceTimersByTime(8); attachment.input('unsent');
    const oldMessage = socket.onmessage!;
    attachment.connect(true);
    const next = sockets[1]; next.open(); next.message({ type: 'ready' });
    attachment.input('new'); vi.advanceTimersByTime(8); attachment.input('later');
    socket.readyState = 1;
    oldMessage.call(socket.asSocket(), new MessageEvent('message', { data: '{"type":"input-ack","bytes":3,"sequence":1}' }));
    expect(next.send).toHaveBeenCalledTimes(1);
    expect(state).toHaveBeenLastCalledWith({ phase: 'connected', message: expect.stringContaining('will not be replayed') });
    attachment.dispose(); vi.advanceTimersByTime(30_001);
    expect(next.send).toHaveBeenCalledTimes(1);
  });

  it('times out stalled provider acknowledgements and handles rejection without sending queued input', () => {
    const { attachment, socket, state } = connected();
    attachment.input('maybe'); vi.advanceTimersByTime(8); attachment.input('never replay');
    vi.advanceTimersByTime(30_000);
    expect(state).toHaveBeenLastCalledWith({ phase: 'error', message: expect.stringMatching(/not confirmed.*may already have run/) });
    expect(socket.send).toHaveBeenCalledTimes(1);
    attachment.dispose();
    const rejected = connected(); rejected.attachment.input('bad'); vi.advanceTimersByTime(8);
    rejected.socket.message({ type: 'error', message: 'Terminal input rejected.' });
    expect(rejected.state).toHaveBeenLastCalledWith({ phase: 'error', message: expect.stringMatching(/rejected.*will not be replayed/) });
    rejected.attachment.dispose();
  });

  it('bounds the browser socket buffer and stops on invalid ACKs', () => {
    const { attachment, socket, state } = connected();
    socket.bufferedAmount = 64 * 1024;
    attachment.input('new'); vi.advanceTimersByTime(8);
    expect(socket.send).not.toHaveBeenCalled();
    expect(state).toHaveBeenLastCalledWith({ phase: 'error', message: expect.stringContaining('too slow') });
    attachment.dispose();
    const invalid = connected(); invalid.attachment.input('x'); vi.advanceTimersByTime(8);
    invalid.socket.message({ type: 'input-ack', bytes: 2, sequence: 1 });
    expect(invalid.state).toHaveBeenLastCalledWith({ phase: 'error', message: expect.stringContaining('acknowledgement was invalid') });
    invalid.attachment.dispose();
  });

  it('rejects a duplicate ACK with the same byte count without releasing the next frame', () => {
    const { attachment, socket, state } = connected();
    attachment.input('one'); vi.advanceTimersByTime(8); attachment.input('two');
    socket.message({ type: 'input-ack', bytes: 3, sequence: 1 });
    attachment.input('three');
    expect(sent(socket).map(message => message.sequence)).toEqual([1, 2]);
    socket.message({ type: 'input-ack', bytes: 3, sequence: 1 });
    expect(socket.send).toHaveBeenCalledTimes(2);
    expect(state).toHaveBeenLastCalledWith({ phase: 'error', message: expect.stringContaining('acknowledgement was invalid') });
    attachment.dispose();
  });

  it('reports a provider exit as disconnected and requires a fresh explicit ready after retry', () => {
    const { attachment, socket, sockets, state } = connected();
    socket.message({ type: 'exit', message: 'Connection ended', recoverable: true });
    expect(state).toHaveBeenLastCalledWith({ phase: 'disconnected', message: expect.stringContaining('Recover shell') });
    expect(attachment.input('disabled')).toBe(false);
    attachment.connect(true); sockets[1].open();
    expect(state).toHaveBeenLastCalledWith({ phase: 'attaching' });
    expect(attachment.input('still disabled')).toBe(false);
    sockets[1].message({ type: 'ready' });
    expect(state).toHaveBeenLastCalledWith({ phase: 'connected' });
    attachment.dispose();
  });
});
