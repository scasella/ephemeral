import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { terminalHeartbeat } from '../server/terminal-heartbeat.js';
function socket() {
  const ws = new EventEmitter() as EventEmitter & { readyState: number; ping: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> };
  ws.readyState = WebSocket.OPEN; ws.ping = vi.fn(); ws.terminate = vi.fn(() => { ws.readyState = WebSocket.CLOSED; ws.emit('close'); });
  return ws;
}
afterEach(() => vi.useRealTimers());
it('requires matching pongs and reclaims unresponsive transports', async () => {
  vi.useFakeTimers(); const ws = socket(); terminalHeartbeat(ws as unknown as WebSocket, 40);
  await vi.advanceTimersByTimeAsync(40); expect(ws.ping).toHaveBeenCalledWith('1');
  ws.emit('pong', Buffer.from('unrelated')); await vi.advanceTimersByTimeAsync(40);
  expect(ws.terminate).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0); expect(ws.listenerCount('pong')).toBe(0);
});
it('keeps healthy connections and clears heartbeat timers and listeners on close or shutdown', async () => {
  vi.useFakeTimers(); const ws = socket(), stop = terminalHeartbeat(ws as unknown as WebSocket, 40);
  for (let i = 1; i <= 5; i++) { await vi.advanceTimersByTimeAsync(40); ws.emit('pong', Buffer.from(String(i))); }
  expect(ws.terminate).not.toHaveBeenCalled(); stop(); stop(); expect(vi.getTimerCount()).toBe(0); expect(ws.listenerCount('pong')).toBe(0);
  const closed = socket(); terminalHeartbeat(closed as unknown as WebSocket, 40); closed.emit('close'); expect(vi.getTimerCount()).toBe(0);
});
