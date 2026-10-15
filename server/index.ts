import { readConfig, ConfigurationError } from './config.js';
import { createApplication } from './app.js';
import { PROCESS_EXIT_TIMEOUT_MS } from './shutdown.js';
import type { Server } from 'node:http';

let application: Awaited<ReturnType<typeof createApplication>> | undefined;
let closing = false, failed = false;
let initializing: Promise<Awaited<ReturnType<typeof createApplication>>> | undefined;
function shutdown(fatal: boolean) {
  failed ||= fatal;
  if (closing) return;
  closing = true;
  // Independent of every resource promise, including database shutdown.
  const timer = setTimeout(() => process.exit(1), PROCESS_EXIT_TIMEOUT_MS);
  void (async () => {
    if (initializing) { try { application = await initializing; } catch { failed = true; } }
    if (application) await application.close();
    clearTimeout(timer);
    process.exit(failed ? 1 : 0);
  })().catch(() => { clearTimeout(timer); process.exit(1); });
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => shutdown(false));
function listen(server: Server, port: number, host: string) {
  return new Promise<void>((resolve, reject) => {
    const error = (failure: Error) => { server.off('listening', ready); reject(failure); };
    const ready = () => { server.off('error', error); resolve(); };
    server.once('error', error); server.once('listening', ready); server.listen(port, host);
  });
}
try {
  const config = readConfig();
  const fatal = () => { if (!failed) console.error('Database ownership was lost; shutting down.'); shutdown(true); };
  initializing = createApplication(config, { onFatal: fatal });
  application = await initializing;
  application.onFatal(fatal);
  application.server.on('error', () => shutdown(true));
  application.viewer?.server.on('error', () => shutdown(true));
  if (!closing && application.viewer) await listen(application.viewer.server, config.previewPort, config.previewHost);
  if (!closing) await listen(application.server, config.port, config.host);
  if (!closing) {
    console.log(`Ephemeral ${config.mode} listening on ${config.publicUrl}`);
    if (config.mode === 'preview') console.log('LOCAL PREVIEW: no real compute, model access, or GitHub operations.');
  }
} catch (error) {
  console.error(error instanceof ConfigurationError ? error.message : 'Ephemeral could not start or lost database ownership.');
  shutdown(true);
}
