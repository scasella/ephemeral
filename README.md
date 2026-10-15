# Ephemeral

Disposable cloud coding sessions: a fresh microVM, a fresh ChatGPT/Codex sign-in, and tightly scoped GitHub access. Stop or expire the session to destroy its compute and clean up its credentials.

## Release status

Ephemeral is a self-hosted, invite-only pilot. GitHub publication to `scasella/ephemeral` is **pending**, and no project license has been selected. No hosted public service has been deployed. Source remains local; `private: true` prevents accidental npm publication.

The release review repaired cross-generation Preview isolation, enforced the reviewed head/base pair for PR creation, and hardened local database locking and Compose password handling. See [release readiness and remaining gates](docs/RELEASE-READINESS.md), [release notes](CHANGELOG.md), [contributor setup](CONTRIBUTING.md), and [security reporting status](SECURITY.md).

This publication copy uses a fresh history and excludes private live-test reports/screenshots. See [validation scope](docs/VALIDATION.md), [hosting and Sites compatibility](docs/HOSTING.md), [hosted acceptance](docs/HOSTED-ACCEPTANCE.md), and the [retention](docs/RETENTION.md) and [support](docs/SUPPORT.md) drafts. Contact setup and policy activation remain pending.

Compute teardown, local credential removal, and upstream revocation are independent outcomes. Remote ChatGPT/Codex token revocation remains **unverified**. This version must not be advertised as automatically revoking every upstream account credential.

## Run locally

Use Node.js 24 LTS and Git.

```sh
npm ci
npm run local
```

Open http://localhost:4310. `npm run local` explicitly selects the **clearly labeled local simulation**, uses a separate database at `.data/local-preview`, and clears integration credentials from the server's environment. No account, domain, tunnel, Docker service, or paid host is needed. It preserves any live configuration files and data. If port 4310 is occupied, run `npm run local -- --port 4311`.

Simulation uses the real session lifecycle and embedded PostgreSQL, but simulates the VM and cleanup. The terminal does not execute commands or produce real Codex responses, and simulation never creates GitHub PRs. It binds only to loopback. Use `npm run dev` for ordinary source watching; real cloud sessions are a separate opt-in flow below.

```sh
npm run test:ci
npm run build
npm run audit:dependencies
```

For the publication secret check, install the pinned Gitleaks version described in [CONTRIBUTING.md](CONTRIBUTING.md), then run `npm run check:secrets`. It scans full Git history and public candidate files, excludes ignored operational files, and redacts findings. No local credentials are required for simulation, tests, or the build.

## Enable real sessions

For guided first-run setup, use Node 24 and run:

```sh
npm ci
npm run setup
npm run live
```

The guide prepares private configuration, walks through an HTTPS tunnel and your own GitHub App, and offers reuse or an explicitly approved E2B template build. Account sign-in and GitHub permissions remain your choices. See [first-run setup](docs/FIRST-RUN.md) for prerequisites, costs, resume behavior and verification. `npm run local` remains simulation only.

For a real E2B smoke test while the control plane stays on your Mac, follow [local live testing](docs/LOCAL-LIVE.md). It uses a separate production server and an HTTPS tunnel, with no Render resources.

Copy `.env.example` to `.env` and configure:

1. An E2B Hobby account for one-hour sessions, API key, and a custom template containing Node, Git, Python3, tmux, Codex CLI, npm and pnpm. See [E2B setup](docs/E2B.md).
2. A GitHub App with selected-repository access, Contents read/write and Pull requests read/write. Configure its callback as `https://YOUR_HOST/auth/github/callback`. See [GitHub setup](docs/GITHUB.md).
3. App ID, slug, OAuth client ID and client secret, and the app private key (prefer a mounted file).
4. A stable random 32-byte base64 `ENCRYPTION_KEY`. It encrypts GitHub credentials at rest; retain it for retrying revocation after restarts.
5. The numeric GitHub account IDs allowed into the pilot in `ALLOWED_GITHUB_IDS`.
6. An HTTPS `PUBLIC_URL` reachable from E2B. Set `EPHEMERAL_MODE=live` and `SESSION_MAX_HOURS=1` for the selected Hobby setup. Four-hour extensions require an explicitly chosen E2B Pro plan and `SESSION_MAX_HOURS=4`.

