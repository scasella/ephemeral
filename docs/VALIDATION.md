# Validation evidence

This public summary omits private test-repository names, PR links, resource identifiers, exact timelines and live screenshots. Unredacted historical evidence remains in private operator storage. No identifier or screenshot was replaced with invented evidence.

## Recorded baseline

The private baseline completed a clean Node 24 install, 821 passing tests across 63 files (one intentionally skipped interactive hold), TypeScript checking and a Vite production build. The lockfile advisory check and Gitleaks scan passed at the time of that review. These are historical observations; rerun checks on the exact candidate before publication.

Local Docker builds and 18 smoke checks passed on native Linux arm64 and emulated Linux amd64. The test database used native arm64 PostgreSQL. Checks covered packaged modules/assets, UID/GID 1000, private umask, disk repair/persistence, PGlite reopen, rejected startup modes, production authentication fences, PostgreSQL migrations and singleton locking, restart and graceful SIGTERM. This was local container evidence, not a hosted deployment.

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

Fresh candidate check results belong in a private receipt keyed by the resulting commit. A successful local check does not substitute for [hosted acceptance](HOSTED-ACCEPTANCE.md), licensing, a tested support/security route or actual GitHub CI.
