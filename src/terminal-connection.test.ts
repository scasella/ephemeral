import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalAttachment } from './terminal-connection';

class FakeSocket {
  readyState = 0;
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
    expect(socket.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: 'input', data: 'new command' }));
    attachment.dispose();
  });

  it('reconnects only the attachment and drops unavailable input without replay', () => {
    const { attachment, sockets, state } = setup(); const first = sockets[0];
    first.open(); first.message({ type: 'ready' }); attachment.input('first command');
    attachment.connect(true);
    expect(first.close).toHaveBeenCalledTimes(1); expect(state).toHaveBeenLastCalledWith({ phase: 'reconnecting' });
    expect(attachment.input('discard this')).toBe(false);
    const second = sockets[1]; second.open(); expect(attachment.input('also discard')).toBe(false);
    second.message({ type: 'ready' });
    expect(second.send).not.toHaveBeenCalled();
    attachment.input('fresh command');
    expect(second.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: 'input', data: 'fresh command' }));
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
    expect(state).toHaveBeenLastCalledWith({ phase: 'error', message: expect.stringContaining('Reconnect') });
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
