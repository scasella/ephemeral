# Architecture and failure model

## Components

- **React + xterm frontend:** repositories, sessions, launch/stop/extend, terminal, lifecycle events, and credential cleanup status. No secrets are accepted in the UI.
- **Node/Express control plane:** GitHub OAuth, invite allowlist, same-origin mutation checks, owner-scoped APIs, WebSocket relay, and a five-second reconciliation loop.
- **PostgreSQL:** durable session state, worker leases, browser login records, encrypted upstream GitHub tokens, hashed gateway capabilities, and issuance uncertainty. Local preview uses PGlite, an embedded PostgreSQL implementation.
- **E2B provider:** one fresh VM per session, a bounded provider timeout, metadata for recovery, isolated Codex credential storage, and tmux-backed PTY reconnection.
- **Git gateway:** authenticated Git smart HTTP backed by a temporary bare repository. A server-owned pre-receive hook allows only one fast-forward update to the assigned session branch. It checks session authorization again and forwards the push upstream before accepting the local ref update. There is no arbitrary GitHub REST forwarding.

Only one control-plane process is supported. PostgreSQL advisory locking or a local file lock enforces that constraint. Worker leases protect state writes; they do not make the deployment horizontally scalable.

Local database startup refuses every existing `control-plane.lock`, including a stale or incomplete file. Graceful shutdown removes the lock; after a crash, inspect the recorded process and verify no control plane uses that data directory before manually removing it. Automatic stale-lock deletion could race with another starter and defeat exclusive ownership. Managed PostgreSQL uses its connection-scoped advisory lock instead.

## Trust boundaries

The VM is an untrusted execution environment. Repository code and the developer can read its scoped gateway capability and their Codex login credentials. They cannot read the E2B API key, GitHub App private key, GitHub installation tokens, OAuth client secret, or encryption key from the control plane.

The browser gets an opaque HttpOnly session cookie. Its raw cookie token is hashed in storage. Browser API mutations require a custom header and a same-origin check; WebSocket upgrades require an exact Origin match and session ownership. GitHub OAuth state is one-use, time-limited, and bound to a separate HttpOnly browser cookie. The invite allowlist uses immutable numeric GitHub IDs.

GitHub repository selection is derived from the intersection of the user's App installations and repository permissions. Session creation checks that selection again. The gateway rechecks the user's current repository write access, session state, capability status, and expiry. Upstream installation tokens are scoped to the selected repository and encrypted with authenticated encryption at rest.

The gateway does not promise that GitHub rules permit a push. Branch protection or repository policy can reject it, and that rejection is returned to the Git client. The session cannot push other branches, delete its branch, force-rewrite its history, or call merge APIs through the gateway. The developer's own independently supplied credentials are outside this boundary.

## Lifecycle

`provisioning → running → cleanup_pending → ended`

Provisioning or sandbox loss may finish as `failed` after cleanup, retaining a safe error message. A partial cleanup remains `cleanup_pending`; retry does not report success until each required phase confirms it. New sessions are blocked while the user's previous session has active or unresolved resources.

The control plane persists external resource identity before preparing the machine. Before external creation it records an uncertainty window. A crash or timeout triggers discovery by session metadata; unknown or unconfirmed resources remain pending rather than being silently forgotten. E2B's initial bounded timeout is an independent backstop.

Gateway access is disabled before teardown proceeds. GitHub token issuance and rotation are tracked independently so previously issued tokens remain retryable. Ambiguous issuance must not be reported as successful revocation. Credentials remain encrypted until revocation or upstream expiry establishes they are no longer usable.

VM deletion and removal of local Codex credentials are separate from remote revocation of ChatGPT authorization. `codexRemoteRevocation` is always `unverified` in this implementation. Ended status confirms compute and gateway/GitHub cleanup; it does **not** assert that an extracted ChatGPT token has been invalidated remotely.

The expiry clock starts at the session request and includes provisioning. New sessions start with one hour. `SESSION_MAX_HOURS=1` is the default and matches E2B Hobby; extensions are rejected. An operator can explicitly configure `SESSION_MAX_HOURS=4` with E2B Pro to permit 30-minute extensions up to four hours from creation. The server exposes its configured limit through bootstrap, while each session records its own maximum expiry. Extension updates durable intent and requests a provider timeout adjustment. Browser or server disconnection does not end a session; expiry and reconciliation do.