For production set `DATABASE_URL` to PostgreSQL. `compose.yaml` supplies a PostgreSQL service and a Node application image; set `POSTGRES_PASSWORD` and place an HTTPS reverse proxy in front of port 4310. The reverse proxy must preserve WebSocket upgrades and the public Host. The app checks the browser Origin against `PUBLIC_URL`. Only one control-plane instance is supported; a database advisory lock prevents accidental concurrent PostgreSQL instances. Persist `.data` and the database.

The [Render deployment guide](docs/DEPLOYMENT.md) and `render.yaml` prepare a singleton Docker deployment with private Postgres. **No Render resources have been created.** Real provisioning, Codex login/model output, scoped Git pushes, draft PR creation, and manual stop passed in the [local live test](docs/VALIDATION.md); that report records the remaining coverage limits. Applying the Blueprint would create paid resources and requires a separate deployment decision.

The image includes Git because repository writes are enforced by a server-side Git gateway. This backend requires a long-running Node process with disk access, a cleanup worker, and WebSockets; it is not a static or edge-worker-only deployment.

## Workflow

Sign in with GitHub, install the app on selected repositories, choose a repository/base branch, and launch. The VM gets a session branch and a browser terminal. Sign in to Codex using its device-code flow; your password is entered on OpenAI's page. Model access uses your eligible ChatGPT/Codex account and its limits. No provider API key is required.

The terminal startup guide separates machine state, current terminal connection, and Codex readiness. Complete a fresh device sign-in and Codex's folder/trust/onboarding prompts before submitting a small task. Never paste credentials into Ephemeral. Once you observe a useful response, click **I received a useful response**. The server records the first confirmation time once; it remains available after reload and session end. **User-confirmed launch-to-confirmation** measures creation through confirmation, including provisioning, sign-in, and waiting. It is not automatic model latency, and this measurement stores no response text. Preview has no real Codex response or timing.

