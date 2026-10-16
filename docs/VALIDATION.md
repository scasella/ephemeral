# Validation evidence

This public summary omits private test-repository names, PR links, resource identifiers, exact timelines and live screenshots. Unredacted historical evidence remains in private operator storage. No identifier or screenshot was replaced with invented evidence.

## Reviewed private main

The sanitized source and reviewed fixes were merged into `main` in the private `scasella/ephemeral` repository at `c4dfb8659a3e25fdc068a05a5a50c923a31ef220`. The repository was subsequently made public with private vulnerability reporting enabled on 2026-10-16. GitHub CI remains pending and its workflow is paused. The CI-skip marker on that runtime commit prevented its private pushes from starting GitHub CI; no hosted-CI result is claimed.

Local verification of that exact runtime candidate passed:

- 1,388 tests across 100 files, with one intentionally skipped interactive browser hold; TypeScript checking and the production build passed.
- 127 selected regression checks in an offline Linux container under a non-root user.
- 34 container checks, including real disposable PostgreSQL, recovery configuration precedence, singleton ownership, restart and shutdown. The Docker context check admitted 19 synthetic build inputs and excluded 94 private/unrelated fixtures.
- A redacted scan of the exact commit and all five sanitized commits, plus all 292 tracked candidate files, with no configured secret-rule matches. A refreshed locked-dependency advisory check reported zero vulnerabilities.

All 64 packaged runtime and built files matched the reviewed checkout. Disposable containers, volumes, network and source export were removed; detailed receipts remain in ignored private storage outside the publication tree.

These checks used synthetic account/provider adapters and disposable local resources. They did not repeat real E2B/GitHub/Codex acceptance on this revision or establish hosted readiness. The separate live tests below retain their original revision and coverage limits. Documentation-only updates after this runtime commit require an exact-commit secret scan; they do not turn these local results into GitHub CI or new live-account evidence.

## Recorded baseline

The private baseline completed a clean Node 24 install, 821 passing tests across 63 files (one intentionally skipped interactive hold), TypeScript checking and a Vite production build. The lockfile advisory check and Gitleaks scan passed at the time of that review. These are historical observations; rerun checks on the exact candidate before publication.

Local Docker builds and 18 smoke checks passed on native Linux arm64 and emulated Linux amd64. The test database used native arm64 PostgreSQL. Checks covered packaged modules/assets, UID/GID 1000, private umask, disk repair/persistence, PGlite reopen, rejected startup modes, production authentication fences, PostgreSQL migrations and singleton locking, restart and graceful SIGTERM. This was local container evidence, not a hosted deployment.

## Clean-checkout local live acceptance

The guided-setup candidate `f784fe88f964080b82a51c661e00548b0b4017a9` was cloned into an independent checkout with no initial configuration, private state or dependencies. It received a fresh install/build using Node 24. Account credentials and generated state were kept in ignored private files. This was a real macOS arm64 local test with an E2B VM, not simulation or a hosted deployment.

| Check | Observed result |
|---|---|
| First-run guide | Prepared private configuration/key/database, created a new private GitHub App and installed it only on a disposable repository. Required browser account checks were completed by the user. |
| Tunnel and restart | ngrok's account request quota blocked that route. Official `cloudflared` 2026.10.0 provided a working Quick Tunnel. A later restart used a new hostname with coordinated private `PUBLIC_URL` and existing App callback updates. Local and public exact live-health checks passed without credentials. |
| Account/template diagnostics | Read-only GitHub installation and E2B access/readiness checks passed. A ready clean template was reused; no template build or plan upgrade was performed. |
| Real provisioning | App launch produced a matching real E2B sandbox with a unique assigned branch, 2 vCPU, 1024 MiB RAM and a one-hour provider deadline. |
| GitHub and Git gateway | GitHub sign-in succeeded. A harmless fixture commit was pushed to the assigned branch. Main, unrelated-branch and assigned-branch-deletion probes received explicit gateway policy rejection; main was unchanged. |
| Codex authentication and response | The user completed fresh device authentication in the VM. `codex login status` independently reported ChatGPT login. After folder trust, Codex CLI 0.162.1 displayed GPT-6.1-Sol and returned a useful read-only README/file-list explanation. No Mac auth cache was copied or credential files read. |
| Terminal reconnect | Browser reconnection retained the same tmux pane/process and authenticated Codex session. A longer task was submitted successfully using terminal paste after reconnection. Input during disconnection was not treated as delivered. |
| Published work | The app's checked comparison showed one published file, one commit ahead and zero behind. An independent pre-stop check found no changed, untracked or ignored workspace files, and local HEAD matched the remote session branch. |
| Manual stop | The app reported VM destruction, GitHub-token cleanup, gateway cleanup and local Codex cleanup confirmed. A separate credential-aware check required the exact application rejection for the former gateway credential and independently confirmed E2B VM absence. |

Codex showed two startup warnings: no system bubblewrap, with an explicit bundled-bubblewrap fallback, and an optional account-synced MCP app that was not authenticated. The read-only task succeeded; no extra MCP authorization or sandbox-protection bypass was performed. These are observed compatibility notes, not a security audit.

This run did **not** test a fresh template build, draft PR creation, full-duration automatic expiry, live crash/fault recovery, independent replay of a former upstream GitHub installation token, remote Codex-token revocation, or private application Preview. Preview remained disabled. The app's GitHub/local-Codex cleanup report is distinct from the independent gateway/VM checks. The useful-response timing button was not clicked; an observed model reply is not a user-confirmation metric. Older PR/Preview results below must not be attributed to this run.

A separate clean archive check of this candidate had 896 passing tests across 66 files, one intentional interactive-hold skip, and a passing typecheck/production build. Its redacted history/candidate scan found no configured secret-rule matches. These results apply to that candidate, not future edits. Private receipts and screenshots remain outside the publication tree; rerun final checks on the eventual release commit.

## Historical integration coverage

Dedicated private fixtures exercised real E2B provisioning, a scoped private clone, fresh Codex device login and model output, terminal reconnect, permitted session-branch pushes, forbidden branch operations, draft PR handoff, supplemental shell, setup recipes, saved-work continuation and durable notes. UI checks covered terminal context, history, reminders, keyboard continuity, compact views, pushed-change review and private Preview readiness/HMR.

Manual stop was followed by independent provider-absence and former gateway-capability rejection checks. Upstream GitHub-token rejection was not independently replayed in that historical live run. Full one-hour automatic expiry and live crash/fault recovery were not established by it. Remote OpenAI grant revocation remains unverified.

A synthetic local browser harness separately demonstrated React/Vite HMR, distinct private-viewer generations, denial of retained old documents and denial on the base viewer hostname. Provider/account adapters were synthetic; this did not test public wildcard DNS, certificates or reverse-proxy routing.

## Repeatable local checks

```sh
npm ci
npm run test:ci
npm run build
npm run audit:dependencies
npm run check:secrets
docker build --tag ephemeral:release-candidate .
npm run test:container
node --import tsx scripts/live-smoke.ts --self-test
```

Use Node 24 and the pinned Gitleaks version from [CONTRIBUTING](../CONTRIBUTING.md). The live-smoke self-test uses local fixtures and makes no cloud/account changes. Actual live commands require an explicit `--fixture OWNER/REPO`, an isolated ignored configuration, and deliberately selected disposable resources. See [local live testing](LOCAL-LIVE.md).

Fresh candidate check results belong in a private receipt keyed by the resulting commit. A successful local check does not substitute for [hosted acceptance](HOSTED-ACCEPTANCE.md), license compliance, a tested support/security route or actual GitHub CI.
