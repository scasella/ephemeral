# Changelog

## [v0.1.1](https://github.com/scasella/ephemeral/releases/tag/v0.1.1) — 2026-10-16 (prerelease)

Experimental local release from reviewed `main` at `c05617a40311aa20826b618dd7dfe296a47b889a`. This tag remains fixed; later documentation updates can advance `main`.

- Appearance: a persistent **System / Light / Dark** selector, available before sign-in and across workspace views. System follows the device; saved choices synchronize across browser tabs and remain usable without storage.
- Shared light/dark styling covers workspace surfaces, forms, dialogs, session history, notes, setup, published review, Preview controls, service feedback and cleanup. The initial theme applies before paint under the production security policy; system monospace fonts remove the external font request.
- Both terminals update ANSI colors, selection, cursor and search highlights in place, preserving connections, output, viewport, selected search match and keyboard continuity. Preview applications retain control over their own appearance.
- Documentation: three matching light/dark screenshot pairs for the workspace, focused terminal and launch dialog, with full-size links, alt text, appearance instructions and synthetic-capture provenance.
- Local validation: 1,399 tests passed across 101 files with one intentional interactive-hold skip; type checking, production build, desktop/mobile Chrome checks, Docker build, context filtering and offline non-root asset checks passed. The exact source commit, release text and reviewed screenshot disclosures were checked; the configured secret scan found no matches. See [validation scope](docs/VALIDATION.md#v011-appearance-release).

GitHub CI remains pending and its workflow is paused. No new real E2B/GitHub/Codex acceptance or hosted deployment was performed for this appearance release. Remote ChatGPT/Codex token revocation remains unverified; [local limitations and hosted-launch gates](docs/RELEASE-READINESS.md) still apply.

## [v0.1.0](https://github.com/scasella/ephemeral/releases/tag/v0.1.0) — 2026-10-16 (prerelease)

Initial experimental local release from reviewed `main` at `90c4db0290f5ddbbc77b1f7100c59432426f92c1`.

The project uses the MIT License with copyright credited to scasella. The sanitized source and reviewed fixes are public on `main` at [scasella/ephemeral](https://github.com/scasella/ephemeral). GitHub private vulnerability reporting is enabled; see [SECURITY](SECURITY.md). GitHub CI remains pending at the owner’s request and its workflow is paused. This entry records the initial GitHub prerelease; no npm package or hosted service was published.

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
- Hosting preparation: Sites compatibility assessment, host-specific acceptance procedure and explicit retention/hosted-support drafts. Hosted contact setup and policy activation remain pending; source vulnerability reports use GitHub private reporting.
- Local onboarding: resumable first-run guide for private configuration, ngrok, personal GitHub App registration/selected-repository installation, and confirmed E2B template builds; read-only diagnostics and isolated local live launch.
- Local setup documentation: verified Cloudflare Quick Tunnel fallback, coordinated hostname/callback restart steps, Node/npm wrapper troubleshooting, fresh Codex login/reconnect guidance, and a sanitized clean-checkout acceptance report with remaining local release gates.

- Disposable E2B coding sessions with GitHub account allowlisting, branch-scoped Git gateway access, fresh Codex device sign-in, bounded lifetimes, and independently tracked cleanup outcomes.
- Persistent terminal context and a supplemental shell; searchable session history; keyboard navigation, focus mode, readable controls, and expiry reminders.
- Explicit reusable setup recipes, pushed-change review, draft PR handoff, saved-work continuation, and revisioned next-session notes.
- Private application previews with readiness diagnostics, proven local React/Vite HMR, and a four-step startup/access sequence.
- Release hardening: a different browser origin for every preview generation; host-bound handoffs and grants; required reviewed head/base commit IDs before PR creation; fail-closed local database locks; PostgreSQL passwords passed separately from Compose connection URLs.
- Publication scaffolding: tests/build/dependency/secret/container CI jobs, pinned actions and Node image, contributor guidance, issue templates, and a security policy linking the enabled GitHub private reporting route.
- Repeatable Docker smoke suite for production assets/authentication, privilege drop, mounted-disk persistence, PostgreSQL locking, restart and shutdown; verified locally on arm64 and emulated amd64.

### Compatibility notes

Private Preview now needs a base DNS origin and wildcard host routing. Existing fixed-host/IP viewer configuration must change before upgrading from the former fixed-host implementation. Existing viewer tabs must be reopened. Local stale database locks require explicit operator inspection instead of automatic deletion. See [migration and release procedure](docs/RELEASE.md).
