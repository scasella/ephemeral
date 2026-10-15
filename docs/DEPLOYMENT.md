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

## Sites compatibility

Sites is suitable for a product information page. Hosting the full application there would require replacing the process/disk Git gateway, PostgreSQL locking and reconciliation architecture. Splitting the current frontend onto another origin also requires a deliberate cookie, OAuth, CSRF and WebSocket design. See [the detailed assessment](HOSTING.md).

## Live end-to-end acceptance

Follow [the hosted acceptance procedure](HOSTED-ACCEPTANCE.md), recording independent failures and uncertainties. No host-specific acceptance result is claimed here. Public source publication, a Sites page and an operating coding service are separate deployment decisions.
