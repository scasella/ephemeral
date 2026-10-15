import { previewFormSource } from '../shared/preview-origin.js';
import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { openDatabase } from './db.js';
import { createAuth, isSameOrigin } from './auth/index.js';
import { createSessionRepository } from './core/repository.js';
import { SessionManager } from './core/lifecycle.js';
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
const sessionLabelInput = z.object({ label: z.string().refine(s => !/[\u0000-\u001f\u007f-\u009f]/.test(s), 'Label cannot contain control characters').transform(s => s.trim()).pipe(z.string().max(80)) }).strict();
const shellNameInput = z.object({ name: z.string().refine(s => !/[\u0000-\u001f\u007f-\u009f]/.test(s), 'Shell name cannot contain control characters').transform(s => s.trim()).pipe(z.string().min(1).max(80)) }).strict();
const shellCreateInput = shellNameInput.extend({ requestId: z.string().uuid() }).strict();
const setupInput = z.object({ label: z.string().trim().min(1).max(80), command: z.string().trim().min(1).max(8192).refine(s => !s.includes('\0'), 'Command cannot contain a null character'), timeoutSeconds: z.number().int().min(5).max(600) }).strict();
export async function createApplication(config: Config, options: { previewAuthorizationCacheMs?: number } = {}) {
  const db = await openDatabase(config.databaseUrl, resolve(config.dataDir, config.mode));
  const repo = await createSessionRepository(db);
  const startup = await createStartupRepository(db);
  const pullRequests = await createPullRequestRepository(db);
  const auth = await createAuth(db, config);
  const previewTokens = await createPreviewTokenStore(db, config.encryptionKey);
  const provider: SandboxProvider = config.mode === 'live' ? new E2BProvider({ apiKey: config.e2bApiKey, templateId: config.e2bTemplateId, gatewayUrl: config.publicUrl, previewTokens }) : new PreviewProvider();
  const applicationPreview = await createApplicationPreview(db, repo, provider, auth, config, { authorizationCacheMs: options.previewAuthorizationCacheMs });
  const viewer = config.previewPublicUrl ? createPreviewViewer(config, applicationPreview) : null;
  const github = config.mode === 'live' ? await createGitHubServices({ db, pullRequests, appId: config.githubAppId, privateKey: config.privateKey, encryptionKey: config.encryptionKey, appSlug: config.githubAppSlug, publicUrl: config.publicUrl, getSession: id => repo.get(id), authorizeSession: auth.authorizeSession }) : null;
  const manager = new SessionManager(repo, provider, github?.credentials || previewCredentials, { maxHours: config.sessionMaxHours });
  const handoffNotes = await createHandoffNotesService(db, repo);
  const continuation = await createContinuationController(db, repo, manager, github, id => pullRequests.list(id), handoffNotes);
  const setup = await createSetupController(db, repo, provider, config.mode, auth.authorizeSession);
  const terminals = new Map<WebSocket, { sessionId: string; shellId: string; connection?: TerminalConnection; timer?: NodeJS.Timeout }>();
  const shells = await createShellController(db, repo, provider, config.mode, auth.authorizeSession, (sessionId, shellId) => {
    for (const [ws, state] of terminals) if (state.sessionId === sessionId && state.shellId === shellId) ws.close(1000, 'Shell closed');
  });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', config.previewPublicUrl ? 'origin' : 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cache-Control', 'no-store');
    if (config.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (process.env.NODE_ENV === 'production') res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'${config.previewPublicUrl ? ` ${previewFormSource(config.previewPublicUrl)}` : ''}`);
    if (config.mode === 'preview' && !['localhost', '127.0.0.1'].includes((req.headers.host || '').split(':')[0])) { res.status(403).send('Preview accepts localhost only'); return; }
    next();
  });
  if (github) app.use('/gateway', github.router);
  app.use('/auth', auth.router);
  app.get('/healthz', (_req, res) => res.json({ status: 'ok', mode: config.mode }));
  const nonemptyJsonBodies = new WeakSet<Request>();
  app.use('/api', express.json({ limit: '32kb', verify: (req, _res, body) => { if (body.length) nonemptyJsonBodies.add(req as Request); } }));
  app.use('/api', (req, res, next) => {
    if (!isSameOrigin(req, config.publicUrl)) { res.status(403).json({ error: 'Cross-origin requests are not permitted' }); return; }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-ephemeral-request'] !== '1') { res.status(403).json({ error: 'Missing request verification header' }); return; }
    next();
  });
  const previewIdentity: Identity & { accessToken: string } = { id: 'preview-user', login: 'local-preview', avatarUrl: '', accessToken: '' };
  async function identity(req: Request) { return config.mode === 'preview' ? previewIdentity : auth.read(req); }
  async function requireIdentity(req: Request) { const user = await identity(req); if (!user) throw new HttpError(401, 'Sign in with GitHub to continue'); return user; }
  async function owned(req: Request) {
    const user = await requireIdentity(req); const session = await repo.get(String(req.params.id));
    if (!session || session.userId !== user.id) throw new HttpError(404, 'Session not found');
    return session;
  }
  app.get('/api/bootstrap', async (req, res) => {
    const user = await identity(req);
    res.json({ user: user && { id: user.id, login: user.login, avatarUrl: user.avatarUrl }, mode: config.mode, sessionMaxHours: config.sessionMaxHours, configured: config.missing.length === 0, missing: config.missing, githubInstallUrl: config.githubAppSlug ? `https://github.com/apps/${encodeURIComponent(config.githubAppSlug)}/installations/new` : null });
  });
  app.get('/api/repositories', async (req, res) => { const user = await requireIdentity(req); res.json(github ? await github.repositories(user.accessToken) : previewRepositories); });
  app.get('/api/repositories/:installationId/:repositoryId/branches', async (req, res) => {
    const user = await requireIdentity(req);
    const installationId = z.coerce.number().int().positive().parse(req.params.installationId); const repositoryId = z.coerce.number().int().positive().parse(req.params.repositoryId);
    res.json(github ? await github.branches(user.accessToken, installationId, repositoryId) : [{ name: 'main' }, { name: 'develop' }]);
  });
  app.get('/api/sessions', async (req, res) => { const user = await requireIdentity(req); res.json(await manager.list(user.id)); });
  app.post('/api/sessions', async (req, res) => {
    const user = await requireIdentity(req); const input = sessionInput.parse(req.body);
    const available = github ? await github.repositories(user.accessToken) : previewRepositories;
    const selected = available.find(r => r.id === input.repositoryId && r.installationId === input.installationId);
    if (!selected) throw new HttpError(403, 'Repository is not authorized for this account');
    if (github) { const branches = await github.branches(user.accessToken, input.installationId, input.repositoryId); if (!branches.some(b => b.name === input.baseBranch)) throw new HttpError(400, 'Base branch does not exist'); }
    const session = await manager.create({ ...input, repository: selected.fullName, userId: user.id });
    res.status(202).json(session);
  });
  app.get('/api/sessions/:id', async (req, res) => res.json(await owned(req)));
  app.get('/api/sessions/:id/handoff-notes', async (req, res) => {
    const session = await owned(req); res.json(await handoffNotes.get(session.userId, session.id));
  });
  app.post('/api/sessions/:id/handoff-notes', async (req, res) => {
    const session = await owned(req); const input = handoffNotesInput.parse(req.body);
    res.json(await handoffNotes.save(session.userId, session.id, input));
  });
  app.post('/api/sessions/:id/label', async (req, res) => {
    const session = await owned(req); const { label } = sessionLabelInput.parse(req.body);
    const updated = await repo.setLabel(session.id, session.userId, label);
    if (!updated) throw new HttpError(404, 'Session not found');
    res.json(updated);
  });
  app.get('/api/sessions/:id/events', async (req, res) => { const session = await owned(req); res.json(await manager.events(session.id)); });
  app.get('/api/sessions/:id/continuation-preview', async (req, res) => {
    const user = await requireIdentity(req); const source = await owned(req);
    try { res.json(await continuation.preview(source, user.accessToken)); }
    catch (error) {
      if (error instanceof GitHubError && error.status === 403) throw error;
      res.json(continuationPreview(source, 'unknown', 'GitHub could not verify the saved branch. Refresh to retry.'));
    }
  });
  app.post('/api/sessions/:id/continue', async (req, res) => {
    const user = await requireIdentity(req); const source = await owned(req); const input = continueInput.parse(req.body);
    res.status(202).json(await continuation.continue(source, user.accessToken, input.expectedHeadSha, input.requestId, input.expectedNoteRevision));
  });
  app.post('/api/sessions/:id/stop', async (req, res) => { const s = await owned(req); await applicationPreview.revoke(s.id); setup.stopSession(s.id); res.json(await manager.stop(s.id)); });
  app.post('/api/sessions/:id/retry-cleanup', async (req, res) => { const s = await owned(req); res.json(await manager.retryCleanup(s.id)); });
  app.post('/api/sessions/:id/extend', async (req, res) => { const s = await owned(req); const { minutes } = z.object({ minutes: z.literal(30) }).strict().parse(req.body); res.json(await manager.extend(s.id, minutes)); });
  const running = (s: Session) => s.state === 'running' && !!s.sandboxId && Number.isFinite(Date.parse(s.expiresAt)) && Date.parse(s.expiresAt) > Date.now();
  async function previewAuthorized(req: Request, expected?: Session) {
    const s = await owned(req);
    if (!previewRunning(s) || (expected && expected.sandboxId !== s.sandboxId)) throw new ApplicationPreviewError(409, 'Application preview requires a running session.');
    try { await auth.authorizeSession(s); } catch { throw new ApplicationPreviewError(403, 'Repository access could not be verified.'); }
    const current = await owned(req);
    if (!previewRunning(current) || current.sandboxId !== s.sandboxId) throw new ApplicationPreviewError(409, 'The session ended while preview access was being verified.');
    return current;
  }
  app.get('/api/sessions/:id/preview', async (req, res) => {
    const s = await owned(req);
    const state = await applicationPreview.state(s);
    if (state.state !== 'unavailable') { await previewAuthorized(req, s); res.json(await applicationPreview.state(await owned(req))); }
    else res.json(state);
  });
  app.post('/api/sessions/:id/preview', async (req, res) => {
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
  app.post('/api/sessions/:id/preview/check', async (req, res) => {
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
  app.post('/api/sessions/:id/preview/close', async (req, res) => {
    emptyPreviewBody(req); const s = await owned(req);
    res.json(await applicationPreview.mutate(s.id, async () => {
      if (config.mode === 'live' && previewRunning(s)) await previewAuthorized(req, s);
      await applicationPreview.disable(s); return applicationPreview.state(await owned(req));
    }));
  });
  app.post('/api/sessions/:id/preview/open', async (req, res) => {
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
  app.get('/api/sessions/:id/published-changes', async (req, res) => {
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
  app.get('/api/sessions/:id/changes', async (req, res) => {
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
  app.get('/api/sessions/:id/shells', async (req, res) => res.json(await shells.list(await owned(req))));
  app.post('/api/sessions/:id/shells', async (req, res) => { const s = await owned(req); const { requestId, name } = shellCreateInput.parse(req.body); res.json(await shells.create(s, requestId, name)); });
  app.post('/api/sessions/:id/shells/:shellId/name', async (req, res) => { const s = await owned(req); const { name } = shellNameInput.parse(req.body); res.json(await shells.rename(s, String(req.params.shellId), name)); });
  app.post('/api/sessions/:id/shells/:shellId/close', async (req, res) => {
    const s = await owned(req); z.object({ confirm: z.literal(true) }).strict().parse(req.body);
    res.json(await shells.closeShell(s, String(req.params.shellId)));
  });
  app.get('/api/sessions/:id/setup', async (req, res) => { res.json(await setup.progress(await owned(req))); });
  app.put('/api/sessions/:id/setup', async (req, res) => { const s = await owned(req); res.json(await setup.save(s, setupInput.parse(req.body))); });
  app.post('/api/sessions/:id/setup/runs', async (req, res) => {
    const s = await owned(req); const { recipeVersion } = z.object({ recipeVersion: z.string().uuid() }).strict().parse(req.body);
    res.status(202).json(await setup.start(s, recipeVersion));
  });
  app.post('/api/sessions/:id/setup/runs/:runId/cancel', async (req, res) => {
    const s = await owned(req);
    if (!nonemptyJsonBodies.has(req)) throw new HttpError(400, 'Submit an empty JSON object to cancel setup.');
    z.object({}).strict().parse(req.body);
    res.json(await setup.cancel(s, z.string().uuid().parse(req.params.runId)));
  });
  app.get('/api/sessions/:id/startup', async (req, res) => { const s = await owned(req); res.json(await startup.progress(s, config.mode)); });
  app.post('/api/sessions/:id/first-useful-response', async (req, res) => {
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
  app.get('/api/sessions/:id/work-status', async (req, res) => {
    const s = await owned(req);
    if (!running(s) || config.mode === 'preview' || !provider.inspectWorkspace) { res.json(emptyWorkStatus('unavailable', config.mode === 'preview' ? 'Preview cannot inspect a real workspace.' : 'Workspace inspection is available only while the session is running.')); return; }
    await auth.authorizeSession(s);
    try {
      const status = await provider.inspectWorkspace(s);
      const current = await repo.get(s.id);
      res.json(current && running(current) ? status : emptyWorkStatus('unavailable', 'The session ended during workspace inspection.'));
    } catch { res.json(emptyWorkStatus('unknown', 'Workspace inspection failed. Refresh to retry before ending the session.')); }
  });
  app.get('/api/sessions/:id/pull-requests', async (req, res) => { const s = await owned(req); res.json(await pullRequests.list(s.id)); });
  app.get('/api/sessions/:id/pull-request-preview', async (req, res) => {
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
  app.post('/api/sessions/:id/pull-request', async (req, res) => {
    const s = await owned(req); const { title, body, expectedHeadSha, expectedBaseSha } = prInput.parse(req.body);
    if (config.mode === 'preview') throw new HttpError(409, 'Preview does not create GitHub pull requests. Configure live integrations first.');
    if (!running(s)) throw new HttpError(409, 'Session is not running');
    await auth.authorizeSession(s);
    res.json(await github!.createPullRequest(s, title, body, expectedHeadSha, expectedBaseSha));
  });
  app.post('/api/logout', async (req, res) => { if (config.mode === 'live') await auth.logout(req, res); res.json({ ok: true }); });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found' }));
  const server = createServer(app);
  server.requestTimeout = 120_000; server.headersTimeout = 15_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', async (req, socket, head) => {
    try {
      const terminalUrl = new URL(req.url || '/', config.publicUrl);
      const path = terminalUrl.pathname;
      if (!/^\/api\/sessions\/[^/]+\/terminal$/.test(path)) { if (process.env.NODE_ENV === 'production') socket.destroy(); return; }
      if (req.headers.origin !== config.publicUrl) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      const shellValues = terminalUrl.searchParams.getAll('shell');
      const shellId = (shellValues[0] ?? 'codex').toLowerCase();
      if ([...terminalUrl.searchParams.keys()].some(key => key !== 'shell') || shellValues.length > 1 || !validShellId(shellId)) { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      const user = config.mode === 'preview' ? previewIdentity : await auth.read(req as Request);
      const id = path.split('/')[3]; const s = await repo.get(id);
      if (!user || !s || s.userId !== user.id || !running(s) || !await shells.attachable(s, shellId)) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      if (config.mode === 'live') await auth.authorizeSession(s);
      if ([...terminals.values()].filter(v => v.sessionId === s.id).length >= 4 || [...terminals.values()].filter(v => v.sessionId === s.id && v.shellId === shellId).length >= 2) { socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, ws => {
        const state: { sessionId: string; shellId: string; connection?: TerminalConnection; timer?: NodeJS.Timeout } = { sessionId: s.id, shellId }; terminals.set(ws, state);
        const decoder = new StringDecoder('utf8');
        const send = (value: object) => { if (ws.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 2 * 1024 * 1024) ws.close(1008, 'Terminal output overflow; reconnect'); else ws.send(JSON.stringify(value)); } };
        let inputQueue = Promise.resolve(); let pending = 0; let inputReady = false;
        ws.on('message', raw => {
          if (!inputReady) return;
          if (++pending > 64) { ws.close(1008, 'Input rate exceeded'); return; }
          inputQueue = inputQueue.then(async () => {
            const message = JSON.parse(raw.toString());
            if (!inputReady || !state.connection || !await shells.attachable(s, shellId)) return;
            if (!inputReady || ws.readyState !== WebSocket.OPEN) return;
            if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 32_768) await state.connection.write(message.data);
            else if (message.type === 'resize') { const { cols, rows } = z.object({ cols: z.number().int().min(10).max(400), rows: z.number().int().min(2).max(200) }).parse(message); await state.connection.resize(cols, rows); }
          }).catch(() => send({ type: 'error', message: 'Terminal input failed. Reconnect to retry.' })).finally(() => { pending--; });
        });
        ws.on('error', () => {});
        ws.on('close', () => { inputReady = false; clearInterval(state.timer); terminals.delete(ws); void state.connection?.disconnect().catch(() => {}); });
        void provider.connectTerminal(s.sandboxId!, data => send({ type: 'output', data: decoder.write(Buffer.from(data)) }), 100, 30, shellId).then(async connection => {
          if (ws.readyState !== WebSocket.OPEN) { await connection.disconnect(); return; }
          state.connection = connection;
          const current = await repo.get(s.id);
          if (!current || !running(current) || !await shells.attachable(current, shellId)) { await connection.disconnect(); ws.close(1000, 'Session or shell ended'); return; }
          if (ws.readyState !== WebSocket.OPEN) { await connection.disconnect(); return; }
          inputReady = true;
          send({ type: 'ready' });
          state.timer = setInterval(() => { void (async () => {
            const current = await repo.get(s.id); const stillLoggedIn = config.mode === 'preview' || await auth.read(req as Request);
            if (!stillLoggedIn || !current || !running(current) || !await shells.attachable(current, shellId)) ws.close(1000, 'Session ended or sign-in expired');
          })().catch(() => ws.close(1011, 'Session check failed')); }, 2000);
          if (config.mode === 'live' && shellId === 'codex') {
            // Telemetry must neither delay ready nor disconnect a working terminal.
            void startup.recordTerminalAttached(s.id).catch(() => {});
          }
        }).catch(() => { send({ type: 'error', message: 'Unable to attach terminal. Retry in a moment.' }); ws.close(1011); });
      });
    } catch { socket.destroy(); }
  });
  let vite: Awaited<ReturnType<typeof import('vite')['createServer']>> | undefined;
  if (process.env.NODE_ENV === 'production') { app.use(express.static(resolve('dist'))); app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html'))); }
  else { const { createServer } = await import('vite'); vite = await createServer({ server: { middlewareMode: true, ws: { server } }, appType: 'spa' }); app.use(vite.middlewares); }
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
    // Never echo upstream response bodies, tokens, shell commands, or stack traces.
    const message = error instanceof Error ? error.message : '';
    const safeMessages = ['already has an active session', 'already active', 'not running', 'maximum', 'expired', 'not found', 'cleanup', 'Sign in', 'GitHub sign-in', 'Repository', 'branch'];
    const safe = safeMessages.some(fragment => message.includes(fragment)) && message.length < 300 && !/https?:|token=|Bearer |gh[psu]_/.test(message);
    res.status(409).json({ error: safe ? message : 'The operation could not be completed. Check configuration or retry.' });
  });
  await manager.reconcile();
  await previewTokens.prune();
  await shells.reconcile();
  let reconciling = false;
  const scheduler = setInterval(() => {
    if (reconciling) return; reconciling = true;
    void manager.reconcile().then(() => auth.prune()).then(() => previewTokens.prune()).catch(() => console.error('Session reconciliation failed; retrying on next tick.')).finally(() => { reconciling = false; });
  }, 5000);
  return { app, server, viewer, applicationPreview, manager, repo, shells, handoffNotes, db, async close() {
    clearInterval(scheduler);
    await viewer?.close();
    for (const ws of terminals.keys()) ws.close(1001, 'Server restarting');
    await shells.close();
    await setup.close();
    await manager.shutdown();
    await github?.close();
    await vite?.close();
    await new Promise<void>(resolveClose => { wss.close(() => resolveClose()); });
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    await db.close();
  } };
}
