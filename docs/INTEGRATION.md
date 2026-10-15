# Integration contract

The control plane composes the authentication, database, lifecycle, provider and Git gateway modules. Source types and route validation are the authoritative contract.

## Browser API
GET /api/bootstrap -> { user: {id,login,avatarUrl}|null, mode:'live'|'preview', configured:boolean, missing:string[], githubInstallUrl:string|null }
GET /api/sessions -> Session[] (server/contracts.ts)
GET /api/repositories -> {id:number,fullName:string,defaultBranch:string,installationId:number}[]
GET /api/repositories/:installationId/:repositoryId/branches -> {name:string}[]
POST /api/sessions body {repositoryId,installationId,baseBranch} -> Session (202)
GET /api/sessions/:id -> Session
GET /api/sessions/:id/events -> SessionEvent[]
POST /api/sessions/:id/stop -> Session
POST /api/sessions/:id/extend body {minutes:30} -> Session
POST /api/sessions/:id/retry-cleanup -> Session
POST /api/sessions/:id/pull-request body {title,body?,expectedHeadSha,expectedBaseSha} -> {url:string}
POST /api/logout -> {ok:true}
GET /auth/github -> sign in redirect
WS /api/sessions/:id/terminal -> client {type:'input',data:string} or {type:'resize',cols,rows}; server {type:'output',data:string} or {type:'error',message:string}. Browser reconnect attaches same tmux session. Cookie authentication required.
Mutation fetches must set X-Ephemeral-Request: 1 header (same-origin CSRF defense). Errors {error:string}. UI polls sessions/events ~3 seconds, preserves terminal on polls, displays honest setup/empty/failure states. Preview is explicitly labeled and cannot execute workloads.

## Module interfaces
Core: server/core/repository.ts exports createSessionRepository(db:Database):Promise<SessionRepository> (migrate there); server/core/lifecycle.ts exports SessionManager(repo,provider,credentials) with create(input), get(id), list(userId?), events(id), stop(id), extend(id,minutes), retryCleanup(id), reconcile(), shutdown(). create returns quickly and provisions async, reconcile handles expiration/startup cleanup. E2B adapter server/infra/e2b.ts exports E2BProvider({apiKey,templateId,gatewayUrl}) implements SandboxProvider.
GitHub: server/github/index.ts exports createGitHubServices({db,appId,privateKey,encryptionKey,appSlug,publicUrl, getSession:(id)=>Promise<Session|null>}) -> {credentials:GatewayCredentials, router:express.Router, repositories(userAccessToken):Promise<Repo[]>, branches(userAccessToken,installationId,repositoryId):Promise<{name:string}[]>, createPullRequest(session,title,body?):Promise<{url:string}>}. Gateway mounted /gateway; clone URL ${publicUrl}/gateway/git/${sessionId}.git. Gateway auth Basic x-access-token:<gateway token>. GET endpoints only Git discovery/upload-pack; writes receive-pack guarded server-side by git pre-receive hook using bare intermediary per session. Never hand GitHub tokens to VM. Persist hashed gateway credentials plus encrypted upstream token rows for worker retry. GitHub repository list MUST intersect user's GitHub App installations/repos using user OAuth credential; don't trust client-selected installation ids. The control plane validates creation against this list. Handle 1h token expiry and rotations; revoke all on cleanup. No general GitHub proxy.

The control plane handles auth/session cookies, same-origin validation, routes, scheduler startup/shutdown, preview mode, HTTP/ws server.
