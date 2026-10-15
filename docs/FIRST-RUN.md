# First run: real E2B sessions from your computer

This setup runs the control plane on your own computer and coding sessions in your E2B account. It needs no hosted application service or domain purchase. It is separate from `npm run local`, which always runs simulation. GitHub publication and licensing of this project remain pending.

## Start the guide

Use Node.js **24 LTS**, npm, Git, OpenSSL and Bash on macOS or Linux. Windows users need a Linux environment such as WSL2; the Git gateway uses Unix sockets and process groups. Install the locked dependencies, then start the guide from the project root:

```sh
npm ci
npm run setup
```

The guide walks through these steps:

1. Check prerequisites and prepare private configuration. Keep the generated encryption key stable. Choose a local port; the default live port is 4311.
2. Install/sign in to ngrok if needed, start the displayed tunnel command in a second terminal, and enter its public HTTPS origin. Leave that terminal running.
3. Identify your GitHub account, review registration of your own private GitHub App, and install it on selected repositories. The browser form declares Contents and Pull requests write permissions. GitHub generates the App credentials; the helper saves them locally without copying them through the terminal.
4. Sign in to the [E2B console](https://console.e2b.dev), create or select your own API key, and enter it at the hidden prompt.
5. Reuse a compatible clean template or explicitly approve building the pinned project template in your E2B account. A template build consumes provider resources. It does not create a running coding session.
6. Check the configuration and upstream account/template access, build the app, and follow the launch instructions.

You complete account sign-in, GitHub registration/installation and billing choices yourself. The guide does not create a GitHub source repository, publish code, purchase hosting, or register a domain. Exit with Ctrl+C and rerun to resume saved configuration. Existing credentials and encryption keys must not be replaced just to rerun setup.

## The tunnel

The E2B VM needs to reach the Git gateway on your computer. Follow [ngrok's installation and account instructions](https://ngrok.com/docs/getting-started/) before running the command displayed by the guide. For the default port:

```sh
ngrok http http://127.0.0.1:4311 --inspect=false --log=false
```

Configure the ngrok account authtoken privately; do not paste it into a shell command that will be retained in history. Disable request inspection and payload logging. The tunnel provider terminates public HTTPS, so use a provider you trust with this traffic. Do not put an extra browser login gate in front of the Git gateway.

Use the **public HTTPS URL** to open the live app, even though the server runs locally. This keeps OAuth callbacks, secure cookies and WebSocket origins consistent. Keep your computer awake and both app and tunnel running during sessions. If the public hostname changes, update the private configuration and the GitHub App's user authorization callback together; rerunning setup must not silently change an existing App's callback.

## Private configuration

The guide stores live settings in ignored `.env.live`, the encryption key in that same private file, and GitHub registration recovery files/PEMs under ignored `.data/github-registration`. Live application data uses `.data/local-live`; simulation uses a separate database. No external PostgreSQL service is required for the single-process local pilot.

Do not commit, upload, screenshot or paste those files. Do not `source` dotenv files: they are configuration data, not shell programs. Keep private directories at mode 0700 and files at 0600. The setup tools reject unsafe paths and already-tracked credential outputs. An existing invalid or conflicting file needs deliberate local correction; deleting it can discard credentials needed for cleanup.

Retain the encryption key and database together when making private backups. Changing the key prevents stored credentials from being read. Stopping the local server does not itself stop the E2B VM; stop machines in the app and inspect cleanup outcomes before closing the tunnel or putting the computer to sleep. If cleanup is pending, preserve the database/key and resume reconciliation.

If a hard interruption leaves `.data/local-live/.setup.lock`, first confirm that no setup process is still running. Only then inspect and remove that lock before rerunning. Do not remove the database or configuration as a lock workaround.

An interrupted or failed template build leaves `.data/local-live/template-build-pending.json`. Check the E2B dashboard and any private `template-recovery-*.json` reference before requesting another build. Reuse a ready template where possible. Only remove the pending receipt after explicitly resolving that uncertainty; setup refuses to start another build while it remains.

## Launch and check

After setup, use:

```sh
npm run live
```

Open the configured public HTTPS URL. Sign in to GitHub in the browser, select an installed repository and launch a machine. In its terminal, complete the fresh Codex device sign-in and folder/trust prompts. Codex uses your eligible account and its limits. A reconnect to the same VM retains its login; a fresh VM requires a fresh login.

The configuration checker is also available separately:

```sh
npm run setup:doctor
# Only local configuration/build checks; no account requests:
npm run setup:doctor -- --offline
# After npm run live starts, verify the tunnel in another terminal:
npm run setup:local -- tunnel-check
```

The tunnel check requires exact live application health responses from both the selected local port and public HTTPS origin. Redirects, proxy HTML, simulation, oversized responses and timeouts fail. It sends no account credentials and does not create a VM. A passing checker is not an end-to-end session result. Use a disposable repository to verify a clone, a useful Codex response, a permitted session-branch push, stop, independent VM absence and former-capability rejection. See [the detailed live procedure](LOCAL-LIVE.md). Keep those receipts private. Remote upstream Codex-token revocation remains unverified.

## Scope and costs

E2B compute/template usage and any tunnel-plan limits belong to your own accounts. The guide keeps one-hour sessions and does not upgrade a plan or extend sessions automatically. Check [current E2B pricing](https://e2b.dev/pricing) and the provider dashboards before approving builds or starting sessions.

The build uses the `ephemeral-codex` template alias. If that alias already serves another installation, reuse a compatible existing template rather than approving an unexpected update to its default build.

The optional application Preview viewer is disabled in the initial configuration. Enabling it requires its own separate viewer-origin setup; it is not enabled by exposing the control plane. See [Preview configuration](RELEASE.md#private-preview-migration).

No security support address or content-retention commitment is active yet. See [security status](../SECURITY.md), [support draft](SUPPORT.md) and [retention draft](RETENTION.md). Treat this as an experimental local project, not an operated public service.
