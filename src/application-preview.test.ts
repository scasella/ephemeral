import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationPreview, ApplicationReadinessResult, PrivatePreviewForm } from './ApplicationPreview';
import { ApplicationPreviewClient, parsePreviewPort, previewUnavailableReason, validatePreviewHandoff, validatePreviewMetadata, validateViewerOrigin, type PreviewHandoff, type PreviewMetadata } from './application-preview';
import type { Session } from './api';
import { previewUnavailablePresentation } from './preview-presentation';
import { readinessIsStale, requestApplicationPreviewCheck, validateApplicationPreviewCheck, type ApplicationPreviewCheck } from './preview-readiness';

const workspaceOrigin = 'https://workspace.test', baseOrigin = 'https://private-viewer.test';
const generationOrigin = (generation: string, base = baseOrigin) => { const url = new URL(base); url.hostname = `${generation}.${url.hostname}`; return url.origin; };
const viewerOrigin = generationOrigin('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const now = Date.parse('2026-10-14T12:00:00Z');
const initial: PreviewMetadata = { mode: 'live', state: 'disabled', port: null, generation: null, updatedAt: null, reason: null, viewerOrigin: baseOrigin };
const enabled: PreviewMetadata = { ...initial, state: 'enabled', viewerOrigin, port: 3000, generation: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', updatedAt: new Date(now).toISOString() };
const handoff: PreviewHandoff = { action: `${viewerOrigin}/__ephemeral/open`, token: 'x'.repeat(43), expiresAt: new Date(now + 60_000).toISOString(), port: 3000, generation: enabled.generation! };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; };
const responded: ApplicationPreviewCheck = { state: 'responded', port: 3000, checkedAt: new Date(now).toISOString(), httpStatus: 200, reason: 'The application root responded.', remedy: null };
const createClient = (request = vi.fn(), publish = vi.fn(), accepts: () => boolean = () => true, timeout = 20_000) => new ApplicationPreviewClient('machine/id', workspaceOrigin, publish, accepts, request, timeout, () => Date.now());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('explicit application reachability checks', () => {
  it('does not check automatically, enable access, or prepare an opening', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const request = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(enabled).mockResolvedValueOnce(responded), client = createClient(request);
    await client.check(); expect(request).not.toHaveBeenCalled();
    await client.refresh(); await client.check(); expect(request).toHaveBeenCalledTimes(1);
    await client.refresh(); expect(client.state.readiness).toBeNull();
    await client.check();
    expect(request.mock.calls.map(call => call.slice(0, 2))).toEqual([['/sessions/machine%2Fid/preview', undefined], ['/sessions/machine%2Fid/preview', undefined], ['/sessions/machine%2Fid/preview/check', {}]]);
    expect(client.state.readiness).toEqual(responded); expect(client.state.handoff).toBeNull(); expect(client.state.snapshot).toEqual(enabled); client.dispose();
  });
  it('bounds check failure without changing confirmed saved access or retrying', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const request = vi.fn().mockResolvedValueOnce(enabled).mockResolvedValueOnce(responded).mockRejectedValueOnce(new Error('secret upstream output')), client = createClient(request);
    await client.refresh(); await client.check(); await client.check();
    expect(client.state.readiness?.state).toBe('unknown'); expect(client.state.readiness?.httpStatus).toBeNull(); expect(JSON.stringify(client.state)).not.toContain('secret');
    expect(client.state.confirmed).toBe(true); expect(request).toHaveBeenCalledTimes(3); client.dispose();
    const timeoutRequest = vi.fn().mockResolvedValueOnce(enabled).mockReturnValueOnce(new Promise(() => {})), timed = createClient(timeoutRequest, vi.fn(), () => true, 50);
    await timed.refresh(); const checking = timed.check(); await vi.advanceTimersByTimeAsync(51); await checking;
    expect(timed.state.checking).toBe(false); expect(timed.state.readiness?.state).toBe('unknown'); expect(timed.state.confirmed).toBe(true); expect(timeoutRequest).toHaveBeenCalledTimes(2); timed.dispose();
  });
  it('cancels port edits and fences older responses from a later check', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const old = deferred<ApplicationPreviewCheck>(), fresh = { ...responded, httpStatus: 503 }, request = vi.fn().mockResolvedValueOnce(enabled).mockReturnValueOnce(old.promise).mockResolvedValueOnce(fresh), client = createClient(request);
    await client.refresh(); const checking = client.check(); await Promise.resolve(); await Promise.resolve();
    client.clearPrepared(); expect(client.state.checking).toBe(false); expect(request.mock.calls[1][2].aborted).toBe(true);
    await client.check(); old.resolve(responded); await checking;
    expect(client.state.readiness).toEqual(fresh); client.dispose();
  });
  it('invalidates results on refresh, replacement, close, scope invalidation and disposal', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    let allowed = true;
    const late = deferred<ApplicationPreviewCheck>(), replaced = { ...enabled, port: 3001, generation: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', viewerOrigin: generationOrigin('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') };
    const request = vi.fn().mockResolvedValueOnce(enabled).mockResolvedValueOnce(responded).mockResolvedValueOnce(enabled).mockResolvedValueOnce(responded).mockResolvedValueOnce(replaced).mockResolvedValueOnce({ ...responded, port: 3001 }).mockResolvedValueOnce(initial).mockResolvedValueOnce(enabled).mockReturnValueOnce(late.promise), client = createClient(request, vi.fn(), () => allowed);
    await client.refresh(); await client.check(); await client.refresh(); expect(client.state.readiness).toBeNull();
    await client.check(); await client.enable(3001); expect(client.state.readiness).toBeNull();
    await client.check(); await client.close(); expect(client.state.readiness).toBeNull();
    await client.refresh(); const checking = client.check(); await Promise.resolve(); await Promise.resolve(); allowed = false;
    late.resolve(responded); await checking; expect(client.state.readiness).toBeNull(); client.dispose(); expect(client.state.checking).toBe(false);
  });
  it('keeps prepared openings independent of HTTP status and reachability failure', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const refused = { ...responded, state: 'connection_refused', httpStatus: null };
    const request = vi.fn().mockResolvedValueOnce(enabled).mockResolvedValueOnce(handoff).mockResolvedValueOnce(refused), client = createClient(request);
    await client.refresh(); await client.prepare(); await client.check();
    expect(client.state.handoff).toEqual(handoff); expect(client.state.readiness?.state).toBe('connection_refused'); expect(client.consumeHandoff()).toBe(true); client.dispose();
  });
  it('validates the narrow result and rejects wrong ports, malformed statuses and timestamps', () => {
    expect(validateApplicationPreviewCheck({ ...responded, body: 'never render', token: 'secret' }, 3000, now, now)).toEqual(responded);
    expect(validateApplicationPreviewCheck({ ...responded, state: 'unavailable', port: null, httpStatus: null }, 3000, now, now).state).toBe('unavailable');
    expect(validateApplicationPreviewCheck({ ...responded, state: 'unknown', port: null, httpStatus: null }, 3000, now, now).port).toBeNull();
    for (const invalid of [null, [], {}, { ...responded, state: 'ready' }, { ...responded, port: 3001 }, { ...responded, port: '3000' }, { ...responded, httpStatus: '200' }, { ...responded, httpStatus: 199 }, { ...responded, httpStatus: 600 }, { ...responded, httpStatus: null }, { ...responded, state: 'timed_out' }, { ...responded, checkedAt: 'bad' }, { ...responded, checkedAt: new Date(now - 2001).toISOString() }, { ...responded, checkedAt: new Date(now + 5001).toISOString() }, { ...responded, reason: 'x'.repeat(1001) }]) expect(() => validateApplicationPreviewCheck(invalid, 3000, now, now)).toThrow();
  });
  it('caps JSON responses and never copies non-success response bodies into errors', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(responded))).mockResolvedValueOnce(new Response('x'.repeat(8193))).mockResolvedValueOnce(new Response('secret upstream diagnostics', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    expect(await requestApplicationPreviewCheck('/sessions/machine/preview/check', new AbortController().signal)).toEqual(responded);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{}' });
    await expect(requestApplicationPreviewCheck('/sessions/machine/preview/check', new AbortController().signal)).rejects.toThrow('could not be verified');
    await expect(requestApplicationPreviewCheck('/sessions/machine/preview/check', new AbortController().signal)).rejects.toThrow('could not be verified');
  });
  it('labels observations stale at one minute and does not present root responses as HMR proof', () => {
    expect(readinessIsStale(responded, now + 59_999)).toBe(false); expect(readinessIsStale(responded, now + 60_000)).toBe(true);
    const html = renderToStaticMarkup(createElement(ApplicationReadinessResult, { result: responded, now: now + 60_000 }));
    expect(html).toContain('Responded · Stale'); expect(html).toContain('Checked port'); expect(html).toContain('200'); expect(html).toContain('HEAD /'); expect(html).toContain('does not verify the page, HMR, or viewer sign-in');
  });
  it('cancels response streams on abort and rejects malformed UTF-8', async () => {
    const cancel = vi.fn(), stream = new ReadableStream<Uint8Array>({ cancel });
    const fetch = vi.fn().mockResolvedValueOnce(new Response(stream)).mockResolvedValueOnce(new Response(new Uint8Array([0xff])));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController(), checking = requestApplicationPreviewCheck('/sessions/machine/preview/check', controller.signal);
    await Promise.resolve(); await Promise.resolve(); controller.abort();
    await expect(checking).rejects.toThrow('could not be verified'); expect(cancel).toHaveBeenCalledOnce();
    await expect(requestApplicationPreviewCheck('/sessions/machine/preview/check', new AbortController().signal)).rejects.toThrow();
  });
});

