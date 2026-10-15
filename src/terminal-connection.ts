export type TerminalPhase = 'connecting' | 'attaching' | 'connected' | 'reconnecting' | 'disconnected' | 'error';
export type TerminalState = { phase: TerminalPhase; message?: string };
export const INPUT_CHUNK_BYTES = 8192;
export const INPUT_BUFFER_BYTES = 256 * 1024;
const encoder = new TextEncoder();
const DISCARDED = 'Unsent or unconfirmed input was discarded and will not be replayed. Some input may already have run; inspect the terminal before retyping.';

// Cut by code point, so every encoded frame preserves complete surrogate pairs.
// 8 KiB also keeps JSON's worst-case escaping below the 64 KiB socket limit.
export function splitTerminalInput(data: string, limit = INPUT_CHUNK_BYTES): string[] {
  const chunks: string[] = [];
  let start = 0; let bytes = 0; let index = 0;
  for (const point of data) {
    const code = point.charCodeAt(0);
    const size = point.length === 2 ? 4 : code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
    if (bytes + size > limit && index > start) { chunks.push(data.slice(start, index)); start = index; bytes = 0; }
    bytes += size; index += point.length;
  }
  if (index > start) chunks.push(data.slice(start));
  return chunks;
}

export function terminalSocketPath(sessionId: string, shellId = 'codex') {
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/terminal`;
  return shellId === 'codex' ? path : `${path}?shell=${encodeURIComponent(shellId)}`;
}

type Operation = { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number };

// An attachment owns a bounded, ordered input queue. Only a provider ACK releases
// the next input frame. A replacement socket never inherits queued input.
export class TerminalAttachment {
  private socket?: WebSocket;
  private timeout?: ReturnType<typeof setTimeout>;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private ackTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private ready = false;
  private queue: Operation[] = [];
  private queuedBytes = 0;
  private outstanding = 0;
  private outstandingSequence = 0;
  private nextSequence = 1;
  private notice?: string;

  constructor(
    private readonly createSocket: () => WebSocket,
    private readonly onState: (state: TerminalState) => void,
    private readonly onOutput: (data: string) => void,
    private readonly onReady: () => void,
    private readonly timeoutMs = 20_000,
  ) {}

  connect(reconnecting = false) {
    if (this.disposed) return;
    if (this.queuedBytes || this.outstanding) this.notice = DISCARDED;
    this.detach();
    this.report(reconnecting ? 'reconnecting' : 'connecting');
    let socket: WebSocket;
    try { socket = this.createSocket(); }
    catch { this.fail('Unable to open the terminal connection. Check your connection and select Reconnect.'); return; }
    this.socket = socket;
    const current = () => !this.disposed && this.socket === socket;
    this.timeout = setTimeout(() => {
      if (current()) this.fail('Terminal attachment timed out. Check the machine is running, then select Reconnect.');
    }, this.timeoutMs);
    socket.onopen = () => { if (current()) this.report('attaching'); };
    socket.onmessage = event => {
      if (!current() || socket.readyState !== 1) return;
      let message: { type?: unknown; data?: unknown; message?: unknown; bytes?: unknown; sequence?: unknown; recoverable?: unknown };
      try { message = JSON.parse(event.data); }
      catch { this.fail('Unable to read the terminal response. Select Reconnect to try again.'); return; }
      if (!message || typeof message !== 'object') {
        this.fail('Unable to read the terminal response. Select Reconnect to try again.'); return;
      }
      if (message.type === 'ready' && !this.ready) {
        clearTimeout(this.timeout); this.timeout = undefined;
        this.ready = true;
        this.report('connected');
        this.onReady();
      } else if (message.type === 'input-ack') {
        if (!this.ready || !Number.isSafeInteger(message.bytes) || message.bytes !== this.outstanding || !this.outstanding || message.sequence !== this.outstandingSequence) {
          this.fail('Terminal input acknowledgement was invalid. Select Reconnect and inspect the terminal before retyping.'); return;
        }
        this.outstanding = 0; this.outstandingSequence = 0;
        clearTimeout(this.ackTimer); this.ackTimer = undefined;
        this.flush();
      } else if (message.type === 'output' && typeof message.data === 'string') {
        this.onOutput(message.data);
      } else if (message.type === 'exit') {
        this.fail(message.recoverable === false ? 'The terminal connection ended. Select Reconnect to check the shell, or refresh saved shells if it has stopped.' : 'The terminal connection ended. Select Reconnect to check the shell, or Recover shell if the primary shell has stopped.', 'disconnected');
      } else if (message.type === 'error') {
        const reason = typeof message.message === 'string' ? message.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300) : 'Terminal attachment failed.';
        this.fail(`${reason} Select Reconnect to try again.`);
      }
    };
    socket.onclose = () => {
      if (current()) this.fail('Terminal disconnected. Check the machine is still running and your sign-in is valid, then select Reconnect.', 'disconnected');
    };
    socket.onerror = () => {
      if (current()) this.fail('Terminal connection unavailable. Check your connection and select Reconnect.');
    };
  }

  input(data: string) {
    if (!this.available()) return false;
    if (!data) return true;
    // UTF-8 is at least as large as a string's UTF-16 length. Reject huge
    // clipboard values before allocating their encoded copy.
    if (data.length > INPUT_BUFFER_BYTES) {
      this.fail('Terminal input buffer is full. The new input was rejected. Select Reconnect and paste smaller sections.'); return false;
    }
    const last = this.queue.at(-1);
    const combined = last?.type === 'input' ? last.data + data : data;
    for (let index = 0; index < combined.length; ++index) {
      const code = combined.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        if (index === combined.length - 1) break;
        const low = combined.charCodeAt(++index);
        if (low >= 0xdc00 && low <= 0xdfff) continue;
      } else if (code < 0xdc00 || code > 0xdfff) continue;
      this.fail('Invalid Unicode terminal input was rejected. Select Reconnect before typing again.'); return false;
    }
    const bytes = encoder.encode(combined).length - (last?.type === 'input' ? encoder.encode(last.data).length : 0);
    if (this.queuedBytes + this.outstanding + bytes > INPUT_BUFFER_BYTES) {
      this.fail('Terminal input buffer is full. The new input was rejected. Select Reconnect and paste smaller sections.'); return false;
    }
    if (last?.type === 'input') last.data = combined;
    else this.queue.push({ type: 'input', data });
    this.queuedBytes += bytes;
    if (!this.outstanding) { clearTimeout(this.ackTimer); this.ackTimer = undefined; }
    return this.schedule();
  }

  resize(cols: number, rows: number) {
    if (!this.available()) return false;
    const last = this.queue.at(-1);
    const tail = last?.type === 'input' ? last.data.charCodeAt(last.data.length - 1) : 0;
    if (tail >= 0xd800 && tail <= 0xdbff) {
      this.fail('Incomplete Unicode input was rejected before resizing the terminal. Select Reconnect before typing again.'); return false;
    }
    if (last?.type === 'resize') { last.cols = cols; last.rows = rows; }
    else this.queue.push({ type: 'resize', cols, rows });
    return this.schedule();
  }

  unavailable(message: string) { if (!this.disposed) this.fail(message, 'disconnected'); }
  dispose() { this.disposed = true; this.detach(); }

  private available() { return !this.disposed && this.ready && this.socket?.readyState === 1; }
  private report(phase: TerminalPhase) { this.onState({ phase, ...(this.notice ? { message: this.notice } : {}) }); }
  private schedule() {
    if (this.queue.length > 128) { this.fail('Terminal input queue is full. Select Reconnect and wait for the terminal before typing.'); return false; }
    if (!this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = undefined; this.flush(); }, 8);
    return true;
  }
  private flush() {
    if (!this.available() || this.outstanding) return;
    while (this.queue.length && !this.outstanding) {
      const next = this.queue[0];
      let message: Operation = next;
      if (next.type === 'input') {
        let [chunk] = splitTerminalInput(next.data);
        // xterm may deliver a surrogate pair in separate callbacks. Hold its
        // trailing high half until the next callback instead of encoding U+FFFD.
        const tail = chunk.charCodeAt(chunk.length - 1);
        if (tail >= 0xd800 && tail <= 0xdbff) chunk = chunk.slice(0, -1);
        if (!chunk) {
          if (!this.ackTimer) this.ackTimer = setTimeout(() => this.fail('Incomplete Unicode input was rejected. Select Reconnect before typing again.'), 30_000);
          return;
        }
        message = { type: 'input', data: chunk };
        const bytes = encoder.encode(chunk).length;
        next.data = next.data.slice(chunk.length);
        this.queuedBytes -= bytes;
        this.outstanding = bytes;
        this.outstandingSequence = this.nextSequence++;
        if (!next.data) this.queue.shift();
      } else this.queue.shift();
      const frame = JSON.stringify(message.type === 'input' ? { ...message, sequence: this.outstandingSequence } : message);
      if ((this.socket!.bufferedAmount || 0) + encoder.encode(frame).length > 64 * 1024) { this.fail('Terminal connection is too slow to accept input. Select Reconnect and paste smaller sections.'); return; }
      try { this.socket!.send(frame); }
      catch { this.fail('Terminal input could not be sent. Select Reconnect before typing again.'); return; }
      if (this.outstanding) this.ackTimer = setTimeout(() => this.fail('Terminal input was not confirmed within 30 seconds. Select Reconnect and inspect the terminal before retyping.'), 30_000);
    }
  }

  private fail(message: string, phase: TerminalPhase = 'error') {
    if (this.queuedBytes || this.outstanding) this.notice = DISCARDED;
    this.detach();
    if (!this.disposed) this.onState({ phase, message: `${message}${this.notice ? ` ${this.notice}` : ''}` });
  }

  private detach() {
    this.ready = false;
    clearTimeout(this.timeout); this.timeout = undefined;
    clearTimeout(this.flushTimer); this.flushTimer = undefined;
    clearTimeout(this.ackTimer); this.ackTimer = undefined;
    this.queue = []; this.queuedBytes = 0; this.outstanding = 0; this.outstandingSequence = 0; this.nextSequence = 1;
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    socket.onopen = null; socket.onmessage = null; socket.onclose = null; socket.onerror = null;
    socket.close();
  }
}
