import { WebSocket } from 'ws';

/** Ping at a fixed cadence; require the matching pong before the next ping. */
export function terminalHeartbeat(ws: WebSocket, intervalMs = 30_000): () => void {
  let awaiting: string | undefined, sequence = 0;
  const pong = (data: Buffer) => { if (awaiting === data.toString()) awaiting = undefined; };
  ws.on('pong', pong);
  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) { stop(); return; }
    if (awaiting !== undefined) { stop(); ws.terminate(); return; }
    awaiting = String(++sequence);
    try { ws.ping(awaiting); } catch { stop(); ws.terminate(); }
  }, intervalMs);
  timer.unref();
  function stop() { clearInterval(timer); ws.off('pong', pong); ws.off('close', stop); }
  ws.once('close', stop);
  return stop;
}
