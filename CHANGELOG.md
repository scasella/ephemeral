# Changelog

## Unreleased — initial pilot publication candidate

The project uses the MIT License with copyright credited to scasella. Publication remains pending. No GitHub release, npm package, or hosted deployment is represented by this entry.

- MIT licensing: retained copyright/license notice required, with an optional request for visible project credit and matching package metadata. No additional attribution condition or npm publication is introduced.
- Network entry hardening: terminal and Preview upgrades handle socket resets during authorization and stop abandoned handshakes; live startup requires production serving, and control-plane URLs use canonical origins with strict input validation. Local regression tests cover reset survival, cancellation, capacity recovery and startup boundaries.
- Database and shutdown hardening: ordinary idle PostgreSQL connection failures can recover, while loss of the singleton lock stops the control plane. Database readiness, query deadlines, bounded shutdown and Compose restart checks cover recovery and retain local ownership when work cannot safely drain.
- Terminal reliability: recover a stopped primary shell on the same machine without replaying Codex startup or restarting a living pane. PTY/pane exit detection and heartbeat cleanup keep connection state current; bounded input batching, Unicode-safe paste chunks and acknowledged writes preserve order without replay after reconnect. Shell management queues are isolated per session.
- Provisioning recovery: durable sandbox and GitHub issuance outcomes retain uncertain requests across restarts and preserve known cleanup handles. Cleanup avoids extending VM lifetimes; an offline, audited operator command inspects or reconciles one abandoned session under the database singleton lock. Continuation retries preserve their target after ambiguous database failures.

- Git handoff: preserve an immutable original clone anchor for first-push ancestry while PR review follows the current target base. Stream large published comparisons under separate wire/metadata budgets, retain only the selected bounded patch, and reuse bounded verification before draft PR creation. Oversized or omitted patches preserve verified change metadata; ref movement and incomplete verification still block handoff. Legacy sessions without an anchor can update an existing assigned branch but need a fresh session for first publication.

- Retained setup output: mask common auth fields, key prefixes, URI credentials and PEM blocks across chunks before clipping; mask known Codex auth values inside the VM and fail safely on an uninspectable existing auth file. Local tests use Node 24, isolated configuration, scoped integration budgets and deterministic fixture barriers; Linux CI runs process checks in a separate session.
- Authorization boundaries: recheck terminal repository access with a bounded, coalesced cache and require fresh authorization inside extension leases. Regression and mutation checks cover ownership, Origin, idle revocation, OAuth state, independent cleanup failures, Git hook/lease enforcement, admission limits and credential binding. Untyped exception text is no longer returned to clients.
- Repository setup reliability: known failures before provider invocation become retryable after their final record is saved; uncertain execution keeps its hold and is never replayed. Setup queues are isolated per session, recorded outcomes distinguish cancellation causes, and new runs retain a redacted beginning and final tail within 64 KiB. Legacy saved output keeps its original truncation description.
- Reconciliation and activity: select only active sessions for background work, persist bounded retry delays across restarts, and keep expiry and explicit recovery immediate. Failed health checks no longer flood events. Session events use bounded keyset pages with exact database timestamps; Activity can browse older pages without polling replacing them.

- Local release fixes: bound anonymous OAuth admission before database work, index and batch expiry pruning, align JSON byte limits with accepted PR text and return explicit parser errors, reject unsafe labels, and make hidden Unicode visible in review surfaces. Changes distinguishes supported EOL normalization from raw comparisons.
- Final review fixes: share Unicode shell-name validation between browser and server, apply selected operator PostgreSQL credentials/TLS defaults, and recheck local session authority after final PR preflight. Docker accepts only build inputs and recursively excludes private configuration/data; synthetic context export and real PostgreSQL recovery checks cover these boundaries. Contributor prerequisites now include Python 3.


- Publication privacy: fresh noreply-attributed history, private evidence retained outside the public tree, synthetic examples, explicit disposable smoke-fixture selection, and no editor snapshot refs.
- Hosting preparation: Sites compatibility assessment, host-specific acceptance procedure and explicit retention/support drafts with contact setup pending.
- Local onboarding: resumable first-run guide for private configuration, ngrok, personal GitHub App registration/selected-repository installation, and confirmed E2B template builds; read-only diagnostics and isolated local live launch.
- Local setup documentation: verified Cloudflare Quick Tunnel fallback, coordinated hostname/callback restart steps, Node/npm wrapper troubleshooting, fresh Codex login/reconnect guidance, and a sanitized clean-checkout acceptance report with remaining local release gates.

- Disposable E2B coding sessions with GitHub account allowlisting, branch-scoped Git gateway access, fresh Codex device sign-in, bounded lifetimes, and independently tracked cleanup outcomes.
- Persistent terminal context and a supplemental shell; searchable session history; keyboard navigation, focus mode, readable controls, and expiry reminders.
- Explicit reusable setup recipes, pushed-change review, draft PR handoff, saved-work continuation, and revisioned next-session notes.
- Private application previews with readiness diagnostics, proven local React/Vite HMR, and a four-step startup/access sequence.
- Release hardening: a different browser origin for every preview generation; host-bound handoffs and grants; required reviewed head/base commit IDs before PR creation; fail-closed local database locks; PostgreSQL passwords passed separately from Compose connection URLs.
- Publication scaffolding: tests/build/dependency/secret/container CI jobs, pinned actions and Node image, contributor guidance, issue templates, and a security policy that records pending private reporting.
- Repeatable Docker smoke suite for production assets/authentication, privilege drop, mounted-disk persistence, PostgreSQL locking, restart and shutdown; verified locally on arm64 and emulated amd64.

### Compatibility notes

Private Preview now needs a base DNS origin and wildcard host routing. Existing fixed-host/IP viewer configuration must change before restarting with this candidate. Existing viewer tabs must be reopened. Local stale database locks require explicit operator inspection instead of automatic deletion. See [migration and release procedure](docs/RELEASE.md).
