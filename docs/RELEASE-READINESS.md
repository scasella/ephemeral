# Release readiness

The sanitized source and reviewed fixes are public on `main` at [scasella/ephemeral](https://github.com/scasella/ephemeral). This is an experimental locally runnable source project licensed under [MIT](../LICENSE), with copyright credited to scasella. GitHub private vulnerability reporting is enabled. GitHub CI remains pending at the owner’s request; its workflow is paused. No public hosted service is represented by this source tree.

## Source preparation

The publication tree has a fresh root history using the owner's verified GitHub noreply identity. It contains no original ancestors or local editor snapshot refs. Original history, detailed live-test records and screenshots are retained privately outside this publication checkout. Public documentation includes reviewed simulation screenshots and GIFs with [capture provenance](media/README.md). Public validation describes observations without publishing private repository URLs, operational resource IDs, exact test timelines or personal contact details.

The release review repaired generation-specific private Preview origins, required the reviewed head/base pair before PR creation, made local database locking fail closed, and separated PostgreSQL passwords from connection URLs. Node 24, pinned dependencies/base image, contributor guidance and CI are prepared. Local validation of the reviewed runtime passed; GitHub CI has not run for that commit. See [validation](VALIDATION.md#reviewed-private-main).

## Local release scope and evidence

The intended initial release is an experimental project users run on their own computer with their own E2B account, GitHub App and eligible Codex account. It still needs an HTTPS tunnel, a compatible clean E2B template and ignored private configuration; an E2B key alone is insufficient. The single local process uses embedded PostgreSQL/PGlite, so it needs no paid application host, external database or owned domain. Optional application Preview stays disabled unless separately configured.

The [clean-checkout test](VALIDATION.md#clean-checkout-local-live-acceptance) passed the guided configuration flow, real GitHub sign-in, E2B provisioning, Codex device login/useful output, scoped Git writes, published-work review, reconnect and manual cleanup. Official Cloudflare Quick Tunnel worked when ngrok's account quota blocked requests. The [setup guide](FIRST-RUN.md) now documents that fallback and deliberate hostname/callback migration. The wizard itself still displays ngrok wording; automatic tunnel selection or callback migration is not implemented.

## Local source publication status

The owner authorized public source visibility and GitHub private vulnerability reporting on 2026-10-16. The reporting setting and public entry point were verified; see [SECURITY](../SECURITY.md) for the route and verification limits. No separate support email or response-time promise is active.

Publish only this reviewed history. Preserve the MIT copyright and permission notice; the README's visible-credit request is optional. Keep `package.json` private to prevent accidental npm publication. Do not attach original-history bundles, private evidence, operational files, or local editor refs.

Run a redacted full-history/candidate scan on the exact commit after any edits. Local validation of the reviewed runtime is recorded in [validation](VALIDATION.md#reviewed-private-main); documentation-only publication changes do not establish new live integration results.

GitHub CI remains pending by explicit owner choice. The CI workflow is disabled manually to prevent push, pull-request and scheduled runs until the owner requests resumption. No hosted-CI success or branch-protection guarantee is claimed. When CI is resumed, verify the workflows before relying on required checks; maintainer/repository protection controls remain a separate follow-up.

Public source visibility does not activate hosted support/retention policies, deploy a service, create a GitHub release/tag, publish to npm, or authorize paid hosting.

## Local pilot limitations to disclose

- Remote ChatGPT/Codex-token revocation remains unverified. Local logout/removal and VM destruction do not prove upstream invalidation. Keep that uncertainty visible and avoid an “all provider tokens revoked” claim. Independent replay of the former upstream GitHub installation token also remains outside the clean-checkout evidence.
- Real full-hour automatic expiry and crash/cleanup recovery need their own acceptance runs before claiming those paths are live-validated. Manual stop and gateway/VM cleanup passed. A new template build and draft PR creation were not repeated in the clean-checkout run; earlier evidence is identified separately.
- The Cloudflare fallback is a temporary development tunnel with manual hostname/callback updates. The wizard still names ngrok. Users must keep the computer/app/tunnel awake and resolve VM cleanup before shutting them down.
- The real clean-checkout run used macOS arm64. Linux/WSL instructions and older container evidence do not establish equivalent interactive first-run acceptance on those platforms. Optional Codex MCP integrations need their own authorization; the core test did not require them.
- State and notes persist locally after compute ends; there is no general scheduled content purge or account-deletion UI. Document that behavior for local users. Hosted retention/support drafts are not active service commitments.

These are explicit limits of an experimental local pilot. They do not require buying a host or domain, enabling optional Preview, or claiming unperformed tests passed. A stable or fully revoking service claim would require additional implementation-specific evidence.

## Hosted-launch gates

The current backend needs a continuously running Node container with Git subprocesses, persistent storage and PostgreSQL. Sites can serve an informational page, but cannot host this backend unchanged. See [hosting assessment](HOSTING.md).

The [hosted acceptance procedure](HOSTED-ACCEPTANCE.md) requires real wildcard DNS/TLS, private viewer isolation/HMR, full-duration expiry, process-crash recovery, provider absence and independent former-token rejection on the chosen host. Local simulation and container smoke tests do not satisfy those gates.

Hosted retention and support drafts are prepared, with activation and a tested support/deletion contact still pending. Source vulnerability reports use the active private GitHub route. The product has no general account/content deletion feature or scheduled content purge. [Current retention and proposed policy](RETENTION.md) distinguishes implemented behavior from the proposed operating policy.

Remote ChatGPT/Codex revocation remains unverified. The current VM-local Codex login is not an implementation of the separately documented application OAuth revocation flow. Do not mark its cleanup result confirmed without implementation-specific proof. Preserve the invite allowlist, singleton operation, bounded lifetimes and explicit cleanup uncertainty.
