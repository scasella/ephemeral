import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShellWorkspaceClient, mountedShells, operationCompleted, parsePendingShellOperation, parseShellSnapshot, reconcileShellSelection, shellNameValue, type ShellOperation, type ShellSnapshot, type WorkspaceShell } from './shell-workspace';
import { terminalSocketPath } from './terminal-connection';

const requestId = '95cfd762-c498-4860-9c85-64527670028b';
const shellId = 'd82db7c5-27f5-4cb3-bc01-01a2c05d8cea';
const primary: WorkspaceShell = { id: 'codex', name: 'Codex', kind: 'primary', state: 'open', requestId: null, error: null, createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z' };
const secondary: WorkspaceShell = { ...primary, id: shellId, name: 'Build logs', kind: 'supplemental', requestId };
const snapshot = (...shells: WorkspaceShell[]): ShellSnapshot => ({ mode: 'live', shells: [primary, ...shells], canCreate: shells.every(shell => shell.state === 'closed'), reason: null });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('shell request recovery', () => {
  it('rejects invalid names before saving an intent or issuing any request', async () => {
    const transport = vi.fn();
    const persist = vi.fn();
    const client = new ShellWorkspaceClient('machine', () => {}, transport, null, persist);
    for (const name of ['', '   ', 'bad\u0085name', 'bad\u0000name', '\uD800', '\uDC00', 'a'.repeat(81), '😀'.repeat(81)]) {
      await client.perform({ kind: 'create', requestId, name });
      expect(client.state.pending).toBeNull();
      expect(client.state.error).toContain('1–80 Unicode characters');
    }
    expect(transport).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    client.dispose();
  });
  it('settles a lost rename when the shell is permanently closed before its name is saved', async () => {
    const operation: ShellOperation = { kind: 'rename', requestId, shellId, name: 'Renamed logs' };
    const transport = vi.fn().mockRejectedValueOnce(new Error('lost reply')).mockResolvedValueOnce(snapshot({ ...secondary, state: 'closed' }));
    const persist = vi.fn();
    const client = new ShellWorkspaceClient('machine', () => {}, transport, null, persist);
    await client.perform(operation);
    expect(client.state.pending).toBeNull();
    expect(client.state.snapshot?.shells[1].name).toBe('Build logs');
    expect(client.state.snapshot?.canCreate).toBe(true);
    expect(persist).toHaveBeenLastCalledWith(null);
    client.dispose();
  });
  it('does not clear an intent or mount a target from a malformed mutation response', async () => {
    const malformed = snapshot({ ...secondary, id: '../different-shell' });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(malformed)))
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot()))));
    const operation: ShellOperation = { kind: 'create', requestId, name: 'Build logs' };
    const persist = vi.fn();
    const client = new ShellWorkspaceClient('machine', () => {}, undefined, null, persist);
    await client.perform(operation);
    expect(client.state.pending).toEqual(operation);
    expect(mountedShells(client.state.snapshot)).toEqual([]);
    expect(persist.mock.calls).toEqual([[operation]]);
    client.dispose();
  });
  it('coalesces read-only refreshes and removes a naturally exited shell only after saved closure is confirmed', async () => {
    const inspection = deferred<ShellSnapshot>();
    const transport = vi.fn().mockResolvedValueOnce(snapshot(secondary)).mockReturnValueOnce(inspection.promise);
    const client = new ShellWorkspaceClient('machine', () => {}, transport);
    await client.refresh();
    const poll = client.refresh();
    const visibleRefresh = client.refresh();
    expect(visibleRefresh).toBe(poll);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(mountedShells(client.state.snapshot).map(shell => shell.id)).toEqual([shellId]);
    expect(reconcileShellSelection(shellId, client.state.snapshot!)).toBe(shellId);
    inspection.resolve(snapshot({ ...secondary, state: 'closed' }));
    await poll;
    expect(mountedShells(client.state.snapshot)).toEqual([]);
    expect(reconcileShellSelection(shellId, client.state.snapshot!)).toBe('codex');
    expect(client.state.snapshot?.canCreate).toBe(true);
    expect(transport.mock.calls.every(call => call[0] === '/sessions/machine/shells' && call[1] === undefined)).toBe(true);
    client.dispose();
  });
  it('reconciles a lost create reply by request ID without opening another shell', async () => {
    const operation: ShellOperation = { kind: 'create', requestId, name: 'Build logs' };
    const transport = vi.fn().mockRejectedValueOnce(new Error('lost reply')).mockResolvedValueOnce(snapshot(secondary));
    const saved = vi.fn();
    const client = new ShellWorkspaceClient('machine', () => {}, transport, null, saved);
    await client.perform(operation);
    expect(transport.mock.calls.map(call => call[1])).toEqual([{ requestId, name: 'Build logs' }, undefined]);
    expect(client.state.pending).toBeNull();
    expect(client.state.snapshot?.shells[1].id).toBe(shellId);
    expect(saved.mock.calls).toEqual([[operation], [null]]);
    client.dispose();
  });
  it('retains an uncertain close and blocks a new create until saved closed metadata exists', async () => {
    const close: ShellOperation = { kind: 'close', requestId, shellId };
    const transport = vi.fn().mockRejectedValueOnce(new Error('lost reply')).mockResolvedValueOnce(snapshot({ ...secondary, state: 'uncertain' })).mockResolvedValueOnce(snapshot({ ...secondary, state: 'closed' }));
    const client = new ShellWorkspaceClient('machine', () => {}, transport);
    await client.perform(close);
    expect(client.state.pending).toEqual(close);
    expect(mountedShells(client.state.snapshot).map(shell => shell.id)).toEqual([shellId]);
    await client.perform({ kind: 'create', requestId: 'another-request', name: 'Another shell' });
    expect(transport).toHaveBeenCalledTimes(2);
    await client.refresh();
    expect(client.state.pending).toBeNull();
    expect(mountedShells(client.state.snapshot)).toEqual([]);
    expect(reconcileShellSelection(shellId, client.state.snapshot!)).toBe('codex');
    client.dispose();
  });
  it('explicit retry keeps the creation request ID when both POST and recovery GET fail', async () => {
    const operation: ShellOperation = { kind: 'create', requestId, name: 'Build logs' };
    const transport = vi.fn().mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(snapshot(secondary));
    const client = new ShellWorkspaceClient('machine', () => {}, transport);
    await client.perform(operation);
    expect(client.state.pending).toEqual(operation);
    await client.perform(client.state.pending!);
    expect(transport.mock.calls[0][1]).toEqual(transport.mock.calls[2][1]);
    expect(client.state.pending).toBeNull();
    client.dispose();
  });
  it('keeps an uncertain create identity even when a retry receives an authorization rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Sign in again.' }), { status: 401 })).mockResolvedValueOnce(new Response(JSON.stringify(snapshot()))));
    const operation: ShellOperation = { kind: 'create', requestId, name: 'Build logs' };
    const client = new ShellWorkspaceClient('machine', () => {}, undefined, operation);
    await client.perform(operation);
    expect(client.state.pending).toEqual(operation);
    expect(client.state.snapshot).toEqual(snapshot());
    client.dispose();
  });
  it('can explicitly close the uncertain shell from a lost create without opening a replacement', async () => {
    const create: ShellOperation = { kind: 'create', requestId, name: 'Build logs' };
    const transport = vi.fn().mockRejectedValueOnce(new Error('lost reply')).mockResolvedValueOnce(snapshot({ ...secondary, state: 'uncertain' })).mockResolvedValueOnce(snapshot({ ...secondary, state: 'closed' }));
    const client = new ShellWorkspaceClient('machine', () => {}, transport);
    await client.perform(create);
    await client.perform({ kind: 'close', requestId: 'a96bc9e4-0961-4672-900e-604d036f4731', shellId });
    expect(transport.mock.calls[2].slice(0, 2)).toEqual([`/sessions/machine/shells/${shellId}/close`, { confirm: true }]);
    expect(client.state.pending).toBeNull();
    client.dispose();
  });
  it('never applies a GET started before a mutation after the mutation completes', async () => {
    const old = deferred<ShellSnapshot>();
    const transport = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(snapshot(secondary));
    const client = new ShellWorkspaceClient('machine', () => {}, transport);
    const refresh = client.refresh();
    await client.perform({ kind: 'create', requestId, name: secondary.name });
    old.resolve(snapshot());
    await refresh;
    expect(client.state.snapshot).toEqual(snapshot(secondary));
    expect(client.state.loading).toBe(false);
    client.dispose();
  });
  it('aborts on unmount and ignores late metadata', async () => {
    const late = deferred<ShellSnapshot>();
    const changed = vi.fn();
    const transport = vi.fn().mockReturnValue(late.promise);
    const client = new ShellWorkspaceClient('machine', changed, transport);
    const refresh = client.refresh();
    const signal = transport.mock.calls[0][2] as AbortSignal;
    client.dispose();
    const notifications = changed.mock.calls.length;
    late.resolve(snapshot(secondary));
    await refresh;
    expect(signal.aborted).toBe(true);
    expect(changed).toHaveBeenCalledTimes(notifications);
    expect(client.state.snapshot).toBeNull();
  });
  it('bounds requests even when transport ignores abort and retains create identity', async () => {
    vi.useFakeTimers();
    const never = deferred<ShellSnapshot>();
    const transport = vi.fn().mockReturnValue(never.promise);
    const client = new ShellWorkspaceClient('machine', () => {}, transport, null, () => {}, 50);
    const operation: ShellOperation = { kind: 'create', requestId, name: 'Build logs' };
    const sent = client.perform(operation);
    await vi.advanceTimersByTimeAsync(101);
    await sent;
    expect(client.state.pending).toEqual(operation);
    expect(client.state.sending).toBe(false);
    expect(client.state.loading).toBe(false);
    expect(client.state.error).toContain('timed out');
    client.dispose();
  });
  it('protects primary shell mutations and rejects unrelated request metadata', async () => {
    const transport = vi.fn();
    const client = new ShellWorkspaceClient('machine', () => {}, transport);
    await client.perform({ kind: 'close', requestId, shellId: 'codex' });
    expect(transport).not.toHaveBeenCalled();
    expect(operationCompleted({ kind: 'create', requestId: 'other', name: 'Build logs' }, snapshot(secondary))).toBe(false);
    expect(parsePendingShellOperation(JSON.stringify({ kind: 'close', requestId, shellId: 'codex' }))).toBeNull();
    expect(parsePendingShellOperation(JSON.stringify({ kind: 'create', requestId, name: 'Build logs' }))).toEqual({ kind: 'create', requestId, name: 'Build logs' });
    client.dispose();
  });
  it('restores only canonical shell operations and preserves a pending rename across reload', () => {
    expect(parsePendingShellOperation(JSON.stringify({ kind: 'rename', requestId: requestId.toUpperCase(), shellId: shellId.toUpperCase(), name: '  Build logs  ' }))).toEqual({ kind: 'rename', requestId, shellId, name: 'Build logs' });
    expect(parsePendingShellOperation(JSON.stringify({ kind: 'close', requestId, shellId: 'not-a-shell' }))).toBeNull();
    expect(parsePendingShellOperation(JSON.stringify({ kind: 'create', requestId: '-'.repeat(36), name: 'Build logs' }))).toBeNull();
    expect(parsePendingShellOperation(JSON.stringify({ kind: 'create', requestId, name: 'Build\nlogs' }))).toBeNull();
    expect(parsePendingShellOperation(JSON.stringify({ kind: 'create', requestId, name: 'a'.repeat(80) }))?.name).toHaveLength(80);
    expect(parsePendingShellOperation(JSON.stringify({ kind: 'create', requestId, name: 'a'.repeat(81) }))).toBeNull();
  });
});

