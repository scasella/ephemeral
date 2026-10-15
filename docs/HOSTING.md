# Hosting assessment

## Can this application run on Sites?

An informational page can run on Sites. The complete application cannot run there unchanged. The installed Sites runtime contract uses Cloudflare Workers, 128 MB isolates, HTTP-based external connections, and D1/R2 storage. Its native custom-domain surface registers individual hostnames; it does not establish support for this application's wildcard private-viewer ingress.

| Application requirement | Current implementation | Consequence for Sites |
|---|---|---|
| Git policy gateway | Local Git child processes, Unix sockets, hooks and temporary bare repositories | Requires a separate Git-capable backend or a new architecture. |
| Durable control-plane data | PostgreSQL queries and a connection-held singleton advisory lock; PGlite locally | D1 is not a drop-in PostgreSQL/locking replacement. |
| Repository intermediaries | Persistent disk ownership/permissions and explicit cleanup | Worker temporary files are request-local and lack POSIX ownership/permission behavior. |
| Lifecycle cleanup | A continuously running reconciliation loop and durable retry state | Must be redesigned around supported durable scheduling/coordination before moving. |
| Browser terminals/viewers | Authenticated relays and per-generation viewer hostnames | Needs an explicitly tested origin, WebSocket and wildcard-routing design. |

This is an inference from the inspected source and runtime contract, not a failed deployment. No Site, domain or hosting resource was created. General Workers Node compatibility does not supply a local Git executable or the persistent disk semantics this implementation uses. See [Workers Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) and [Workers filesystem behavior](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/).

The smallest deployment change is to keep the frontend and control plane together on the tested container architecture, with PostgreSQL and a separate wildcard viewer ingress. Sites can later host an optional information page linking to that service. A Sites-hosted authenticated frontend with an external API is also possible in principle, but requires cross-origin authentication, OAuth, CSRF and WebSocket changes; it is not a static-upload shortcut.

Sites visitor sign-in is not evidence that a VM has Codex credentials or that a GitHub repository is authorized. Keep those authorizations separate. Do not put a workspace-wide private-Site bypass credential into an untrusted VM to make the Git gateway reachable.

## What this does and does not unblock

Source sanitization, local tests, policy drafts and the hosted acceptance procedure can be prepared without a paid host. Real DNS/TLS and host lifecycle checks need a selected deployment and namespace. A successful Sites information page would not satisfy those checks. Keep Preview disabled if its wildcard ingress is unavailable; do not restore a shared viewer hostname.

## Upstream ChatGPT/Codex revocation

The current flow signs in to the Codex CLI inside each VM. Official [Codex authentication guidance](https://learn.chatgpt.com/docs/auth) describes `codex logout` as clearing stored credentials. Local clearing and VM destruction do not prove upstream rejection of copied credentials, so the current unverified status remains correct.

OpenAI separately documents an application-owned renewable-session [revocation flow](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions): use the session's issued client ID and refresh token with the discovery-advertised revocation endpoint, retaining uncertainty on network failure. That is not proof that the same flow has been implemented or validated for this VM-local CLI integration. Do not reuse a different OAuth client's credentials or infer implementation-specific revocation from an unrelated sign-out result.

Closing this gap requires a supported authentication integration, reviewed credential ownership, bounded revocation/retry behavior and a dedicated disposable-session rejection test. A revocation endpoint returning success for an already-invalid token alone is not evidence that a previously valid credential was invalidated. Preserve honest UI language until that work is complete.