Reconnect attaches to the same VM and tmux shell without restarting Codex or resetting the expiry deadline. If a task is queued, complete visible prompts and allow the current response to finish. **Esc** cancels the current generation. Once Codex is responsive and idle, type `/quit` and press Enter to return to the shell. If needed, **Ctrl+C** can interrupt current work; it may need repeating and does not guarantee exit. Do not kill tmux or launch another Codex while work is still active. Only at a visible shell prompt, run `codex` to restart. If sign-in expired, run `codex login --device-auth` at the shell, complete a fresh sign-in, then run `codex`. See [OpenAI's device sign-in instructions](https://learn.chatgpt.com/docs/auth).

The selected running machine's browser terminal stays attached when switching detail tabs or visiting Repositories and Integrations. Its current buffer, selection, and Find state stay in memory; hidden terminals accept no input. **Focus mode** expands the same terminal while keeping connection, repository, branch, and expiry visible. Font decrease/increase/reset controls use a local browser preference. **Find** searches the current browser buffer, with previous/next results and explicit no-match feedback; tmux history is not searched. Ctrl/Cmd+F inside the terminal opens Find. Escape from the shell still reaches Codex; Escape on toolbar/search controls closes Find first, then focus mode. Reloading, selecting a different machine, or ending the session disposes browser terminal state; tmux remains subject to the session lifetime.

**Session history** shows full repositories, creation dates, and state. Search task names, repository names, IDs, and branches, or filter by repository and state. Filtering never changes the selected machine; an explicit notice identifies a selected machine outside the results. Give a running or ended machine an optional task name in **Settings**; names are saved to your account's session and survive cleanup. Saving an empty name restores its generated name. Machine, tab, and workspace-view URLs support bookmarks, reload, and browser Back/Forward; unavailable links show an explicit notice. The [terminal and history test report](docs/VALIDATION.md) records real local session checks and cleanup.

**Expiry reminders** appear across Machines, Repositories, and Integrations for your running machine at ten minutes and two minutes remaining, even when another machine is selected. **Review save commands** opens that machine's Terminal view and focuses its save guidance. A late arrival shows only the most urgent warning. The reminder deadline is the earlier of the session and maximum expiry; reconnects and navigation never reset it.

Use **Reminders** in the top bar to reach optional desktop-notification settings. Browser permission is requested only after an explicit enable action; preferences are scoped to this account and mode on the current browser origin. Supported browsers coordinate across tabs and retain bounded delivery receipts through reload, so each threshold alerts at most once for a given absolute deadline. An explicit extension starts a new deadline cycle. Stopped sessions, logout, stale snapshots, and denied or unavailable browser capabilities suppress desktop delivery. A permission request that never resolves times out after sixty seconds; late approval does not silently enable alerts. Local simulation sends no desktop notifications.

Desktop delivery is best effort while the app is open. Background suspension, closed tabs, browser/OS permissions, and notification settings can prevent alerts; reminders never save work or extend compute. In-app warnings remain available when desktop delivery cannot be used. See the [expiry-reminder verification report](docs/VALIDATION.md).

The workspace uses larger interface text, wrapping controls, and labeled navigation at narrow widths. **Go to machine details** jumps directly to the selected detail tab. Keyboard skip links reach main content, selected details, and active work; detail tabs support arrows, Home, and End. Canceling a dialog or pressing Escape restores its opener when still available.

**Session history** and **Save your work** collapse by default when a machine is selected. Their summaries retain selected identity, filters, unsaved counts, and uncertainty warnings; expanding restores mounted controls and inspection state. Disclosure choices stay in memory for the account and machine. The save-guidance link opens the relevant disclosures automatically. While browsing another machine, Repositories, or Integrations, **Return to active work** shows the observed machine and original deadline, checks current status, and opens that exact machine. Failed checks keep the current view and label the last known state. Navigation never extends compute. See [readability and keyboard verification](docs/VALIDATION.md).

Use **+ Open shell** in Terminal to open one named bash shell alongside the protected **Codex** terminal. Run tests or a development server there while Codex stays available. Both shells share the same repository, session access, VM, and expiration; opening or reconnecting a shell does not extend the session. Shell tabs keep independent browser buffers and connections across detail tabs and workspace navigation. Names and shell identities are saved; reload attaches to the existing tmux session without executing a new command. Preview simulates these controls and executes no commands.

**Close shell** requires confirmation and stops ordinary commands and jobs belonging to the supplemental shell, while preserving Codex. Typing `exit` also releases its slot after the next saved-shell refresh. A replacement gets a new identity; retrying an old request cannot recreate a closed shell. If creation or closure is uncertain, **Refresh saved shells** observes its existing state; explicitly retry closure before opening another. Commands that deliberately daemonize or escape their process groups may survive shell closure until the VM ends. The [second-shell test report](docs/VALIDATION.md) records the live server, navigation, reconnect, replacement, reload, and cleanup checks.

Use **Changes** to review current uncommitted files without entering Git commands. The list identifies staged, unstaged, untracked, renamed, and deleted files. Select a file to view its combined staged-and-unstaged text diff against HEAD, or an untracked text preview. Committed changes are not shown. Ignored files and submodule contents are excluded; submodule pointer changes have no content preview. Inspection shows its check time and HEAD, lists at most 200 files, and previews text at most 64 KiB. Binary/non-UTF-8, oversized, symlink, conflict, and safely unreadable files show an explicit explanation.

**Refresh changes** checks again; terminal edits are not automatically reflected. An old observation is labeled, and failed refreshes hide prior file content. A selected file removed from the refreshed list clears its preview. Review does not stage, edit, fetch, commit, or push, and file content is not saved in the database. Preview and ended machines cannot inspect files. The bookmarked Changes tab supports reload and keyboard navigation. See the [change-review test report](docs/VALIDATION.md) and [current quality-of-life priorities](docs/ROADMAP.md).

The workspace status panel inspects dirty and untracked files, local commits ahead of the assigned branch, and the currently observed remote commit. A failed inspection is shown as unknown. Remote observation time is not a push timestamp or a backup guarantee.

Use **Preview** to open a running application privately. Start its server yourself in the supplemental shell, listening on `127.0.0.1` or `0.0.0.0`, then enable its port (1024–49151). **Prepare private preview**, followed by **Open private preview**, opens an isolated browser origin with access lasting at most ten minutes. Preparing or opening never starts commands, resumes a VM, or extends its deadline. Replacing or closing access revokes existing viewers and their WebSockets while leaving the app and Codex running. Session stop, expiry, and signing out of the originating browser login also revoke access.

**Check application** explicitly sends a bounded `HEAD /` request to the saved port. It reports the port, check time, observed HTTP status, or a connection refusal/timeout with suggested next steps. HTTP errors count as responses; a response does not prove the page is healthy, viewer sign-in works, or HMR works. Results become stale after one minute and are cleared when access is refreshed, replaced, closed, or its port is edited. Checks run no terminal commands, start no server, mint no viewer grant, and persist no application content. Older running machines without the diagnostic gateway can continue using ordinary preview access; diagnostics require a fresh machine.

A pinned [React/Vite fixture](scripts/fixtures/preview-vite/README.md) supports a repeatable edit-to-browser HMR test. Keep the development server on the saved port with `strictPort: true`; its WebSocket must use the isolated viewer origin. Do not disable Vite's host/WebSocket checks or expose a sandbox port publicly. See [readiness and HMR verification](docs/VALIDATION.md).

The operator configures a separate **base DNS origin** such as `https://preview.example.net`. Each access generation receives its own `<generation>.preview.example.net` hostname and host-only cookie; an old document cannot acquire access to a new generation. Hosted Preview requires wildcard DNS, wildcard TLS, and proxy routing that preserves Host and WebSocket upgrades. The base hostname serves no application. A single fixed viewer hostname or IP address is no longer supported. See [current configuration and migration](docs/RELEASE.md#private-preview-migration); the [original verification report](docs/VALIDATION.md) records historical behavior.

Local testing uses a `localhost` base, generation-specific `.localhost` hostnames, a control plane outside that namespace, and explicit `PREVIEW_LOCAL_ONLY=1`; it creates no Render resources. The pilot supports relative assets, ordinary HTTP requests, and WebSockets. Application cookies, service workers, SSE/long streaming, responses over 8 MiB, and external redirects are unsupported. E2B and account credentials stay outside the application request. Local simulation and ended machines cannot execute a preview.

Use the machine's **Setup** tab to save a named shell command with a 5–600 second timeout, then click **Run saved recipe**. Recipes are scoped to your account and repository and can be reused on fresh machines. Saving, launching, reloading, and reconnecting never execute setup automatically. Save changes before running; every run captures the exact saved recipe version. Setup runs independently of Codex sign-in in the repository workspace and may change files. Keep credentials out of recipes and output: the command and bounded output are retained in the database.

The Setup tab shows the latest run's recorded command, status, exit code, timestamps, errors, and output truncation. It polls active runs while visible and offers cancellation; leaving the tab does not cancel a run. Ended machines retain their saved result without execution. If a request fails or times out, use **Check saved setup** to confirm its outcome before another action. Interrupted or uncertain runs may block another run until the previous process's bounded deadline. Timeout and cancellation stop the ordinary process group; they are not a security boundary against commands that deliberately escape it. Preview runs are labeled simulations and execute no commands.

Commit and push work intentionally from the terminal, then use **Published** to review the pushed contribution against the selected PR base. The view shows exact head, base, and merge-base commits, ahead/behind counts, and a commit-pinned GitHub comparison link. Select a file for its bounded patch; the list displays at most 200 files and each patch at most 64 KiB. Omitted, partial, and oversized patches are labeled. Dirty files and local-only commits are excluded. Reads use your current GitHub access and remain available after the machine ends, without starting a VM or minting a session token. File contents are not persisted. **Refresh review** gets a new comparison; failed reads or observations older than one minute hide patches and require another check. See [published-review verification](docs/VALIDATION.md).

**Create pull request** includes the same published comparison. Creation checks both reviewed head and base again and rejects either branch changing, while keeping the draft title and description. GitHub's branch-based PR creation is not atomic with these checks: if its returned snapshot differs, the app records the actual PR and asks you to review it on GitHub. It creates a draft PR only when the published branch has changes against the base, and reuses an existing open PR on retry. Saved PR links and the GitHub response's head/base snapshot remain available after stop and server restart; later pushes can change the PR's current head. The gateway permits pushes only to the assigned session branch and exposes no merge API. Actual GitHub installation tokens never enter the VM. Browser disconnects leave the VM running.

After an ended or failed machine completes cleanup, use **Continue saved work** to review its source branch, published GitHub commit, and original PR target base. Only pushed commits can be restored; uncommitted files, unpushed commits, terminal history, and Codex conversations are unavailable. A ready, current review launches a fresh VM on a new session branch at that exact commit, with a fresh Codex sign-in. The original pull request is not updated and no new PR is created automatically. Saved setup recipes remain available and run only when explicitly requested. Preview cannot verify real published work and disables continuation.

The server verifies the source and commit again on confirmation. Missing or deleted branches, unavailable repository access, incomplete cleanup, and uncertain verification block launch; a changed head requires a fresh review. Only one active machine is allowed. If a continuation request times out or loses its response, check the machine list or use **Check or retry saved request**. The browser retains the reviewed commit and request ID for the same tab across reload, and a retry recovers the same machine instead of creating another. It clears the request only after a confirmed machine response or a durable server rejection proving that request cannot create a machine; then a fresh review can start another request. Saved lineage and source-machine links remain visible after reload; the review also lists machines already continued from that source.

The [continuation test report](docs/VALIDATION.md) records the real two-session save-and-restore chain, unchanged source PR, and independently verified cleanup.

Use **Notes** to save a private next step, unresolved issues, and verification note (2,000 characters each). Notes remain available after stop and control-plane restart. Saves include a revision and timestamp; conflicting edits from another tab preserve your draft and require checking or reloading the saved note. Unsaved drafts stay in memory across detail tabs and workspace views for the selected machine, but are not durable across reload or machine selection. Keep credentials out of notes.

**Continue saved work** reviews the saved note and atomically captures its exact revision for the new machine. Later source edits cannot change this inherited copy. The new machine has its own empty note; **Copy text** and **Use inherited as draft** are explicit actions. Notes are plain user-written context, not verified results, and are never automatically sent to Codex, executed, or written into the repository. See the [handoff-note verification report](docs/VALIDATION.md).

Sessions start with one hour. The default `SESSION_MAX_HOURS=1` matches E2B Hobby and disables extensions. With E2B Pro and `SESSION_MAX_HOURS=4`, running sessions can be extended in 30-minute steps to four hours from creation. Stop refreshes workspace status and requires a discard acknowledgement when work is at risk or status is unknown; expiry still ends the session without waiting for inspection. No snapshots or automatic commits are created. The terminal reconnects to a persistent tmux session.

The [workspace status and PR handoff test report](docs/VALIDATION.md) records the real E2B checks, draft PR creation, confirmed cleanup, and retained PR link after a control-plane restart.

The [startup and terminal recovery test report](docs/VALIDATION.md) records a fresh Codex sign-in, a confirmed useful response, the retained startup measurement, and recovery of the same VM and tmux session across reconnect and control-plane restart.

The [repository setup test report](docs/VALIDATION.md) records real dependency installation, recipe reuse in a fresh VM, failure output, timeout, cancellation, crash recovery, and verified cleanup of both test VMs.

## Cleanup semantics

The control plane records VM, GitHub, gateway, and Codex cleanup separately. Gateway access is disabled first. Every issued GitHub token is tracked for revocation. Codex logout removes local credentials; its remote account-token revocation is **unverified**, never represented as confirmed. VM destruction removes the remaining local credential files. Failures remain visible and retry through reconciliation; a request to clean up is not itself proof of cleanup.

An expired or stopped session may lose its disk before Codex logout can run. This is recorded honestly. The service does not promise that copied or exfiltrated ChatGPT credentials are invalidated by VM destruction. Do not describe this version as revoking all upstream provider credentials.

Operator credentials live only in the control plane. GitHub OAuth access tokens are encrypted and used to verify each developer's repository access. Browser logins expire within eight hours; reconnecting may require GitHub sign-in again. Logging out of Ephemeral does not implicitly destroy a running VM.

## Operational limits

- This is an invite-only pilot implementation, not a security-audited public multi-tenant service.
- The documented local live test passed provisioning, account sign-in/model output, Git handoff, and manual stop. Full one-hour expiry, fault injection, independent upstream GitHub-token replay, and remote OpenAI authorization revocation remain outside that test's evidence.
- Keep an operator spend limit on E2B. Per-user concurrency is one; the invite list determines maximum fleet size.
- Back up the database and encryption key together. Losing either can prevent retrying GitHub revocation; GitHub installation tokens still have upstream expiry.
- Git intermediaries can contain repository data. Restrict host disk access and follow the gateway retention guidance.
- Terminal I/O is relayed without recording a transcript. Session metadata, lifecycle events, PR links, setup recipes, and bounded setup output persist in PostgreSQL. Browser terminal state is transient.

See [architecture and review notes](docs/ARCHITECTURE.md) for the trust boundaries and failure model.
