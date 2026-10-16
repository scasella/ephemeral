import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubAPI } from '../server/github/api.js';
import { GitHubError } from '../server/github/security.js';

afterEach(() => vi.restoreAllMocks());
const api = () => new GitHubAPI('42', 'unused', 'app');
describe('bounded GitHub launch metadata responses', () => {
  it('decodes ordinary streamed JSON inside the caller limit and retains the request signal deadline', async () => {
    const signal = AbortSignal.timeout(30_000), encoder = new TextEncoder();
    const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode('{"sha":')); controller.enqueue(encoder.encode('"reviewed"}')); controller.close();
    } })));
    expect(await api().request('/repos/owner/repo/git/commits/reviewed', 'SYNTHETIC-OAUTH', 'GET', undefined, signal, 256)).toEqual({ sha: 'reviewed' });
    expect(network).toHaveBeenCalledWith('https://api.github.com/repos/owner/repo/git/commits/reviewed', expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
    expect(network.mock.calls[0][1]?.signal?.aborted).toBe(false);
  });
  it('cancels an oversized streaming response before buffering the remaining JSON', async () => {
    const cancel = vi.fn(), encoder = new TextEncoder(); let sent = 0;
    const stream = new ReadableStream({ pull(controller) { sent++; controller.enqueue(encoder.encode('x'.repeat(128))); }, cancel });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream));
    await expect(api().request('/repos/owner/repo/compare/a...b', 'SYNTHETIC-OAUTH', 'GET', undefined, undefined, 256)).rejects.toMatchObject({ status: 413 });
    expect(cancel).toHaveBeenCalledTimes(1); expect(sent).toBeLessThanOrEqual(4);
  });
  it('rejects an oversized declared length without reading its body', async () => {
    const cancel = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { 'Content-Length': '10485760' } }));
    await expect(api().request('/repos/owner/repo/compare/a...b', 'SYNTHETIC-OAUTH', 'GET', undefined, undefined, 256)).rejects.toBeInstanceOf(GitHubError);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('requires valid UTF-8 and valid JSON in bounded responses', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d])))
      .mockResolvedValueOnce(new Response('{invalid json'));
    await expect(api().request('/repos/owner/repo/git/commits/a', 'SYNTHETIC-OAUTH', 'GET', undefined, undefined, 256)).rejects.toThrow();
    await expect(api().request('/repos/owner/repo/git/commits/a', 'SYNTHETIC-OAUTH', 'GET', undefined, undefined, 256)).rejects.toThrow();
    expect(network).toHaveBeenCalledTimes(2);
  });
  it('leaves existing unbounded callers unchanged and rejects invalid explicit limits before fetch', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ value: 'x'.repeat(1024) })));
    expect(await api().request<{ value: string }>('/existing-endpoint', 'SYNTHETIC-OAUTH')).toHaveProperty('value', 'x'.repeat(1024));
    for (const limit of [0, -1, Infinity, NaN]) await expect(api().request('/unused', 'SYNTHETIC-OAUTH', 'GET', undefined, undefined, limit)).rejects.toMatchObject({ status: 400 });
    expect(network).toHaveBeenCalledTimes(1);
  });
});
