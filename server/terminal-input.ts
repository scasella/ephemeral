import type { TerminalConnection } from './contracts.js';

export const TERMINAL_FRAME_BYTES = 32_768;
export const TERMINAL_QUEUE_BYTES = 256 * 1024;
type Operation = { type: 'input'; data: string; bytes: number; sequence?: number } | { type: 'resize'; cols: number; rows: number };

/** A bounded, ordered attachment queue. ACKs mean successful remote writes only. */
export function terminalInput(options: {
  connection: () => TerminalConnection | undefined;
  allowed: () => Promise<boolean>;
  ack: (bytes: number, sequence?: number) => void;
  fail: (message: string) => void;
  track: (task: Promise<void>) => unknown;
}) {
  let queue: Operation[] = [], bytes = 0, stopped = false, draining = false, lastSequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function close() { stopped = true; clearTimeout(timer); timer = undefined; queue = []; }
  function fail(message: string) { if (stopped) return; close(); options.fail(message); }
  async function drain() {
    if (draining || stopped) return;
    draining = true;
    try {
      while (!stopped && queue.length) {
        if (!await options.allowed()) { fail('Terminal is unavailable. Reconnect to retry.'); return; }
        const connection = options.connection();
        if (stopped || !connection) return;
        const next = queue.shift()!;
        if (next.type === 'input') {
          await connection.write(next.data);
          bytes -= next.bytes;
          if (!stopped) options.ack(next.bytes, next.sequence);
        } else await connection.resize(next.cols, next.rows);
      }
    } catch { fail('Terminal input failed. Reconnect to retry.'); }
    finally { draining = false; }
  }
  function receive(raw: string, binary = false) {
    if (stopped) return;
    let message: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(raw);
      if (binary || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      message = value as Record<string, unknown>;
    } catch { fail('Invalid terminal message. Reconnect to retry.'); return; }
    if (message.type === 'input') {
      if (Object.keys(message).some(key => !['type', 'data', 'sequence'].includes(key)) || typeof message.data !== 'string' || /[\uD800-\uDFFF]/u.test(message.data) ||
        (message.sequence !== undefined && (!Number.isSafeInteger(message.sequence) || (message.sequence as number) <= lastSequence))) {
        fail('Invalid terminal input. Reconnect to retry.'); return;
      }
      const size = Buffer.byteLength(message.data, 'utf8');
      if (!size || size > TERMINAL_FRAME_BYTES || bytes + size > TERMINAL_QUEUE_BYTES) {
        fail('Terminal input limit exceeded. Reconnect and send a smaller paste.'); return;
      }
      if (message.sequence !== undefined) lastSequence = message.sequence as number;
      const sequence = message.sequence as number | undefined;
      bytes += size;
      const last = queue.at(-1);
      if (last?.type === 'input' && last.bytes + size <= TERMINAL_FRAME_BYTES) { last.data += message.data; last.bytes += size; last.sequence = sequence; }
      else queue.push({ type: 'input', data: message.data, bytes: size, sequence });
    } else if (message.type === 'resize') {
      if (Object.keys(message).length !== 3 || !Number.isInteger(message.cols) || !Number.isInteger(message.rows) ||
        (message.cols as number) < 10 || (message.cols as number) > 400 || (message.rows as number) < 2 || (message.rows as number) > 200) {
        fail('Invalid terminal size. Reconnect to retry.'); return;
      }
      const next = { type: 'resize' as const, cols: message.cols as number, rows: message.rows as number };
      if (queue.at(-1)?.type === 'resize') queue[queue.length - 1] = next;
      else if (queue.length >= 1024) { fail('Terminal input limit exceeded. Reconnect to retry.'); return; }
      else queue.push(next);
    } else { fail('Invalid terminal message. Reconnect to retry.'); return; }
    if (!draining && !timer) timer = setTimeout(() => { timer = undefined; options.track(drain()); }, 8);
  }
  return { receive, close };
}
