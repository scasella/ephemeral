# Security

## Status and supported scope

Ephemeral is an invite-only pilot implementation licensed under [MIT](LICENSE). Publication remains pending. There is no security audit, supported stable release line, or guaranteed response time. Security fixes are evaluated against the current pilot code; older snapshots are not maintained release branches.

The owner has kept contact setup pending. [Support](docs/SUPPORT.md) and [retention](docs/RETENTION.md) are explicit drafts; neither establishes an active inbox, staffed response commitment or implemented content-purge service.

The supported deployment has one control-plane instance, an explicit GitHub account allowlist, and one active machine per user. Local preview simulates provider and cleanup operations. Local tests cannot establish the security of real upstream integrations. Before operating real sessions, review the [architecture](docs/ARCHITECTURE.md), [live testing guide](docs/LOCAL-LIVE.md), and the README's [cleanup semantics](README.md#cleanup-semantics) and [operational limits](README.md#operational-limits).

VM destruction removes remaining local credential files, but does not establish that copied credentials were invalidated upstream. Remote OpenAI account-token revocation is unverified. A cleanup request is not proof of cleanup; unresolved failures require operator reconciliation.

## Reporting a vulnerability

GitHub private vulnerability reporting has not been enabled or verified for the intended repository. There is no verified private reporting address in this project. Before public publication, the maintainer must select and test a private reporting contact and update this section. GitHub's built-in private reporting is available for public repositories: enable and test it as part of an explicitly authorized visibility change, then document the working route before announcing the release. See [GitHub's configuration instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository). Do not describe a reporting route as available before testing it.

Until a private route is documented, keep suspected vulnerabilities and exploit details private. Do not open a public issue, pull request, or discussion containing them. Routine non-sensitive bugs can use the issue templates once the repository is published.

When a private route is available, report the affected revision, affected component and mode, expected authorization boundary, sanitized reproduction steps, observed impact, and any mitigation. Use a disposable environment and accounts you control. Do not attach private keys, tokens, cookies, `.env` files, databases, terminal transcripts, user content, or private repository files. A short redacted diagnostic excerpt is preferable to a complete log.

## If a credential is exposed

Treat the credential as compromised. Revoke or rotate it through its upstream provider and verify the result there. Stop affected sessions and reconcile any incomplete cleanup. Do not assume deleting a file, removing a public post, signing out locally, or destroying a VM revokes all upstream access. Keep incident evidence in private operator storage and redact it before sharing.