describe('Unicode shell names', () => {
  it.each(['😀'.repeat(41), '😀'.repeat(80), `${'a'.repeat(40)}${'😀'.repeat(40)}`, 'e\u0301'.repeat(40)])('preserves an accepted name through saved metadata and pending operations: %s', name => {
    expect(shellNameValue(`  ${name}  `)).toBe(name);
    const saved = JSON.parse(JSON.stringify(snapshot({ ...secondary, name })));
    expect(parseShellSnapshot(saved).shells[1].name).toBe(name);
    for (const kind of ['create', 'rename'] as const) {
      const operation = { kind, requestId, ...(kind === 'rename' ? { shellId } : {}), name: `  ${name}  ` };
      expect(parsePendingShellOperation(JSON.stringify(operation))).toEqual({ ...operation, name });
    }
  });

  it.each(['😀'.repeat(81), 'e\u0301'.repeat(41), '\uD800', '\uDC00', 'bad\uD800name', '\nShell', 'Shell\u0085'])('rejects invalid names in saved metadata and pending operations: %s', name => {
    expect(shellNameValue(name)).toBeNull();
    expect(() => parseShellSnapshot(snapshot({ ...secondary, name }))).toThrow('saved shell list');
    for (const kind of ['create', 'rename'] as const) {
      expect(parsePendingShellOperation(JSON.stringify({ kind, requestId, shellId, name }))).toBeNull();
    }
  });

  it('sends and settles an 80-code-point create without losing its intent or saved shell', async () => {
    const name = '😀'.repeat(80);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot({ ...secondary, name })))));
    const persist = vi.fn();
    const client = new ShellWorkspaceClient('machine', () => {}, undefined, null, persist);
    await client.perform({ kind: 'create', requestId, name: `  ${name}  ` });
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual({ requestId, name });
    expect(client.state.pending).toBeNull();
    expect(client.state.error).toBe('');
    expect(mountedShells(client.state.snapshot)[0].name).toBe(name);
    expect(persist).toHaveBeenLastCalledWith(null);
    client.dispose();
  });
});

