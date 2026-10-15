import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewTarget, Session } from '../server/contracts.js';
import { PREVIEW_DIAGNOSTIC_HEADER, PREVIEW_DIAGNOSTIC_PATH } from '../server/infra/preview-gateway.js';
import { PREVIEW_CHECK_TIMEOUT_MS, probeApplicationPreview } from '../server/preview-readiness.js';

const session = (): Session => ({ id: 'session', userId: 'owner', sandboxId: 'sandbox-a', repository: 'org/repo', repositoryId: 12,
  installationId: 1, baseBranch: 'main', branch: 'work', state: 'running', createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(), maxExpiresAt: new Date(Date.now() + 120_000).toISOString(),
  endedAt: null, error: null, codexRemoteRevocation: 'unverified', cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' } });
const target = (): PreviewTarget => ({ origin: 'https://49152-sandbox-a.e2b.app', headers: {
  'e2b-traffic-access-token': 'NATIVE-SECRET', 'x-ephemeral-preview-port': '5173', origin: 'http://localhost:5173',
  authorization: 'OTHER-SECRET', cookie: 'OTHER-SECRET', 'x-custom': 'OTHER-SECRET' } });
const response = (data: unknown = { protocol: 1, state: 'responded', port: 5173, httpStatus: 200 }) =>
  new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', [PREVIEW_DIAGNOSTIC_HEADER]: '1' } });
const fixture = () => ({ provider: { previewTarget: vi.fn().mockResolvedValue(target()) }, fetch: vi.fn<typeof fetch>().mockResolvedValue(response()) });
afterEach(() => vi.useRealTimers());

describe('bounded private application diagnostic lookup', () => {
  it('checks precisely the selected private gateway with only its native auth and diagnostic headers', async () => {
    const f = fixture(), s = session(), original = structuredClone(s);
    const result = await probeApplicationPreview(f.provider, s, 5173, { fetch: f.fetch });
    expect(f.provider.previewTarget).toHaveBeenCalledWith(s, 5173, expect.any(AbortSignal));
    expect(f.fetch).toHaveBeenCalledWith(new URL(PREVIEW_DIAGNOSTIC_PATH, 'https://49152-sandbox-a.e2b.app'), {
      method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
        'e2b-traffic-access-token': 'NATIVE-SECRET', 'x-ephemeral-preview-port': '5173', [PREVIEW_DIAGNOSTIC_HEADER]: '1' } });
    expect(result).toMatchObject({ state: 'responded', port: 5173, httpStatus: 200 });
    expect(Number.isFinite(Date.parse(result.checkedAt))).toBe(true); expect(s).toEqual(original);
    expect(result.reason).toBe('The application returned HTTP 200 for HEAD /.');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it.each([404, 500, 302])('reports HTTP %s as a response and preserves the exact status', async httpStatus => {
    const f = fixture(); f.fetch.mockResolvedValue(response({ protocol: 1, state: 'responded', port: 5173, httpStatus }));
    const result = await probeApplicationPreview(f.provider, session(), 5173, { fetch: f.fetch });
    expect(result).toMatchObject({ state: 'responded', httpStatus });
    if (httpStatus >= 400) expect(result.remedy).toContain('correct the HTTP error');
  });
  it.each(['connection_refused', 'timed_out', 'unknown'])('preserves the gateway %s outcome without reflecting content', async state => {
    const f = fixture(); f.fetch.mockResolvedValue(response({ protocol: 1, state, port: 5173, httpStatus: null }));
    const result = await probeApplicationPreview(f.provider, session(), 5173, { fetch: f.fetch });
    expect(result).toMatchObject({ state, httpStatus: null, port: 5173 }); expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it.each(['https://evil.test', 'https://49152-other.e2b.app', 'https://49152-sandbox-a.e2b.app/path',
    'https://49152-sandbox-a.e2b.app:443', 'https://user:secret@49152-sandbox-a.e2b.app', 'http://49152-sandbox-a.e2b.app',
    'https://49152-sandbox-a.e2b.app?token=secret', 'https://49152-sandbox-a.e2b.app#fragment'])('rejects unsafe target %s without making a request', async origin => {
    const f = fixture(); f.provider.previewTarget.mockResolvedValue({ ...target(), origin });
    expect((await probeApplicationPreview(f.provider, session(), 5173, { fetch: f.fetch })).state).toBe('unavailable');
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('rejects invalid ports, unavailable sessions, and invalid or mismatched native headers before fetching', async () => {
    const f = fixture();
    for (const port of [22, 49152, NaN, 5173.5]) {
      expect(await probeApplicationPreview(f.provider, session(), port, { fetch: f.fetch })).toMatchObject({ state: 'unavailable', port: null });
    }
    expect((await probeApplicationPreview(f.provider, { ...session(), state: 'ended' }, 5173, { fetch: f.fetch })).state).toBe('unavailable');
    expect(f.provider.previewTarget).not.toHaveBeenCalled();
    for (const headers of [{}, { 'e2b-traffic-access-token': 'bad\r\nHeader:value', 'x-ephemeral-preview-port': '5173' },
      { 'e2b-traffic-access-token': 'NATIVE-SECRET', 'x-ephemeral-preview-port': '3000' }]) {
      f.provider.previewTarget.mockResolvedValue({ ...target(), headers });
      expect((await probeApplicationPreview(f.provider, session(), 5173, { fetch: f.fetch })).state).toBe('unavailable');
    }
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('declines old gateways, gateway failures, and redirects without consuming their bodies', async () => {
    const f = fixture();
    for (const reply of [new Response('private secret', { status: 302, headers: { location: 'https://evil.test' } }),
      new Response('private secret', { status: 502 }), new Response(JSON.stringify({ protocol: 1, state: 'responded', port: 5173, httpStatus: 200 }),
        { headers: { 'content-type': 'application/json' } })]) {
      f.fetch.mockResolvedValue(reply);
      const result = await probeApplicationPreview(f.provider, session(), 5173, { fetch: f.fetch });
      expect(result.state).toBe('unavailable'); expect(JSON.stringify(result)).not.toContain('private secret');
    }
  });
  it.each([{ protocol: 1, state: 'responded', port: 3000, httpStatus: 200 }, { protocol: 2, state: 'responded', port: 5173, httpStatus: 200 },
    { protocol: 1, state: 'ready', port: 5173, httpStatus: 200 }, { protocol: 1, state: 'responded', port: 5173, httpStatus: null },
    { protocol: 1, state: 'responded', port: 5173, httpStatus: 600 }, { protocol: 1, state: 'responded', port: 5173, httpStatus: 101 },
    { protocol: 1, state: 'responded', port: 5173, httpStatus: 200, reason: 'secret spoof' }, [],
    { protocol: 1, state: 'connection_refused', port: 5173, httpStatus: 502 }, null])(
    'rejects invalid diagnostic payload %s', async data => {
      const f = fixture(); f.fetch.mockResolvedValue(response(data));
      expect((await probeApplicationPreview(f.provider, session(), 5173, { fetch: f.fetch })).state).toBe('unknown');
    });
  it('limits declared and streamed diagnostic bodies, including malformed JSON', async () => {
    const f = fixture();
    for (const reply of [new Response('{}', { headers: { 'content-type': 'application/json', [PREVIEW_DIAGNOSTIC_HEADER]: '1', 'content-length': '1025' } }),
      new Response('x'.repeat(1025), { headers: { 'content-type': 'application/json', [PREVIEW_DIAGNOSTIC_HEADER]: '1' } }),
      new Response('private invalid json', { headers: { 'content-type': 'application/json', [PREVIEW_DIAGNOSTIC_HEADER]: '1' } })]) {
      f.fetch.mockResolvedValue(reply);
      const result = await probeApplicationPreview(f.provider, session(), 5173, { fetch: f.fetch });
      expect(result.state).toBe('unknown'); expect(JSON.stringify(result)).not.toContain('private invalid json');
    }
  });
  it('bounds a provider that ignores cancellation and never fetches after its deadline', async () => {
    vi.useFakeTimers(); const f = fixture();
    let resolve!: (value: PreviewTarget) => void;
    f.provider.previewTarget.mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = probeApplicationPreview(f.provider, session(), 5173, { fetch: f.fetch });
    await vi.advanceTimersByTimeAsync(PREVIEW_CHECK_TIMEOUT_MS);
    expect(await pending).toMatchObject({ state: 'unavailable', httpStatus: null, reason: expect.stringContaining('application was not checked') });
    resolve(target()); await Promise.resolve(); expect(f.fetch).not.toHaveBeenCalled();
    expect(f.provider.previewTarget.mock.calls[0][2].aborted).toBe(true);
  });
  it('bounds a fetch and body stream that ignore cancellation', async () => {
    vi.useFakeTimers(); const f = fixture();
    for (const stalled of [() => new Promise<Response>(() => {}), () => Promise.resolve(new Response(new ReadableStream({ start() {} }),
      { headers: { 'content-type': 'application/json', [PREVIEW_DIAGNOSTIC_HEADER]: '1' } }))]) {
      f.fetch.mockImplementation(stalled);
      const pending = probeApplicationPreview(f.provider, session(), 5173, { fetch: f.fetch });
      await vi.advanceTimersByTimeAsync(PREVIEW_CHECK_TIMEOUT_MS);
      expect((await pending).state).toBe('timed_out');
    }
  });
  it('actively cancels and releases a stalled body reader when the caller aborts', async () => {
    const f = fixture(), cancelled = vi.fn(), controller = new AbortController();
    const reply = new Response(new ReadableStream({ cancel: cancelled }),
      { headers: { 'content-type': 'application/json', [PREVIEW_DIAGNOSTIC_HEADER]: '1' } });
    f.fetch.mockResolvedValue(reply);
    const pending = probeApplicationPreview(f.provider, session(), 5173, { fetch: f.fetch, signal: controller.signal });
    await vi.waitFor(() => expect(reply.body!.locked).toBe(true));
    controller.abort(); expect((await pending).state).toBe('unavailable');
    await vi.waitFor(() => expect(reply.body!.locked).toBe(false)); expect(cancelled).toHaveBeenCalledOnce();
  });
  it('rejects malformed UTF-8 without interpreting replacement characters as diagnostic data', async () => {
    const f = fixture(), prefix = Buffer.from('{"protocol":1,"state":"responded","port":5173,"httpStatus":200,"');
    f.fetch.mockResolvedValue(new Response(Buffer.concat([prefix, Buffer.from([0xc3]), Buffer.from('\":true}')]),
      { headers: { 'content-type': 'application/json', [PREVIEW_DIAGNOSTIC_HEADER]: '1' } }));
    expect((await probeApplicationPreview(f.provider, session(), 5173, { fetch: f.fetch })).state).toBe('unknown');
  });
  it('handles prior and in-flight caller cancellation without fetching late or reflecting failures', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    expect((await probeApplicationPreview(f.provider, session(), 5173, { signal: controller.signal, fetch: f.fetch })).state).toBe('unavailable');
    expect(f.provider.previewTarget).not.toHaveBeenCalled();
    const inFlight = new AbortController(); f.provider.previewTarget.mockImplementation(() => new Promise(() => {}));
    const pending = probeApplicationPreview(f.provider, session(), 5173, { signal: inFlight.signal, fetch: f.fetch });
    inFlight.abort(); expect((await pending).state).toBe('unavailable'); expect(f.fetch).not.toHaveBeenCalled();
  });
  it('sanitizes provider errors and gateway transport errors without classifying the latter as application refusal', async () => {
    const f = fixture(); f.provider.previewTarget.mockRejectedValue(new Error('NATIVE-SECRET'));
    expect((await probeApplicationPreview(f.provider, session(), 5173, { fetch: f.fetch })).state).toBe('unavailable');
    f.provider.previewTarget.mockResolvedValue(target()); f.fetch.mockRejectedValue(new Error('ECONNREFUSED NATIVE-SECRET'));
    const result = await probeApplicationPreview(f.provider, session(), 5173, { fetch: f.fetch });
    expect(result.state).toBe('unknown'); expect(JSON.stringify(result)).not.toContain('SECRET');
  });
});
