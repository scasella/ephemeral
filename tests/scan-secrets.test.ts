import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const helper = resolve('scripts/scan-secrets.mjs');
const fixtures: string[] = [];
afterEach(async () => { for (const path of fixtures.splice(0)) await rm(path, { recursive: true, force: true }); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ephemeral-secret-helper-test-'));
  fixtures.push(directory);
  const root = join(directory, 'repository'), trace = join(directory, 'trace.jsonl'), scanner = join(directory, 'scanner.mjs');
  await mkdir(root);
  await writeFile(join(root, '.gitignore'), '.env\n.data/\nnode_modules/\n*.pem\n');
  await writeFile(join(root, '.gitleaks.toml'), '[extend]\nuseDefault = true\n');
  await writeFile(join(root, 'tracked.txt'), 'original public text');
  for (const args of [['init', '--quiet'], ['add', '.gitignore', '.gitleaks.toml', 'tracked.txt']]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(0);
  }
  // This local stub exercises the helper's boundary and failures, not Gitleaks rules.
  await writeFile(scanner, `#!/usr/bin/env node
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === 'version') { console.log('8.30.1'); process.exit(0); }
const target = args.at(-1), names = [];
function visit(path) { for (const entry of readdirSync(path, { withFileTypes: true })) {
  const file = join(path, entry.name);
  if (entry.isDirectory()) visit(file); else names.push(relative(target, file));
} }
if (args[0] === 'dir') visit(target);
appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ mode: args[0], target, names, redacted: args.includes('--redact=100'), allHistory: args.includes('--log-opts=--all') }) + '\\n');
if (names.some(name => readFileSync(join(target, name), 'utf8').includes('FAIL_SCAN'))) process.exit(1);
`);
  await chmod(scanner, 0o700);
  const run = (binary = scanner) => spawnSync(process.execPath, [helper], { cwd: root, encoding: 'utf8',
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, GITLEAKS_BIN: binary } });
  return { root, trace, scanner, run };
}

it('scans changed tracked and non-ignored untracked candidates, excluding ignored operational files, then removes its copy', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'tracked.txt'), 'changed public text');
  await writeFile(join(f.root, 'new public file.txt'), 'new public text');
  await writeFile(join(f.root, '.env'), 'PRIVATE_OPERATIONAL_MARKER');
  await mkdir(join(f.root, '.data')); await writeFile(join(f.root, '.data', 'private.txt'), 'PRIVATE_OPERATIONAL_MARKER');
  await mkdir(join(f.root, 'node_modules')); await writeFile(join(f.root, 'node_modules', 'private.txt'), 'PRIVATE_OPERATIONAL_MARKER');
  const result = f.run();
  expect(result.status).toBe(0);
  const scans = (await readFile(f.trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(scans.map(scan => scan.mode)).toEqual(['git', 'dir']);
  expect(scans.every(scan => scan.redacted)).toBe(true);
  expect(scans[0].allHistory).toBe(true);
  expect(scans[1].names.sort()).toEqual(['.gitignore', '.gitleaks.toml', 'new public file.txt', 'tracked.txt']);
  await expect(lstat(scans[1].target)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(result.stdout + result.stderr).not.toContain('PRIVATE_OPERATIONAL_MARKER');
});

it('propagates candidate findings and cleans the temporary copy on failure', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'untracked.txt'), 'FAIL_SCAN');
  const result = f.run();
  expect(result.status).toBe(1);
  const scans = (await readFile(f.trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  await expect(lstat(scans[1].target)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(result.stderr).toContain('require private review');
});

it('rejects a public symlink rather than reading its ignored target', async () => {
  const f = await fixture();
  await writeFile(join(f.root, '.env'), 'PRIVATE_OPERATIONAL_MARKER');
  await symlink(join(f.root, '.env'), join(f.root, 'public-link'));
  expect(spawnSync('git', ['add', 'public-link'], { cwd: f.root }).status).toBe(0);
  const result = f.run();
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('non-regular public candidate');
  expect(result.stdout + result.stderr).not.toContain('PRIVATE_OPERATIONAL_MARKER');
  await expect(lstat(f.trace)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('fails without downloading when the requested CLI is unavailable', async () => {
  const f = await fixture();
  const result = f.run(join(f.root, 'missing-executable'));
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('no tool was downloaded');
  await expect(lstat(f.trace)).rejects.toMatchObject({ code: 'ENOENT' });
});
