# Release readiness

This is a local publication candidate for `scasella/ephemeral`. Licensing and GitHub publication are pending. No public hosted service is represented by this source tree.

## Source preparation

The publication tree has a fresh root history using the owner's verified GitHub noreply identity. It contains no original ancestors or local editor snapshot refs. Original history, detailed live-test records and screenshots are retained privately outside this publication checkout. One reviewed synthetic local-preview overview remains. Public validation describes observations without publishing private repository URLs, operational resource IDs, exact test timelines or personal contact details.

The release review repaired generation-specific private Preview origins, required the reviewed head/base pair before PR creation, made local database locking fail closed, and separated PostgreSQL passwords from connection URLs. Node 24, pinned dependencies/base image, contributor guidance and CI are prepared. See [validation](VALIDATION.md).

## Remaining source-publication gates

- The owner selects licensing and explicitly authorizes repository creation/publication. Keep `package.json` private in the meantime.
- Establish and test a private security contact; contact setup is deliberately pending. See [SECURITY](../SECURITY.md) and the [support draft](SUPPORT.md).
- Review the exact sanitized commit, run its redacted full-history/candidate scan, and run GitHub CI after repository creation is authorized. Configure branch protection and available repository security controls before announcement.
- Publish only this reviewed history. Do not attach an original-history bundle, private evidence, operational files, or local editor refs.

## Hosted-launch gates

The current backend needs a continuously running Node container with Git subprocesses, persistent storage and PostgreSQL. Sites can serve an informational page, but cannot host this backend unchanged. See [hosting assessment](HOSTING.md).

The [hosted acceptance procedure](HOSTED-ACCEPTANCE.md) requires real wildcard DNS/TLS, private viewer isolation/HMR, full-duration expiry, process-crash recovery, provider absence and independent former-token rejection on the chosen host. Local simulation and container smoke tests do not satisfy those gates.

Retention and support drafts are prepared, with activation and a tested contact still pending. The product has no general account/content deletion feature or scheduled content purge. [Current retention and proposed policy](RETENTION.md) distinguishes implemented behavior from the proposed operating policy.

Remote ChatGPT/Codex revocation remains unverified. The current VM-local Codex login is not an implementation of the separately documented application OAuth revocation flow. Do not mark its cleanup result confirmed without implementation-specific proof. Preserve the invite allowlist, singleton operation, bounded lifetimes and explicit cleanup uncertainty.
