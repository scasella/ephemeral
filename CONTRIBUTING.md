# Contributing

The sanitized source and reviewed fixes are committed to `main` in the private GitHub repository `scasella/ephemeral`. Public publication and GitHub CI remain pending. The `package.json` repository URL identifies that repository; its `private: true` setting prevents npm publication and does not control GitHub visibility. The project is licensed under [MIT](LICENSE); preserve its copyright and permission notice when redistributing copies or substantial portions. No separate contributor agreement is supplied by this guide.

## Local setup

Use Node.js 24 LTS, npm, Git, Python 3, and `openssl` for local tests. Workspace-change inspection tests invoke `python3` directly; confirm that command is available before running the suite. Install `tmux` and `ps` (`procps` on Linux) for both real shell-containment tests; those two checks skip explicitly if tmux is absent. CI installs the tools, including `setsid` from `util-linux` on Linux, and launches the suite with `setsid --wait npm run test:ci` to give containment fixtures an ordinary process group. If running the suite in Docker, use `--init` so orphaned fixture processes are reaped, and run `setsid --wait npm run test:ci` inside the container. The package supports Node 24; `.nvmrc` and `.node-version` select that major for compatible version managers. With nvm, run `nvm install` and `nvm use` first. Confirm `node --version` reports v24 before installing dependencies. From the repository root:

```sh
npm ci
npm run local
```

Open <http://localhost:4310>. The local launcher explicitly selects simulation, clears integration credentials, and uses its own `.data/local-preview` database. For a second instance, use `npm run local -- --port 4311`. It simulates VM provisioning, terminal commands, GitHub mutations, and cleanup. It cannot demonstrate real Codex output or upstream credential revocation. The local preview binds to loopback. Use `npm run dev` for source watching with your chosen development configuration.

Run `npm run test:local` to check the launcher's mode, storage, credential and port isolation. Local simulation data persists across restarts; treat `.data/local-preview` as private and keep it out of source control.

The real-account first-run guide is `npm run setup`; see [first-run setup](docs/FIRST-RUN.md). Its configuration, GitHub command gates and template-worker boundaries have synthetic tests in the regular suite. These tests do not register Apps, issue provider builds or authenticate Codex. `npm run setup:doctor -- --offline` checks an existing local configuration without account requests; the default doctor performs read-only upstream checks. No setup credential is needed in CI.

The [independent clean-checkout run](docs/VALIDATION.md#clean-checkout-local-live-acceptance) separately verified real GitHub/E2B/Codex integration and manual teardown. The guide documents a Cloudflare Quick Tunnel fallback; the current wizard still names ngrok. Keep private test receipts, account details, device codes and live screenshots out of documentation changes. Record unexecuted paths separately from historical or synthetic coverage.

Local preview development needs no account credentials. Keep live integration configuration in ignored local files and follow [local live testing](docs/LOCAL-LIVE.md) only when deliberately testing real resources. Never add `.env` files, private keys, tokens, browser cookies, credential-bearing URLs, production databases, or terminal transcripts to a contribution.

## Validate a change

```sh
npm run test:ci
npm run build
node --import tsx scripts/live-smoke.ts --self-test
npm run audit:dependencies
npm run check:secrets
```

`test` and `test:ci` enforce Node 24, start Vitest with an allowlisted environment and disposable home, and prevent repository `.env` loading. Direct Vitest runs also use a setup hook that clears integration settings before server imports. Dedicated configuration subprocess tests explicitly opt back into dotenv using synthetic temporary files. `test:ci` limits Vitest to two workers. PGlite, local Git, HTTP and process integration files receive 30-second test/hook budgets; pure unit tests keep the default budget. No automatic test retries hide assertion failures. `build` runs TypeScript checking and the Vite build. The dependency audit checks both application and development dependencies against npm's current advisory service and fails on high or critical advisories; it requires network access. Registry failure is an incomplete audit, not a clean result. Do not run `npm audit fix --force` without reviewing dependency and compatibility changes.

`check:secrets` requires an already-installed Gitleaks 8.30.1 on `PATH`, or an explicit `GITLEAKS_BIN` executable path. It downloads nothing. It scans all Git history and a temporary copy of tracked and non-ignored untracked files, then deletes the copy. Ignored local operational files stay outside the working-file scan; accidentally tracked files remain in scope. Shallow clones and non-regular candidate files fail for separate review. Output is fully redacted, and no findings report is saved or uploaded. Pattern scanning is one check, not proof that a release contains no sensitive data. CI installs a pinned, checksum-verified CLI for this check.

The regular suite includes a bounded local private-preview E2E check. To run only that check, or inspect its browser flow:

```sh
npm run test:preview
npm run build
npm run test:preview:browser
```

This harness exercises the real control plane, DB-backed browser authentication, generated preview gateway, isolated viewer, and React/Vite HMR transport on loopback. Account/provider adapters are synthetic. No E2B resources, GitHub mutations, account sign-in, or `.env` reads are involved. Browser mode requires explicit manual observations and ends on quit, Ctrl-C, or its deadline. See [the harness instructions](scripts/fixtures/preview-vite/LOCAL_E2E.md).

Real E2B provisioning, GitHub permissions and pushes, Codex sign-in/output, expiry, and external credential revocation require separate live evidence. CI runs local tests and builds without operator secrets. Do not add automatic live tests, cloud deployment, package publication, or GitHub mutations to it.

To check the packaged runtime with a local Docker daemon:

```sh
docker build --tag ephemeral:release-candidate .
npm run test:container
# Check context filtering alone, without building the application image:
npm run test:container:context
```

The Docker build context uses an allowlist of build inputs and excludes private configuration and data directories at every depth. The container test first exports a synthetic context with Docker and verifies that nested private files cannot enter builder layers, then checks the packaged runtime. The runner does not load `.env` or require host `node_modules`. It checks privilege drop, disk permissions and persistence, startup safeguards, built assets and authentication fences, real PostgreSQL migrations/locking, restart and SIGTERM. It pulls the Compose PostgreSQL image if needed and uses generated test configuration, disposable volumes, an internal Docker network, and no published host ports. It removes test resources and leaves images cached. See [the local container report](docs/VALIDATION.md). CI is configured to run the same suite without publishing images or deploying resources; an actual GitHub CI run remains pending at the owner's request. This is local runtime evidence, not a real E2B/GitHub or hosted acceptance test.

## Scope and review

Keep changes focused and explain the user-visible problem, resulting behavior, and validation. Include a regression test when it meaningfully protects behavior; use screenshots and keyboard checks for interface changes. Update documentation when configuration, trust boundaries, cleanup guarantees, or supported behavior changes. Record what a test actually observed, including missing evidence and simulations.

This version supports an invite-only pilot with one control-plane instance and one active machine per user. It is not a security-audited public multi-tenant service. Cleanup and credential revocation can fail and must remain visible. Remote OpenAI authorization revocation remains unverified. Consult the [architecture](docs/ARCHITECTURE.md) and operational limits in the [README](README.md) before changing these boundaries.

After publication, use the issue and pull-request templates for ordinary defects and proposals. Review all screenshots and diagnostics for secrets and private repository data before attaching them. Handle suspected vulnerabilities through [SECURITY.md](SECURITY.md), rather than a public issue.
