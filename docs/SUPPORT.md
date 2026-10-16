# Support and security reporting

## Public source project

Ephemeral is an experimental, locally runnable MIT project at [scasella/ephemeral](https://github.com/scasella/ephemeral). Use the [issue templates](https://github.com/scasella/ephemeral/issues/new/choose) for non-sensitive bugs and proposals. Include version, mode, affected feature, expected/observed behavior and a short sanitized error. Review screenshots before attaching them.

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/scasella/ephemeral/security/advisories/new), following [SECURITY](../SECURITY.md). GitHub's enabled setting and the public reporting entry point were checked on 2026-10-16; report submission and email delivery were not tested. Do not post exploit details or secrets publicly.

There is no separate support/security email, guaranteed response time, SLA or staffed incident coverage. A GitHub noreply commit address is not a support inbox. Do not republish a maintainer's personal address as a substitute. Never request or attach `.env`, PEMs, auth caches, browser cookies, raw setup/terminal transcripts or capability receipts.

## Hosted support draft

The following is a proposed operating process, not an activated hosted-service commitment. Before inviting hosted users, configure a private support/deletion channel, verify receipt and reply from an outside account, restrict operator access, and document the working route in application help. Exercise routine support, deletion requests and an urgent cleanup/security report. Confirm owner/account identity without requesting passwords, tokens or device codes. GitHub private source vulnerability reporting does not provide an account-deletion service.

Proposed triage targets are one business day for acknowledgement and immediate operator review of suspected unauthorized access or unresolved billable resources. These are draft targets, not an SLA or a statement that monitoring is staffed. The owner must adopt realistic coverage before activation.

Handle private repository content and deletion requests through the separately configured private hosted channel. Operators may request a narrowly scoped status result there. Do not use public issues as the fallback for sensitive material.

## Urgent session/credential problems

Stop the affected machine through the application, inspect every cleanup outcome and retry unresolved phases. If the only control plane is unavailable, the operator must independently inspect provider resources and upstream credentials, preserve recovery state and reconcile before service resumes. Do not erase the database/key or private cleanup evidence to hide a failure.

Local Codex logout and VM destruction do not establish remote account-token revocation. Tell users what has and has not been verified. Direct upstream account actions through the provider's official interface and record outcomes without copying credentials into support.
