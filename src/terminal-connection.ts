export type TerminalPhase = 'connecting' | 'attaching' | 'connected' | 'reconnecting' | 'error';
export type TerminalState = { phase: TerminalPhase; message?: string };

export function terminalSocketPath(sessionId: string, shellId = 'codex') {
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/terminal`;
  return shellId === 'codex' ? path : `${path}?shell=${encodeURIComponent(shellId)}`;
}

// This controller owns only the browser attachment. Replacing it never restarts
// the workspace or tmux, and input is sent immediately or discarded, never queued.
export class TerminalAttachment {
  private socket?: WebSocket;
  private timeout?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private ready = false;

  constructor(
    private readonly createSocket: () => WebSocket,
    private readonly onState: (state: TerminalState) => void,
    private readonly onOutput: (data: string) => void,
    private readonly onReady: () => void,
    private readonly timeoutMs = 20_000,
  ) {}

  connect(reconnecting = false) {
    if (this.disposed) return;
    this.detach();
    this.onState({ phase: reconnecting ? 'reconnecting' : 'connecting' });
    let socket: WebSocket;
    try { socket = this.createSocket(); }
    catch { this.fail('Unable to open the terminal connection. Check your connection and select Reconnect.'); return; }
    this.socket = socket;
    const current = () => !this.disposed && this.socket === socket;
    this.timeout = setTimeout(() => {
      if (current()) this.fail('Terminal attachment timed out after 20 seconds. Check the machine is running, then select Reconnect.');
    }, this.timeoutMs);
    socket.onopen = () => { if (current()) this.onState({ phase: 'attaching' }); };
    socket.onmessage = event => {
      if (!current() || socket.readyState !== 1) return;
      let message: { type?: unknown; data?: unknown; message?: unknown };
      try { message = JSON.parse(event.data); }
      catch { this.fail('Unable to read the terminal response. Select Reconnect to try again.'); return; }
      if (!message || typeof message !== 'object') {
        this.fail('Unable to read the terminal response. Select Reconnect to try again.'); return;
      }
      if (message.type === 'ready') {
        clearTimeout(this.timeout); this.timeout = undefined;
        this.ready = true;
        this.onState({ phase: 'connected' });
        this.onReady();
      } else if (message.type === 'output' && typeof message.data === 'string') {
        // Providers can emit startup output before their attachment is writable.
        this.onOutput(message.data);
      } else if (message.type === 'error') {
        this.fail(typeof message.message === 'string' ? `${message.message} Select Reconnect to try again.` : 'Terminal attachment failed. Select Reconnect to try again.');
      }
    };
    socket.onclose = () => {
      if (current()) this.fail('Terminal disconnected. Check the machine is still running and your sign-in is valid, then select Reconnect.');
    };
    socket.onerror = () => {
      if (current()) this.fail('Terminal connection unavailable. Check your connection and select Reconnect.');
    };
  }

  input(data: string) { return this.send({ type: 'input', data }); }
  resize(cols: number, rows: number) { return this.send({ type: 'resize', cols, rows }); }

  dispose() {
    this.disposed = true;
    this.detach();
  }

  private send(message: object) {
    if (this.disposed || !this.ready || this.socket?.readyState !== 1) return false;
    try { this.socket.send(JSON.stringify(message)); return true; }
    catch { this.fail('Terminal input could not be sent. Select Reconnect before typing again.'); return false; }
  }

  private fail(message: string) {
    this.detach();
    if (!this.disposed) this.onState({ phase: 'error', message });
  }

  private detach() {
    this.ready = false;
    clearTimeout(this.timeout); this.timeout = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    socket.onopen = null; socket.onmessage = null; socket.onclose = null; socket.onerror = null;
    socket.close();
  }
}
