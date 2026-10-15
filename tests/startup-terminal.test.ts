import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sandbox } from 'e2b';
import { E2BProvider } from '../server/infra/e2b.js';

const stubs = vi.hoisted(() => ({ get: vi.fn(), run: vi.fn(), create: vi.fn(), sendInput: vi.fn(), resize: vi.fn(), kill: vi.fn(), disconnect: vi.fn() }));
vi.mock('e2b', async importOriginal => {
  const actual = await importOriginal<typeof import('e2b')>();
  return { ...actual, ApiClient: class { api = { GET: stubs.get }; },
    Sandbox: class extends actual.Sandbox {
      constructor(...args: ConstructorParameters<typeof actual.Sandbox>) {
        super(...args); Object.defineProperty(this, 'pty', { value: { create: stubs.create, sendInput: stubs.sendInput, resize: stubs.resize, kill: stubs.kill } });
        Object.defineProperty(this, 'commands', { value: { run: stubs.run } });
      }
    } };
});
const provider = () => new E2BProvider({ apiKey: 'test-only-key', templateId: 'test-template', gatewayUrl: 'https://gateway.example.test' });
const info = () => ({ sandboxID: 'sandbox-a', state: 'running', envdVersion: '0.4.0', envdAccessToken: 'test-only-token', lifecycle: { autoResume: false } });
beforeEach(() => {
  stubs.get.mockReset().mockResolvedValue({ data: info() });
  stubs.run.mockReset().mockResolvedValue({ exitCode: 0, stdout: '{"state":"open"}\nEPHEMERAL_SHELL_COMPLETE\n' });
  stubs.disconnect.mockReset().mockResolvedValue(undefined);
  stubs.create.mockReset().mockResolvedValue({ pid: 123, disconnect: stubs.disconnect });
  stubs.sendInput.mockReset().mockResolvedValue(undefined); stubs.resize.mockReset().mockResolvedValue(undefined); stubs.kill.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('manual terminal reconnect without VM lifecycle mutations', () => {
  it('uses bounded read-only detail lookup and a local client, preserves tmux, and never connects or extends the VM', async () => {
    const connect = vi.spyOn(Sandbox, 'connect'), timeout = vi.spyOn(Sandbox, 'setTimeout'), create = vi.spyOn(Sandbox, 'create');
    const terminal = await provider().connectTerminal('sandbox-a', () => {}, 100, 30);
    expect(stubs.get).toHaveBeenCalledWith('/sandboxes/{sandboxID}', { params: { path: { sandboxID: 'sandbox-a' } }, signal: expect.any(AbortSignal) });
    expect(stubs.create).toHaveBeenCalledWith(expect.objectContaining({ user: 'user', cwd: '/home/user/workspace', timeoutMs: 0 }));
    expect(new TextDecoder().decode(stubs.sendInput.mock.calls[0][1])).toBe("exec tmux attach-session -t '=ephemeral'\r");
    await terminal.write('test'); await terminal.resize(80, 24); await terminal.disconnect(); await terminal.disconnect();
    expect(stubs.disconnect).toHaveBeenCalledTimes(1); expect(stubs.kill).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled(); expect(timeout).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });

  it('declines paused, auto-resuming, unidentified, and missing sandboxes before any PTY', async () => {
    const connect = vi.spyOn(Sandbox, 'connect');
    const responses = [{ data: { ...info(), state: 'paused' } }, { data: { ...info(), lifecycle: { autoResume: true } } },
      { data: { ...info(), lifecycle: {} } }, { data: { ...info(), sandboxID: 'foreign' } }, { error: { code: 404 } }];
    for (const response of responses) {
      stubs.get.mockResolvedValueOnce(response);
      await expect(provider().connectTerminal('sandbox-a', () => {}, 100, 30)).rejects.toThrow();
    }
    expect(stubs.create).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
  });

  it('cleans up a failed tmux attachment without destroying its sandbox', async () => {
    const killSandbox = vi.spyOn(Sandbox, 'kill'); stubs.sendInput.mockRejectedValueOnce(new Error('private upstream failure'));
    await expect(provider().connectTerminal('sandbox-a', () => {}, 100, 30)).rejects.toThrow('Unable to attach sandbox terminal.');
    expect(stubs.disconnect).toHaveBeenCalledTimes(1); expect(stubs.kill).toHaveBeenCalledWith(123, expect.any(Object));
    expect(killSandbox).not.toHaveBeenCalled();
  });
});
