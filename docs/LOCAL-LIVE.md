# Test real E2B from the local app

This path runs the control plane on your Mac and reaches it through an HTTPS tunnel. It creates **no Render service or database**. A real E2B template/sandbox and GitHub App are still required; provider usage and the user's Codex account limits apply. Preparation is not evidence that the live test passed.

Historical local integration results are summarized in [validation](VALIDATION.md). Run the acceptance checks again against your own dedicated fixture; historical results do not establish a new deployment.

The local preview can keep running on port 4310. Run a separate, built production application on **127.0.0.1:4311**, with **`.env.live`** and **`.data/local-live`**. Use only a dedicated private fixture repository such as **`example-owner/ephemeral-smoke`** for the initial GitHub App installation and test changes.

## 1. Build and isolate configuration

From the repository root, use Node 24 and installed Git:

```sh
npm run build
```

Production serves the generated `dist` files. Do not use `npm run dev` for the public tunnel: it starts Vite development middleware. `NODE_ENV=production` selects static serving and prevents local preview from being published accidentally.

Create a private live configuration once. This command writes a random 32-byte base64 encryption key directly into the ignored file without printing it; `flag: 'wx'` refuses to overwrite an existing file. If `.env.live` already exists, retain it and edit it privately instead.

```sh
node --input-type=module - <<'JS'
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
mkdirSync('.data/local-live', { recursive: true, mode: 0o700 });
const configuration = [
  'NODE_ENV=production',
  'EPHEMERAL_MODE=live',
  'HOST=127.0.0.1',
  'PORT=4311',
  'DATA_DIR=.data/local-live',
  'DATABASE_URL=',
  'SESSION_MAX_HOURS=1',
  'PUBLIC_URL=',
  'E2B_API_KEY=',
  'E2B_TEMPLATE_ID=',
  'GITHUB_APP_ID=',
  'GITHUB_APP_SLUG=',
  'GITHUB_CLIENT_ID=',
  'GITHUB_CLIENT_SECRET=',
  'GITHUB_APP_PRIVATE_KEY=',
  'GITHUB_APP_PRIVATE_KEY_FILE=',
  'ALLOWED_GITHUB_IDS=',
  `ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,
].join('\n') + '\n';
writeFileSync('.env.live', configuration, { flag: 'wx', mode: 0o600 });
JS
chmod 600 .env.live
chmod 700 .data/local-live
```

Use a private local editor to fill required values. Do not enter secrets in shell commands, exports, chat messages, logs, or command history. Do not dump `.env.live`, environment variables, private PEMs, OAuth grants, credential-helper output, or Codex auth files. Keep `ENCRYPTION_KEY` stable across restarts. The existing `.gitignore` excludes `.env.*`, `.data/`, and PEM files; verify the live file remains ignored with `git check-ignore .env.live`.

Set `DATABASE_URL=` explicitly. The server imports `.env` as supplemental configuration after Node loads `.env.live`; it does not overwrite existing variables, but any omitted value can still be inherited from `.env`. An explicit empty database URL selects embedded PostgreSQL/PGlite, so no external PostgreSQL service is required. Its actual live database directory is `.data/local-live/live/postgres`; this differs from preview's directory. A file lock enforces one process using that database.

Fill every relevant setting in `.env.live`. If using the PEM file setting, keep `GITHUB_APP_PRIVATE_KEY=` explicitly empty and set `GITHUB_APP_PRIVATE_KEY_FILE` to its absolute private path. Existing exported shell variables also take precedence over Node's environment file; clear conflicting exports by name before starting, without printing their values. Do not reuse the preview data directory or allow two control planes to operate this live database.

## 2. Start a reachable HTTPS tunnel

Install a supported ngrok agent and configure its account authtoken privately; installation alone does not establish authentication. If authentication is missing, add the credential through a private configuration editor with restricted file permissions, rather than placing it in a command argument.

In a separate terminal, start the tunnel:

```sh
ngrok http http://127.0.0.1:4311 --inspect=false --log=false
```

These flags disable agent HTTP inspection and agent log output. Do not enable request capture/replay or payload logging: OAuth redirects, browser cookies, and Git Authorization headers are sensitive. The [ngrok CLI reference](https://ngrok.com/docs/gateway/agent/cli) documents the HTTP forwarding and inspection options.

Record the assigned **HTTPS origin**, such as `https://your-assigned-name.ngrok-free.app`, in `.env.live` as `PUBLIC_URL`. Use the actual URL, with no path or query and no local address. Keep this endpoint unchanged throughout a session. The app and VM use this origin for OAuth callbacks, browser Origin checks, WebSockets, and the Git gateway.

