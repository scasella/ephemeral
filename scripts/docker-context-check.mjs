// Verify the real Docker context filter using synthetic files only. No image or network needed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function checkDockerContext() {
  const root = await mkdtemp(join(tmpdir(), 'ephemeral-context-test-'));
  const context = join(root, 'context'), destination = join(root, 'export');
  // Include a direct child and a nested child for every admitted source tree.
  const allowed = ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'public/appearance.js',
    ...['server', 'shared', 'src', 'tests', 'scripts', 'sandbox'].flatMap(dir => [`${dir}/fixture.ts`, `${dir}/nested/fixture.ts`]),
    'src/nested/fixture.tsx', 'src/nested/fixture.css'];
  const denied = ['.env', '.env.local', '.data/fixture.ts', '.git/config', 'private.pem', 'credentials.json',
    'public/private.js', 'public/credentials.json', 'public/.env', 'docs/private.md', 'private/notes.txt', 'node_modules/fixture.ts', 'dist/fixture.ts',
    ...['server', 'shared', 'src', 'tests', 'scripts', 'sandbox'].flatMap(dir => [
      `${dir}/nested/.env`, `${dir}/nested/.env.local`, `${dir}/nested/private.pem`, `${dir}/nested/private.key`,
      `${dir}/nested/private.p12`, `${dir}/nested/private.pfx`, `${dir}/nested/private.log`, `${dir}/nested/credentials.json`,
      `${dir}/nested/private.txt`, `${dir}/nested/.data/fixture.ts`, `${dir}/nested/.git/fixture.ts`,
      `${dir}/nested/.ssh/fixture.ts`, `${dir}/nested/node_modules/fixture.ts`, `${dir}/nested/dist/fixture.ts`,
    ])];
  try {
    await mkdir(context, { recursive: true });
    await writeFile(join(context, '.dockerignore'), await readFile(new URL('../.dockerignore', import.meta.url)));
    for (const path of [...allowed, ...denied]) {
      await mkdir(dirname(join(context, path)), { recursive: true });
      await writeFile(join(context, path), `synthetic context fixture: ${path}\n`);
    }
    const result = spawnSync('docker', ['build', '--network=none', '--output', `type=local,dest=${destination}`, '-f', '-', context], {
      input: 'FROM scratch\nCOPY . /\n', encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `Docker context export failed: ${result.stderr}`);
    const files = [];
    async function walk(directory, prefix = '') {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = `${prefix}${entry.name}`;
        if (entry.isDirectory()) await walk(join(directory, entry.name), `${path}/`);
        else files.push(path);
      }
    }
    await walk(destination);
    assert.deepEqual(files.sort(), allowed.sort(), 'Docker must export only admitted build inputs; nested private files must be absent');
    console.log(`PASS Docker context allowlist: ${allowed.length} build inputs admitted, ${denied.length} private/unrelated fixtures excluded`);
  } finally { await rm(root, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await checkDockerContext();
}