## Repository setup

Setup runs only on an explicit user request. A saved recipe belongs to one authenticated user and numeric repository ID; each edit creates a new version without executing it. Run requests require the reviewed version and retain an immutable recipe snapshot. Recipes survive session replacement, while runs stay attached to their original session in separate tables. Setup writes do not modify lifecycle state or worker leases.

Owner checks and current GitHub authorization protect mutations. Execution requires a running, unexpired session and read-only VM identity verification; it never resumes a paused VM or extends its lifetime. Commands run as the ordinary workspace `user` with the terminal's filesystem, network, scoped Git capability, and developer credentials. The 5–600 second timeout is capped by remaining session time and sent as an absolute deadline. An independent VM wrapper reserves cleanup time and kills ordinary process-group children before reporting completion. This is not containment against hostile code that deliberately detaches or interferes with another process of the same user; VM expiry and deletion remain the outer boundary.

Only one execution or unresolved execution hold is allowed per session. Cancellation, session stop, expiry, or access loss requests termination. Cancellation and timeout results require confirmed group cleanup. Missing confirmation marks the run interrupted and retains its hold through the original deadline plus cleanup grace. Restart interrupts unfinished records and never automatically replays commands. Failed final persistence retains local ownership and the bounded snapshot; reads, later run requests, and a background retry save it after database recovery.

The browser polls durable status and output. Each run retains at most 64 KiB of output and reports truncation. Known credential values are masked inside the VM before transport; the control plane masks common credential formats and strips terminal controls. These checks cannot identify every application secret. Recipes and output are stored, so users must avoid embedded or printed secrets. Preview explicitly simulates the workflow and never executes submitted commands on the host.

## Verification boundaries

Automated tests exercise the state machine with real PostgreSQL semantics through PGlite and injectable cloud providers, credential encryption/tampering, active-session uniqueness, cleanup failures, owner authorization, CSRF and WebSocket Origin rejection. Git tests exercise the actual pre-receive hook with local temporary repositories.

These tests do not prove live E2B credentials, template provisioning, GitHub App permissions, Codex device login, or an HTTPS production proxy are configured correctly. Before inviting users, run an end-to-end disposable repository smoke test: launch, authenticate Codex, commit/push the allowed branch, reject a push to another branch, open a draft PR, reconnect the terminal, verify Hobby rejects extensions (or test an explicitly configured Pro extension), stop, and verify provider absence plus upstream token rejection. Repeat with forced provisioning and cleanup failures.

The [Render deployment guide](DEPLOYMENT.md) describes the local Blueprint and live acceptance checklist. Render deployment and live E2B/GitHub/Codex behavior remain unverified. The planned attached service disk ensures Render stops the old process before starting a replacement, including when durable state is in managed PostgreSQL.

## Private application viewer

The control plane authorizes a single selected development port and issues a one-use 60-second POST handoff to a different viewer hostname for every access generation. The hostname is `<generation-uuid>.<configured-base-host>`; the base host itself serves no application. The handoff becomes a host-only HttpOnly cookie bound to that host, originating browser login, owner, session, generation, and the earlier of ten minutes or session/login expiry. HTTP, WebSocket, and one-use handoff consumption must match the generation in the Host. Tokens are never in URLs; only hashes persist. Enabling or replacing generates a fresh access generation and browser origin, so an already loaded old application cannot inherit a later generation's cookie. Closing preview preserves workspace processes. Session stop/expiry and browser logout invalidate grants; WebSockets recheck local state every two seconds, and explicit close/stop immediately signals connected viewers.

Every HTTP request verifies browser/session fences and repository authorization. Repository verification alone is shared for at most ten seconds, with a bounded cache and no cached failures; control-plane preview mutations perform fresh checks. Encrypted native ingress credentials are independent of Session JSON. The viewer resolves only the fixed protected gateway for the exact VM, which strips native credentials before forwarding to the selected app. Requests and responses have fixed bounds, and the viewer exposes no account APIs. Browser policy blocks framing, workers, cross-origin application connections and external redirects. Hosting requires a separate base DNS namespace with wildcard HTTPS routing; explicit local-only configuration permits a `localhost` base with generation-specific loopback hosts and matching listener port. See [release migration](RELEASE.md#private-preview-migration).

See [configuration, limits, and verification evidence](VALIDATION.md). This remains a single-control-plane pilot.
