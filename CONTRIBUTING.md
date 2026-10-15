# Contributing

GitHub publication is pending. The `package.json` repository URL records the intended destination, `scasella/ephemeral`; it does not establish that the repository is public. No project license has been selected. This guide does not grant a license or introduce contributor legal terms.

## Local setup

Use Node.js 24 LTS, npm, Git, and `openssl` for the local private-preview tests. Install `tmux` and `ps` (`procps` on Linux) for both real shell-containment tests; those two checks skip explicitly if tmux is absent. CI installs the tools. If running the suite in Docker, use `--init` so orphaned fixture processes are reaped. The package supports Node 24; `.nvmrc` and `.node-version` select that major for compatible version managers. With nvm, run `nvm install` and `nvm use` first. Confirm `node --version` reports v24 before installing dependencies. From the repository root:

```sh
npm ci
npm run local
```

Open <http://localhost:4310>. The local launcher explicitly selects simulation, clears integration credentials, and uses its own `.data/local-preview` database. For a second instance, use `npm run local -- --port 4311`. It simulates VM provisioning, terminal commands, GitHub mutations, and cleanup. It cannot demonstrate real Codex output or upstream credential revocation. The local preview binds to loopback. Use `npm run dev` for source watching with your chosen development configuration.

Run `npm run test:local` to check the launcher's mode, storage, credential and port isolation. Local simulation data persists across restarts; treat `.data/local-preview` as private and keep it out of source control.

The real-account first-run guide is `npm run setup`; see [first-run setup](docs/FIRST-RUN.md). Its configuration, GitHub command gates and template-worker boundaries have synthetic tests in the regular suite. These tests do not register Apps, issue provider builds or authenticate Codex. `npm run setup:doctor -- --offline` checks an existing local configuration without account requests; the default doctor performs read-only upstream checks. No setup credential is needed in CI.

Local preview development needs no account credentials. Keep live integration configuration in ignored local files and follow [local live testing](docs/LOCAL-LIVE.md) only when deliberately testing real resources. Never add `.env` files, private keys, tokens, browser cookies, credential-bearing URLs, production databases, or terminal transcripts to a contribution.

## Validate a change

```sh
npm run test:ci
npm run build
node --import tsx scripts/live-smoke.ts --self-test
npm run audit:dependencies
npm run check:secrets
```

`test:ci` limits Vitest to two workers. `build` runs TypeScript checking and the Vite build. The dependency audit checks both application and development dependencies against npm's current advisory service and fails on high or critical advisories; it requires network access. Registry failure is an incomplete audit, not a clean result. Do not run `npm audit fix --force` without reviewing dependency and compatibility changes.

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
```

The runner does not load `.env` or require host `node_modules`. It checks privilege drop, disk permissions and persistence, startup safeguards, built assets and authentication fences, real PostgreSQL migrations/locking, restart and SIGTERM. It pulls the Compose PostgreSQL image if needed and uses generated test configuration, disposable volumes, an internal Docker network, and no published host ports. It removes test resources and leaves images cached. See [the local container report](docs/VALIDATION.md). CI runs the same suite without publishing images or deploying resources; an actual GitHub CI run remains pending publication. This is local runtime evidence, not a real E2B/GitHub or hosted acceptance test.

## Scope and review

Keep changes focused and explain the user-visible problem, resulting behavior, and validation. Include a regression test when it meaningfully protects behavior; use screenshots and keyboard checks for interface changes. Update documentation when configuration, trust boundaries, cleanup guarantees, or supported behavior changes. Record what a test actually observed, including missing evidence and simulations.

This version supports an invite-only pilot with one control-plane instance and one active machine per user. It is not a security-audited public multi-tenant service. Cleanup and credential revocation can fail and must remain visible. Remote OpenAI authorization revocation remains unverified. Consult the [architecture](docs/ARCHITECTURE.md) and operational limits in the [README](README.md) before changing these boundaries.

After publication, use the issue and pull-request templates for ordinary defects and proposals. Review all screenshots and diagnostics for secrets and private repository data before attaching them. Handle suspected vulnerabilities through [SECURITY.md](SECURITY.md), rather than a public issue.
