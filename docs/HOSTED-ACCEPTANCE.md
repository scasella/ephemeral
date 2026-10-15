# Hosted pilot acceptance

Status: prepared procedure; not yet passed on a hosted deployment. Use a dedicated disposable repository/account/session. Preserve private recovery evidence until cleanup is confirmed. Do not post credentials, private repository data, DNS-account details or raw terminal transcripts in public results.

## Evidence record

Record the exact application commit and container digest, host configuration revision, account/fixture scope, start/end times and a pass/fail result for each check below in a private receipt. Keep raw resource identifiers and token receipts outside source control. A public summary can report outcomes and limits without those identifiers.

| Gate | Procedure and required observation |
|---|---|
| Control-plane TLS and identity | Verify the real HTTPS origin/certificate, OAuth callback, secure cookies, allowlist and owner checks. Unauthenticated private APIs must reject access. |
| Wildcard DNS/TLS | Resolve at least two distinct random generation hostnames under the viewer base; verify certificates cover both, route to the dedicated viewer and preserve their Host. An apex certificate alone does not cover the wildcard. |
| Base/unknown viewer denial | The viewer base and an unknown generation hostname must serve no application. Distinguish the expected application denial from a proxy login/error page. |
| Fresh viewer access | A native one-use opening reaches the selected app only for the owning browser/session. Wrong-host/replayed openings fail without consuming another host's valid opening. |
| Retained document isolation | Keep an old viewer document loaded. Replace access and open a fresh generation. The old document must receive the application access denial while the new one works; repeat for a fresh machine. |
| Framework HMR | Run the checked-in React/Vite fixture in the supplemental shell; change its heading and observe a genuine hot update with counter/input/document state preserved. Verify WebSocket upgrades through the actual HTTPS proxy. |
| Full-duration expiry | Run a real one-hour Hobby session to its original deadline. Check cross-view reminders and server expiry without extending it. Verify cleanup phases independently; do not shorten database timestamps and call that a full-duration run. |
| Interrupted provisioning | In a disposable run, interrupt the control plane around external creation/identity persistence. Restart once and verify discovery, no duplicate running VM, blocked new work while cleanup is uncertain, and eventual provider absence. |
| Interrupted cleanup | Interrupt after gateway disable and before all external teardown is confirmed. Restart and verify retry state, continued gateway denial and independent completion of the remaining phases. |
| Former gateway token | Require the exact gateway application JSON rejection and HTTP 401/403. A dead host, proxy denial or timeout does not prove revocation. |
| Former GitHub token | Capture a dedicated installation token privately before stop. Confirm a read-only repository request succeeds while valid. After cleanup, replay that same token privately and require GitHub's authentication rejection. Check elapsed expiry so natural expiry is not misrepresented as active revocation. Never expose token values in a receipt. |
| Provider absence | Query the provider independently after expiry/cleanup and require the tested VM to be absent. A UI ended label is insufficient. |
| Retention/support activation | Adopt [retention](RETENTION.md), implement/verify its purge and backup procedure, publish a tested private contact and exercise [support](SUPPORT.md). Draft text alone does not pass this gate. |

## Codex limitation

Keep remote Codex revocation marked unverified. Its status cannot be cleared by the checks above. See [the authentication gap](HOSTING.md#upstream-chatgptcodex-revocation). A future supported revocation implementation needs its own before/after credential-validity evidence in a dedicated user-approved session.

## Stop conditions

Stop inviting users when authorization, credential rejection, provider absence or retry recovery is uncertain. Preserve the database/encryption key and scoped private receipts. Resolve cleanup before deleting records or shutting down the only reconciler. Record failures as failures; do not bypass TLS, allowlisting, origin isolation or independent cleanup checks to complete the checklist.