describe('preview trust boundaries', () => {
  it('requires a numeric integer port in the explicit allowed range', () => {
    expect(parsePreviewPort('1024')).toBe(1024); expect(parsePreviewPort('49151')).toBe(49151);
    for (const port of ['', '80', '1023', '49152', '65535', '3000.0', '3e3', '+3000', ' 3000', '3000 ', '0xbbb', '003000', 'NaN']) expect(parsePreviewPort(port)).toBeNull();
  });
  it('requires a canonical DNS origin and matches the saved generation exactly', () => {
    expect(validateViewerOrigin(viewerOrigin, workspaceOrigin, enabled.generation)).toBe(viewerOrigin);
    const local = generationOrigin(enabled.generation!, 'http://localhost:4312');
    expect(validateViewerOrigin(local, 'http://127.0.0.1:4310', enabled.generation)).toBe(local);
    expect(validateViewerOrigin(baseOrigin, workspaceOrigin, null)).toBe(baseOrigin);
    for (const origin of [workspaceOrigin, `${viewerOrigin}/`, `${viewerOrigin}/app`, `${viewerOrigin}?token=secret`, `${viewerOrigin}#secret`, 'https://user:pass@private-viewer.test', 'http://private-viewer.test', 'javascript:alert(1)', 'https://workspace.test:444', 'https://PRIVATE-viewer.test', 'http://127.0.0.1:4312', 'https://[::1]', baseOrigin, generationOrigin('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')]) expect(() => validateViewerOrigin(origin, workspaceOrigin, enabled.generation)).toThrow('could not be verified');
    expect(() => validateViewerOrigin(local, 'https://control.localhost', enabled.generation)).toThrow();
  });
  it('accepts an authenticated HTTPS workspace response selecting the explicit local-only HTTP viewer', async () => {
    const origin = generationOrigin(enabled.generation!, 'http://localhost:4312');
    const localMetadata = { ...enabled, viewerOrigin: origin };
    const localHandoff = { ...handoff, action: `${origin}/__ephemeral/open` };
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(localMetadata))).mockResolvedValueOnce(new Response(JSON.stringify(localHandoff)));
    vi.stubGlobal('fetch', fetch); vi.useFakeTimers(); vi.setSystemTime(now);
    const client = new ApplicationPreviewClient('machine', workspaceOrigin, () => {});
    await client.refresh(); await client.prepare();
    expect(client.state.handoff).toEqual(localHandoff);
    expect(fetch.mock.calls[0][1].credentials).toBe('same-origin');
    const html = renderToStaticMarkup(createElement(PrivatePreviewForm, { handoff: localHandoff, viewerOrigin: origin, workspaceOrigin, now, onSubmit: () => {} }));
    expect(html).toContain(`action="${origin}/__ephemeral/open"`); expect(html).toContain('method="POST"');
    client.dispose();
  });
  it('rejects malformed and contradictory saved access, and strips unknown fields', () => {
    expect(validatePreviewMetadata({ ...enabled, secret: 'never-render' }, workspaceOrigin)).toEqual(enabled);
    for (const invalid of [null, [], {}, { ...enabled, port: '3000' }, { ...enabled, port: 80 }, { ...enabled, generation: null }, { ...enabled, generation: 'invalid' }, { ...enabled, updatedAt: 'invalid' }, { ...enabled, viewerOrigin: null }, { ...enabled, viewerOrigin: baseOrigin }, { ...enabled, viewerOrigin: generationOrigin('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') }, { ...initial, port: 3000 }, { ...initial, generation: enabled.generation }, { ...enabled, mode: 'preview' }, { ...initial, state: 'unknown' }]) expect(() => validatePreviewMetadata(invalid, workspaceOrigin)).toThrow('could not be verified');
    expect(validatePreviewMetadata({ ...initial, state: 'unavailable', mode: 'preview', viewerOrigin: null }, workspaceOrigin).state).toBe('unavailable');
    expect(validatePreviewMetadata({ ...enabled, state: 'disabled' }, workspaceOrigin).port).toBe(3000);
  });
  it('binds the one-use handoff to the exact origin, port, generation and short expiry', () => {
    expect(validatePreviewHandoff(handoff, enabled, workspaceOrigin, now)).toEqual(handoff);
    for (const invalid of [{ ...handoff, action: `${viewerOrigin}/__ephemeral/open?token=secret` }, { ...handoff, action: `${workspaceOrigin}/__ephemeral/open` }, { ...handoff, token: 'secret' }, { ...handoff, port: 3001 }, { ...handoff, generation: 'b'.repeat(36) }, { ...handoff, expiresAt: new Date(now).toISOString() }, { ...handoff, expiresAt: new Date(now + 60_001).toISOString() }, { ...handoff, expiresAt: 'bad' }]) expect(() => validatePreviewHandoff(invalid, enabled, workspaceOrigin, now)).toThrow();
    expect(() => validatePreviewHandoff(handoff, initial, workspaceOrigin, now)).toThrow();
  });
  it('blocks preview simulation, preparation, stopped machines and expiry', () => {
    const session = { state: 'running', expiresAt: new Date(now + 60_000).toISOString(), maxExpiresAt: new Date(now + 600_000).toISOString() } as const;
    expect(previewUnavailableReason(session, false, now)).toBeNull();
    expect(previewUnavailableReason(session, true, now)).toContain('simulation');
    expect(previewUnavailableReason({ ...session, state: 'provisioning' }, false, now)).toContain('prepared');
    expect(previewUnavailableReason({ ...session, state: 'ended' }, false, now)).toContain('stopped');
    expect(previewUnavailableReason(session, false, now + 60_000)).toContain('expired');
  });
});

