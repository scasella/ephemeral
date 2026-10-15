import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../server/app.js';
import { readConfig } from '../server/config.js';

const resources = vi.hoisted(() => ({ database: vi.fn(), vite: vi.fn() }));
vi.mock('../server/db.js', () => ({ openDatabase: resources.database }));
vi.mock('vite', () => ({ createServer: resources.vite }));

describe('live application startup boundary', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it.each([undefined, 'development', 'test'])('rejects injected live configuration with NODE_ENV=%s before resources open', async nodeEnv => {
    const config = { ...readConfig({ EPHEMERAL_MODE: 'preview' }), mode: 'live' as const };
    vi.stubEnv('NODE_ENV', nodeEnv);
    await expect(createApplication(config)).rejects.toThrow('Live mode requires NODE_ENV=production');
    expect(resources.database).not.toHaveBeenCalled();
    expect(resources.vite).not.toHaveBeenCalled();
  });
});