Do not put ngrok Basic Auth or a second interactive OAuth gate in front of the gateway: the VM's Git client authenticates using the application's own scoped capability. Preserve normal HTTP forwarding, WebSocket upgrades, Origin, and cookies. No Host rewrite or `trust proxy` change is required by the current code: secure cookies are configured from the explicit HTTPS `PUBLIC_URL`, and redirects use that configured origin.

Open the app through its **public HTTPS tunnel URL** for all browser actions. Opening the live UI through `http://127.0.0.1:4311` causes mismatched WebSocket Origins and secure-cookie domains. Local HTTP remains suitable for a non-authenticated health check.

ngrok Free can show a browser warning before HTML pages; click through once on the assigned domain. Its [Free-plan documentation](https://ngrok.com/docs/pricing-limits/free-plan-limits) says programmatic API access is unaffected. Verify real VM Git traffic still reaches the gateway. If you receive an HTML interstitial instead of a Git smart-HTTP response, resolve tunnel behavior before claiming a clone or push passed.

## 3. Configure GitHub and E2B

Set the GitHub App's user authorization callback to exactly:

```text
https://YOUR_ACTUAL_TUNNEL_HOST/auth/github/callback
```

Use a private App with Contents read/write and Pull requests read/write, installed on **selected repositories → `example-owner/ephemeral-smoke` only**. For a new App, use the helper below to persist its App ID/slug, OAuth client ID/secret, and private PEM file path directly into `.env.live`. If reusing an existing App, configure those values privately instead. Set `ALLOWED_GITHUB_IDS` to the operator's numeric GitHub ID. GitHub usernames are not stable authorization identities.

For a fresh App, invoke the registration helper with the explicit live-file target:

```sh
npm run github:register -- --public-url https://ACTUALHOST --owner-id 123456 --env-file .env.live
```

Replace `ACTUALHOST` with the actual assigned public tunnel hostname, and use the intended numeric owner ID (the numeric value is a synthetic example). Review the account and requested permissions in the helper's local browser form, then create the App and separately install it on the smoke fixture only. The helper persists credentials privately into `.env.live`, keeps PEM/recovery files under ignored `.data/github-registration`, and leaves preview's `.env` unchanged. Its regression suite covers the isolated target and registration protections. It refuses existing GitHub credentials or a different configured `PUBLIC_URL`; do not rerun it for an already registered App or bypass those protections. The helper's one-use registration callback is a separate loopback callback; the App's user authorization callback remains the public tunnel URL above.

Supply the E2B API key privately in `.env.live`. If the custom template is already built, reuse its verified ID; never use a logged-in user's environment as the template. If a new build is required, the following uses the pinned template recipe and consumes provider resources:

```sh
node --env-file=.env.live --import tsx sandbox/build-template.ts
```

Save the resulting template ID in `.env.live`. Then run the read-only account/template preflight against the correct file:

```sh
node --env-file=.env.live --import tsx scripts/e2b-preflight.ts .env.live
```

A passing preflight verifies configured account/template access; it does not create a sandbox or prove the tunnel can be reached from one. Keep `SESSION_MAX_HOURS=1` for E2B Hobby. No extension beyond one hour is allowed. Provider defaults determine the template allocation; inspect preflight/provider metadata rather than assuming a particular memory size. See [E2B runtime details](E2B.md).

## 4. Start the separate production server

With the tunnel running and all `.env.live` values filled, start the server from the repository root:

```sh
node --env-file=.env.live --import tsx server/index.ts
```

Expect startup to identify **live** mode at the public HTTPS origin. A missing credential must fail startup; it must not silently expose preview. The process listens only on **127.0.0.1:4311**. Keep the Mac awake, the server running, and the tunnel connected during the test.

Check local health without sending credentials:

```sh
curl --fail --silent --show-error http://127.0.0.1:4311/healthz
```

Expect `{"status":"ok","mode":"live"}`. Request the same `/healthz` path through the public HTTPS URL; expect the same response. Open the public origin in a browser and confirm GitHub sign-in, no preview label, and a one-hour maximum. Confirm the public page loads compiled JavaScript from `/assets/…`, without `/@vite/client` or source module paths. An unauthenticated health response proves reachability and live startup, not successful GitHub or E2B integration.

## 5. Complete the actual live test

Record session ID, template ID, timestamps, actual upstream commit, pull request URL, and redacted cleanup outcomes. Keep credentials and Codex device codes out of recorded evidence.

1. Sign in with the allowlisted GitHub identity. Confirm `example-owner/ephemeral-smoke` appears and unrelated repositories do not.
2. Launch from the intended base branch. Observe provisioning then running and a matching real E2B sandbox. The work branch must be unique, the countdown must start at about one hour, and the extension button must be absent.
3. Complete **fresh Codex device authentication in that VM** with the user's account. The app does not reuse the Mac's Codex credentials or another session's auth. Verify Codex starts. Create a scratch marker, disconnect/reconnect the browser terminal, and verify the same tmux session and marker remain.
4. Make a harmless smoke change and intentionally `git add`, `git commit`, and `git push -u origin HEAD`. Verify the actual GitHub session branch contains the commit. Attempt an update to a different disposable branch or tag and verify rejection with no upstream update. Do not merge the smoke branch into the repository's base branch.
5. Create a draft pull request from the UI. Verify its real GitHub URL, selected base, unique session head, and committed diff. The UI action must not automatically commit or push work.
6. Stop through the unpushed-work-loss confirmation. Watch the independent gateway, GitHub, local Codex, and VM cleanup outcomes. Confirm the E2B resource is absent. Credential-rejection checks require a private, credential-aware harness that reports statuses without printing captured secrets. Codex **remote** revocation remains explicitly **unverified**.
7. For automatic-expiry acceptance, launch another clean machine and let the full one-hour lifetime elapse while the control plane remains online. Verify the ten-minute and two-minute warnings, automatic cleanup, and provider absence. Do not manipulate SQL timestamps as a substitute for a real expiry test.

Run recovery and fault-injection checks from the [full acceptance checklist](DEPLOYMENT.md#live-end-to-end-acceptance) when needed; they can use this local control plane and tunnel without Render. Keep the resulting status explicit: checks not executed remain unverified.

## Scripted Git smoke and cleanup checks

`scripts/live-smoke.ts` reads `.env.live` as data without sourcing it into a shell. It prints redacted pass/fail checks and suppresses raw SDK output, authentication files, capabilities, HTTP headers/bodies, and device codes. Never add shell tracing or print its private receipt.

First run its local protocol self-test:

```sh
node --import tsx scripts/live-smoke.ts --self-test
```

This checks fixture/URL gates, a real local Git pre-receive rejection, and rejection-response validation without E2B, GitHub, or network operations. It is not a substitute for the live run.

While the selected sandbox is running, replace `SESSION_UUID` and `SANDBOX_ID` with its actual IDs and run:

```sh
node --import tsx scripts/live-smoke.ts --env-file .env.live --fixture YOUR_OWNER/YOUR_DISPOSABLE_REPO --session-id SESSION_UUID --sandbox-id SANDBOX_ID
```

The live mode requires an explicit `--fixture OWNER/REPO` and checks the exact repository in provider metadata and cleanup receipts. The name shown here is a synthetic example; supply your own disposable fixture. It verifies provider metadata, the expected assigned branch and gateway remote, installed runtime tools, and a clean worktree. It refuses to commit unrelated user changes. It then creates a harmless fixture file, commits only that file, and actually pushes to the assigned session branch. Its negative probes test main, an unassigned branch, and assigned-branch deletion. The main probe carries main's existing commit rather than a modified commit, and verifies main remains unchanged. Successful Git checks do not prove Codex model execution or browser reconnect.

Before those writes, the script captures the former scoped gateway capability into **`.data/live-smoke/SESSION_UUID.json`**, an ignored **mode-0600 secret receipt** inside a private directory. The capability is never printed. Keep this receipt private and intact until cleanup verification; it is not a report to upload, paste, or commit.

After stopping the machine through the UI and waiting for its cleanup status, leave the server/tunnel online and run:

```sh
node --import tsx scripts/live-smoke.ts --env-file .env.live --fixture YOUR_OWNER/YOUR_DISPOSABLE_REPO --session-id SESSION_UUID --sandbox-id SANDBOX_ID --verify-cleanup
```

This mode performs no sandbox creation/resume/destruction or Git writes. It reads the matching private receipt, requests Git discovery with the former gateway credential, requires the exact application gateway JSON error with HTTP 401/403, and checks that E2B reports the VM not found. A proxy/tunnel denial, unrelated JSON error, generic network error, dead tunnel, or timeout is not successful credential rejection or provider-absence confirmation. The receipt must match the same session, sandbox, fixture, and public origin.

**Coverage limit:** `--verify-cleanup` independently tests old gateway rejection and VM absence. It does not independently replay upstream GitHub installation tokens, verify local Codex logout, or prove Codex remote authorization revocation. Review the application's separate GitHub/Codex cleanup states, preserve unresolved cleanup, and continue to label Codex remote revocation unverified. Remove the private receipt only after its evidence is no longer needed and required cleanup has completed; never discard it to hide a failure.

## Finish safely

Stop the test machine and resolve pending cleanup **before** shutting down the local server or tunnel. Check provider absence and individual cleanup statuses; merely closing the browser does not stop compute. Exit the server gracefully with Ctrl-C, then stop ngrok. Preserve `.env.live`, its encryption key, and `.data/local-live` privately for any pending revocation/recovery. Do not delete them to hide a cleanup failure.

Server shutdown deliberately preserves active VMs. If the Mac sleeps, crashes, or the server exits while a sandbox runs, the provider's timeout still bounds compute, but persisted gateway/GitHub cleanup may need the same control plane restarted. A changed tunnel URL breaks the old VM's configured Git remote; stop/reconcile outstanding sessions before rotating the public origin, then update both `.env.live` and the GitHub callback together.

This route does not use Docker or create Render resources. It does expose the production control plane through a third-party tunnel for the duration of the authorized test. Restrict the App installation and numeric allowlist to the smoke test, retain no request payload traces, and report the actual live result separately from local unit-test results.

## Private application previews

The local production control plane can use an isolated loopback viewer without paid hosting. Add these non-secret settings to the private `.env.live`, rebuild, and restart:

```dotenv
PREVIEW_PUBLIC_URL=http://localhost:4312
PREVIEW_PORT=4312
PREVIEW_HOST=127.0.0.1
PREVIEW_LOCAL_ONLY=1
```

Keep the existing HTTPS control-plane `PUBLIC_URL` outside the `localhost` namespace. This is the viewer's base origin: each access generation opens a different `<uuid>.localhost:4312` host with its own cookie. The base hostname serves no application. The loopback viewer works only on this Mac; it is not a public preview link. Hosted use requires a separate base DNS origin, wildcard DNS/TLS, and proxy routing preserving each generated Host and WebSocket upgrades. Do not expose the loopback configuration through a tunnel. Leaving `PREVIEW_PUBLIC_URL` empty disables browser previews. See [release migration](RELEASE.md#private-preview-migration).

Launch a fresh session, open a supplemental shell, and start your application. In **Preview**, enable its port, prepare an opening, then open the private viewer. Older VMs created before the protected gateway was installed cannot serve previews. See the [verified private-preview run](VALIDATION.md) for results and compatibility limits.
