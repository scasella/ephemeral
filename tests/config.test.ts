import { describe, expect, it } from 'vitest';
import { readConfig } from '../server/config.js';

describe('session plan configuration', () => {
  it('defaults to one hour without requiring paid plan configuration', () => {
    expect(readConfig({ EPHEMERAL_MODE: 'preview' }).sessionMaxHours).toBe(1);
  });
  it('accepts an explicit four-hour Pro lifetime', () => {
    expect(readConfig({ EPHEMERAL_MODE: 'preview', SESSION_MAX_HOURS: '4' }).sessionMaxHours).toBe(4);
  });
  it.each(['0', '2', '5', '-1', '1.5', 'unknown'])('rejects unsupported lifetime %s', value => {
    expect(() => readConfig({ EPHEMERAL_MODE: 'preview', SESSION_MAX_HOURS: value })).toThrow('SESSION_MAX_HOURS');
  });
});

describe('isolated application preview origin', () => {
  const config = (url?: string) => readConfig({ EPHEMERAL_MODE: 'preview', PUBLIC_URL: 'http://127.0.0.1:4310', PREVIEW_PUBLIC_URL: url, ...(url?.startsWith('http://localhost:4312') ? { PREVIEW_LOCAL_ONLY: '1' } : {}) });
  it('is unavailable by default and uses a dedicated local listener', () => { expect(config()).toMatchObject({ previewPublicUrl: null, previewPort: 4312, previewHost: '127.0.0.1' }); });
  it('accepts HTTPS or a distinct loopback HTTP hostname', () => {
    expect(config('https://preview.example.test').previewPublicUrl).toBe('https://preview.example.test');
    expect(config('http://localhost:4312').previewPublicUrl).toBe('http://localhost:4312');
  });
  it.each(['http://localhost:9999', 'https://127.0.0.1', 'https://[::1]', 'https://127.1', 'https://a..test', 'http://public.test', 'ftp://public.test', 'https://u:p@public.test', 'https://public.test/path', 'https://public.test/.', 'https://public.test/..', 'https://public.test/?x=1', 'https://public.test/#x', 'https://public.test\n'])('rejects unsafe origin %s', url => { expect(() => config(url)).toThrow('PREVIEW_PUBLIC_URL'); });
  it('rejects an implicit HTTP viewer and a control hostname under the viewer namespace', () => {
    expect(() => readConfig({ PREVIEW_PUBLIC_URL: 'http://localhost:4312', PUBLIC_URL: 'http://127.0.0.1:4310' })).toThrow('PREVIEW_LOCAL_ONLY');
    expect(() => readConfig({ PREVIEW_PUBLIC_URL: 'https://preview.test', PUBLIC_URL: 'https://control.preview.test' })).toThrow('DNS namespace');
  });
  it('rejects invalid listener ports and production HTTP', () => {
    expect(() => readConfig({ PREVIEW_PORT: '0' })).toThrow('PREVIEW_PORT');
    expect(() => readConfig({ NODE_ENV: 'production', PREVIEW_PUBLIC_URL: 'http://localhost:4312' })).toThrow('PREVIEW_PUBLIC_URL');
  });
  it('permits explicit production local testing only with matching loopback listener and URL', () => {
    const local = { NODE_ENV: 'production', EPHEMERAL_MODE: 'live', E2B_API_KEY: 'test', E2B_TEMPLATE_ID: 'test', GITHUB_APP_ID: '1', GITHUB_APP_SLUG: 'test', GITHUB_CLIENT_ID: 'test', GITHUB_CLIENT_SECRET: 'test', GITHUB_APP_PRIVATE_KEY: 'test', ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), ALLOWED_GITHUB_IDS: '1', PUBLIC_URL: 'https://control.test', PREVIEW_LOCAL_ONLY: '1', PREVIEW_PUBLIC_URL: 'http://localhost:4312', PREVIEW_PORT: '4312' };
    expect(readConfig(local)).toMatchObject({ previewLocalOnly: true, previewHost: '127.0.0.1' });
    expect(() => readConfig({ ...local, PREVIEW_HOST: '0.0.0.0' })).toThrow('PREVIEW_LOCAL_ONLY');
    expect(() => readConfig({ ...local, PREVIEW_PORT: '4313' })).toThrow('PREVIEW_LOCAL_ONLY');
    expect(() => readConfig({ ...local, PREVIEW_PUBLIC_URL: 'https://preview.test' })).toThrow('PREVIEW_LOCAL_ONLY');
    expect(() => readConfig({ ...local, PREVIEW_PORT: '4310' })).toThrow('PREVIEW_PORT');
  });
});
