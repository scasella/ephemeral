import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function localEnvironment(directory, port, inherited = process.env) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a TCP port between 1 and 65535.');
  const env = {...inherited};
  for (const key of Object.keys(env)) {
    if (/^(E2B_|GITHUB_|GH_|OPENAI_|CODEX_)/.test(key)) delete env[key];
  }
  // Empty values also prevent process.loadEnvFile from enabling integrations.
  return {...env, NODE_ENV: 'development', EPHEMERAL_MODE: 'preview', HOST: '127.0.0.1', PORT: String(port),
    PUBLIC_URL: `http://localhost:${port}`, DATA_DIR: join(directory, '.data', 'local-preview'), DATABASE_URL: '',
    PREVIEW_PUBLIC_URL: '', PREVIEW_LOCAL_ONLY: '0', PREVIEW_HOST: '127.0.0.1', PREVIEW_PORT: '4312', SESSION_MAX_HOURS: '1',
    E2B_API_KEY: '', E2B_TEMPLATE_ID: '', GITHUB_APP_ID: '', GITHUB_APP_SLUG: '', GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '', GITHUB_APP_PRIVATE_KEY: '', GITHUB_APP_PRIVATE_KEY_FILE: '',
    ENCRYPTION_KEY: '', ALLOWED_GITHUB_IDS: ''};
}

async function main() {
  const {values} = parseArgs({options: {port: {type: 'string', default: '4310'}, help: {type: 'boolean', default: false}}});
  if (values.help) { console.log('Usage: npm run local -- [--port 4310]\nRuns simulated sessions on loopback, with a separate local database and no integration credentials.'); return; }
  if (process.versions.node.split('.')[0] !== '24') throw new Error('Use Node.js 24 LTS first (nvm install && nvm use), then npm ci.');
  if (!/^\d+$/.test(values.port)) throw new Error('Choose a numeric TCP port.');
  const port = Number(values.port), env = localEnvironment(root, port);
  try { await access(join(root, 'node_modules', 'tsx', 'package.json')); }
  catch { throw new Error('Dependencies are missing. Run npm ci first.'); }
  await new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', () => fail(new Error(`Port ${port} is unavailable. Choose another with npm run local -- --port ${port < 65535 ? port + 1 : 4310}.`)));
    probe.listen(port, '127.0.0.1', () => probe.close(error => error ? fail(new Error('Could not release the local port.')) : done()));
  });
  console.log(`Local simulation: http://localhost:${port}\nNo hosting account, GitHub sign-in or E2B key is needed. Terminal/model output and cloud cleanup are simulated.`);
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {cwd: root, env, stdio: 'inherit'});
  const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  child.once('error', () => { console.error('The local server could not start.'); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
