# Retention policy draft

Status: proposed pilot policy, not an activated hosted-service promise. The owner has kept the private contact pending. The product currently has no account/content deletion UI or general scheduled purge. Do not invite hosted users under a promised deletion period until the operator procedure and backup behavior have been implemented and tested.

## Current behavior

| Data | Implemented behavior |
|---|---|
| VM workspace, tmux and VM-local Codex files | Tied to VM lifetime; stop/expiry initiates cleanup. Failure remains visible and retryable. Unpushed work may be lost. |
| Browser terminal buffer | Kept in browser memory while mounted; the service does not record terminal transcripts. Browser preferences may persist locally until cleared. |
| Sessions, labels, notes, inherited notes, setup recipes/output, events and PR records | Persist in the control-plane database after compute ends. There is no general automatic content-deletion period. |
| Browser OAuth/login records | Time-bounded; expired rows are pruned by reconciliation and logout removes the selected login record. This is not account-wide content deletion or upstream OAuth revocation. |
| Upstream GitHub installation tokens | Encrypted while usable or pending reconciliation. Their ciphertext is cleared after confirmed rejection/revocation or expiry; recovery records may remain. |
| Repository intermediaries and backups | Can contain private repository content. Gateway teardown/startup cleanup is separate from host/backup retention. Operators must restrict access and verify cleanup. |

## Proposed operating policy

- Retain ended-session content for at most 30 days, unless the owner requests earlier deletion or explicitly chooses a longer saved-work period.
- Retain private operational/support receipts only as long as needed to verify cleanup, with a proposed 30-day limit after resolution. Never retain raw credentials in public evidence.
- Preserve the minimum credential/resource/reconciliation state necessary for unresolved cleanup until it is safely resolved. Restrict access and disclose any extension rather than silently claiming erasure.
- Keep encrypted backups on a defined rolling schedule, proposed at no more than 30 days. Reapply completed deletion requests after a restore; document when the last recoverable backup ages out.
- Separate control-plane deletion from pushed GitHub work and provider/account records, which follow their own controls. Do not delete GitHub branches/PRs or disconnect upstream accounts implicitly.

These periods are proposals. Approval, a tested operator deletion tool/procedure, backup configuration and a working contact are required before activation. Do not run ad-hoc SQL deletion against active or cleanup-pending sessions.

## Activation test

Use synthetic records to inventory every owned table/file, resolve all test resources, exercise deletion and verify notes/inherited snapshots/output/events/auth records and intermediary files are gone as intended. Restore a test backup and reapply the deletion ledger. Keep a sanitized result proving the procedure; do not claim purge support from this document alone.
