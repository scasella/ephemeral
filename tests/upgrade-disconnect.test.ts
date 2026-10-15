import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
describe('disconnected websocket upgrades (isolated Node process)', () => {
  for (const handler of ['terminal', 'viewer']) {
    it(`survives TCP resets and cancels pending ${handler} work`, async () => {
      // Keep socket errors fatal in the child, so removing the early error guard
      // fails this test without taking down the Vitest worker.
      const result = await run(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx',
        fileURLToPath(new URL('./fixtures/upgrade-disconnect.ts', import.meta.url)), handler], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 30_000,
        env: { PATH: process.env.PATH, NODE_ENV: 'production' },
      });
      expect(result.stdout).toContain(`${handler}: cancellation and subsequent connection passed`);
    }, 35_000);
  }
});
