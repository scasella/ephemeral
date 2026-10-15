import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnv } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CommandExitError, ConnectionConfig, NotFoundError, Sandbox, SandboxNotFoundError } from 'e2b';

const WORKSPACE = '/home/user/workspace';
const ZERO = '0'.repeat(40);
const BRANCH_POLICY = 'Ephemeral: only the assigned session branch may be pushed';
const DELETE_POLICY = 'Ephemeral: branch deletion is disabled';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
class SmokeError extends Error {}
type Receipt = { sessionId: string; sandboxId: string; repository: string; branch: string; gatewayOrigin: string; capability: string; capturedAt: string };
const checks: { name: string; ok: boolean; message: string }[] = [];
const pass = (name: string, message: string) => checks.push({ name, ok: true, message });
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new SmokeError(message); }

function identity(metadata: Record<string, string>, sessionId: string, fixture: string) {
  assert(metadata.ephemeral_session_id === sessionId, 'Sandbox session metadata does not match.');
  assert(metadata.ephemeral_repository === fixture, 'Smoke writes require the explicitly selected disposable fixture.');
  assert(/^\d+$/.test(metadata.ephemeral_repository_id ?? ''), 'Sandbox repository identity metadata is missing.');
  assert(metadata.ephemeral_branch === `ephemeral/${sessionId}`, 'Sandbox assigned-branch metadata does not match.');
}
function gatewayRemote(remote: string, origin: string, sessionId: string) {
  let url: URL;
  try { url = new URL(remote.trim()); } catch { throw new SmokeError('Workspace origin remote is not a valid gateway URL.'); }
  assert(url.origin === origin && url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === `/gateway/git/${sessionId}.git`, 'Workspace remote does not match this server/session gateway.');
}
function packetLine(payload: string): Buffer {
  const bytes = Buffer.from(payload);
  return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, '0')), bytes]);
}
function safeMainPacket(mainOid: string): Buffer {
  assert(/^[a-f0-9]{40}$/.test(mainOid), 'Main branch must have a valid SHA-1 object ID.');
  const emptyPack = Buffer.alloc(12);
  emptyPack.write('PACK'); emptyPack.writeUInt32BE(2, 4); emptyPack.writeUInt32BE(0, 8);
  // Asking to create an existing main at its current commit invokes the hook
  // without supplying a changed main commit. Ordinary git suppresses no-op
  // pushes. The zero old OID also makes upstream force-with-lease expect absence.
  return Buffer.concat([packetLine(`${ZERO} ${mainOid} refs/heads/main\0report-status side-band-64k\n`), Buffer.from('0000'), emptyPack, createHash('sha1').update(emptyPack).digest()]);
}
function sideband(response: Buffer) {
  const status: Buffer[] = [], diagnostics: Buffer[] = [];
  let offset = 0;
  while (offset < response.length) {
    const header = response.subarray(offset, offset + 4).toString();
    assert(/^[a-f0-9]{4}$/i.test(header), 'Gateway returned malformed Git status framing.');
    const length = parseInt(header, 16); offset += 4;
    if (length === 0) continue;
    assert(length >= 5 && offset + length - 4 <= response.length, 'Gateway returned truncated Git status framing.');
    const payload = response.subarray(offset, offset + length - 4); offset += length - 4;
    if (payload[0] === 1) status.push(payload.subarray(1));
    else if (payload[0] === 2) diagnostics.push(payload.subarray(1));
    else throw new SmokeError('Gateway returned unexpected Git sideband status.');
  }
  return { status: Buffer.concat(status).toString(), diagnostics: Buffer.concat(diagnostics).toString() };
}

