import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import type { Database } from '../server/contracts.js';
import { openDatabase } from '../server/db.js';
import { createSessionRepository } from '../server/core/repository.js';
import { SESSION_UUID } from '../server/core/continuation.js';
import { CredentialStore } from '../server/github/store.js';
import { GitHubAPI } from '../server/github/api.js';
import { encryptionKey } from '../server/github/security.js';
import { beforeDeadline } from '../server/shutdown.js';
import { disableRecoveryGateway, inspectRecovery, migrateRecoveryAudit, RECOVERY_REASONS, reconcileRecovery, RecoveryError,
  type RecoveryContext, type RecoveryManager } from '../server/operator-recovery.js';

const HELP = `Local operator recovery (Node 24). Stop the application before using this tool.
Usage:
  npm run session:recovery -- inspect --session UUID [--mode live|preview] [--env-file PATH]
  npm run session:recovery -- reconcile --session UUID --confirm-session UUID --reason CATEGORY [--env-file PATH]
Reasons: ${RECOVERY_REASONS.join(', ')}
Reconcile performs destructive cleanup only on the selected cleanup_pending or abandoned provisioning session.
It never accepts a manual assertion as cleanup evidence. No force-unlock option exists.
Database selection: DATABASE_URL, otherwise DATA_DIR/<mode>; mode defaults to EPHEMERAL_MODE or live.
Inspect is offline and does not require provider credentials. Reconcile requires valid live production configuration.
`;
interface Arguments { command: 'inspect' | 'reconcile'; sessionId: string; mode?: 'live' | 'preview'; envFile?: string; confirmedId?: string; reason?: string }
function parseArguments(argv: string[]): Arguments | null {
  if (argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0])) return null;
  if (!['inspect', 'reconcile'].includes(argv[0])) throw new RecoveryError('invalid_arguments');
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!['--session', '--mode', '--env-file', '--confirm-session', '--reason'].includes(key) || !value || value.startsWith('--') || values.has(key)) throw new RecoveryError('invalid_arguments');
    values.set(key, value);
  }
  const sessionId = values.get('--session') ?? '';
  const mode = values.get('--mode');
  if (!SESSION_UUID.test(sessionId) || (mode !== undefined && !['live', 'preview'].includes(mode))) throw new RecoveryError('invalid_arguments');
  if (argv[0] === 'inspect' && (values.has('--reason') || values.has('--confirm-session'))) throw new RecoveryError('invalid_arguments');
  if (argv[0] === 'reconcile' && (values.get('--confirm-session') !== sessionId || !RECOVERY_REASONS.includes(values.get('--reason') as typeof RECOVERY_REASONS[number]))) throw new RecoveryError('invalid_arguments');
  return { command: argv[0] as Arguments['command'], sessionId, mode: mode as Arguments['mode'], envFile: values.get('--env-file'), confirmedId: values.get('--confirm-session'), reason: values.get('--reason') };
}
async function selectedEnvironment(env: NodeJS.ProcessEnv, filename?: string): Promise<NodeJS.ProcessEnv> {
  if (!filename) return { ...env };
  const handle = await open(resolve(filename), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 65_536) throw new RecoveryError('configuration_invalid');
    return { ...env, ...parseEnv(await handle.readFile('utf8')) };
  } finally { await handle.close(); }
}
async function liveManager(context: RecoveryContext, env: NodeJS.ProcessEnv): Promise<RecoveryManager> {
  // Snapshot is explicit: legacy config module's implicit .env load cannot override selection.
  const { readConfig } = await import('../server/config.js');
  const config = readConfig(env);
  if (config.mode !== 'live') throw new RecoveryError('configuration_invalid');
  const { E2BProvider } = await import('../server/infra/e2b.js');
  const { SessionManager } = await import('../server/core/lifecycle.js');
  const { createPreviewTokenStore } = await import('../server/application-preview-secrets.js');
  const store = new CredentialStore(context.db, encryptionKey(config.encryptionKey), new GitHubAPI(config.githubAppId, config.privateKey, config.githubAppSlug));
  await store.migrate();
  const previewTokens = await createPreviewTokenStore(context.db, config.encryptionKey);
  const provider = new E2BProvider({ apiKey: config.e2bApiKey, templateId: config.e2bTemplateId, gatewayUrl: config.publicUrl, previewTokens });
  return new SessionManager(context.repo, provider, {
    issue: async () => { throw new RecoveryError('operation_failed'); },
    disable: id => disableRecoveryGateway(store, id),
    revokeGitHub: id => store.revoke(id),
  }, { maxHours: config.sessionMaxHours });
}
export interface RecoveryCLIOptions {
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** Test seam only: the CLI has no fixture mode or provider injection flags. */
  createManager?: (context: RecoveryContext, env: NodeJS.ProcessEnv) => Promise<RecoveryManager>;
  workTimeoutMs?: number;
  closeTimeoutMs?: number;
}
/** No SDK/configuration error text crosses this boundary, including failed database acquisition. */
export async function runSessionRecovery(argv: string[], options: RecoveryCLIOptions = {}): Promise<number> {
  const stdout = options.stdout ?? (text => { process.stdout.write(text); });
  const stderr = options.stderr ?? (text => { process.stderr.write(text); });
  let db: Database | undefined;
  let manager: RecoveryManager | undefined;
  let retained = false;
  let code = 1;
  try {
    const args = parseArguments(argv);
    if (!args) { stdout(HELP); return 0; }
    let env: NodeJS.ProcessEnv;
    try { env = await selectedEnvironment(options.env ?? process.env, args.envFile); }
    catch { throw new RecoveryError('configuration_invalid'); }
    const mode = args.mode ?? env.EPHEMERAL_MODE ?? 'live';
    if (!['live', 'preview'].includes(mode) || (args.command === 'reconcile' && mode !== 'live')) throw new RecoveryError('configuration_invalid');
    const dataDir = resolve(env.DATA_DIR || '.data', mode);
    if (!env.DATABASE_URL) {
      try {
        const directory = await lstat(resolve(dataDir, 'postgres'));
        const marker = await lstat(resolve(dataDir, 'postgres', 'PG_VERSION'));
        if (!directory.isDirectory() || directory.isSymbolicLink() || !marker.isFile() || marker.isSymbolicLink()) throw new RecoveryError('database_not_found');
      } catch { throw new RecoveryError('database_not_found'); }
    }
    try { db = await openDatabase(env.DATABASE_URL, dataDir, env); }
    catch { throw new RecoveryError('ownership_unavailable'); }
    let ownershipLost = false;
    db.onFatal?.(() => { ownershipLost = true; });
    const existing = await db.query<{ present: string | null }>("SELECT to_regclass('ephemeral_sessions')::text AS present");
    if (!existing.rows[0]?.present) throw new RecoveryError('database_not_found');
    const repo = await createSessionRepository(db);
    // Diagnostics touch schema and safe projections only. This key/API can never be used for mutations.
    const diagnosticStore = new CredentialStore(db, Buffer.alloc(32), new GitHubAPI('', '', ''));
    await diagnosticStore.migrate();
    await migrateRecoveryAudit(db);
    const context: RecoveryContext = { db, repo, store: diagnosticStore };
    if (args.command === 'inspect') { stdout(JSON.stringify(await inspectRecovery(context, args.sessionId), null, 2) + '\n'); code = 0; }
    else {
      // Validate target before provider construction/config validation; running sessions are never stopped.
      const session = await repo.get(args.sessionId);
      if (!session) throw new RecoveryError('session_not_found');
      if (!['provisioning', 'cleanup_pending'].includes(session.state)) throw new RecoveryError('ineligible_session');
      try { manager = await (options.createManager ?? liveManager)(context, { ...env, EPHEMERAL_MODE: mode }); }
      catch { throw new RecoveryError('configuration_invalid'); }
      context.manager = manager;
      if (ownershipLost) throw new RecoveryError('ownership_unavailable');
      const result = await reconcileRecovery(context, args.sessionId, args.confirmedId!, args.reason!, options.workTimeoutMs);
      retained = result.ownershipRetained;
      stdout(JSON.stringify(result, null, 2) + '\n');
      code = result.outcome === 'completed' ? 0 : 2;
    }
  } catch (error) {
    stderr(JSON.stringify({ error: error instanceof RecoveryError ? error.code : 'operation_failed' }) + '\n');
  } finally {
    if (db && !retained) {
      try { await beforeDeadline((async () => { await manager?.shutdown(); await db!.close(); })(), options.closeTimeoutMs ?? 7_000); }
      catch { retained = true; code = 2; }
    }
    if (retained) stderr(JSON.stringify({ error: 'shutdown_incomplete', ownershipRetained: true }) + '\n');
  }
  return code;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Hard process cap preserves a local lock if initialization, audit, or draining hangs.
  const watchdog = setTimeout(() => {
    process.stderr.write('{"error":"shutdown_incomplete","ownershipRetained":true}\n');
    process.exit(2);
  }, 140_000);
  void runSessionRecovery(process.argv.slice(2)).then(code => { clearTimeout(watchdog); process.exit(code); }, () => {
    process.stderr.write('{"error":"operation_failed"}\n'); process.exit(1);
  });
}
