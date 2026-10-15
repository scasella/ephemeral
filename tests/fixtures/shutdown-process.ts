import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mock } from 'node:test';

const mode = process.argv[2];
const server = createServer((_req, res) => res.end('ready'));
let port = 0;
const occupied = createServer();
if (mode === 'startup-error') {
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address(); assert(address && typeof address !== 'string'); port = address.port;
}
mock.module('../../server/config.ts', { exports: { ConfigurationError: class extends Error {}, readConfig: () => ({ mode: 'preview', host: '127.0.0.1', port, publicUrl: 'http://localhost' }) } });
mock.module('../../server/shutdown.ts', { exports: { PROCESS_EXIT_TIMEOUT_MS: 180 } });
mock.module('../../server/app.ts', { exports: { createApplication: async (_config: unknown, options: { onFatal?: () => void }) => {
  if (mode === 'unexpected-startup-error') throw new Error('Injected sensitive failure: Bearer synthetic-private-value /private/fixture-key.pem');
  if (mode === 'fatal-during-init-hang') { setTimeout(() => options.onFatal?.(), 5); await new Promise(() => {}); }
  if (mode === 'signal-during-init') {
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 5);
    await new Promise(resolve => setTimeout(resolve, 35));
    console.log('initialization completed');
  }
  return {
    server,
    onFatal(listener: () => void) {
      if (mode === 'fatal' || mode === 'hanging-close') setTimeout(listener, 15);
    },
    async close() {
      console.log('close started');
      if (mode === 'hanging-close') await new Promise(() => {});
      await new Promise<void>(resolve => server.close(() => resolve()));
      await new Promise<void>(resolve => occupied.close(() => resolve()));
      console.log('close completed');
    },
  };
} } });
await import('../../server/index.js');
