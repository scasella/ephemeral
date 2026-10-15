import { previewFormSource } from '../shared/preview-origin.js';
import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { MIMEType } from 'node:util';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { openDatabase } from './db.js';
import { beforeDeadline, SHUTDOWN_TIMEOUT_MS, trackListener, WorkTracker } from './shutdown.js';
import { terminalInput } from './terminal-input.js';
import { terminalHeartbeat } from './terminal-heartbeat.js';
import { trackedRoutes } from './tracked-routes.js';
import { createAuth, isSameOrigin } from './auth/index.js';
import { createTerminalAuthorization } from './auth/terminal-authorization.js';
import { createSessionRepository } from './core/repository.js';
import { SessionManager } from './core/lifecycle.js';
import { SessionOperationError } from './core/errors.js';
import { parseSessionEventPageOptions, SessionEventPageError } from './core/session-events.js';
import { SessionNotCreatedError } from './core/provisioning.js';
import { E2BProvider } from './infra/e2b.js';
import { createGitHubServices } from './github/index.js';
import { createPullRequestRepository, type PullRequestPreview } from './github/pull-requests.js';
import { GitHubError } from './github/security.js';
import { PublishedChangesError, validatePublishedChangesQuery, type PublishedChanges } from './github/published-changes.js';
import type { WorkStatus } from './workspace-status.js';
import { isChangePath, type WorkspaceChanges } from './workspace-changes.js';
import { createChangeInspectionGate } from './changes.js';
import { createApplicationPreview, ApplicationPreviewError, previewRunning } from './application-preview.js';
import { createPreviewViewer } from './application-preview-viewer.js';
import { createPreviewTokenStore } from './application-preview-secrets.js';
import { createStartupRepository } from './startup.js';
import { createSetupController, SetupError } from './setup.js';
import { createShellController, ShellError, validShellId } from './shells.js';
import { createContinuationController, continuationPreview, ContinuationError } from './continuation.js';
import { createHandoffNotesService, handoffNotesInput, HandoffNotesError } from './handoff-notes.js';
import { PreviewProvider, previewCredentials, previewRepositories } from './preview.js';
import type { Config } from './config.js';
import type { Identity, SandboxProvider, Session, TerminalConnection } from './contracts.js';

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const sessionInput = z.object({ repositoryId: z.number().int().positive(), installationId: z.number().int().positive(), baseBranch: z.string().min(1).max(240).refine(s => !/[\x00-\x20\x7f~^:?*\[\\]/.test(s) && !s.includes('..') && !s.includes('@{') && !s.startsWith('-') && !s.startsWith('/') && !s.endsWith('/') && !s.endsWith('.') && s.split('/').every(p => p && !p.startsWith('.') && !p.endsWith('.lock')), 'Invalid branch name') }).strict();
const prInput = z.object({ title: z.string().trim().min(1).max(240), body: z.string().max(20_000).optional(), expectedHeadSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i), expectedBaseSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i) }).strict();
const continueInput = z.object({ expectedHeadSha: z.string().regex(/^[a-f0-9]{40}$/i), requestId: z.string().uuid(), expectedNoteRevision: z.number().int().min(0).max(2147483646).optional() }).strict();
const labelText = (name: string, minimum = 1) => z.string()
  .refine(s => !/[\u0000-\u001f\u007f-\u009f]/.test(s), `${name} cannot contain control characters`)
  .refine(s => !/[\uD800-\uDFFF]/u.test(s), `${name} must contain valid Unicode`)
  .transform(s => s.trim()).pipe(z.string().min(minimum).max(80));
