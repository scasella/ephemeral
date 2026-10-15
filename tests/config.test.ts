import { describe, expect, it } from 'vitest';
import { readConfig, ConfigurationError } from '../server/config.js';
import { isSameOrigin } from '../server/auth/index.js';

const liveEnvironment = {
  NODE_ENV: 'production', EPHEMERAL_MODE: 'live', PUBLIC_URL: 'https://control.test',
  E2B_API_KEY: 'test', E2B_TEMPLATE_ID: 'test', GITHUB_APP_ID: '1', GITHUB_APP_SLUG: 'test',
  GITHUB_CLIENT_ID: 'test', GITHUB_CLIENT_SECRET: 'test', GITHUB_APP_PRIVATE_KEY: 'test',
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), ALLOWED_GITHUB_IDS: '1',
};

describe('trusted configuration diagnostics', () => {
  it('marks fixed validation messages as safe configuration errors', () => {
    expect(() => readConfig({ PORT: 'unsafe-private-value' })).toThrow(ConfigurationError);
    try { readConfig({ EPHEMERAL_MODE: 'live', GITHUB_CLIENT_SECRET: 'synthetic-private-value' }); }
    catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as Error).message).toContain('Missing live configuration:');
      expect((error as Error).message).not.toContain('synthetic-private-value');
    }
  });
});

describe('live mode environment boundary', () => {
  it.each(['live', undefined])('accepts production for explicit or inferred live mode (%s)', mode => {
    expect(readConfig({ ...liveEnvironment, EPHEMERAL_MODE: mode }).mode).toBe('live');
  });
  it.each([undefined, 'development', 'test'])('rejects live mode with NODE_ENV=%s', nodeEnv => {
    for (const mode of ['live', undefined]) {
      expect(() => readConfig({ ...liveEnvironment, EPHEMERAL_MODE: mode, NODE_ENV: nodeEnv })).toThrow('Live mode requires NODE_ENV=production');
    }
  });
  it('keeps local simulation available and rejects production preview', () => {
    for (const nodeEnv of [undefined, 'development', 'test']) expect(readConfig({ EPHEMERAL_MODE: 'preview', NODE_ENV: nodeEnv }).mode).toBe('preview');
    expect(() => readConfig({ EPHEMERAL_MODE: 'preview', NODE_ENV: 'production' })).toThrow('Preview cannot run in production');
  });
  it('still requires HTTPS for live mode', () => {
    expect(() => readConfig({ ...liveEnvironment, PUBLIC_URL: 'http://control.test' })).toThrow('Live mode requires HTTPS PUBLIC_URL');
  });
});

describe('control-plane public origin', () => {
  it.each([
    ['HTTPS://CONTROL.TEST:443/', 'https://control.test'],
    ['http://LOCALHOST:80/', 'http://localhost'],
    ['https://CONTROL.TEST:8443/', 'https://control.test:8443'],
    ['http://[::1]:4310/', 'http://[::1]:4310'],
  ])('canonicalizes %s', (input, origin) => {
    expect(readConfig({ EPHEMERAL_MODE: 'preview', PUBLIC_URL: input }).publicUrl).toBe(origin);
  });
  it('uses the canonical configured origin for browser origin checks', () => {
    const config = readConfig({ ...liveEnvironment, PUBLIC_URL: 'HTTPS://CONTROL.TEST:443/' });
    expect(config.publicUrl).toBe('https://control.test');
    expect(isSameOrigin({ headers: { origin: 'https://control.test' } }, config.publicUrl)).toBe(true);
    expect(isSameOrigin({ headers: { origin: 'https://evil.test' } }, config.publicUrl)).toBe(false);
  });
  it.each([
    'ftp://control.test', 'https://', 'https:control.test', 'https:///control.test',
    'https://u:p@control.test', 'https://@control.test', 'https://control.test/path',
    'https://control.test/.', 'https://control.test/..', 'https://control.test/%2e',
    'https://control.test/%2e%2e', 'https://control.test//', 'https://control.test?',
    'https://control.test?x=1', 'https://control.test#', 'https://control.test/#x',
    'https://control.test\\', 'https:\\\\control.test', 'https://control.test\\.\\',
    ' https://control.test', 'https://control.test ', 'https://control.test\n',
    'https://con\ttrol.test', 'https://control.test\r', 'https://control.test\u0000',
    'https://control.test\u007f', 'https://control.test\u0085', 'https://control.test:invalid',
  ])('rejects non-origin or normalized unsafe input %j', publicUrl => {
    expect(() => readConfig({ EPHEMERAL_MODE: 'preview', PUBLIC_URL: publicUrl })).toThrow('PUBLIC_URL must be an HTTP(S) origin');
  });
});

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
    const local = { ...liveEnvironment, PREVIEW_LOCAL_ONLY: '1', PREVIEW_PUBLIC_URL: 'http://localhost:4312', PREVIEW_PORT: '4312' };
    expect(readConfig(local)).toMatchObject({ previewLocalOnly: true, previewHost: '127.0.0.1' });
    expect(() => readConfig({ ...local, PREVIEW_HOST: '0.0.0.0' })).toThrow('PREVIEW_LOCAL_ONLY');
    expect(() => readConfig({ ...local, PREVIEW_PORT: '4313' })).toThrow('PREVIEW_LOCAL_ONLY');
    expect(() => readConfig({ ...local, PREVIEW_PUBLIC_URL: 'https://preview.test' })).toThrow('PREVIEW_LOCAL_ONLY');
    expect(() => readConfig({ ...local, PREVIEW_PORT: '4310' })).toThrow('PREVIEW_PORT');
  });
});