describe('confirmed preview access and request recovery', () => {
  it('checks access with encoded GET and never runs a command or includes a secret', async () => {
    const request = vi.fn().mockResolvedValue(initial), client = createClient(request);
    await client.refresh();
    expect(request.mock.calls[0].slice(0, 2)).toEqual(['/sessions/machine%2Fid/preview', undefined]);
    for (const port of [80, 49152, 3000.5]) await client.enable(port);
    expect(request).toHaveBeenCalledTimes(1); expect(client.state.error).toContain('1024'); client.dispose();
  });
  it('confirms saved enable/replace/disable responses without optimistic access', async () => {
    const save = deferred<PreviewMetadata>();
    const replaced = { ...enabled, generation: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', viewerOrigin: generationOrigin('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') };
    const request = vi.fn().mockResolvedValueOnce(initial).mockReturnValueOnce(save.promise).mockResolvedValueOnce(replaced).mockResolvedValueOnce(initial), client = createClient(request);
    await client.refresh(); const enabling = client.enable(3000); await Promise.resolve(); await Promise.resolve();
    expect(client.state.snapshot?.state).toBe('disabled'); expect(client.state.confirmed).toBe(false);
    save.resolve(enabled); await enabling; expect(client.state.snapshot).toEqual(enabled);
    await client.enable(3000); expect(client.state.snapshot).toEqual(replaced);
    await client.close(); expect(client.state.snapshot?.state).toBe('disabled');
    expect(request.mock.calls.map(call => call[1])).toEqual([undefined, { port: 3000 }, { port: 3000 }, {}]); client.dispose();
  });
  it('recovers a lost mutation reply with GET and no automatic mutation retry', async () => {
    const request = vi.fn().mockResolvedValueOnce(initial).mockRejectedValueOnce(new Error('secret credential')).mockResolvedValueOnce(enabled), client = createClient(request);
    await client.refresh(); await client.enable(3000);
    expect(request.mock.calls.map(call => call[1])).toEqual([undefined, { port: 3000 }, undefined]);
    expect(client.state.snapshot).toEqual(enabled); expect(client.state.confirmed).toBe(true);
    expect(client.state.error).toContain('not confirmed'); expect(client.state.error).not.toContain('secret'); client.dispose();
  });
  it('blocks opening and changing unknown access until a bounded manual refresh succeeds', async () => {
    const request = vi.fn().mockResolvedValueOnce(enabled).mockRejectedValueOnce(new Error('lost')).mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(initial), client = createClient(request);
    await client.refresh(); await client.close();
    expect(client.state.snapshot).toEqual(enabled); expect(client.state.confirmed).toBe(false);
    await client.prepare(); await client.enable(3001); expect(request).toHaveBeenCalledTimes(3);
    await client.refresh(); expect(client.state.confirmed).toBe(true); expect(client.state.snapshot).toEqual(initial); client.dispose();
  });
  it('refuses a contradictory or stale mutation reply and confirms only a recovery GET', async () => {
    const request = vi.fn().mockResolvedValueOnce(enabled).mockResolvedValueOnce(enabled).mockResolvedValueOnce(enabled), client = createClient(request);
    await client.refresh(); await client.enable(3000);
    expect(request).toHaveBeenCalledTimes(3); expect(client.state.error).toContain('not confirmed'); client.dispose();
  });
  it('coalesces refreshes and rejects late GET metadata after a scope/account change', async () => {
    const response = deferred<PreviewMetadata>(); let allowed = true;
    const publish = vi.fn(), request = vi.fn().mockReturnValue(response.promise), client = createClient(request, publish, () => allowed);
    const first = client.refresh(); expect(client.refresh()).toBe(first); await Promise.resolve(); await Promise.resolve();
    allowed = false; const count = publish.mock.calls.length; response.resolve(enabled); await first;
    expect(client.state.snapshot).toBeNull(); expect(publish).toHaveBeenCalledTimes(count); client.dispose();
  });
  it('aborts requests and clears all credentials on disposal', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const request = vi.fn().mockResolvedValueOnce(enabled).mockResolvedValueOnce(handoff), client = createClient(request);
    await client.refresh(); await client.prepare(); expect(client.state.handoff?.token).toBe(handoff.token);
    client.dispose(); expect(client.state.handoff).toBeNull(); expect(client.state.snapshot).toBeNull();
    const response = deferred<PreviewMetadata>(), delayed = createClient(vi.fn().mockReturnValue(response.promise));
    const loading = delayed.refresh(); await Promise.resolve(); delayed.dispose(); response.resolve(enabled); await loading;
    expect(delayed.state.snapshot).toBeNull();
  });
  it('bounds uncooperative transport timeouts and recovery before allowing manual refresh', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const request = vi.fn().mockResolvedValueOnce(initial).mockReturnValue(new Promise(() => {})), client = createClient(request, vi.fn(), () => true, 50);
    await client.refresh(); const enabling = client.enable(3000); await vi.advanceTimersByTimeAsync(101); await enabling;
    expect(client.state.confirmed).toBe(false); expect(client.state.sending).toBeNull(); expect(client.state.error).toContain('unknown'); expect(request).toHaveBeenCalledTimes(3); client.dispose();
  });
});

