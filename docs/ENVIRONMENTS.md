# Faster, repeatable environments

Choose an **Environment profile** when launching a machine from the repository picker, a GitHub URL, or **Continue saved work**. A profile selects a prepared E2B template with common tools already installed. This avoids installing those tools in each new workspace. Repository dependencies still belong to the repository's lockfiles and its explicitly run **Setup** recipe.

The app remembers your last selected profile for each repository in this browser, scoped to your account and app address. Browser storage is optional: if unavailable, select a profile on each visit. If a remembered profile changes or disappears, review and select an available profile before launching. A saved, possibly accepted launch request retains its original selection for safe recovery.

**Settings → Environment profile** shows the selection recorded for that machine, including its template reference and catalog revision. Older machines have no recorded profile; the app does not reconstruct one from today's configuration. Continuing saved work can preselect the source profile only while its exact catalog revision remains available. You can choose a different environment for the fresh machine.

## Configure profiles locally

The existing `E2B_TEMPLATE_ID` provides the **Base** profile. No catalog file is required. To offer additional prepared toolchains, save a JSON array in an ignored private file, for example `.data/local-live/environments.json`:

```json
[
  {
    "id": "node",
    "name": "Node.js with TypeScript",
    "description": "Common Node.js tools. Install project dependencies using its lockfile.",
    "templateRef": "ephemeral-node:release-2026-10-16",
    "tools": ["Node.js 24", "TypeScript 7.0.2", "pnpm", "Git", "Python", "Codex"]
  },
  {
    "id": "python",
    "name": "Python with build tools",
    "description": "Python venv and native build tools alongside the base Codex runtime.",
    "templateRef": "ephemeral-python:release-2026-10-16",
    "tools": ["Python", "venv", "build-essential", "Node.js", "Git", "Codex"]
  }
]
```

Replace those illustrative references with templates you have actually built and checked in your own E2B account. Labels are operator-supplied descriptions, not an inspection of installed tools. Keep the file private with `chmod 600 .data/local-live/environments.json`. Set `ENVIRONMENT_PROFILES_FILE` to its absolute path in the private `.env.live` used by guided local setup, or in the server's environment for a manually configured installation. Restart the control plane after changing the catalog.

For a Docker installation, mount the catalog read-only and use its absolute path inside the container. Host filesystem paths are not automatically available inside the image.

The file is limited to 64 KiB and 16 custom profiles. IDs must be unique lowercase slugs and cannot be `default`. Each entry has exactly the five fields shown above; descriptions and tool names must be plain text. Custom references require an explicit release tag other than `default` or `latest`. Use a new release tag when changing a toolchain, and never move a tag that existing profiles use. The browser can select only a server-configured profile; it cannot submit a template ID, build code, or change the catalog.

Catalog revisions fingerprint the profile's metadata and template reference. **They do not pin an immutable E2B build.** E2B tags can move, and the installed SDK launches by template reference rather than a separately selected build ID. Changing an upstream tag without changing the catalog cannot be detected by the catalog revision. Base retains compatibility with the existing untagged `E2B_TEMPLATE_ID`; use a release-tagged reference there too when possible.

## Prepare a toolchain

The source-free template recipe supports three presets:

| Preset | Tools added to the shared base |
| --- | --- |
| `base` | Existing Node/npm, pnpm, Git, Python, tmux and Codex runtime |
| `node` | TypeScript 7.0.2 |
| `python` | Python venv, Python development headers and native build tools |

Inspect the recipes offline first; these commands do not build a template or require an API key:

```sh
npm run template:build -- --profile base --dry-run
npm run template:build -- --profile node --tag release-2026-10-16 --dry-run
npm run template:build -- --profile python --tag release-2026-10-16 --dry-run
```

Building consumes E2B resources. After reviewing costs and the serialized recipe, an operator can build a tagged preset explicitly using the private configuration file:

```sh
node --env-file=.env.live --import tsx sandbox/build-template.ts --profile node --tag release-2026-10-16
```

Use the printed tagged template reference in the catalog. The default aliases are `ephemeral-codex`, `ephemeral-node` and `ephemeral-python`; `E2B_TEMPLATE_ALIAS` overrides the selected alias. Avoid reusing aliases/tags belonging to another installation. Run the existing [read-only preflight](E2B.md#build-a-fresh-template) against each reference before offering it. Starting a machine and verifying its tools requires a separate live test. Toolchain presets do not change the account's default CPU/RAM or establish a performance benchmark.

## What is reused

Only the clean template's common tools and the selected profile preference are reused. Every machine still gets a fresh repository checkout, work branch, session credential and Codex device sign-in. No repository source, workspace snapshot, authentication cache, terminal history or Codex conversation is baked into these presets.

Saved repository **Setup** recipes remain available across machines but never run automatically. Use lockfiles and exact project dependency versions for repeatable project setup; the template's Debian packages still resolve from their package repositories at build time. See [E2B runtime details](E2B.md) for the pinned base image and CLI versions.

`npm run local` offers clearly labeled simulated Base, Node.js and Python profiles. It exercises selection, launch and recorded metadata without installing tools or creating VMs. Local regression tests and browser checks do not prove a successful cloud build or faster live startup.
