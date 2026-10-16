import { Template, defaultBuildLogger } from 'e2b';
import { runtimeVersions } from './runtime-versions.js';
import { pathToFileURL } from 'node:url';
import { isEnvironmentTemplateRef } from '../shared/environments.js';

export type TemplateProfile = 'base' | 'node' | 'python';
export const TEMPLATE_TYPESCRIPT_VERSION = '7.0.2';
export function parseTemplateBuildArgs(args: string[]): { profile: TemplateProfile; dryRun: boolean; tag?: string } {
  let profile: TemplateProfile = 'base', dryRun = false, selected = false, tag: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dry-run' && !dryRun) { dryRun = true; continue; }
    if (arg === '--profile' && !selected) {
      const value = args[++index];
      if (value !== 'base' && value !== 'node' && value !== 'python') throw new Error('Use --profile base, node, or python.');
      profile = value; selected = true; continue;
    }
    if (arg === '--tag' && tag === undefined) {
      const value = args[++index];
      if (!value || !isEnvironmentTemplateRef(`template:${value}`, true)) throw new Error('Use a safe release tag other than latest or default.');
      tag = value; continue;
    }
    throw new Error('Use only --profile base|node|python, --tag RELEASE, and --dry-run, at most once each.');
  }
  return { profile, dryRun, ...(tag ? { tag } : {}) };
}

/** The shared, source-free recipe used by both operator builds and local setup. */
export function createTemplateRecipe(options: { baseImage?: string; codexVersion?: string; pnpmVersion?: string; profile?: TemplateProfile } = {}) {
  const baseImage = options.baseImage ?? runtimeVersions.baseImage;
  const codexVersion = options.codexVersion ?? runtimeVersions.codex;
  const pnpmVersion = options.pnpmVersion ?? runtimeVersions.pnpm;
  const profile = options.profile ?? 'base';
  const exactVersion = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
  if (!['base', 'node', 'python'].includes(profile) || codexVersion.trim() !== codexVersion || pnpmVersion.trim() !== pnpmVersion || !exactVersion.test(codexVersion) || !exactVersion.test(pnpmVersion)) throw new Error('Invalid template recipe options.');
  const pythonPackages = profile === 'python' ? ' python3-venv python3-dev build-essential' : '';
  const nodePackages = profile === 'node' ? ` typescript@${TEMPLATE_TYPESCRIPT_VERSION}` : '';
  let recipe = Template()
    .fromImage(baseImage)
    .setUser('root')
    .runCmd(`apt-get update && apt-get install -y --no-install-recommends git tmux procps python3 openssh-client ca-certificates${pythonPackages} && rm -rf /var/lib/apt/lists/*`)
    .runCmd(`npm install --include=optional -g @openai/codex@${codexVersion} pnpm@${pnpmVersion}${nodePackages}`)
    .runCmd('set -eu; if ! id user >/dev/null 2>&1; then useradd --create-home --user-group --shell /bin/bash user; fi; test "$(getent passwd user | cut -d: -f6)" = /home/user; install -d -m 700 -o user -g "$(id -gn user)" /home/user/.codex')
    .setUser('user')
    .setWorkdir('/home/user')
    .runCmd('set -eu; test "$HOME" = /home/user; printf \'cli_auth_credentials_store = "file"\\nforced_login_method = "chatgpt"\\n\' > /home/user/.codex/config.toml; chmod 600 /home/user/.codex/config.toml; node --version; npm --version; pnpm --version; git --version; python3 --version; tmux -V; codex --version; codex login --help | grep -- --device-auth; test ! -f /home/user/.codex/auth.json');
  if (profile === 'node') recipe = recipe.runCmd(`tsc --version | grep -Fx 'Version ${TEMPLATE_TYPESCRIPT_VERSION}'`);
  if (profile === 'python') recipe = recipe.runCmd('set -eu; python3 -m venv /tmp/ephemeral-venv-check; /tmp/ephemeral-venv-check/bin/python -m pip --version; rm -rf /tmp/ephemeral-venv-check');
  return recipe;
}

export async function runTemplateBuild(args: string[], env: NodeJS.ProcessEnv, log: (text: string) => void = console.log): Promise<void> {
  const { profile, dryRun, tag } = parseTemplateBuildArgs(args);

  // This is an operator-run build, not part of server startup. Never bake account
  // auth, an API key, a repository, or a workspace snapshot into this template.
  const { E2B_API_KEY: apiKey } = env;
  const alias = env.E2B_TEMPLATE_ALIAS ?? (profile === 'base' ? 'ephemeral-codex' : `ephemeral-${profile}`);
  const codexVersion = env.E2B_TEMPLATE_CODEX_VERSION ?? runtimeVersions.codex;
  const pnpmVersion = env.E2B_TEMPLATE_PNPM_VERSION ?? runtimeVersions.pnpm;
  const version = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
  if (!dryRun && !apiKey) throw new Error('Set E2B_API_KEY for the template build.');
  if (!codexVersion || codexVersion.trim() !== codexVersion || !version.test(codexVersion) || !pnpmVersion || pnpmVersion.trim() !== pnpmVersion || !version.test(pnpmVersion)) {
    throw new Error('Template CLI overrides must be exact E2B_TEMPLATE_CODEX_VERSION and E2B_TEMPLATE_PNPM_VERSION values.');
  }
  if (alias.trim() !== alias || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(alias)) throw new Error('Invalid template alias.');
  const template = createTemplateRecipe({ baseImage: env.E2B_BASE_IMAGE, codexVersion, pnpmVersion, profile });
  if (dryRun) {
    // Serializing the template is local. This branch never requires/sends an API key.
    log(JSON.stringify({ profile, ...(tag ? { tag } : {}), recipe: await Template.toJSON(template, false) }, null, 2));
  } else {
    // Omit custom compute so Hobby receives E2B's account default CPU/RAM.
    const built = await Template.build(template, { apiKey, alias, ...(tag ? { tags: [tag] } : {}), onBuildLogs: defaultBuildLogger() });
    log(`Template ready. Set E2B_TEMPLATE_ID=${built.templateId}${tag ? `:${tag}` : ''}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const { dryRun } = parseTemplateBuildArgs(args);
  // A source-free dry run does not even load local provider credentials.
  if (!dryRun) {
    try { process.loadEnvFile('.env'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Unable to read the local environment file.'); }
  }
  await runTemplateBuild(args, process.env);
}
