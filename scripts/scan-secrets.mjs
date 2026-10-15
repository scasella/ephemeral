import { spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

// Use an operator-installed CLI. This helper never downloads or installs tools.
const binary = process.env.GITLEAKS_BIN || 'gitleaks';
const scannerEnv = { PATH: process.env.PATH, TMPDIR: tmpdir(), LANG: 'C', NO_COLOR: '1' };
let temporary;

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error('Git candidate enumeration failed; secret scan is incomplete.');
  return result.stdout;
}

function scan(args, cwd) {
  const result = spawnSync(binary, args, { cwd, env: scannerEnv, stdio: 'inherit', timeout: 120_000 });
  if (result.error || result.status === null || ![0, 1].includes(result.status)) {
    throw new Error('Gitleaks could not complete a scan; no clean result is available.');
  }
  return result.status;
}

try {
  if (process.argv.length > 2) throw new Error('Usage: npm run check:secrets (optionally set GITLEAKS_BIN).');
  const version = spawnSync(binary, ['version'], { env: scannerEnv, encoding: 'utf8', timeout: 10_000 });
  if (version.error || version.status !== 0 || version.stdout.trim() !== '8.30.1') {
    throw new Error('Install Gitleaks 8.30.1 on PATH or set GITLEAKS_BIN to that executable; no tool was downloaded.');
  }
  const root = await realpath(git(['rev-parse', '--show-toplevel']).trim());
  if (git(['rev-parse', '--is-shallow-repository'], root).trim() !== 'false') {
    throw new Error('Full Git history is required. Fetch the complete history before scanning.');
  }
  const config = join(root, '.gitleaks.toml');
  if (!(await lstat(config)).isFile()) throw new Error('The repository Gitleaks configuration must be a regular file.');
  temporary = await mkdtemp(join(tmpdir(), 'ephemeral-public-secret-scan-'));
  const candidates = join(temporary, 'candidates');
  await mkdir(candidates);
  // --exclude-standard excludes ignored untracked operational files, not tracked
  // files. An accidentally tracked secret must remain in the public scan scope.
  const names = new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root).split('\0').filter(Boolean));
  let copied = 0;
  for (const name of names) {
    const source = resolve(root, name);
    const inside = relative(root, source);
    if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new Error('An unsafe public candidate path prevented scanning.');
    }
    let stat;
    try { stat = await lstat(source); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; } // Deleted tracked files are covered by history.
    if (!stat.isFile() || await realpath(source) !== source) {
      throw new Error('A non-regular public candidate prevented safe scanning; symlinks and submodules need separate review.');
    }
    const destination = join(candidates, inside);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    copied++;
  }
  const common = ['--config', config, '--redact=100', '--no-banner', '--no-color', '--ignore-gitleaks-allow',
    '--gitleaks-ignore-path', temporary, '--timeout', '120'];
  console.log('Scanning all Git history with secrets fully redacted.');
  const history = scan(['git', '--log-opts=--all', ...common, root], root);
  console.log(`Scanning ${copied} tracked and non-ignored candidate files in a temporary copy.`);
  const working = scan(['dir', ...common, candidates], root);
  process.exitCode = history || working;
  if (process.exitCode) console.error('Secret findings require private review before publication.');
  else console.log('No secrets detected by the configured rules in history or public candidate files.');
} catch (error) {
  // Do not echo child output, environment values, file contents, or arbitrary OS errors.
  const known = error instanceof Error && /^(Git candidate|Gitleaks could|Usage:|Install Gitleaks|Full Git|The repository Gitleaks|An unsafe public|A non-regular public)/.test(error.message);
  console.error(known ? error.message : 'Secret scanning failed; review local tooling and file access privately.');
  process.exitCode = 2;
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