describe('private viewer handoff lifecycle', () => {
  it('blocks reuse immediately while preserving the published form through microtasks until the next timer task', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const publish = vi.fn(), request = vi.fn().mockResolvedValueOnce(enabled).mockResolvedValueOnce(handoff), client = createClient(request, publish);
    await client.refresh(); await client.prepare();
    const notifications = publish.mock.calls.length;
    const rendered = publish.mock.calls.at(-1)![0];
    expect(rendered.handoff.token).toBe(handoff.token);
    expect(client.consumeHandoff()).toBe(true);
    expect(client.state.handoff).toBeNull(); expect(client.consumeHandoff()).toBe(false);
    expect(publish).toHaveBeenCalledTimes(notifications);
    expect(rendered.handoff.token).toBe(handoff.token);
    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(notifications);
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledTimes(notifications + 1);
    expect(publish.mock.calls.at(-1)![0].handoff).toBeNull();
    expect(publish.mock.calls.at(-1)![0].notice).toContain('Opening requested');
    client.dispose();
  });
  it('expires credentials, consumes them only once, and requires a fresh prepare for another opening', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const request = vi.fn().mockResolvedValueOnce(enabled).mockResolvedValueOnce(handoff).mockResolvedValueOnce({ ...handoff, expiresAt: new Date(now + 60_001).toISOString() }), client = createClient(request);
    await client.refresh(); await client.prepare(); expect(client.consumeHandoff()).toBe(true); expect(client.state.handoff).toBeNull(); expect(client.consumeHandoff()).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await client.prepare(); expect(client.state.handoff).not.toBeNull();
    await vi.advanceTimersByTimeAsync(60_000); expect(client.state.handoff).toBeNull(); expect(client.consumeHandoff()).toBe(false); client.dispose();
  });
  it('drops prepared credentials on refresh, port edit, disable, replacement and scope invalidation', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const request = vi.fn().mockResolvedValue(enabled), client = createClient(request);
    await client.refresh(); request.mockResolvedValueOnce(handoff); await client.prepare(); client.clearPrepared(); expect(client.state.handoff).toBeNull();
    request.mockResolvedValueOnce(handoff); await client.prepare(); await client.refresh(); expect(client.state.handoff).toBeNull();
    request.mockResolvedValueOnce(handoff); await client.prepare(); request.mockResolvedValueOnce(initial); await client.close(); expect(client.state.handoff).toBeNull();
    client.dispose();
  });
  it('ignores a late handoff after a port edit and rejects handoffs for a stale generation', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const opening = deferred<PreviewHandoff>(), request = vi.fn().mockResolvedValueOnce(enabled).mockReturnValueOnce(opening.promise).mockResolvedValueOnce({ ...handoff, generation: 'b'.repeat(36) }).mockResolvedValueOnce(enabled), client = createClient(request);
    await client.refresh(); const preparing = client.prepare(); await Promise.resolve(); await Promise.resolve();
    client.clearPrepared(); opening.resolve(handoff); await preparing; expect(client.state.handoff).toBeNull(); expect(client.state.sending).toBeNull();
    await client.prepare(); expect(client.state.handoff).toBeNull(); expect(client.state.error).toContain('not confirmed'); client.dispose();
  });
  it('posts to the fixed isolated origin with no token in URL and prevents unsafe form destinations', () => {
    const props = { handoff, viewerOrigin, workspaceOrigin, now, onSubmit: () => {} };
    const html = renderToStaticMarkup(createElement(PrivatePreviewForm, props));
    expect(html).toContain('method="POST"'); expect(html).toContain(`action="${viewerOrigin}/__ephemeral/open"`);
    expect(html).toContain('target="_blank"'); expect(html).toContain('rel="noopener"'); expect(html).not.toContain('noreferrer');
    expect(html).toContain(`type="hidden" name="token" value="${handoff.token}"`); expect(html).not.toContain('?token'); expect(html).not.toContain('iframe');
    for (const invalid of [{ ...props, viewerOrigin: workspaceOrigin }, { ...props, handoff: { ...handoff, action: `${workspaceOrigin}/__ephemeral/open` } }, { ...props, now: now + 60_000 }, { ...props, handoff: { ...handoff, expiresAt: 'bad' } }]) expect(renderToStaticMarkup(createElement(PrivatePreviewForm, invalid))).toBe('');
  });
  it('leads simulation with its reason and a live-machine route, without startup controls', () => {
    vi.stubGlobal('window', { location: { origin: workspaceOrigin } });
    const session = { id: 'machine', userId: 'owner', state: 'running', expiresAt: new Date(now + 600_000).toISOString(), maxExpiresAt: new Date(now + 600_000).toISOString() } as Session;
    const html = renderToStaticMarkup(createElement(ApplicationPreview, { session, preview: true, now, accountKey: 'preview:owner' }));
    expect(html).toContain('Preview simulation'); expect(html).toContain('Use a running live machine');
    expect(html).not.toContain('application-preview-port'); expect(html).not.toContain('disabled=""'); expect(html).not.toContain('name="token"'); expect(html).not.toContain('iframe');
  });
});