async function requireGatewayRejection(response: Response): Promise<void> {
  const expected = response.status === 401 ? 'Invalid or disabled gateway credential'
    : response.status === 403 ? 'Session is inactive or expired' : undefined;
  assert(expected && /^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? ''), 'Old gateway capability did not receive the application gateway rejection response.');
  const reader = response.body?.getReader();
  assert(reader, 'Gateway rejection response body was missing.');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      assert(length <= 4096, 'Gateway rejection response exceeded the supported size.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  let result: unknown;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new SmokeError('Gateway rejection response was not valid application JSON.'); }
  assert(typeof result === 'object' && result !== null && !Array.isArray(result) &&
    Object.keys(result).length === 1 && (result as { error?: unknown }).error === expected,
    'Old gateway capability was not independently rejected by the application gateway; proxy/tunnel denials do not establish revocation.');
}
async function saveReceipt(receipt: Receipt) {
  await mkdir('.data/live-smoke', { recursive: true, mode: 0o700 });
  const path = join('.data/live-smoke', `${receipt.sessionId}.json`);
  try {
    const existing = await readFile(path, 'utf8');
    const prior = JSON.parse(existing) as Receipt;
    assert(prior.sessionId === receipt.sessionId && prior.sandboxId === receipt.sandboxId && prior.capability === receipt.capability && prior.gatewayOrigin === receipt.gatewayOrigin, 'Existing smoke receipt differs; refusing to overwrite cleanup evidence.');
    assert(((await stat(path)).mode & 0o077) === 0, 'Existing capability receipt permissions are too broad.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(receipt), 'utf8'); await file.sync(); }
    finally { await file.close(); }
  }
}
function options(args: string[]) {
  const flags = new Map<string, string>(); let cleanup = false, selfTest = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--verify-cleanup') cleanup = true;
    else if (args[i] === '--self-test') selfTest = true;
    else {
      assert(['--session-id', '--sandbox-id', '--env-file', '--fixture'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--') && !flags.has(args[i]), 'Use --fixture OWNER/REPO --session-id UUID --sandbox-id ID, optionally --env-file PATH or --verify-cleanup.');
      flags.set(args[i], args[++i]);
    }
  }
  if (!selfTest) {
    assert(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(flags.get('--fixture') ?? ''), 'An explicit --fixture OWNER/REPO for a disposable test repository is required.');
    assert(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(flags.get('--session-id') ?? ''), 'A valid session UUID is required.');
    assert(/^[a-zA-Z0-9_-]{1,100}$/.test(flags.get('--sandbox-id') ?? ''), 'A valid sandbox ID is required.');
  }
  return { fixture: flags.get('--fixture')!, sessionId: flags.get('--session-id')!, sandboxId: flags.get('--sandbox-id')!, envFile: flags.get('--env-file') ?? '.env.live', cleanup, selfTest };
}

async function smoke(cli: ReturnType<typeof options>) {
  const values = parseEnv(await readFile(cli.envFile, 'utf8'));
  for (const key of ['E2B_API_KEY', 'E2B_DOMAIN', 'E2B_API_URL', 'E2B_DEBUG', 'E2B_SANDBOX_URL', 'PUBLIC_URL']) if (!process.env[key] && values[key]) process.env[key] = values[key];
  const apiKey = process.env.E2B_API_KEY;
  assert(apiKey, 'E2B_API_KEY is missing.');
  const opts = { apiKey, requestTimeoutMs: 30_000, retries: 0 };
  const connection = new ConnectionConfig(opts);
  const api = new URL(connection.apiUrl);
  assert(!connection.debug && api.protocol === 'https:' && ['api.e2b.app', 'api.e2b.dev'].includes(api.hostname) && !process.env.E2B_SANDBOX_URL, 'Live smoke requires E2B Cloud without development API/sandbox overrides.');
  const publicUrl = new URL(process.env.PUBLIC_URL ?? '');
  assert(publicUrl.protocol === 'https:' && !publicUrl.username && !publicUrl.password && publicUrl.pathname === '/' && !publicUrl.search && !publicUrl.hash, 'PUBLIC_URL must be the server HTTPS origin.');
  const gateway = `${publicUrl.origin}/gateway/git/${cli.sessionId}.git`;

  if (cli.cleanup) {
    const path = join('.data/live-smoke', `${cli.sessionId}.json`);
    assert(((await stat(path)).mode & 0o077) === 0, 'Capability receipt must remain private.');
    const receipt = JSON.parse(await readFile(path, 'utf8')) as Receipt;
    assert(receipt.sessionId === cli.sessionId && receipt.sandboxId === cli.sandboxId && receipt.repository === cli.fixture && receipt.branch === `ephemeral/${cli.sessionId}` && receipt.gatewayOrigin === publicUrl.origin, 'Cleanup receipt does not match this fixture/session/server.');
    const result = await fetch(`${gateway}/info/refs?service=git-upload-pack`, { redirect: 'manual', signal: AbortSignal.timeout(30_000), headers: {
      Authorization: `Basic ${Buffer.from(`x-access-token:${receipt.capability}`).toString('base64')}`, 'ngrok-skip-browser-warning': '1',
    } });
    await requireGatewayRejection(result);
    pass('old-gateway-capability', 'Old gateway credential independently rejected with the exact application JSON error and HTTP 401/403.');
    let absent = false;
    try { await Sandbox.getInfo(cli.sandboxId, opts); }
    catch (error) { if (error instanceof SandboxNotFoundError || error instanceof NotFoundError) absent = true; else throw error; }
    assert(absent, 'VM still exists or provider absence was not confirmed.');
    pass('provider-vm-absence', 'E2B independently reports the VM not found.');
    pass('scope', 'No resource creation, resume, destruction, or Git writes performed in cleanup verification. GitHub upstream token revocation was not independently tested; consult the app cleanup report.');
    return;
  }

  const info = await Sandbox.getInfo(cli.sandboxId, opts);
  identity(info.metadata, cli.sessionId, cli.fixture);
  assert(info.state === 'running', 'Smoke will not resume a paused VM.');
  pass('fixture-identity', 'Provider metadata matches the disposable fixture, session, repository ID, and assigned branch.');
  const sandbox = await Sandbox.connect(cli.sandboxId, opts);
  const run = async (command: string, timeoutMs = 30_000) => {
    const result = await sandbox.commands.run(command, { user: 'user', cwd: WORKSPACE, timeoutMs, requestTimeoutMs: timeoutMs + 5_000 });
    assert(result.exitCode === 0, 'Sandbox command did not finish successfully.');
    return result;
  };
  await run('set -eu; command -v node; command -v npm; command -v pnpm; command -v git; command -v tmux; command -v codex; node --version; codex --version');
  pass('runtime-tools', 'Node/npm/pnpm/Git/tmux/Codex commands are installed and their version commands execute. No auth files were read.');
  gatewayRemote((await run('git remote get-url origin')).stdout, publicUrl.origin, cli.sessionId);
  assert((await run('git symbolic-ref --short HEAD')).stdout.trim() === info.metadata.ephemeral_branch, 'Workspace is not on its assigned session branch.');
  assert((await run('git status --porcelain')).stdout.trim() === '', 'Workspace is not clean; refusing to commit unrelated user changes.');
  pass('gateway-remote', 'Workspace uses the exact server/session gateway remote and assigned branch.');
  const capability = (await run('printf %s "$EPHEMERAL_GATEWAY_TOKEN"')).stdout.trim();
  assert(/^[A-Za-z0-9_-]{32,512}$/.test(capability), 'Gateway capability could not be safely captured.');
  await saveReceipt({ sessionId: cli.sessionId, sandboxId: cli.sandboxId, repository: cli.fixture, branch: info.metadata.ephemeral_branch, gatewayOrigin: publicUrl.origin, capability, capturedAt: new Date().toISOString() });
  pass('cleanup-evidence', 'Saved the old scoped capability in an ignored mode-600 receipt; its value is never printed.');
  const file = `ephemeral-smoke-${randomUUID()}.txt`;
  await sandbox.files.write(`${WORKSPACE}/${file}`, 'Disposable Ephemeral gateway smoke fixture. Safe to delete with its branch.\n', { user: 'user', requestTimeoutMs: 30_000 });
  await run(`git add -- ${quote(file)} && git -c user.name='Ephemeral Smoke' -c user.email='ephemeral-smoke@example.invalid' commit --only -m 'Verify disposable Ephemeral gateway' -- ${quote(file)}`);
  const git = 'GIT_TERMINAL_PROMPT=0 GIT_TRACE=0 git -c http.followRedirects=false';
  await run(`${git} push --porcelain -- origin HEAD:${quote(`refs/heads/${info.metadata.ephemeral_branch}`)}`, 120_000);
  pass('assigned-branch-push', 'Innocuous fixture commit pushed successfully to the assigned ephemeral branch.');

  const main = (await run(`${git} ls-remote --refs origin refs/heads/main`, 60_000)).stdout.trim().split(/\s+/)[0];
  const response = await fetch(`${gateway}/git-receive-pack`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(90_000), headers: {
    Authorization: `Basic ${Buffer.from(`x-access-token:${capability}`).toString('base64')}`, 'Content-Type': 'application/x-git-receive-pack-request', 'ngrok-skip-browser-warning': '1',
  }, body: new Uint8Array(safeMainPacket(main)) });
  assert(response.ok && response.headers.get('content-type')?.includes('application/x-git-receive-pack-result'), 'Gateway did not return Git receive-pack status for the safe main probe.');
  const decoded = sideband(Buffer.from(await response.arrayBuffer()));
  assert(decoded.status.includes('ng refs/heads/main pre-receive hook declined') && decoded.diagnostics.includes(BRANCH_POLICY), 'Gateway did not prove its explicit main-branch restriction. No changed main commit was supplied; inspect the disposable fixture manually.');
  assert((await run(`${git} ls-remote --refs origin refs/heads/main`, 60_000)).stdout.trim().split(/\s+/)[0] === main, 'Main branch changed during the safe probe; inspect the disposable fixture manually.');
  pass('main-push-rejected', 'Server-owned pre-receive explicitly rejected main. Probe supplied its existing commit, never a modified main commit.');
  const reject = async (command: string, marker: string, name: string) => {
    let rejected = false;
    try { await run(command, 90_000); }
    catch (error) {
      if (error instanceof CommandExitError && error.exitCode !== 0 && (error.stdout + error.stderr).includes(marker)) rejected = true;
      else throw error;
    }
    assert(rejected, `${name} was not explicitly rejected. Inspect the disposable fixture; no automatic rollback will run.`);
    pass(name, 'Git client received the explicit server-owned gateway policy rejection.');
  };
  await reject(`${git} push --porcelain -- origin HEAD:${quote(`refs/heads/smoke-unassigned-${cli.sessionId}`)}`, BRANCH_POLICY, 'unassigned-branch-push-rejected');
  await reject(`${git} push --porcelain --delete -- origin ${quote(info.metadata.ephemeral_branch)}`, DELETE_POLICY, 'assigned-branch-deletion-rejected');
}

async function selfTest() {
  const fixture = 'example-owner/disposable-smoke';
  const id = '12345678-1234-4234-8234-123456789012';
  const metadata = { ephemeral_session_id: id, ephemeral_repository: fixture, ephemeral_repository_id: '123', ephemeral_branch: `ephemeral/${id}` };
  identity(metadata, id, fixture);
  let blocked = false; try { identity({ ...metadata, ephemeral_repository: 'example-owner/other-project' }, id, fixture); } catch { blocked = true; }
  assert(blocked, 'Fixture gate self-test failed.');
  for (const value of [undefined, 'owner/repo/extra', 'https://example.invalid/repo', 'owner/repo#branch', 'owner/repo with spaces']) {
    let denied = false;
    try { options(['--session-id', id, '--sandbox-id', 'test-sandbox', ...(value ? ['--fixture', value] : [])]); } catch { denied = true; }
    assert(denied, 'Missing or malformed fixture must be rejected before configuration/network access.');
  }
  assert(options(['--fixture', fixture, '--session-id', id, '--sandbox-id', 'test-sandbox']).fixture === fixture, 'Explicit fixture selection was not retained.');
  gatewayRemote(`https://server.example/gateway/git/${id}.git`, 'https://server.example', id);
  blocked = false; try { gatewayRemote(`https://server.example/gateway/git/other.git`, 'https://server.example', id); } catch { blocked = true; }
  assert(blocked, 'Gateway scope self-test failed.');
  const directory = mkdtempSync(join(tmpdir(), 'ephemeral-safe-main-selftest-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert(result.status === 0, 'Local Git protocol fixture setup failed.'); return result.stdout.trim();
  };
  try {
    git(['init', '--initial-branch=main']);
    git(['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
    const oid = git(['rev-parse', 'HEAD']); const bare = join(directory, 'bare.git');
    git(['clone', '--bare', '.', bare]);
    const marker = join(directory, 'hook-ran');
    writeFileSync(join(bare, 'hooks', 'pre-receive'), `#!/bin/sh\nprintf yes > ${quote(marker)}\necho '${BRANCH_POLICY}' >&2\nexit 1\n`, { mode: 0o700 });
    const result = spawnSync('git', ['receive-pack', '--stateless-rpc', bare], { cwd: directory, input: safeMainPacket(oid) });
    const decoded = sideband(result.stdout);
    assert(existsSync(marker) && decoded.status.includes('ng refs/heads/main pre-receive hook declined') && decoded.diagnostics.includes(BRANCH_POLICY), 'Safe main probe did not invoke/capture the server hook.');
    assert(git(['--git-dir', bare, 'rev-parse', 'refs/heads/main']) === oid, 'Safe main probe changed the fixture ref.');
  } finally { rmSync(directory, { recursive: true, force: true }); }
  await requireGatewayRejection(Response.json({ error: 'Invalid or disabled gateway credential' }, { status: 401 }));
  await requireGatewayRejection(Response.json({ error: 'Session is inactive or expired' }, { status: 403 }));
  for (const response of [new Response('Tunnel forbidden', { status: 403, headers: { 'Content-Type': 'text/html' } }),
    Response.json({ error: 'Forbidden' }, { status: 403 }),
    new Response('x'.repeat(4097), { status: 401, headers: { 'Content-Type': 'application/json' } })]) {
    let rejected = false; try { await requireGatewayRejection(response); } catch { rejected = true; }
    assert(rejected, 'Proxy/invalid/oversize rejection response incorrectly proved credential revocation.');
  }
  pass('self-test', 'Gateway JSON rejection checks, fixture/URL gates and real local Git protocol rejection passed; main stayed unchanged. No E2B/GitHub/network operations occurred.');
}

try {
  const cli = options(process.argv.slice(2));
  if (cli.selfTest) await selfTest(); else await smoke(cli);
} catch (error) {
  // All SDK stdout/stderr, headers, bodies, device/auth files, and capability
  // values stay out of console output, including exceptional exits.
  checks.push({ name: 'smoke', ok: false, message: error instanceof SmokeError ? error.message : 'Smoke operation failed without confirmed success. Inspect provider/app state; raw SDK errors were suppressed to protect credentials.' });
  process.exitCode = 1;
}
console.log(JSON.stringify({ ok: checks.every(check => check.ok), checks }, null, 2));
