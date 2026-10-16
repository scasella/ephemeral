# Release and publication procedure

The owner authorized public source publication on 2026-10-16. The sanitized source and reviewed fixes are public on `main` at [scasella/ephemeral](https://github.com/scasella/ephemeral), with [private vulnerability reporting](../SECURITY.md) enabled. The owner selected the [MIT License](../LICENSE), with copyright credited to scasella. **GitHub CI remains pending** and its workflow is paused. This procedure does not authorize a hosted deployment, GitHub release/tag or package publication. Keep `package.json` private and do not run `npm publish`; that package setting does not control GitHub repository visibility.

Use only the separate sanitized publication checkout and its reviewed `main` history. Original history and private evidence are archived outside it. Never mirror-push the original repository, import its ancestors/editor refs, or attach private bundles and receipts to a release. Any future edits require a new exact-commit scan.

## Local candidate checks

For the local source project, start with [publication status and pilot limitations](RELEASE-READINESS.md#local-source-publication-status). The real [clean-checkout acceptance](VALIDATION.md#clean-checkout-local-live-acceptance) passed the core local flow using the documented Cloudflare fallback. MIT licensing and GitHub private reporting are now configured separately; that live test does not establish hosted-CI success or evidence for unexecuted expiry/crash/upstream-revocation checks. Hosted acceptance below is a separate deployment decision.

Use Node 24, npm, Git, Python 3, and `openssl`. The process-containment tests also need `tmux` and `ps`; see [contributor prerequisites](../CONTRIBUTING.md#local-setup) for Linux packages and container process-group setup. From a clean checkout without integration configuration:

```sh
npm ci
npm run test:ci
npm run build
npm run audit:dependencies
npm run check:secrets
```

The last command requires Gitleaks 8.30.1 on PATH or `GITLEAKS_BIN` pointing at that executable. Installation is explicit; the script never downloads a tool. CI downloads the pinned official Linux archive and verifies a committed checksum. It scans all Git history and a temporary copy of tracked/non-ignored candidate files, fully redacts findings, and rejects incomplete scans or symlinks. The narrowly scoped config exception matches only an empty-default environment mapping; it does not exclude the configuration file. A scan is evidence within its rule coverage, not proof that all sensitive information is absent.

Run `npm run test:preview:browser` after building for the interactive local viewer/HMR/isolation test. Use the [fixture instructions](../scripts/fixtures/preview-vite/LOCAL_E2E.md). Local account/provider adapters are synthetic; tests require no operator credentials.

With a local Docker daemon running:

```sh
docker build --tag ephemeral:release-candidate .
npm run test:container
```

The smoke runner needs only Node and Docker on the host; it does not install host dependencies or load `.env`. It tests packaged modules and assets, UID 1000/umask, mounted-disk repair and persistence, embedded database reopen, rejected startup configurations, production HTTP/authentication fences, a real PostgreSQL connection and singleton lock, restart, and graceful SIGTERM. It pulls `postgres:17-bookworm` if missing, generates test-only configuration, publishes no host ports, and blocks external container access with an internal Docker network. Its temporary containers, volumes, and network are removed on completion. Built/pulled images remain cached. Optional image arguments: `npm run test:container -- ephemeral:ci postgres:17-bookworm`.

Local Docker validation passes; see [reviewed private-main validation](VALIDATION.md#reviewed-private-main) for current evidence and the historical reports for earlier platforms. CI is configured to run the same suite, but GitHub CI remains pending at the owner's request. The workflow is disabled manually; resume it only when requested. Prior private-main pushes used a CI-skip marker; they are not hosted-CI evidence. These tests use no real E2B/GitHub credentials and do not establish hosted lifecycle acceptance.

## Private Preview migration

The former single fixed viewer hostname allowed a loaded old application document to receive a later generation's host-wide cookie. The candidate gives every access generation a different hostname and binds handoff consumption, HTTP, and WebSocket authorization to it. The base hostname never serves application content.

1. Stop active machines normally and resolve cleanup before upgrading. Keep the database and encryption key together. Back up the database before changing the sole control plane.
2. If Preview is needed, configure `PREVIEW_PUBLIC_URL` as a canonical HTTPS **base DNS origin**, such as `https://preview.example.net`, with no trailing slash/path, credentials, query, or fragment. IP literals are rejected. The control-plane hostname must be outside this base's namespace.
3. Configure wildcard DNS and a certificate for `*.preview.example.net`. Route generated hostnames to the dedicated viewer listener; preserve their exact Host and WebSocket upgrades. Configure only the viewer upstream for this namespace, never the control-plane listener. No DNS, domain, certificate, proxy, or hosting change was performed during preparation.
4. The app derives `https://<generation-uuid>.preview.example.net` and limits the native POST form CSP to that wildcard namespace and port. Do not rewrite generated Host to the base hostname. Existing root-host tabs/grants will stop working; prepare fresh openings from the upgraded app. Existing database preview rows need no manual rewriting.
5. For a local-only viewer, use `PREVIEW_PUBLIC_URL=http://localhost:4312`, `PREVIEW_PORT=4312`, `PREVIEW_HOST=127.0.0.1`, and `PREVIEW_LOCAL_ONLY=1`. The control plane must be outside `.localhost` (the live guide uses its HTTPS tunnel; the synthetic harness uses `127.0.0.1`). Chromium resolves generated `.localhost` hosts locally. Never expose this HTTP configuration through a public tunnel.
6. If wildcard hosting is unavailable, leave `PREVIEW_PUBLIC_URL` empty. Preview will show an unavailable reason; do not restore the fixed-host behavior as a workaround.

Recheck real framework HMR and retained-old-page denial on the actual HTTPS deployment. A local HTTP fixture does not verify wildcard DNS/TLS or the production proxy. [The historical reports](VALIDATION.md) predate this migration.

## Local database recovery

The embedded local database refuses every existing `control-plane.lock`, including stale or incomplete files. After an unclean stop, inspect the recorded PID and all control-plane processes using that exact data directory. Only after confirming none are running, remove that one lock and restart. Do not delete database files or remove a live process's lock. Use separate `DATA_DIR` values for separate local instances. Production PostgreSQL uses its existing connection-held advisory lock.

Compose now passes the raw password through `PGPASSWORD` and uses a password-free `DATABASE_URL`, so URI delimiter characters do not corrupt the connection string. Keep `.env` ignored and protect the host's environment/containers as privileged surfaces.

## Source maintenance and release checklist

Public source visibility and GitHub private reporting were authorized and configured on 2026-10-16. Subsequent source updates and any tagged release should follow these checks:

- Retain the MIT License, copyright notice and matching package metadata. The README's visible-credit request is optional, not an additional license condition. No separate contributor agreement is supplied.
- Review source, all reachable history, documentation images, author metadata and release notes for disclosures. Re-run the redacted full-history/candidate scan on the exact commit. Never publish `.env`, private keys, `.data`, database backups, raw logs, original-history refs, or credential-aware test receipts.
- Keep [GitHub private vulnerability reporting](https://github.com/scasella/ephemeral/security/advisories/new) enabled and the [security policy](../SECURITY.md) current. Check the reporting entry point after repository/permission changes; no separate inbox or report-delivery test is claimed.
- Continue from reviewed `main` in `scasella/ephemeral`; do not create a replacement repository or import the original private history.
- Keep CI pending until the owner requests resumption. The workflow is disabled manually, including scheduled and pull-request runs. When authorized, enable it, run all jobs (including containers), verify their results and configure appropriate branch/required-check protections. Available repository security controls and maintainer permissions remain separate follow-ups; do not claim they were configured by publishing source.
- A GitHub tag/release needs a separate decision. Use the actual license and experimental limitations; do not label this a generally available hosted service or imply upstream Codex revocation is proven.

Public source publication and hosted public access are separate decisions. A GitHub release must not apply `render.yaml`, expose listeners, spend money, build a paid E2B template, or invite accounts automatically. CI intentionally has no deployment/publishing credentials or steps.

## Hosted pilot acceptance

Keep the account allowlist, singleton control plane, one-active-machine limit, and operator E2B spend controls. Follow [deployment acceptance](DEPLOYMENT.md#live-end-to-end-acceptance) on the chosen host: real one-hour expiry, crash/provisioning/cleanup recovery, rejected former GitHub/gateway credentials, provider absence, HTTPS OAuth/proxy/WebSockets, and wildcard viewer isolation/HMR. Historical successful local runs do not satisfy these deployment-specific gates.

Choose and communicate an operator retention/deletion policy and private support contact before inviting additional users. Session history, notes, inherited note revisions, recipes/output, PR records, and events persist after compute ends; automatic product-wide erasure is not implemented. Do not delete credential/reconciliation state while cleanup is unresolved. Remote OpenAI revocation remains unverified. No paid hosting or public service was launched as part of release preparation.

The concrete [hosted acceptance procedure](HOSTED-ACCEPTANCE.md), [hosting assessment](HOSTING.md), [retention draft](RETENTION.md) and [support draft](SUPPORT.md) record what remains to be activated and tested. Contact setup remains pending at the owner's request.