describe('preview task sequence and unavailable recovery', () => {
  const session = { id: 'machine', userId: 'owner', state: 'running', expiresAt: new Date(now + 600_000).toISOString(), maxExpiresAt: new Date(now + 600_000).toISOString() } as Session;
  const render = (changes: Partial<Session> = {}, callbacks = {}) => {
    vi.stubGlobal('window', { location: { origin: workspaceOrigin } });
    return renderToStaticMarkup(createElement(ApplicationPreview, { session: { ...session, ...changes }, preview: false, now, accountKey: 'live:owner', ...callbacks }));
  };
  it('shows ordered explicit actions with shell access beside startup and optional framework help', () => {
    const html = render({}, { onOpenShell: () => {} });
    const headings = ['Start server', 'Select port', 'Check application', 'Open private viewer'].map(text => html.indexOf(`<h4>${text}</h4>`));
    expect(headings.every(index => index >= 0)).toBe(true); expect(headings).toEqual([...headings].sort((a, b) => a - b));
    expect(html.indexOf('Open supplemental shell')).toBeLessThan(headings[1]);
    expect(html).toContain('Start server → Select port → Check application (optional) → Open private viewer.');
    for (const number of [1, 2, 3, 4]) expect(html).toContain(`<span class="preview-step-number" aria-hidden="true">${number}</span>`);
    expect(html).toContain('<ol class="preview-sequence">');
    expect(html).toContain('These controls never run a start command');
    expect(html).toContain('<details class="preview-framework-help"><summary>Framework and HMR help</summary>');
    expect(html).toContain('listen on <code>127.0.0.1</code> or <code>0.0.0.0</code>');
    expect(html).toContain('Saved access does not confirm that the application is running or reachable');
    expect(html).toContain('This check is optional'); expect(html).toContain('An application response does not verify HMR');
    expect(html).toContain('10 minutes'); expect(html).toContain('renew access'); expect(html).toContain('Closing access ends every existing viewer and prepared opening');
    expect(html).toContain('Machine expires'); expect(html).not.toContain('name="token"');
  });
  it('replaces ended and failed startup forms with explicit published recovery routes', () => {
    for (const state of ['ended', 'failed'] as const) {
      const html = render({ state }, { onReviewPublished: () => {}, onContinueSavedWork: () => {} });
      expect(html).toContain(state === 'ended' ? 'This machine has ended' : 'This machine failed');
      expect(html).toContain('Review published work'); expect(html).toContain('Review continuation'); expect(html).toContain('verified published source');
      expect(html).not.toContain('application-preview-port'); expect(html).not.toContain('Prepare private preview'); expect(html).not.toContain('Start server'); expect(html).not.toContain('preview-overview');
    }
    expect(render({ state: 'ended' }, { onReviewPublished: () => {} })).not.toContain('Review continuation</button>');
  });
  it('keeps cleanup, expiry and provisioning reasons distinct without claiming recovery is ready', () => {
    const cleanup = render({ state: 'cleanup_pending' }, { onReviewPublished: () => {} });
    expect(cleanup).toContain('Machine cleanup is pending'); expect(cleanup).toContain('Continuation still requires'); expect(cleanup).not.toContain('application-preview-port');
    const expired = render({ expiresAt: new Date(now).toISOString() }, { onReviewPublished: () => {} });
    expect(expired).toContain('lifetime has expired'); expect(expired).toContain('Shutdown and cleanup may still be awaiting confirmation'); expect(expired).not.toContain('Start server');
    const preparing = render({ state: 'provisioning' });
    expect(preparing).toContain('Machine preparation in progress'); expect(preparing).toContain('Wait for preparation to finish'); expect(preparing).not.toContain('application-preview-port'); expect(preparing).not.toContain('Review continuation');
  });
  it('bounds preview by the earlier lifetime and distinguishes unknown deadlines from expiry', () => {
    const expiredMaximum = { ...session, maxExpiresAt: new Date(now).toISOString() };
    expect(previewUnavailableReason(expiredMaximum, false, now)).toContain('expired');
    expect(previewUnavailablePresentation(expiredMaximum, false, now)?.title).toContain('expired');
    const expired = render({ maxExpiresAt: expiredMaximum.maxExpiresAt });
    expect(expired).toContain('lifetime has expired'); expect(expired).not.toContain('application-preview-port');
    for (const changes of [{ expiresAt: 'invalid' }, { maxExpiresAt: 'invalid' }]) {
      expect(previewUnavailableReason({ ...session, ...changes }, false, now)).toContain('could not be confirmed');
      const html = render(changes);
      expect(html).toContain('Machine deadline unconfirmed'); expect(html).not.toContain('lifetime has expired'); expect(html).not.toContain('application-preview-port');
    }
    const bounded = render({ maxExpiresAt: new Date(now + 60_000).toISOString() });
    expect(bounded).toContain(new Date(now + 60_000).toISOString());
  });
  it('leads ended simulations with lifecycle and qualifies their published recovery', () => {
    vi.stubGlobal('window', { location: { origin: workspaceOrigin } });
    const html = renderToStaticMarkup(createElement(ApplicationPreview, { session: { ...session, state: 'ended' }, preview: true, now, accountKey: 'preview:owner', onReviewPublished: () => {}, onContinueSavedWork: () => {} }));
    expect(html.indexOf('This machine has ended')).toBeLessThan(html.indexOf('Preview simulation'));
    expect(html).toContain('published evidence and continuation here are simulated'); expect(html).toContain('Review published work'); expect(html).toContain('Review continuation'); expect(html).not.toContain('application-preview-port');
  });
  it('uses presentation state without loosening client eligibility or triggering recovery callbacks', () => {
    expect(previewUnavailablePresentation(session, false, now)).toBeNull();
    expect(previewUnavailablePresentation({ ...session, expiresAt: 'invalid' }, false, now)?.title).toContain('unconfirmed');
    expect(previewUnavailablePresentation({ ...session, state: 'failed' }, true, now)?.title).toBe('This machine failed');
    const onReviewPublished = vi.fn(), onContinueSavedWork = vi.fn(), onOpenShell = vi.fn();
    render({ state: 'ended' }, { onReviewPublished, onContinueSavedWork, onOpenShell });
    expect(onReviewPublished).not.toHaveBeenCalled(); expect(onContinueSavedWork).not.toHaveBeenCalled(); expect(onOpenShell).not.toHaveBeenCalled();
  });
});
