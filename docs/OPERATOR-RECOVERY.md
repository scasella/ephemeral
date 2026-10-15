# Restricted operator session recovery

Use `npm run session:recovery` from a trusted Node 24 control-plane host to diagnose one persisted session and retry its cleanup after an incident. This is a local operator CLI. It opens no browser, HTTP administration route, Git gateway listener, or background reconciler. It never provisions a VM, mints a GitHub token, retries another session, or deletes a gateway root.

Stop the application gracefully before running either command. The CLI acquires the **same singleton database ownership** as the application. It refuses another application/operator owner and any existing PGlite lock file, including a stale file. There is no force-unlock option, and the CLI never deletes a pre-existing ownership file. A shutdown that left ownership behind requires separate host incident investigation; deleting the file to make this command run is not a recovery procedure.

Stopping the server preserves running VMs. This tool rejects `running`, `ended`, and `failed` sessions. Stop an intentional running session through the normal application before shutting down the service. A provisioning session is eligible only as abandoned work under exclusive database ownership; an unexpired per-session lease still prevents reconciliation.

## Select the existing database

Both commands use `DATABASE_URL` when present, otherwise `DATA_DIR/<mode>/postgres`. `DATA_DIR` defaults to `.data`. Mode defaults to `EPHEMERAL_MODE`, then `live`; pass `--mode live` explicitly in operational commands. A missing local PostgreSQL directory/version marker or missing session schema is an error. The CLI does not initialize a new empty application database to satisfy a mistaken path.

Configuration comes from the current process environment or an explicit `--env-file /absolute/private/operator.env`. Values from that selected file override inherited environment values. The file must be a regular file owned by the current Unix user, have no group/world permissions, be at most 64 KiB, and not be a symlink. The CLI never edits configuration. Do not supply credential values in command arguments. Keep the same encryption key and database selection as the stopped deployment.

Remote PostgreSQL uses the selected `PGPASSWORD`, connection defaults (`PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`, `PGOPTIONS`, `PGCLIENT_ENCODING`, `PGREPLICATION`), and pg TLS defaults (`PGSSLMODE`, `PGSSLNEGOTIATION`). Nonempty credentials and other explicit settings inside `DATABASE_URL` retain pg's normal precedence over these defaults, including URL TLS options. For certificate files, use URL parameters `sslcert`, `sslkey`, and `sslrootcert`; pg does not read `PGSSLCERT`, `PGSSLKEY`, or `PGSSLROOTCERT` environment variables. Supply remote database passwords through `DATABASE_URL` or `PGPASSWORD`; recovery does not consult `.pgpass`. Passwords supplied through `PGPASSWORD` remain literal, including URL delimiter characters.

Offline inspection does not load `.env`, validate cloud credentials, decrypt tokens, or call providers. Reconciliation uses the existing production configuration validation: live mode, `NODE_ENV=production`, HTTPS `PUBLIC_URL`, and the deployment's required GitHub/E2B settings and stable encryption key. Its config module retains the application's legacy `.env` loading behavior, but validation uses the explicit environment snapshot; an invalid/unreadable local configuration can still cause a sanitized configuration error.

## Inspect one session

```sh
npm run session:recovery -- inspect --mode live --session SESSION_UUID --env-file /absolute/private/operator.env
```

The JSON projection includes session lifecycle and cleanup states, recorded sandbox IDs, safe creation/issuance attempt status and fixed reason codes, uncertainty deadlines, blockers, and the latest ten operator audit attempts. It excludes raw upstream errors, event text, session labels, repository names, credentials, ciphertext, token hashes, authentication headers, private keys, file paths, and configuration values. Missing or malformed fields appear as `unknown`/`null` rather than raw stored text. Schema migrations may create diagnostic tables; inspection does not modify lifecycle or perform remote work.

A creation deadline describes possible resource lifetime; it does not establish VM absence. `github_issuance_uncertain`, unresolved issuance attempts, or unconfirmed cleanup mean the active-session slot may remain occupied. `codexRemoteRevocation` remains `unverified`, including after VM cleanup.

## Retry evidenced cleanup

Fix the underlying production configuration or provider incident first, then run one explicit cleanup action:

```sh
npm run session:recovery -- reconcile --mode live --session SESSION_UUID --confirm-session SESSION_UUID --reason configuration_fixed --env-file /absolute/private/operator.env
```