const sessionLabelInput = z.object({ label: labelText('Label', 0) }).strict();
const shellNameInput = z.object({ name: labelText('Shell name') }).strict();
const shellCreateInput = shellNameInput.extend({ requestId: z.string().uuid() }).strict();
const setupInput = z.object({ label: labelText('Label'), command: z.string().trim().min(1).max(8192).refine(s => !s.includes('\0'), 'Command cannot contain a null character'), timeoutSeconds: z.number().int().min(5).max(600) }).strict();
// The largest shape is a PR: 20,000 body + 240 title code points and two
// 64-character SHAs. Each non-BMP code point can require twelve UTF-8 bytes
// as a JSON surrogate escape pair; the fully escaped shape fits below 245 KB.
// Keep a finite transport cap, including after inflation;
// field limits still apply independently after decoding and trimming.
const API_JSON_BYTE_LIMIT = 256 * 1024;
export async function createApplication(config: Config, options: { previewAuthorizationCacheMs?: number; terminalAuthorizationCacheMs?: number; shutdownTimeoutMs?: number; healthTimeoutMs?: number; terminalHeartbeatMs?: number; terminalCheckMs?: number; onFatal?: () => void } = {}) {
  const production = process.env.NODE_ENV === 'production';
  if (config.mode === 'live' && !production) throw new Error('Live mode requires NODE_ENV=production');
  const db = await openDatabase(config.databaseUrl, resolve(config.dataDir, config.mode));
  let closing = false, failed = false, initialized = false;
  const fatalListeners = new Set<() => void>();
  const work = new WorkTracker();
  const resources: (() => Promise<unknown> | undefined)[] = [];
  let closePromise: Promise<void> | undefined;
  const timeoutMs = options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    // All resource close methods stop admission synchronously, before waiting.
    const drains = resources.map(stop => { try { return Promise.resolve(stop()); } catch (error) { return Promise.reject(error); } });
    closePromise = (async () => {
      let failure: unknown;
      try {
        const results = await beforeDeadline(Promise.allSettled(drains).then(async results => { await work.drain(); return results; }), timeoutMs);
        failure = results.find(result => result.status === 'rejected');
      } catch (error) { failure = error; }
      // Database.close fences new queries before draining existing calls. On a
      // hung app drain keep ownership until process exit instead of unlocking.
      if (!failure) await beforeDeadline(db.close(), Math.max(1, timeoutMs - (Date.now() - startedClosing)));
      if (failure) throw new Error('Server resources did not drain; database ownership is retained until process exit.');
    })();
    return closePromise;
  };
  let startedClosing = 0;
  const beginClose = () => { if (!closePromise) startedClosing = Date.now(); return close(); };
  const unlistenFatal = db.onFatal?.(() => {
    failed = true;
    if (!initialized) options.onFatal?.();
    for (const listener of fatalListeners) listener();
    if (initialized) void beginClose().catch(() => {});
  });
  try {
  const repo = await createSessionRepository(db);
  const startup = await createStartupRepository(db);
  const pullRequests = await createPullRequestRepository(db);
  const auth = await createAuth(db, config, work);
  const previewTokens = await createPreviewTokenStore(db, config.encryptionKey);
  const provider: SandboxProvider = config.mode === 'live' ? new E2BProvider({ apiKey: config.e2bApiKey, templateId: config.e2bTemplateId, gatewayUrl: config.publicUrl, previewTokens }) : new PreviewProvider();
  const applicationPreview = await createApplicationPreview(db, repo, provider, auth, config, { authorizationCacheMs: options.previewAuthorizationCacheMs });
  const viewer = config.previewPublicUrl ? createPreviewViewer(config, applicationPreview) : null;
  if (viewer) resources.push(() => viewer.close());
  const github = config.mode === 'live' ? await createGitHubServices({ db, pullRequests, appId: config.githubAppId, privateKey: config.privateKey, encryptionKey: config.encryptionKey, appSlug: config.githubAppSlug, publicUrl: config.publicUrl, getSession: id => repo.get(id), authorizeSession: auth.authorizeSession, registerClose: close => resources.push(close) }) : null;
  const manager = new SessionManager(repo, provider, github?.credentials || previewCredentials, { maxHours: config.sessionMaxHours });
  resources.push(() => manager.shutdown());
  const handoffNotes = await createHandoffNotesService(db, repo);
  const continuation = await createContinuationController(db, repo, manager, github, id => pullRequests.list(id), handoffNotes);
  const setup = await createSetupController(db, repo, provider, config.mode, auth.authorizeSession);
  resources.push(() => setup.close());
  function terminalTask(task: Promise<unknown>) { return work.track(task); }
  const terminals = new Map<WebSocket, { sessionId: string; shellId: string; connection?: TerminalConnection; timer?: NodeJS.Timeout; stop?: () => void }>();
  const terminalAuthorization = createTerminalAuthorization(auth.authorizeSession, options.terminalAuthorizationCacheMs);
  resources.push(() => { terminalAuthorization.close(); return undefined; });
  function denyTerminals(sessionId: string) {
    terminalAuthorization.revoke(sessionId);
    for (const [ws, state] of terminals) if (state.sessionId === sessionId) {
      state.stop?.(); clearInterval(state.timer);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', message: 'Repository access could not be verified. Sign in and reconnect.' }));
      ws.close(1008, 'Repository access could not be verified');
    }
  }
  const shells = await createShellController(db, repo, provider, config.mode, auth.authorizeSession, (sessionId, shellId) => {
    for (const [ws, state] of terminals) if (state.sessionId === sessionId && state.shellId === shellId) ws.close(1000, 'Shell closed');
  });
  resources.push(() => shells.close());
  const app = express();
  const routes = trackedRoutes(app, work);
  app.use((_req, res, next) => {
    if (closing || failed) { res.status(503).json({ status: 'unavailable' }); return; }
    next();
  });
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', config.previewPublicUrl ? 'origin' : 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cache-Control', 'no-store');
    if (config.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (production) res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'${config.previewPublicUrl ? ` ${previewFormSource(config.previewPublicUrl)}` : ''}`);
    if (config.mode === 'preview' && !['localhost', '127.0.0.1'].includes((req.headers.host || '').split(':')[0])) { res.status(403).send('Preview accepts localhost only'); return; }
    next();
  });
  if (github) app.use('/gateway', github.router);
  app.use('/auth', auth.router);
  routes.get('/healthz', async (_req, res) => {
    try {
      await beforeDeadline(db.query('SELECT 1'), options.healthTimeoutMs ?? 1000);
      if (closing || failed) throw new Error('Unavailable');
      res.json({ status: 'ok', mode: config.mode });
    } catch { res.status(503).json({ status: 'unavailable' }); }
  });
  const nonemptyJsonBodies = new WeakSet<Request>();
  const parseApiJson = express.json({ limit: API_JSON_BYTE_LIMIT, verify: (req, _res, body) => { if (body.length) nonemptyJsonBodies.add(req as Request); } });
  app.use('/api', (req, res, next) => {
    let contentType: MIMEType | undefined;
    try { if (req.headers['content-type']) contentType = new MIMEType(req.headers['content-type']); } catch { /* Let the parser handle malformed media types. */ }
    const charset = contentType?.params.get('charset');
    if (contentType?.essence === 'application/json' && charset && charset.toLowerCase() !== 'utf-8') {
      res.status(415).json({ error: 'Unsupported JSON request encoding' }); return;
    }
    parseApiJson(req, res, error => {
      if (!error) { next(); return; }
      // Normalize only parser failures here: parser messages can echo request
      // contents or compression details and must never reach the generic 409.
      const type = (error as { type?: string }).type;
      if (type === 'entity.too.large') { res.status(413).json({ error: 'JSON request body is too large' }); return; }
      if (type === 'charset.unsupported' || type === 'encoding.unsupported') { res.status(415).json({ error: 'Unsupported JSON request encoding' }); return; }
      res.status(400).json({ error: 'Invalid JSON request body' });
    });
  });
  app.use('/api', (req, res, next) => {
    if (!isSameOrigin(req, config.publicUrl)) { res.status(403).json({ error: 'Cross-origin requests are not permitted' }); return; }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-ephemeral-request'] !== '1') { res.status(403).json({ error: 'Missing request verification header' }); return; }
    next();
  });
  const previewIdentity: Identity & { accessToken: string } = { id: 'preview-user', login: 'local-preview', avatarUrl: '', accessToken: '' };
  function checkOpen() { if (closing || failed) throw new HttpError(503, 'Server is restarting.'); }
  async function identity(req: Request) { checkOpen(); return config.mode === 'preview' ? previewIdentity : auth.read(req); }
  async function requireIdentity(req: Request) { const user = await identity(req); checkOpen(); if (!user) throw new HttpError(401, 'Sign in with GitHub to continue'); return user; }
  async function owned(req: Request) {
    const user = await requireIdentity(req); const session = await repo.get(String(req.params.id));
    checkOpen();
    if (!session || session.userId !== user.id) throw new HttpError(404, 'Session not found');
    return session;
  }
  routes.get('/api/bootstrap', async (req, res) => {
    const user = await identity(req);
    res.json({ user: user && { id: user.id, login: user.login, avatarUrl: user.avatarUrl }, mode: config.mode, sessionMaxHours: config.sessionMaxHours, configured: config.missing.length === 0, missing: config.missing, githubInstallUrl: config.githubAppSlug ? `https://github.com/apps/${encodeURIComponent(config.githubAppSlug)}/installations/new` : null });
  });
  routes.get('/api/repositories', async (req, res) => { const user = await requireIdentity(req); res.json(github ? await github.repositories(user.accessToken) : previewRepositories); });
  routes.get('/api/repositories/:installationId/:repositoryId/branches', async (req, res) => {
    const user = await requireIdentity(req);
    const installationId = z.coerce.number().int().positive().parse(req.params.installationId); const repositoryId = z.coerce.number().int().positive().parse(req.params.repositoryId);
    res.json(github ? await github.branches(user.accessToken, installationId, repositoryId) : [{ name: 'main' }, { name: 'develop' }]);
  });
  routes.get('/api/sessions', async (req, res) => { const user = await requireIdentity(req); res.json(await manager.list(user.id)); });
  routes.post('/api/sessions', async (req, res) => {
    const user = await requireIdentity(req); const input = sessionInput.parse(req.body);
    const available = github ? await github.repositories(user.accessToken) : previewRepositories;
    const selected = available.find(r => r.id === input.repositoryId && r.installationId === input.installationId);
    if (!selected) throw new HttpError(403, 'Repository is not authorized for this account');
    if (github) { const branches = await github.branches(user.accessToken, input.installationId, input.repositoryId); if (!branches.some(b => b.name === input.baseBranch)) throw new HttpError(400, 'Base branch does not exist'); }
    const session = await manager.create({ ...input, repository: selected.fullName, userId: user.id });
    res.status(202).json(session);
  });
  routes.get('/api/sessions/:id', async (req, res) => res.json(await owned(req)));
  routes.get('/api/sessions/:id/handoff-notes', async (req, res) => {
    const session = await owned(req); res.json(await handoffNotes.get(session.userId, session.id));
  });
  routes.post('/api/sessions/:id/handoff-notes', async (req, res) => {
    const session = await owned(req); const input = handoffNotesInput.parse(req.body);
    res.json(await handoffNotes.save(session.userId, session.id, input));
  });
  routes.post('/api/sessions/:id/label', async (req, res) => {
    const session = await owned(req); const { label } = sessionLabelInput.parse(req.body);
    const updated = await repo.setLabel(session.id, session.userId, label);
    if (!updated) throw new HttpError(404, 'Session not found');
    res.json(updated);
  });
  routes.get('/api/sessions/:id/events', async (req, res) => {
    const session = await owned(req);
    try {
      // Authorize first, including malformed cursors, so foreign sessions stay hidden.
      const query = new URL(req.originalUrl, 'http://localhost').searchParams;
      if ([...query.keys()].some(key => !['limit', 'before'].includes(key)) || query.getAll('limit').length > 1 || query.getAll('before').length > 1) throw new SessionEventPageError();
      const options = parseSessionEventPageOptions({ limit: query.get('limit') ?? undefined, before: query.get('before') ?? undefined }, session.id);
      res.json(await repo.eventPage(session.id, options));
    } catch (error) {
      if (error instanceof SessionEventPageError) { res.status(400).json({ error: 'Invalid session event pagination.' }); return; }
      throw error;
    }
  });
  routes.get('/api/sessions/:id/continuation-preview', async (req, res) => {
    const user = await requireIdentity(req); const source = await owned(req);
    try { res.json(await continuation.preview(source, user.accessToken)); }
    catch (error) {
      if (error instanceof GitHubError && error.status === 403) throw error;
      res.json(continuationPreview(source, 'unknown', 'GitHub could not verify the saved branch. Refresh to retry.'));
    }
  });
  routes.post('/api/sessions/:id/continue', async (req, res) => {
    const user = await requireIdentity(req); const source = await owned(req); const input = continueInput.parse(req.body);
    res.status(202).json(await continuation.continue(source, user.accessToken, input.expectedHeadSha, input.requestId, input.expectedNoteRevision));
  });
  routes.post('/api/sessions/:id/stop', async (req, res) => { const s = await owned(req); await applicationPreview.revoke(s.id); setup.stopSession(s.id); res.json(await manager.stop(s.id)); });
  routes.post('/api/sessions/:id/retry-cleanup', async (req, res) => { const s = await owned(req); res.json(await manager.retryCleanup(s.id)); });
  routes.post('/api/sessions/:id/extend', async (req, res) => {
    const s = await owned(req); const { minutes } = z.object({ minutes: z.literal(30) }).strict().parse(req.body);
    res.json(await manager.extend(s.id, minutes, async current => {
      const owner = await owned(req);
      if (!sameTerminalSession(s, current) || !sameTerminalSession(s, owner)) throw new HttpError(409, 'Session changed while extension access was being verified.');
      if (config.mode === 'live') {
        try { await auth.authorizeSession(current); }
        catch { denyTerminals(s.id); throw new HttpError(403, 'Repository access could not be verified. Check access and retry.'); }
      }
      const checked = await owned(req);
      if (req.aborted || res.destroyed || !running(checked) || !sameTerminalSession(current, checked)) throw new HttpError(409, 'Session ended while extension access was being verified.');
    }));
  });
  const running = (s: Session) => s.state === 'running' && !!s.sandboxId && Number.isFinite(Date.parse(s.expiresAt)) && Date.parse(s.expiresAt) > Date.now();
  const sameTerminalSession = (expected: Session, current: Session) => expected.id === current.id && expected.userId === current.userId && expected.repository === current.repository && expected.repositoryId === current.repositoryId && expected.installationId === current.installationId && expected.sandboxId === current.sandboxId && expected.createdAt === current.createdAt && expected.branch === current.branch && expected.baseBranch === current.baseBranch;
  async function previewAuthorized(req: Request, expected?: Session) {
    const s = await owned(req);
    if (!previewRunning(s) || (expected && expected.sandboxId !== s.sandboxId)) throw new ApplicationPreviewError(409, 'Application preview requires a running session.');
    try { await auth.authorizeSession(s); } catch { throw new ApplicationPreviewError(403, 'Repository access could not be verified.'); }
    const current = await owned(req);
    if (!previewRunning(current) || current.sandboxId !== s.sandboxId) throw new ApplicationPreviewError(409, 'The session ended while preview access was being verified.');
    return current;
  }
  routes.get('/api/sessions/:id/preview', async (req, res) => {
    const s = await owned(req);
    const state = await applicationPreview.state(s);
    if (state.state !== 'unavailable') { await previewAuthorized(req, s); res.json(await applicationPreview.state(await owned(req))); }
    else res.json(state);
  });
  routes.post('/api/sessions/:id/preview', async (req, res) => {
    const { port } = z.object({ port: z.number().int().min(1024).max(49151) }).strict().parse(req.body);
    const s = await owned(req);
    res.json(await applicationPreview.mutate(s.id, async () => {
      if ((await applicationPreview.state(s)).state === 'unavailable') throw new ApplicationPreviewError(409, 'Application preview is unavailable.');
      const current = await previewAuthorized(req, s);
      await applicationPreview.enable(current, port);
      try { await previewAuthorized(req, current); } catch (error) { await applicationPreview.disable(current); throw error; }
      return applicationPreview.state(await owned(req));
    }));
  });
  const emptyPreviewBody = (req: Request) => {
    if (!nonemptyJsonBodies.has(req)) throw new ApplicationPreviewError(400, 'Submit an empty JSON object.');
    z.object({}).strict().parse(req.body);
  };
  const previewChecks = createChangeInspectionGate();
  routes.post('/api/sessions/:id/preview/check', async (req, res) => {
    emptyPreviewBody(req);
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', disconnected); res.once('close', disconnected);
    const deadline = setTimeout(() => controller.abort(), 10_000);
    let release: (() => void) | undefined;
    let cancelled!: () => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      cancelled = () => reject(new Error('Application check cancelled'));
      controller.signal.addEventListener('abort', cancelled, { once: true });
    });
    try {
      const operation = (async () => {
        const s = await owned(req);
        controller.signal.throwIfAborted();
        release = previewChecks.acquire(s.userId, s.id) ?? undefined;
        if (!release) { res.setHeader('Retry-After', '1'); throw new ApplicationPreviewError(429, 'Too many application checks. Retry shortly.'); }
        return applicationPreview.check(s, auth.browserHash(req), async (session, accessToken, signal) => {
          if (!github) throw new ApplicationPreviewError(409, 'Application checks require live repository access.');
          await github.authorizeContinuation(session, accessToken, signal);
        }, controller.signal);
      })();
      const result = await Promise.race([operation, cancellation]);
      if (!controller.signal.aborted && !res.destroyed) res.json(result);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      if (!req.aborted && !res.destroyed) res.json({ state: 'unknown', checkedAt: new Date().toISOString(), port: null, httpStatus: null,
        reason: 'Application readiness could not be verified before the check deadline.', remedy: 'Retry the application check.' });
    } finally {
      clearTimeout(deadline); controller.signal.removeEventListener('abort', cancelled);
      req.off('aborted', disconnected); res.off('close', disconnected); release?.();
    }
  });
  routes.post('/api/sessions/:id/preview/close', async (req, res) => {
    emptyPreviewBody(req); const s = await owned(req);
    res.json(await applicationPreview.mutate(s.id, async () => {
      if (config.mode === 'live' && previewRunning(s)) await previewAuthorized(req, s);
      await applicationPreview.disable(s); return applicationPreview.state(await owned(req));
    }));
  });
  routes.post('/api/sessions/:id/preview/open', async (req, res) => {
    emptyPreviewBody(req); const s = await owned(req);
    res.json(await applicationPreview.mutate(s.id, async () => {
      if ((await applicationPreview.state(s)).state !== 'enabled') throw new ApplicationPreviewError(409, 'Enable preview for a running session first.');
      const current = await previewAuthorized(req, s), hash = auth.browserHash(req);
      if (!hash) throw new ApplicationPreviewError(401, 'Sign in again before opening preview.');
      return applicationPreview.open(current, hash);
    }));
  });
  const changeInspections = createChangeInspectionGate();
  const publishedInspections = createChangeInspectionGate();
  routes.get('/api/sessions/:id/published-changes', async (req, res) => {
    const user = await requireIdentity(req), session = await owned(req);
    const params = new URL(req.originalUrl, config.publicUrl).searchParams;
    const allowed = ['path', 'expectedHeadSha', 'expectedBaseSha'];
    // URLSearchParams replaces malformed UTF-8; reject the original encoding first.
    try {
      for (const part of req.originalUrl.split('?').slice(1).join('?').split('&')) {
        for (const value of part.split('=')) decodeURIComponent(value.replaceAll('+', ' '));
      }
    } catch { throw new HttpError(400, 'Specify a valid UTF-8 repository-relative path and reviewed SHA pair.'); }
    if ([...params.keys()].some(key => !allowed.includes(key)) || allowed.some(key => params.getAll(key).length > 1)) {
      throw new HttpError(400, 'Specify at most one path and one reviewed SHA pair.');
    }
    const query = validatePublishedChangesQuery(Object.fromEntries(params));
    if (query.path !== undefined && (!query.expectedHeadSha || !query.expectedBaseSha)) throw new HttpError(400, 'Select a file using the reviewed head and base SHA pair.');
    const unavailable = (reason: string): PublishedChanges => ({ state: 'unavailable', checkedAt: new Date().toISOString(), reason,
      repository: session.repository, headBranch: session.branch, baseBranch: session.baseBranch, headSha: null, baseSha: null,
      mergeBaseSha: null, aheadCommits: null, behindCommits: null, comparisonUrl: null, listTruncated: false, files: [], selected: null });
    if (!github) { res.json(unavailable('Preview cannot inspect published GitHub changes.')); return; }
    const release = publishedInspections.acquire(user.id, session.id);
    if (!release) { res.setHeader('Retry-After', '1'); throw new HttpError(429, 'Too many published review requests. Retry shortly.'); }
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', disconnected); res.once('close', disconnected);
    try {
      const changes = await github.publishedChanges(session, user.accessToken, query, controller.signal);
      if (controller.signal.aborted) return;
      const currentUser = await requireIdentity(req), current = await owned(req);
      if (currentUser.id !== user.id || currentUser.accessToken !== user.accessToken) throw new HttpError(401, 'Sign in again before reviewing published changes.');
      // Ending a sandbox does not invalidate published content; its repository/ref identity does.
      if (current.repository !== session.repository || current.repositoryId !== session.repositoryId || current.installationId !== session.installationId ||
        current.branch !== session.branch || current.baseBranch !== session.baseBranch || current.createdAt !== session.createdAt) {
        res.json(unavailable('The session changed during published review. Refresh to retry.')); return;
      }
      res.json(changes);
    } catch (error) { if (!controller.signal.aborted) throw error; }
    finally { req.off('aborted', disconnected); res.off('close', disconnected); release(); }
  });
  const emptyChanges = (state: 'unknown' | 'unavailable', reason: string): WorkspaceChanges => ({ state, checkedAt: new Date().toISOString(), reason,
    headSha: null, files: [], listTruncated: false, selected: null });
  routes.get('/api/sessions/:id/changes', async (req, res) => {
    const session = await owned(req);
    const query = new URL(req.originalUrl, config.publicUrl).searchParams;
    const paths = query.getAll('path');
    if ([...query.keys()].some(key => key !== 'path') || paths.length > 1 || (paths.length === 1 && !isChangePath(paths[0]))) {
      throw new HttpError(400, 'Specify at most one valid repository-relative path.');
    }
    const unavailable = (reason = 'Change review is available only while the session is running.') => emptyChanges('unavailable', reason);
    if (config.mode === 'preview') { res.json(unavailable('Preview cannot inspect real workspace changes.')); return; }
    if (!running(session) || !provider.inspectChanges) { res.json(unavailable()); return; }
    const release = changeInspections.acquire(session.userId, session.id);
    if (!release) { res.setHeader('Retry-After', '1'); throw new HttpError(429, 'Too many change review requests. Retry shortly.'); }
    try {
      const current = async () => {
        const latest = await owned(req);
        return running(latest) && latest.sandboxId === session.sandboxId ? latest : null;
      };
      const authorize = async (latest: Session) => {
        try { await auth.authorizeSession(latest); }
        catch { throw new HttpError(403, 'Repository access could not be verified. Check access and retry.'); }
        return current();
      };
      const latest = await current();
      const authorized = latest && await authorize(latest);
      if (!authorized) { res.json(unavailable('The session ended while change review access was being verified.')); return; }
      let changes: WorkspaceChanges;
      try { changes = await provider.inspectChanges(authorized, paths[0]); }
      catch { changes = emptyChanges('unknown', 'Workspace changes could not be inspected. Refresh to retry.'); }
      const inspected = await current();
      const verified = inspected && await authorize(inspected);
      res.json(verified ? changes : unavailable('The session ended during change review.'));
    } finally { release(); }
  });
  routes.get('/api/sessions/:id/shells', async (req, res) => res.json(await shells.list(await owned(req))));
  routes.post('/api/sessions/:id/shells', async (req, res) => { const s = await owned(req); const { requestId, name } = shellCreateInput.parse(req.body); res.json(await shells.create(s, requestId, name)); });
  routes.post('/api/sessions/:id/shells/codex/recover', async (req, res) => {
    const s = await owned(req); z.object({}).strict().parse(req.body);
    const recovered = await shells.recoverPrimary(s);
    shellObservations.delete(`${s.id}:codex`);
    res.json(recovered);
  });
  routes.post('/api/sessions/:id/shells/:shellId/name', async (req, res) => { const s = await owned(req); const { name } = shellNameInput.parse(req.body); res.json(await shells.rename(s, String(req.params.shellId), name)); });
  routes.post('/api/sessions/:id/shells/:shellId/close', async (req, res) => {
    const s = await owned(req); z.object({ confirm: z.literal(true) }).strict().parse(req.body);
    res.json(await shells.closeShell(s, String(req.params.shellId)));
  });
  routes.get('/api/sessions/:id/setup', async (req, res) => { res.json(await setup.progress(await owned(req))); });
  routes.put('/api/sessions/:id/setup', async (req, res) => { const s = await owned(req); res.json(await setup.save(s, setupInput.parse(req.body))); });
  routes.post('/api/sessions/:id/setup/runs', async (req, res) => {
    const s = await owned(req); const { recipeVersion } = z.object({ recipeVersion: z.string().uuid() }).strict().parse(req.body);
    res.status(202).json(await setup.start(s, recipeVersion));
  });
  routes.post('/api/sessions/:id/setup/runs/:runId/cancel', async (req, res) => {
    const s = await owned(req);
    if (!nonemptyJsonBodies.has(req)) throw new HttpError(400, 'Submit an empty JSON object to cancel setup.');
    z.object({}).strict().parse(req.body);
    res.json(await setup.cancel(s, z.string().uuid().parse(req.params.runId)));
  });
  routes.get('/api/sessions/:id/startup', async (req, res) => { const s = await owned(req); res.json(await startup.progress(s, config.mode)); });
  routes.post('/api/sessions/:id/first-useful-response', async (req, res) => {
    const s = await owned(req);
    if (!nonemptyJsonBodies.has(req)) throw new HttpError(400, 'Submit an empty JSON object to mark a useful response.');
    z.object({}).strict().parse(req.body);
    if (config.mode === 'preview') throw new HttpError(409, 'Preview cannot measure a real Codex response.');
    if (!running(s)) throw new HttpError(409, 'Session is not running');
    await auth.authorizeSession(s);
    if (!await startup.recordFirstUsefulResponse(s.id)) throw new HttpError(409, 'Attach the terminal in a running session before marking a useful response.');
    res.json(await startup.progress(s, config.mode));
  });
  const emptyWorkStatus = (state: 'unknown' | 'unavailable', reason: string): WorkStatus => ({ state, checkedAt: new Date().toISOString(), reason,
    dirtyFiles: null, untrackedFiles: null, aheadCommits: null, headSha: null, remoteSha: null, remoteCheckedAt: null, branch: null, branchMatches: null, remoteExists: null });
  routes.get('/api/sessions/:id/work-status', async (req, res) => {
    const s = await owned(req);
    if (!running(s) || config.mode === 'preview' || !provider.inspectWorkspace) { res.json(emptyWorkStatus('unavailable', config.mode === 'preview' ? 'Preview cannot inspect a real workspace.' : 'Workspace inspection is available only while the session is running.')); return; }
    await auth.authorizeSession(s);
    try {
      const status = await provider.inspectWorkspace(s);
      const current = await repo.get(s.id);
      res.json(current && running(current) ? status : emptyWorkStatus('unavailable', 'The session ended during workspace inspection.'));
    } catch { res.json(emptyWorkStatus('unknown', 'Workspace inspection failed. Refresh to retry before ending the session.')); }
  });
  routes.get('/api/sessions/:id/pull-requests', async (req, res) => { const s = await owned(req); res.json(await pullRequests.list(s.id)); });
  routes.get('/api/sessions/:id/pull-request-preview', async (req, res) => {
    const s = await owned(req);
    const unavailable: PullRequestPreview = { state: 'unavailable', checkedAt: new Date().toISOString(), reason: config.mode === 'preview' ? 'Preview cannot verify or create a real GitHub pull request.' : 'Pull request creation is available only while the session is running.', headSha: null, baseSha: null, baseBranch: s.baseBranch, headBranch: s.branch, aheadCommits: null };
    if (!github || !running(s)) { res.json(unavailable); return; }
    await auth.authorizeSession(s);
    try {
      const preview = await github.pullRequestPreview(s);
      const current = await repo.get(s.id);
      res.json(current && running(current) ? preview : unavailable);
    } catch (error) {
      if (error instanceof GitHubError && [401, 403].includes(error.status)) throw error;
      res.json({ ...unavailable, state: 'unknown', reason: 'GitHub could not verify the published branch and selected base. Refresh to retry.' });
    }
  });
  routes.post('/api/sessions/:id/pull-request', async (req, res) => {
    const s = await owned(req); const { title, body, expectedHeadSha, expectedBaseSha } = prInput.parse(req.body);
    if (config.mode === 'preview') throw new HttpError(409, 'Preview does not create GitHub pull requests. Configure live integrations first.');
    if (!running(s)) throw new HttpError(409, 'Session is not running');
    await auth.authorizeSession(s);
    res.json(await github!.createPullRequest(s, title, body, expectedHeadSha, expectedBaseSha));
  });
  routes.post('/api/logout', async (req, res) => { if (config.mode === 'live') await auth.logout(req, res); res.json({ ok: true }); });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found' }));
  const server = createServer(app);
  const listener = trackListener(server);
  resources.push(() => listener.close());
  server.requestTimeout = 120_000; server.headersTimeout = 15_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  resources.push(() => {
    for (const [ws, state] of terminals) {
      clearInterval(state.timer); state.stop?.();
      if (state.connection) { terminalTask(state.connection.disconnect().catch(() => {})); state.connection = undefined; }
      ws.terminate();
    }
    return new Promise<void>(resolve => wss.close(() => resolve()));
  });
  resources.push(() => { shellObservations.clear(); return undefined; });
  const shellObservations = new Map<string, { until: number; value: Promise<import('./contracts.js').TerminalShellState> }>();
  function observeShell(session: Session, shellId: string) {
    const key = `${session.id}:${shellId}`;
    const cached = shellObservations.get(key);
    if (cached && cached.until > Date.now()) return cached;
    for (const [id, value] of shellObservations) if (value.until <= Date.now()) shellObservations.delete(id);
    const value = provider.inspectShell ? provider.inspectShell(session, shellId).catch(() => 'unknown' as const) : Promise.resolve('unknown' as const);
    const observation = { until: Date.now() + (options.terminalCheckMs ?? 5000), value };
    shellObservations.set(key, observation);
    return observation;
  }
  server.on('upgrade', (req, socket, head) => { terminalTask((async () => {
    if (closing || failed) { socket.destroy(); return; }
    // ws installs its socket error listener only in handleUpgrade, after auth.
    let disconnected = false;
    socket.on('error', () => { disconnected = true; socket.destroy(); });
    socket.once('close', () => { disconnected = true; });
    const unavailable = () => closing || failed || disconnected || socket.destroyed || !socket.readable || !socket.writable;
    try {
      const terminalUrl = new URL(req.url || '/', config.publicUrl);
      const path = terminalUrl.pathname;
      if (!/^\/api\/sessions\/[^/]+\/terminal$/.test(path)) { if (production) socket.destroy(); return; }
      if (req.headers.origin !== config.publicUrl) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      const shellValues = terminalUrl.searchParams.getAll('shell');
      const shellId = (shellValues[0] ?? 'codex').toLowerCase();
      if ([...terminalUrl.searchParams.keys()].some(key => key !== 'shell') || shellValues.length > 1 || !validShellId(shellId)) { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      const user = config.mode === 'preview' ? previewIdentity : await auth.read(req as Request);
      if (unavailable()) return;
      const id = path.split('/')[3]; const s = await repo.get(id);
      if (unavailable()) return;
      if (!user || !s || s.userId !== user.id || !running(s)) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      const attachable = await shells.attachable(s, shellId);
      if (unavailable()) return;
      if (!attachable) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      const browserHash = config.mode === 'preview' ? 'preview' : auth.browserHash(req as Request);
      let attachment: WebSocket | undefined, accessPending: Promise<Session> | undefined;
      const access = () => accessPending ??= (async () => {
        const current = await repo.get(s.id);
        const browser = config.mode === 'preview' ? previewIdentity : await auth.read(req as Request);
        if (unavailable() || (attachment && attachment.readyState !== WebSocket.OPEN)) throw new Error('Terminal unavailable');
        if (!browserHash || !browser || browser.id !== s.userId || !current || !sameTerminalSession(s, current) || !running(current) || !await shells.attachable(current, shellId)) throw new Error('Terminal unavailable');
        if (config.mode === 'live') {
          try { await terminalAuthorization.authorize(current, browserHash); }
          catch { denyTerminals(s.id); throw new Error('Repository access could not be verified'); }
        }
        // Neither permission cache nor an in-flight success can revive an ended
        // attachment, expired login, replaced sandbox or changed owner.
        const checked = await repo.get(s.id);
        const signedIn = config.mode === 'preview' ? previewIdentity : await auth.read(req as Request);
        if (unavailable() || (attachment && attachment.readyState !== WebSocket.OPEN) || !signedIn || signedIn.id !== s.userId || !checked || !sameTerminalSession(s, checked) || !running(checked) || !await shells.attachable(checked, shellId)) throw new Error('Terminal unavailable');
        if (unavailable() || (attachment && attachment.readyState !== WebSocket.OPEN) || !running(checked)) throw new Error('Terminal unavailable');
        return checked;
      })().finally(() => { accessPending = undefined; });
      try { await access(); }
      catch { if (!unavailable()) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); } return; }
      if (unavailable()) return;
      if ([...terminals.values()].filter(v => v.sessionId === s.id).length >= 4 || [...terminals.values()].filter(v => v.sessionId === s.id && v.shellId === shellId).length >= 2) { socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, ws => {
        attachment = ws;
        const state: { sessionId: string; shellId: string; connection?: TerminalConnection; timer?: NodeJS.Timeout; stop?: () => void } = { sessionId: s.id, shellId }; terminals.set(ws, state);
        const decoder = new StringDecoder('utf8');
        const send = (value: object) => { if (ws.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 2 * 1024 * 1024) ws.close(1008, 'Terminal output overflow; reconnect'); else ws.send(JSON.stringify(value)); } };
        let inputReady = false;
        const stopHeartbeat = terminalHeartbeat(ws, options.terminalHeartbeatMs);
        const input = terminalInput({
          connection: () => state.connection,
          allowed: async () => {
            if (closing || failed || !inputReady || ws.readyState !== WebSocket.OPEN) return false;
            try { await access(); }
            catch { state.stop?.(); ws.close(1008, 'Terminal access could not be verified'); return false; }
            return !closing && !failed && inputReady && ws.readyState === WebSocket.OPEN;
          },
          ack: (bytes, sequence) => send({ type: 'input-ack', bytes, ...(sequence === undefined ? {} : { sequence }) }),
          fail: message => { send({ type: 'error', message }); ws.close(1008, 'Terminal input rejected'); },
          track: terminalTask,
        });
        let stopExit: (() => void) | undefined;
        state.stop = () => { inputReady = false; input.close(); stopHeartbeat(); stopExit?.(); };
        ws.on('message', (raw, binary) => {
          if (!inputReady) { send({ type: 'error', message: 'Terminal is not ready for input.' }); ws.close(1008, 'Terminal not ready'); return; }
          input.receive(raw.toString(), binary);
        });
        ws.on('error', () => {});
        ws.on('close', () => {
          state.stop?.(); clearInterval(state.timer); terminals.delete(ws);
          if (![...terminals.values()].some(attached => attached.sessionId === s.id && attached.shellId === shellId)) shellObservations.delete(`${s.id}:${shellId}`);
          const connection = state.connection; state.connection = undefined;
          if (connection) terminalTask(connection.disconnect().catch(() => {}));
        });
        terminalTask(provider.connectTerminal(s.sandboxId!, data => send({ type: 'output', data: decoder.write(Buffer.from(data)) }), 100, 30, shellId, s).then(async connection => {
          if (closing || failed || ws.readyState !== WebSocket.OPEN) { await connection.disconnect(); return; }
          state.connection = connection;
          stopExit = connection.onExit?.(() => {
            inputReady = false; input.close();
            send({ type: 'exit', message: 'Terminal connection ended. Reconnect to check the shell.', recoverable: shellId === 'codex' });
            ws.close(1000, 'Terminal connection ended');
          });
          if (ws.readyState !== WebSocket.OPEN) return;
          try { await access(); }
          catch { state.stop?.(); ws.close(1008, 'Terminal access could not be verified'); return; }
          if (closing || failed || ws.readyState !== WebSocket.OPEN) return;
          inputReady = true;
          send({ type: 'ready' });
          let checking = false;
          state.timer = setInterval(() => {
            if (checking) return;
            checking = true;
            terminalTask((async () => {
              let current: Session;
              try { current = await access(); }
              catch { state.stop?.(); ws.close(1008, 'Terminal access could not be verified'); return; }
              if (closing || failed || ws.readyState !== WebSocket.OPEN) return;
              // remain-on-exit preserves a dead pane, so tmux's client PTY may
              // remain alive. Inspect the pane as well as observing pty.wait().
              const observationKey = `${s.id}:${shellId}`, observation = observeShell(current, shellId);
              if (await observation.value === 'closed' && shellObservations.get(observationKey) === observation) {
                for (const [attachment, attached] of terminals) if (attached.sessionId === s.id && attached.shellId === shellId) {
                  attached.stop?.();
                  if (attachment.readyState === WebSocket.OPEN) attachment.send(JSON.stringify({ type: 'exit', message: 'The shell ended. Recover it to start a new shell.', recoverable: shellId === 'codex' }));
                  attachment.close(1000, 'Shell ended');
                }
              }
            })().catch(() => ws.close(1011, 'Session check failed')).finally(() => { checking = false; }));
          }, options.terminalCheckMs ?? 2000);
          if (config.mode === 'live' && shellId === 'codex') {
            // Telemetry must neither delay ready nor disconnect a working terminal.
            terminalTask(startup.recordTerminalAttached(s.id).catch(() => {}));
          }
        }).catch(() => { send({ type: 'error', message: 'Unable to attach terminal. Retry in a moment.' }); ws.close(1011); }));
      });
    } catch { socket.destroy(); }
  })()); });
  let vite: Awaited<ReturnType<typeof import('vite')['createServer']>> | undefined;
  if (production) { app.use(express.static(resolve('dist'))); routes.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html'))); }
  else { const { createServer } = await import('vite'); vite = await createServer({ server: { middlewareMode: true, ws: { server } }, appType: 'spa' }); app.use(vite.middlewares); }
  if (vite) resources.push(() => vite!.close());
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (error instanceof SyntaxError && (error as SyntaxError & { type?: string }).type === 'entity.parse.failed') { res.status(400).json({ error: 'Invalid JSON request body' }); return; }
    if (error instanceof z.ZodError) { res.status(400).json({ error: error.issues.map(i => i.message).join('; ') }); return; }
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof PublishedChangesError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    if (error instanceof HandoffNotesError) { res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) }); return; }
    if (error instanceof ShellError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof SetupError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof ApplicationPreviewError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof ContinuationError) { res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code, outcome: error.outcome } : {}) }); return; }
    if (error instanceof GitHubError) {
      res.status(error.status).json({ error: error.status === 409 ? error.message : 'GitHub authorization or verification failed. Check access and retry.' }); return;
    }
    if (error instanceof SessionOperationError || error instanceof SessionNotCreatedError) { res.status(409).json({ error: error.message }); return; }
    // Untyped exceptions may contain upstream bodies, commands or credentials.
    res.status(409).json({ error: 'The operation could not be completed. Check configuration or retry.' });
  });
  await manager.reconcile();
  await previewTokens.prune();
  await shells.reconcile();
  let reconciling: Promise<unknown> | undefined;
  const scheduler = setInterval(() => {
    if (closing || failed || reconciling) return;
    reconciling = manager.reconcile().then(() => { if (!closing) return auth.prune(); }).then(() => { if (!closing) return previewTokens.prune(); })
      .catch(() => console.error('Session reconciliation failed; retrying on next tick.')).finally(() => { reconciling = undefined; });
  }, 5000);
  resources.unshift(() => { clearInterval(scheduler); return reconciling; });
  if (failed) throw new Error('Database ownership was lost during startup.');
  initialized = true;
  return { app, server, viewer, applicationPreview, manager, repo, shells, handoffNotes, db,
    onFatal(listener: () => void) { fatalListeners.add(listener); if (failed) listener(); return () => { fatalListeners.delete(listener); }; },
    close: beginClose,
  };
  } catch (error) {
    try { await beginClose(); } catch { /* Keep the original startup failure. Ownership remains fail-closed on an incomplete drain. */ }
    unlistenFatal?.();
    throw error;
  }
}
