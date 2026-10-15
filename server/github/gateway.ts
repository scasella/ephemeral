import express, { type Request, type Response } from 'express';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Session } from '../contracts.js';
import { CredentialStore } from './store.js';
import { GitHubError, safeRepository } from './security.js';
import { PRE_RECEIVE } from './hook.js';
import { copyContinuation } from '../core/continuation.js';
import { WorkTracker, trackListener, beforeDeadline, SHUTDOWN_TIMEOUT_MS } from '../shutdown.js';

const MAX_BODY = 32 * 1024 * 1024;
const MAX_RESPONSE = 256 * 1024 * 1024;
const MAX_DISK = 1024 * 1024 * 1024;
const COMMAND_TIMEOUT = 120_000;
const sessionIdPattern = /^[A-Za-z0-9_-]{1,80}$/;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const baseEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  GIT_PROTOCOL_FROM_USER: '0', LC_ALL: 'C' });
// Only packet-line command names distinguish v0/v1 fetch from v2 ls-refs.
function isFetch(body: Buffer): boolean {
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(header)) return false;
    const size = parseInt(header, 16);
    if (size <= 2) { offset += 4; continue; }
    if (size < 4 || offset + size > body.length) return false;
    const line = body.subarray(offset + 4, offset + size).toString('utf8');
    if (line === 'command=fetch' || line === 'command=fetch\n' || /^want [a-f0-9]{40}(?:[ \n]|$)/.test(line)) return true;
    offset += size;
  }
  return false;
}
function kill(child: ChildProcess): void { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } }
export interface GateOptions {
  getSession(id: string): Promise<Session | null>;
  authorizeSession?(session: Session): Promise<void>;
}
export class GitGateway {
  readonly router = express.Router();
  private readonly work = new WorkTracker();
  private stopped = false;
  private closePromise?: Promise<void>;
  private listener?: ReturnType<typeof trackListener>;
  private root = '';
  private socket = '';
  private server?: Server;
  private secret = randomBytes(32).toString('hex');
  private queues = new Map<string, Promise<unknown>>();
  private queueSize = new Map<string, number>();
  private active = new Map<string, Set<ChildProcess>>();
  private dirs = new Map<string, string>();
  private initialized = new Set<string>();
  constructor(private store: CredentialStore, private options: GateOptions) {
    this.router.use((req, res) => this.work.track(this.handle(req, res).catch(error => {
      if (res.headersSent) { res.destroy(); return; }
      res.status(error instanceof GitHubError ? error.status : 502).json({ error: error instanceof GitHubError ? error.message : 'Git gateway request failed' });
    })));
  }
  async start(): Promise<void> {
    try {
    // Persisted paths enable cleanup after a crash. Only our strictly bounded temporary paths are removed.
    for (const disk of await this.store.disks()) {
      await this.removeDisk(disk.path);
      await this.store.forgetDisk(disk.session_id);
    }
    for (const root of await this.store.roots()) {
      if (!/^\/tmp\/ep-gh-[A-Za-z0-9]+$/.test(root.path)) throw new Error('Unsafe Git gateway root cleanup path');
      await rm(root.path, { recursive: true, force: true }); await this.store.forgetRoot(root.path);
    }
    this.root = await mkdtemp('/tmp/ep-gh-'); await chmod(this.root, 0o700);
    try { await this.store.recordRoot(this.root); } catch (error) { await rm(this.root, { recursive: true, force: true }); throw error; }
    this.socket = path.join(this.root, 'gate.sock');
    this.server = createServer((req, res) => {
      void this.work.track((async () => {
        this.checkOpen();
        if (req.method !== 'POST' || req.url !== '/' || req.headers.authorization !== `Bearer ${this.secret}`) { res.writeHead(403).end(); return; }
        const data = await this.body(req, 1024);
        const parsed = JSON.parse(data.toString()) as { sessionId: string };
        await this.authorize(parsed.sessionId, true);
        res.writeHead(204).end();
      })().catch(() => { if (!res.destroyed) res.writeHead(403).end(); }));
    });
    this.listener = trackListener(this.server);
    await new Promise<void>((resolve, reject) => {
      const error = (failure: Error) => { this.server!.off('listening', ready); reject(failure); };
      const ready = () => { this.server!.off('error', error); resolve(); };
      this.server!.once('error', error); this.server!.once('listening', ready); this.server!.listen(this.socket);
    });
    await chmod(this.socket, 0o600);
    } catch (error) { await beforeDeadline(this.close(), SHUTDOWN_TIMEOUT_MS); throw error; }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.stopped = true;
    const listener = this.listener?.close();
    for (const children of this.active.values()) for (const child of children) kill(child);
    this.closePromise = (async () => {
      await listener;
      await Promise.allSettled([...this.queues.values()]);
      await this.work.drain();
      for (const [id, dir] of this.dirs) { await this.removeDisk(dir); await this.store.forgetDisk(id); }
      if (this.root) { await rm(this.root, { recursive: true, force: true }); await this.store.forgetRoot(this.root); }
    })();
    return this.closePromise;
  }
  private checkOpen() { if (this.stopped) throw new GitHubError('Git gateway is shutting down', 503); }
  async serialize<T>(id: string, action: () => Promise<T>): Promise<T> {
    this.checkOpen();
    const size = this.queueSize.get(id) ?? 0;
    if (size >= 8) throw new GitHubError('Too many simultaneous Git requests', 429);
    this.queueSize.set(id, size + 1);
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => { this.checkOpen(); return action(); });
    this.queues.set(id, next);
    try { return await next; } finally {
      this.queueSize.set(id, (this.queueSize.get(id) ?? 1) - 1);
      if (this.queues.get(id) === next) { this.queues.delete(id); this.queueSize.delete(id); }
    }
  }
  async disable(id: string): Promise<void> {
    this.checkOpen();
    // Fast DB gate first. Terminate the process group, including pre-receive and upstream push.
    await this.store.disable(id);
    for (const child of this.active.get(id) ?? []) kill(child);
    await this.serialize(id, async () => {
      const dir = this.dirs.get(id) ?? (await this.store.disks()).find(d => d.session_id === id)?.path;
      if (dir) await this.removeDisk(dir);
      await this.store.forgetDisk(id); this.dirs.delete(id); this.initialized.delete(id);
    });
  }
  private async removeDisk(dir: string): Promise<void> {
    // Ignore database paths outside the server-owned temp namespace, never recursively delete arbitrary data.
    if (!/^\/tmp\/ep-gh-[A-Za-z0-9]+\/repo-[A-Za-z0-9_-]{1,80}\.git$/.test(dir)) throw new Error('Unsafe Git gateway cleanup path');
    await rm(dir, { recursive: true, force: true });
  }
  // Local checks deliberately avoid upstream authorization: callers can place
  // this fence after their last remote preflight, immediately before a mutation.
  async authorizeLocal(id: string, write: boolean, capability?: string): Promise<Session> {
    this.checkOpen();
    if (!sessionIdPattern.test(id) || !await this.store.enabled(id, capability)) throw new GitHubError('Invalid or disabled gateway credential', 401);
    const session = await this.options.getSession(id);
    if (!session || Date.parse(session.expiresAt) <= Date.now() || !Number.isFinite(Date.parse(session.expiresAt)) || (write ? session.state !== 'running' : !['provisioning', 'running'].includes(session.state))) {
      throw new GitHubError('Session is inactive or expired', 403);
    }
    safeRepository(session.repository);
    if (session.branch === session.baseBranch || !session.branch.startsWith('ephemeral/')) throw new GitHubError('Invalid assigned session branch', 403);
    this.checkOpen();
    return session;
  }
  async authorize(id: string, write: boolean, capability?: string): Promise<Session> {
    const session = await this.authorizeLocal(id, write, capability);
    await this.options.authorizeSession?.(session);
    // Permissions can take a network round trip. Stop, expiry or capability
    // revocation during that wait must invalidate the result.
    return this.authorizeLocal(id, write, capability);
  }
  private async body(req: AsyncIterable<Uint8Array>, max = MAX_BODY): Promise<Buffer> {
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > max) throw new GitHubError('Git request exceeds the body limit', 413); chunks.push(Buffer.from(chunk)); }
    return Buffer.concat(chunks);
  }
  private async command(id: string, args: string[], env: NodeJS.ProcessEnv, input?: Buffer): Promise<Buffer> {
    this.checkOpen();
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const children = this.active.get(id) ?? new Set<ChildProcess>(); children.add(child); this.active.set(id, children);
      let outputSize = 0; const output: Buffer[] = []; let exceeded = false;
      const timeout = setTimeout(() => { exceeded = true; kill(child); }, COMMAND_TIMEOUT);
      const repoDir = this.dirs.get(id);
      let checkingDisk = false;
      const diskTimer = repoDir ? setInterval(() => {
        if (checkingDisk) return; checkingDisk = true;
        void this.diskLimit(repoDir).catch(() => { exceeded = true; kill(child); }).finally(() => { checkingDisk = false; });
      }, 1000) : undefined;
      diskTimer?.unref();
      child.stdout!.on('data', (data: Buffer) => { outputSize += data.length; if (outputSize > MAX_RESPONSE) { exceeded = true; kill(child); } else output.push(data); });
      // Discard upstream stderr: credentials and GitHub response bodies must never become application logs.
      child.stderr!.resume();
      child.stdin!.on('error', () => undefined); child.stdin!.end(input);
      child.on('error', reject);
      child.on('close', code => { clearTimeout(timeout); if (diskTimer) clearInterval(diskTimer); children.delete(child); if (!children.size) this.active.delete(id);
        if (code !== 0 || exceeded) reject(new GitHubError('Git operation failed or exceeded its resource limit')); else resolve(Buffer.concat(output)); });
    });
  }
  private async withAuth<T>(session: Session, token: string, action: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    this.checkOpen();
    const authDir = await mkdtemp(path.join(this.root, 'auth-')); await chmod(authDir, 0o700);
    const tokenFile = path.join(authDir, 'token'); const askpassJS = path.join(authDir, 'askpass.cjs'); const askpass = path.join(authDir, 'askpass');
    await writeFile(tokenFile, token, { mode: 0o600 });
    await writeFile(askpassJS, `const fs=require('node:fs');process.stdout.write(/username/i.test(process.argv[2]||'')?'x-access-token\\n':fs.readFileSync(process.env.EP_TOKEN_FILE,'utf8')+'\\n');`, { mode: 0o600 });
    await writeFile(askpass, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(askpassJS)} "$@"\n`, { mode: 0o700 });
    const env = { ...baseEnv(), GIT_ASKPASS: askpass, EP_TOKEN_FILE: tokenFile, EP_GATE_SOCKET: this.socket,
      EP_GATE_SECRET: this.secret, EP_SESSION: session.id, EP_BRANCH: session.branch, EP_UPSTREAM: `https://github.com/${session.repository}.git` };
    try { this.checkOpen(); return await action(env); } finally { await rm(authDir, { recursive: true, force: true }); }
  }
  private async prepare(session: Session, env: NodeJS.ProcessEnv): Promise<string> {
    await this.command(session.id, ['check-ref-format', `refs/heads/${session.branch}`], env);
    await this.command(session.id, ['check-ref-format', `refs/heads/${session.baseBranch}`], env);
    const dir = path.join(this.root, `repo-${session.id}.git`);
    if (!this.initialized.has(session.id)) {
      await this.store.recordDisk(session.id, dir); this.dirs.set(session.id, dir);
      await this.command(session.id, ['init', '--bare', dir], env);
      await this.command(session.id, ['--git-dir', dir, 'config', 'http.receivepack', 'true'], env);
      await this.command(session.id, ['--git-dir', dir, 'config', 'receive.maxInputSize', String(MAX_BODY)], env);
      await this.command(session.id, ['--git-dir', dir, 'config', 'receive.fsckObjects', 'true'], env);
      // Upstream history can contain legacy fsck findings. Only incoming VM pushes
      // require receive.fsckObjects; transfer.fsckObjects also rejects trusted fetches.
      await this.command(session.id, ['--git-dir', dir, 'config', 'uploadpack.allowAnySHA1InWant', 'false'], env);
      const script = path.join(dir, 'hooks', 'ephemeral-pre-receive.cjs');
      await writeFile(script, PRE_RECEIVE, { mode: 0o600 });
      await writeFile(path.join(dir, 'hooks', 'pre-receive'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)}\n`, { mode: 0o700 });
      this.initialized.add(session.id);
    }
    await this.diskLimit(dir);
    await this.command(session.id, ['-c', 'credential.helper=', '-c', `core.askPass=${env.GIT_ASKPASS}`, '-c', 'http.followRedirects=false',
      '--git-dir', dir, 'fetch', '--no-tags', '--prune', '--no-auto-maintenance', env.EP_UPSTREAM!, '+refs/heads/*:refs/heads/*'], env);
    await this.diskLimit(dir);
    return dir;
  }
  private async diskLimit(dir: string): Promise<void> {
    // File traversal is bounded to server-created objects; no repository checkout or symlinks from commits.
    let total = 0;
    const visit = async (location: string): Promise<void> => {
      const { readdir, lstat } = await import('node:fs/promises');
      for (const item of await readdir(location, { withFileTypes: true })) {
        const file = path.join(location, item.name);
        if (item.isDirectory()) await visit(file); else total += (await lstat(file)).size;
        if (total > MAX_DISK) throw new GitHubError('Repository exceeds the gateway disk limit', 413);
      }
    };
    await visit(dir);
  }
  private async handle(req: Request, res: Response): Promise<void> {
    this.checkOpen();
    res.setHeader('Cache-Control', 'no-store');
    const match = /^\/git\/([A-Za-z0-9_-]{1,80})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(req.path);
    if (!match) throw new GitHubError('Gateway route not found', 404);
    const [, id, endpoint] = match;
    const service = endpoint === 'info/refs' ? req.query.service : endpoint;
    if ((endpoint === 'info/refs' ? req.method !== 'GET' : req.method !== 'POST') || !['git-upload-pack', 'git-receive-pack'].includes(String(service)) || typeof service !== 'string') throw new GitHubError('Unsupported Git request', 405);
    const auth = /^Basic ([A-Za-z0-9+/]+=*)$/.exec(req.headers.authorization ?? '');
    const basic = auth && Buffer.from(auth[1], 'base64').toString('utf8');
    if (!basic || !basic.startsWith('x-access-token:') || basic.length > 128) { res.setHeader('WWW-Authenticate', 'Basic realm="Ephemeral"'); throw new GitHubError('Gateway authentication required', 401); }
    const capability = basic.slice('x-access-token:'.length);
    const write = service === 'git-receive-pack';
    await this.authorize(id, write, capability);
    if (endpoint !== 'info/refs' && req.headers['content-type'] !== `application/x-${service}-request`) throw new GitHubError('Unsupported Git content type', 415);
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new GitHubError('Compressed Git request bodies are unsupported', 415);
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) throw new GitHubError('Git request exceeds the body limit', 413);
    // Acquire the bounded session queue before buffering any body. Only one body is held per session.
    await this.serialize(id, async () => {
      const session = await this.authorize(id, write, capability);
      if (res.destroyed) return;
      // Requests have a 30-second input deadline before launching a subprocess.
      const body = endpoint === 'info/refs' ? Buffer.alloc(0) : await Promise.race([this.body(req), new Promise<never>((_, reject) => { const timer = setTimeout(() => { req.destroy(); reject(new GitHubError('Git body timed out', 408)); }, 30_000); timer.unref(); req.once('end', () => clearTimeout(timer)); req.once('close', () => clearTimeout(timer)); })]);
      const token = await this.store.token(session);
      await this.withAuth(session, token, async env => {
        const dir = await this.prepare(session, env);
        let baseOid = await this.store.anchors.get(session);
        const eligible = await this.store.anchors.eligible(session);
        const baseRef = `refs/heads/${session.baseBranch}`;
        const resolve = async (ref: string): Promise<string | null> => {
          // Missing objects are batch results, not subprocess failures: resource and
          // transport failures must keep their real error instead of becoming 'missing'.
          const result = (await this.command(id, ['--git-dir', dir, 'cat-file', '--batch-check=%(objectname) %(objecttype)'],
            env, Buffer.from(`${ref}^{commit}\n`))).toString().trim();
          return /^([a-f0-9]{40}) commit$/.exec(result)?.[1] ?? null;
        };
        // Never pick a first-push ancestor from receive-pack's moving upstream base.
        // Persist before the first upload advertisement, including protocol v2 discovery.
        if (!baseOid && !write && eligible) {
          const source = session.continuation ? copyContinuation(session.continuation).commitSha : baseRef;
          const candidate = await resolve(source);
          if (!candidate) throw new GitHubError('The session clone base is unavailable; restore the selected base or start a fresh session', 409);
          baseOid = await this.store.anchors.capture(session, candidate);
        }
        if (baseOid) {
          const cloneComplete = await this.store.anchors.cloneComplete(session);
          // Pruning branch refs must not discard the immutable clone object. A visible
          // non-branch ref also keeps an earlier advertised want valid across stateless
          // HTTP requests, without allowing arbitrary or hidden-object SHA wants.
          if (!await resolve(baseOid) && !write && !cloneComplete) {
            await this.command(id, ['-c', 'credential.helper=', '-c', `core.askPass=${env.GIT_ASKPASS}`, '-c', 'http.followRedirects=false',
              '--git-dir', dir, 'fetch', '--no-tags', '--no-auto-maintenance', env.EP_UPSTREAM!, baseOid], env);
          }
          if (await resolve(baseOid)) await this.command(id, ['--git-dir', dir, 'update-ref', 'refs/ephemeral/clone-anchor', baseOid], env);
          if (!cloneComplete && !write) {
            // Discovery, ls-refs and fetch must describe the same initial snapshot.
            await this.command(id, ['--git-dir', dir, 'update-ref', baseRef, baseOid], env);
          }
        }
        const head = await resolve(baseRef) ? baseRef : await resolve(`refs/heads/${session.branch}`) ? `refs/heads/${session.branch}` : null;
        if (head) await this.command(id, ['--git-dir', dir, 'symbolic-ref', 'HEAD', head], env);
        else if (baseOid && await resolve(baseOid)) await this.command(id, ['--git-dir', dir, 'update-ref', '--no-deref', 'HEAD', baseOid], env);
        else await this.command(id, ['--git-dir', dir, 'symbolic-ref', 'HEAD', baseRef], env);
        const anchorError = eligible ? 'the original clone base has not been recorded; clone the session first (restore the selected base if it is missing)' :
          'this legacy session has no recorded clone base; create a fresh session before publishing a new branch';
        await this.authorize(id, write, capability);
        if (res.destroyed) return;
        const backendEnv = { ...env, EP_BASE_OID: baseOid ?? '', EP_BASE_ERROR: anchorError, GIT_PROJECT_ROOT: this.root, GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: `/repo-${id}.git/${endpoint}`, REQUEST_METHOD: req.method, QUERY_STRING: endpoint === 'info/refs' ? `service=${service}` : '',
          CONTENT_TYPE: req.headers['content-type'] ?? '', CONTENT_LENGTH: String(body.length), REMOTE_USER: 'session',
          GIT_PROTOCOL: req.headers['git-protocol'] === 'version=2' ? 'version=2' : '' };
        const disconnected = () => { for (const child of this.active.get(id) ?? []) kill(child); };
        res.once('close', disconnected);
        let result: Buffer;
        try { result = await this.command(id, ['http-backend'], backendEnv, body); } finally { res.removeListener('close', disconnected); }
        await this.diskLimit(dir);
        const separator = result.indexOf('\r\n\r\n');
        if (separator < 0 || separator > 32768) throw new GitHubError('Malformed Git backend response');
        let status = 200;
        for (const line of result.subarray(0, separator).toString().split('\r\n')) {
          const colon = line.indexOf(':'); if (colon < 0) continue;
          const key = line.slice(0, colon).toLowerCase(), value = line.slice(colon + 1).trim();
          if (key === 'status') status = Number(value.split(' ')[0]);
          else if (key === 'content-type') res.setHeader('Content-Type', value);
        }
        if (status === 200 && baseOid && !write && endpoint === 'git-upload-pack' && isFetch(body) &&
            result.subarray(separator + 4).includes(Buffer.from('PACK'))) {
          await this.store.anchors.complete(session);
        }
        res.status(status).end(result.subarray(separator + 4));
      });
    });
  }
}
