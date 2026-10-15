# Container pilot deployment

Deployment is pending. This guide and `render.yaml` prepare a singleton container deployment; applying them creates resources and may start recurring charges. Review the provider's current plans and displayed charges before creating anything. No hosting resource is created by preparing this source.

## Required shape

- One continuously running Node 24 application container with Git and a persistent `/app/.data` mount.
- PostgreSQL reachable by the control plane. Keep the database and encryption key together in private backups.
- An HTTPS control-plane origin reachable by E2B, preserving browser Origin, Host and WebSocket upgrades. Configure the GitHub App callback for that exact origin.
- A separate private Preview namespace and viewer ingress if Preview is enabled. The control plane must sit outside that namespace.
- A restricted GitHub account allowlist, one active machine per user, provider spending limits, a tested private contact and an activated retention policy.

`render.yaml` describes one Docker service, PostgreSQL and a persistent disk with generic resource names. It does not provision wildcard Preview DNS/TLS or a second public listener. A second port inside the application is not automatically exposed as another HTTPS endpoint. Leave `PREVIEW_PUBLIC_URL` empty until the viewer ingress is actually configured and tested.

## Configure and validate

1. Build/test the exact source candidate using [validation](VALIDATION.md). Review licensing and publication separately.
2. Provision the selected host only after its scope and charges are authorized. Use the tested Dockerfile and one control-plane instance. Configure a graceful-stop window longer than the application's shutdown deadline.
3. Supply the names documented in `.env.example` through private runtime settings. Never put operator credentials in source, browser code, build arguments, command history or screenshots. Set live mode, an HTTPS `PUBLIC_URL`, PostgreSQL connectivity and a stable encryption key.
4. Mount the persistent disk at `/app/.data`; the entrypoint repairs ownership when started as root and then runs the app as UID 1000. Explicit non-root launches require a pre-writable mount.
5. Verify unauthenticated health and static assets, GitHub OAuth/cookies, allowlist enforcement, the scoped gateway and browser terminal. A health response alone is not integration acceptance.
6. Configure and test separate viewer wildcard DNS/TLS if needed, then complete [hosted acceptance](HOSTED-ACCEPTANCE.md). Keep unresolved cleanup visible and retain its recovery state.

Compose passes the PostgreSQL password through `PGPASSWORD` separately from its password-free URI. Do not render an operator's Compose configuration into public logs.

Compose restarts both services with `unless-stopped`. The application's healthcheck calls `/healthz`, which checks the database and returns HTTP 503 during a database outage or shutdown. Docker marks a failed healthcheck unhealthy; restart policy acts when the application exits, including controlled exit after loss of its singleton database connection. Ordinary idle query-client loss can recover through the pool without exiting.

Application shutdown has a 25-second deadline and an independent 30-second process exit deadline; Compose allows 40 seconds before sending a forced kill. Graceful shutdown preserves active VMs for reconciliation after restart. A timeout or incomplete resource drain causes a nonzero exit. If application work is still outstanding, database ownership is retained through process exit; an incompletely closed local PGlite database keeps `control-plane.lock` for manual inspection instead of allowing an unsafe concurrent restart.

Use a direct PostgreSQL connection or a pooler that preserves session affinity. Transaction pooling cannot preserve the connection-scoped singleton advisory lock. For database diagnostics, inspect `pg_stat_activity` for `application_name = 'ephemeral-control-plane'`; join `pg_locks` on PID and check `locktype = 'advisory'`, `objid = 378120985` and `granted` to identify its owner. `pg_isready` only checks PostgreSQL availability and does not establish that the app holds ownership or can serve requests. After a local PGlite shutdown failure, verify that the recorded process and all other control planes using its directory are stopped before manually removing `control-plane.lock`.

## Sites compatibility

Sites is suitable for a product information page. Hosting the full application there would require replacing the process/disk Git gateway, PostgreSQL locking and reconciliation architecture. Splitting the current frontend onto another origin also requires a deliberate cookie, OAuth, CSRF and WebSocket design. See [the detailed assessment](HOSTING.md).

## Live end-to-end acceptance

Follow [the hosted acceptance procedure](HOSTED-ACCEPTANCE.md), recording independent failures and uncertainties. No host-specific acceptance result is claimed here. Public source publication, a Sites page and an operating coding service are separate deployment decisions.