it('validates saved identities, kinds, lifecycle states, names and request IDs before accepting metadata', () => {
  expect(parseShellSnapshot(snapshot(secondary))).toEqual(snapshot(secondary));
  expect(parseShellSnapshot(snapshot({ ...secondary, id: shellId.toUpperCase(), requestId: requestId.toUpperCase() })).shells[1]).toEqual(secondary);
  for (const change of [{ id: 'arbitrary' }, { kind: 'primary' }, { kind: 'other' }, { state: 'connected' }, { name: 'bad\u0085label' }, { name: 'a'.repeat(81) }, { requestId: 'not-a-UUID' }, { requestId: null }]) {
    expect(() => parseShellSnapshot(snapshot({ ...secondary, ...change } as WorkspaceShell))).toThrow('saved shell list');
  }
  expect(() => parseShellSnapshot({ ...snapshot(), shells: [primary, null] })).toThrow('saved shell list');
  expect(() => parseShellSnapshot(snapshot(secondary, secondary))).toThrow('saved shell list');
});

it('routes Codex compatibly and reconnects secondary to its exact encoded identity', () => {
  expect(terminalSocketPath('machine /id')).toBe('/api/sessions/machine%20%2Fid/terminal');
  expect(terminalSocketPath('machine', shellId)).toBe(`/api/sessions/machine/terminal?shell=${shellId}`);
  expect(terminalSocketPath('machine', 'bad&shell')).toBe('/api/sessions/machine/terminal?shell=bad%26shell');
});