The two UUIDs must match exactly. The reason is one of these fixed audit categories: `configuration_fixed`, `provider_recovered`, `credential_recovery`, or `incident_cleanup`. Freeform explanations and manual claims are rejected, so secrets cannot enter the audit trail through a reason. Keep incident narrative in your separate incident record.

The CLI durably records a `started` audit attempt **before** requesting the manager's awaited single-session reconciliation. It then records `completed`, `incomplete`, `failed`, or `timed_out`, the resulting lifecycle state, and cleanup evidence states. These records are in `ephemeral_operator_recovery`; `inspect` projects their safe metadata. An interrupted process may leave an audit attempt at `started`; treat that as incomplete work, inspect, and retry after ownership is safely available.

Cleanup disables only the selected database gateway capability, removes only its exact recorded `repo-<session UUID>.git` disk in a recorded private canonical server-owned `/tmp/ep-gh-*` root, retries only that session's GitHub revocations, and discovers/checks/destroys only its provider resources through the existing lifecycle cleanup. Unsafe, symlinked, mismatched, unowned, or non-private scratch paths fail closed. Sibling disks, shared roots, and abandoned askpass/root files are preserved for separate host investigation. Run on the stopped deployment's host with its database and scratch storage; this command is not an all-host disk scrubber.

VM cleanup confirms only API-established absence. An absent/rejected/expired GitHub credential or confirmed revocation is handled by the credential journal's evidence rules. An operator statement, a dashboard screenshot, an expired VM TTL, a timeout, an authentication failure, or lack of an API response never supplies missing cleanup evidence. The tool has no acknowledgement, force-complete, lease-clear, or active-slot-release command. An uncertain creation or token issuance stays pending until the existing evidence rules resolve it. GitHub session branches/PRs are preserved, and Codex remote authorization revocation remains unverified.

## Run from the deployed container image

The runtime image includes this CLI. For the repository's Compose deployment, stop only `app`, leave PostgreSQL available, and run a serial one-off process using the same service configuration and persistent volume:

```sh
docker compose stop app
docker compose run --rm --no-deps app node --import tsx scripts/session-recovery.ts inspect --mode live --session SESSION_UUID
# After reviewing the target and fixing the underlying incident:
docker compose run --rm --no-deps app node --import tsx scripts/session-recovery.ts reconcile --mode live --session SESSION_UUID --confirm-session SESSION_UUID --reason configuration_fixed
```

Compose supplies the existing database, encryption key, and provider configuration through the service environment; the arguments contain only IDs and a fixed reason. Do not run an additional copy of the application, publish a recovery listener, select a fresh database volume, or replace the deployment's encryption key. A one-off container's scratch filesystem does not expose files in a stopped container's old `/tmp`; inspect that host/container scratch storage separately if it is retained. The CLI never sweeps unrelated roots. Restart `app` only after the operator process has exited and database ownership is safely available; a retained-lock or shutdown incident requires investigation first.

## Deadlines and exit codes

Remote work has a 120-second overall observation budget; provider adapters also retain their individual request deadlines. Normal shutdown drains manager work before database close, with a seven-second close budget. An independent CLI process deadline is 140 seconds. There are no automatic retry loops.

- Exit `0`: inspection succeeded, or every required cleanup phase is confirmed and the target reached a terminal state.
- Exit `1`: invalid arguments/configuration, missing database/session, ownership refusal, or an ineligible target. Errors use fixed codes and omit exception messages/stacks.
- Exit `2`: cleanup remains incomplete/failed, or work/shutdown did not drain before its deadline.

`ownershipRetained: true` means the CLI deliberately did not close/release the database while worker tasks remained unresolved. For PGlite, process exit leaves the ownership file intact. For remote PostgreSQL, process termination necessarily disconnects the advisory-lock connection; durable uncertainty and session leases still fence recovery, and termination never confirms remote cleanup. A `timed_out` audit result is an observation of unfinished work, not cancellation or proof of absence. Do not start another local owner past a retained lock. Investigate the shutdown incident before retrying.

These commands are covered by real offline PGlite fixtures and synthetic provider/credential adapters. They have not been run against an operator account, cloud resource, or production database as part of implementation validation.
