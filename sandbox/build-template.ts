import { Template, defaultBuildLogger } from 'e2b';
import { runtimeVersions } from './runtime-versions.js';

try { process.loadEnvFile('.env'); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Unable to read the local environment file.'); }

// This is an operator-run build, not part of server startup. Never bake account
// auth, an API key, a repository, or a workspace snapshot into this template.
const apiKey = process.env.E2B_API_KEY;
const alias = process.env.E2B_TEMPLATE_ALIAS ?? 'ephemeral-codex';
const codexVersion = process.env.E2B_TEMPLATE_CODEX_VERSION ?? runtimeVersions.codex;
const pnpmVersion = process.env.E2B_TEMPLATE_PNPM_VERSION ?? runtimeVersions.pnpm;
const dryRun = process.argv.includes('--dry-run');
const version = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
if (!dryRun && !apiKey) throw new Error('Set E2B_API_KEY for the template build.');
if (!codexVersion || !version.test(codexVersion) || !pnpmVersion || !version.test(pnpmVersion)) {
  throw new Error('Template CLI overrides must be exact E2B_TEMPLATE_CODEX_VERSION and E2B_TEMPLATE_PNPM_VERSION values.');
}
if (!/^[a-z0-9][a-z0-9_-]*$/.test(alias)) throw new Error('Invalid template alias.');
const template = Template()
  .fromImage(process.env.E2B_BASE_IMAGE ?? runtimeVersions.baseImage)
  .setUser('root')
  .runCmd('apt-get update && apt-get install -y --no-install-recommends git tmux procps python3 openssh-client ca-certificates && rm -rf /var/lib/apt/lists/*')
  .runCmd(`npm install --include=optional -g @openai/codex@${codexVersion} pnpm@${pnpmVersion}`)
  .runCmd('set -eu; if ! id user >/dev/null 2>&1; then useradd --create-home --user-group --shell /bin/bash user; fi; test "$(getent passwd user | cut -d: -f6)" = /home/user; install -d -m 700 -o user -g "$(id -gn user)" /home/user/.codex')
  .setUser('user')
  .setWorkdir('/home/user')
  .runCmd('set -eu; test "$HOME" = /home/user; printf \'cli_auth_credentials_store = "file"\\nforced_login_method = "chatgpt"\\n\' > /home/user/.codex/config.toml; chmod 600 /home/user/.codex/config.toml; node --version; npm --version; pnpm --version; git --version; python3 --version; tmux -V; codex --version; codex login --help | grep -- --device-auth; test ! -f /home/user/.codex/auth.json');
if (dryRun) {
  // Serializing the template is local. This branch never requires/sends an API key.
  console.log(await Template.toJSON(template, false));
} else {
  // Omit custom compute so Hobby receives E2B's account default CPU/RAM.
  const built = await Template.build(template, { apiKey, alias, onBuildLogs: defaultBuildLogger() });
  console.log(`Template ready. Set E2B_TEMPLATE_ID=${built.templateId}`);
}
