import { readConfig } from './config.js';
import { createApplication } from './app.js';
const config = readConfig();
const application = await createApplication(config);
if (application.viewer) {
  try {
    await new Promise<void>((resolve, reject) => { application.viewer!.server.once('error', reject); application.viewer!.server.listen(config.previewPort, config.previewHost, resolve); });
  } catch {
    await application.close();
    throw new Error('The separate application preview listener could not start.');
  }
}
application.server.listen(config.port, config.host, () => {
  console.log(`Ephemeral ${config.mode} listening on ${config.publicUrl}`);
  if (config.mode === 'preview') console.log('LOCAL PREVIEW: no real compute, model access, or GitHub operations.');
});
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (closing) return; closing = true;
  const timer = setTimeout(() => process.exit(1), 30_000); timer.unref();
  void application.close().then(() => { clearTimeout(timer); process.exit(0); }).catch(() => process.exit(1));
});
