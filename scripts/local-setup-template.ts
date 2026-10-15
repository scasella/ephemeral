/** Confirmed local template build and read-only verification. Never starts a VM. */
import { fork } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { localChildEnvironment, readLocalConfig, setLocalConfigValue } from './local-setup-config.js';
import type { E2bPreflightReport } from './e2b-preflight.js';

export class SetupTemplateError extends Error {}

const templateIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const buildFailure = 'Template build did not finish successfully. Check the E2B dashboard for an existing or pending build before rerunning setup with --confirm-build. Check the saved E2B_API_KEY if access was denied. The private .data/local-live/template-build-pending.json receipt records the attempt; remove it only after checking the dashboard and before explicitly retrying. No VM was started.';
const verifyFailure = 'Read-only E2B verification failed. Check the saved E2B_API_KEY, E2B_TEMPLATE_ID, and provider availability, then rerun setup doctor. No VM was started.';
const recoveryDirectory = '.data/local-live';
const pendingReceiptName = 'template-build-pending.json';
type WorkerResult = { templateId: string } | E2bPreflightReport;

function validTemplateId(value: unknown, key: string): value is string {
  return typeof value === 'string' && templateIdPattern.test(value) && (!key || !value.includes(key));
}
function validReport(value: unknown): value is E2bPreflightReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as E2bPreflightReport;
  return typeof report.ok === 'boolean' && Array.isArray(report.checks) && report.checks.length <= 20 && report.checks.every(check =>
    typeof check?.name === 'string' && /^[a-z-]{1,40}$/.test(check.name) && ['pass', 'fail', 'unverified'].includes(check.status) &&
    typeof check.message === 'string' && check.message.length <= 600 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(check.message));
}

/** No stdout/stderr is read, buffered, parsed, or forwarded. Only a bounded IPC result is accepted. */
async function runWorker(workspace: string, mode: 'build' | 'verify', values: Record<string, string>): Promise<WorkerResult> {
  const env = localChildEnvironment({
    E2B_API_KEY: values.E2B_API_KEY, E2B_TEMPLATE_ID: values.E2B_TEMPLATE_ID,
    PUBLIC_URL: values.PUBLIC_URL, SESSION_MAX_HOURS: values.SESSION_MAX_HOURS || '1',
  }, {});
  return new Promise((resolve, reject) => {
    let settled = false; let result: WorkerResult | undefined;
    const failure = mode === 'build' ? buildFailure : verifyFailure;
    let child: ReturnType<typeof fork>;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) { child.kill('SIGKILL'); reject(error); } else resolve(result!);
    };
    try {
      child = fork(fileURLToPath(import.meta.url), ['--setup-worker', mode, ...(mode === 'build' ? ['--confirmed-build'] : [])], {
        cwd: workspace, env, execArgv: ['--import', import.meta.resolve('tsx')], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json',
      });
    } catch { reject(new SetupTemplateError(failure)); return; }
    const timer = setTimeout(() => finish(new SetupTemplateError(failure)), mode === 'build' ? 20 * 60_000 : 2 * 60_000);
    child.on('message', message => {
      if (settled) return;
      if (result || !message || typeof message !== 'object' || JSON.stringify(message).length > 16_384) { finish(new SetupTemplateError(failure)); return; }
      const envelope = message as { type?: unknown; result?: unknown };
      if (envelope.type !== 'setup-result') { finish(new SetupTemplateError(failure)); return; }
      const received = envelope.result as { templateId?: unknown };
      if (mode === 'build' ? !validTemplateId(received?.templateId, values.E2B_API_KEY) : !validReport(received)) { finish(new SetupTemplateError(failure)); return; }
      if (values.E2B_API_KEY && JSON.stringify(received).includes(values.E2B_API_KEY)) { finish(new SetupTemplateError(failure)); return; }
      result = received as WorkerResult;
    });
    child.on('error', () => finish(new SetupTemplateError(failure)));
    child.on('exit', (code, signal) => finish(code === 0 && !signal && result ? undefined : new SetupTemplateError(failure)));
  });
}

async function writeRecovery(workspace: string, templateId: string): Promise<string> {
  // Random exclusive file creation cannot overwrite an existing recovery record or follow a symlink.
  await readLocalConfig(workspace);
  const directory = join(workspace, recoveryDirectory); const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || (process.getuid && info.uid !== process.getuid())) throw new SetupTemplateError('Private recovery directory unavailable.');
  const path = join(directory, `template-recovery-${randomUUID()}.json`);
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify({ templateId }) + '\n'); await file.sync(); } finally { await file.close(); }
  return path;
}