describe('explicit primary shell recovery', () => {
  it('sends one strict recovery request, blocks competing operations, and accepts only an open primary reply', async () => {
    const reply = deferred<ShellSnapshot>();
    const transport = vi.fn().mockReturnValue(reply.promise);
    const persist = vi.fn();
    const client = new ShellWorkspaceClient('machine /id', () => {}, transport, null, persist);
    expect(transport).not.toHaveBeenCalled();
    const recovery = client.recoverPrimary();
    expect(client.state.recoveringPrimary).toBe(true);
    expect(client.state.sending).toBe(true);
    await client.recoverPrimary(); await client.refresh();
    await client.perform({ kind: 'create', requestId, name: 'Shell' });
    expect(transport).toHaveBeenCalledExactlyOnceWith('/sessions/machine%20%2Fid/shells/codex/recover', {}, expect.any(AbortSignal));
    reply.resolve(snapshot(secondary));
    expect(await recovery).toBe(true);
    expect(client.state.snapshot).toEqual(snapshot(secondary));
    expect(client.state.recoveringPrimary).toBe(false);
    expect(client.state.sending).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    client.dispose();
  });

  it('keeps failure actionable and permits another explicit recovery without automatically retrying', async () => {
    const transport = vi.fn().mockRejectedValueOnce(new Error('Shell could not be inspected.')).mockResolvedValueOnce(snapshot());
    const client = new ShellWorkspaceClient('machine', () => {}, transport);
    expect(await client.recoverPrimary()).toBe(false);
    expect(client.state.error).toContain('Reconnect to check');
    expect(client.state.sending).toBe(false);
    expect(client.state.recoveringPrimary).toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await client.recoverPrimary()).toBe(true);
    expect(client.state.error).toBe('');
    client.dispose();
  });

  it('does not report recovery success for a dead primary, stale reads, or a disposed workspace', async () => {
    const old = deferred<ShellSnapshot>();
    const transport = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(snapshot());
    const client = new ShellWorkspaceClient('machine', () => {}, transport);
    const refresh = client.refresh();
    expect(await client.recoverPrimary()).toBe(true);
    old.resolve({ ...snapshot(), shells: [{ ...primary, state: 'closed' }] }); await refresh;
    expect(client.state.snapshot?.shells[0].state).toBe('open');
    client.dispose();
    const dead = new ShellWorkspaceClient('machine', () => {}, vi.fn().mockResolvedValue({ ...snapshot(), shells: [{ ...primary, state: 'closed' }] }));
    expect(await dead.recoverPrimary()).toBe(false);
    expect(dead.state.error).toContain('not ready'); dead.dispose();
    const late = deferred<ShellSnapshot>(); const notify = vi.fn();
    const disposed = new ShellWorkspaceClient('machine', notify, vi.fn().mockReturnValue(late.promise));
    const request = disposed.recoverPrimary(); disposed.dispose(); const count = notify.mock.calls.length;
    late.resolve(snapshot());
    expect(await request).toBe(false);
    expect(notify).toHaveBeenCalledTimes(count);
  });
});
