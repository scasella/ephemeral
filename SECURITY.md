# Security

## Status and supported scope

Ephemeral is an experimental, locally runnable project licensed under [MIT](LICENSE). The sanitized source is public at [scasella/ephemeral](https://github.com/scasella/ephemeral). GitHub CI remains pending at the owner's request; its workflow is paused. There is no security audit, supported stable release line, or guaranteed response time. Security fixes are evaluated against current `main`; older snapshots are not maintained release branches.

GitHub private vulnerability reporting is the project's security-reporting route. No separate support/security email address is published. [Hosted support](docs/SUPPORT.md) and [retention](docs/RETENTION.md) remain drafts; neither establishes a staffed response commitment or implemented content-purge service.

The supported deployment has one control-plane instance, an explicit GitHub account allowlist, and one active machine per user. Local simulation does not perform provider or cleanup operations. Local tests cannot establish the security of real upstream integrations. Before operating real sessions, review the [architecture](docs/ARCHITECTURE.md), [live testing guide](docs/LOCAL-LIVE.md), and the README's [cleanup semantics](README.md#cleanup-semantics) and [operational limits](README.md#operational-limits).

VM destruction removes remaining local credential files, but does not establish that copied credentials were invalidated upstream. Remote OpenAI account-token revocation is unverified. A cleanup request is not proof of cleanup; unresolved failures require operator reconciliation.

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting form](https://github.com/scasella/ephemeral/security/advisories/new). Sign in to GitHub, or open the repository's **Security** tab and choose **Report a vulnerability**. Reports go privately to repository maintainers; do not open a public issue, pull request, or discussion containing suspected vulnerabilities or exploit details.

Private vulnerability reporting was enabled on 2026-10-16. Verification checked GitHub's enabled setting and the public reporting entry point. It did not submit a synthetic vulnerability report or verify email delivery to a separate inbox. No response deadline, bug bounty or staffed incident coverage is promised. See [GitHub's reporting instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately).

Include the affected revision, component and mode, expected authorization boundary, sanitized reproduction steps, observed impact, and any mitigation. Use a disposable environment and accounts you control. Do not attach private keys, tokens, cookies, `.env` files, databases, terminal transcripts, user content, or private repository files. A short redacted diagnostic excerpt is preferable to a complete log.

If the reporting form is unavailable, retain sensitive details privately and retry later. A public issue may ask only for help reaching the private channel, without reproduction details, affected private resources or credentials. Routine non-sensitive bugs can use the [issue templates](https://github.com/scasella/ephemeral/issues/new/choose).

## If a credential is exposed

Treat the credential as compromised. Revoke or rotate it through its upstream provider and verify the result there. Stop affected sessions and reconcile any incomplete cleanup. Do not assume deleting a file, removing a public post, signing out locally, or destroying a VM revokes all upstream access. Keep incident evidence in private operator storage and redact it before sharing.