async function createPendingReceipt(workspace: string): Promise<string> {
  const path = join(workspace, recoveryDirectory, pendingReceiptName);
  let file;
  try { file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch { throw new SetupTemplateError(`A previous template build may be pending. Check the E2B dashboard and private recovery references before another build. To explicitly retry after recovery, remove ${path}, then rerun setup with --confirm-build. No new build was started.`); }
  try { await file.writeFile(JSON.stringify({ status: 'pending', createdAt: new Date().toISOString(), alias: 'ephemeral-codex' }) + '\n'); await file.sync(); }
  finally { await file.close(); }
  return path;
}

/** A literal confirmed:true is required before any provider build or mutation. */
export async function buildSetupTemplate(workspace: string, options: { confirmed: boolean }): Promise<{ templateId: string }> {
  if (options?.confirmed !== true) throw new SetupTemplateError('Template build requires explicit confirmation. Rerun setup with --confirm-build after reviewing the build step.');
  const values = await readLocalConfig(workspace); // Validate private, untracked, regular configuration paths first.
  const file = await open(join(workspace, '.env.live'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let content: string;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > 1024 * 1024 || (process.getuid && info.uid !== process.getuid())) throw new SetupTemplateError('Local configuration must remain a private regular file.');
    content = await file.readFile('utf8');
  } finally { await file.close(); }
  const parsed = parseEnv(content);
  if (Object.keys(parsed).length !== Object.keys(values).length || Object.keys(values).some(key => parsed[key] !== values[key])) {
    throw new SetupTemplateError('Local configuration changed before the build; rerun setup after reviewing the private file. No build was started.');
  }
  if (!values.E2B_API_KEY?.trim()) throw new SetupTemplateError('Save E2B_API_KEY in the private .env.live file, then rerun setup with --confirm-build.');
  if (values.E2B_TEMPLATE_ID?.trim()) throw new SetupTemplateError('E2B_TEMPLATE_ID is already configured. Run setup doctor to verify it before requesting a replacement build.');
  const pendingReceipt = await createPendingReceipt(workspace);
  const built = await runWorker(workspace, 'build', values) as { templateId: string };
  try { await setLocalConfigValue(workspace, 'E2B_TEMPLATE_ID', built.templateId, { expectedContent: content }); }
  catch {
    let recoveryPath: string;
    try { recoveryPath = await writeRecovery(workspace, built.templateId); }
    catch { throw new SetupTemplateError(`Template ${built.templateId} was built, but configuration could not be saved. Recover this template from the E2B dashboard before rerunning a build. Existing configuration was preserved.`); }
    await rm(pendingReceipt, { force: true }).catch(() => {});
    throw new SetupTemplateError(`Template was built, but local configuration changed or could not be saved. Existing configuration was preserved. A private template reference is saved at ${recoveryPath}; review it and set E2B_TEMPLATE_ID explicitly before rerunning setup doctor. Do not rebuild automatically.`);
  }
  await rm(pendingReceipt, { force: true }).catch(() => {});
  return built;
}

export async function verifySetupTemplate(workspace: string): Promise<E2bPreflightReport> {
  const values = await readLocalConfig(workspace);
  try { return await runWorker(workspace, 'verify', values) as E2bPreflightReport; }
  catch { return { ok: false, checks: [{ name: 'provider', status: 'fail', message: verifyFailure }] }; }
}

async function worker(mode: string | undefined) {
  // A direct internal CLI invocation must fail before importing or invoking the SDK.
  if (!process.send || !process.connected) { process.exitCode = 1; return; }
  const stop = () => process.exit(1);
  const timer = setTimeout(stop, mode === 'build' ? 20 * 60_000 : 2 * 60_000);
  process.once('disconnect', stop);
  const disconnect = () => {
    clearTimeout(timer); process.off('disconnect', stop);
    if (process.connected) process.disconnect();
  };
  try {
    let result: WorkerResult;
    if (mode === 'build' && process.argv[4] === '--confirmed-build') {
      if (!process.env.E2B_API_KEY?.trim()) throw new SetupTemplateError();
      const [{ Template }, { createTemplateRecipe }] = await Promise.all([import('e2b'), import('../sandbox/build-template.js')]);
      const built = await Template.build(createTemplateRecipe(), { apiKey: process.env.E2B_API_KEY, alias: 'ephemeral-codex', requestTimeoutMs: 15_000, retries: 0, onBuildLogs: () => {} });
      if (!validTemplateId(built.templateId, process.env.E2B_API_KEY)) throw new SetupTemplateError();
      result = { templateId: built.templateId };
    } else if (mode === 'verify') {
      const { checkE2bConfiguration } = await import('./e2b-preflight.js');
      result = await checkE2bConfiguration(process.env);
    } else throw new SetupTemplateError();
    process.send({ type: 'setup-result', result }, error => {
      if (error) process.exitCode = 1;
      disconnect();
    });
  } catch { process.exitCode = 1; disconnect(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--setup-worker') await worker(process.argv[3]);
