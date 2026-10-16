import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Session } from '../server/contracts.js';
import { prepareGitCommand, SOURCE_CHANGED_EXIT } from '../server/infra/git-prepare.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
function run(command: string, args: string[], cwd?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } });
    let out = '', err = ''; child.stdout.on('data', data => out += data); child.stderr.on('data', data => err += data);
    child.on('error', reject); child.on('close', code => resolve({ code: code ?? -1, out, err }));
  });
}
const git = async (args: string[]) => { const result = await run('git', args); if (result.code) throw new Error(result.err); return result.out.trim(); };
function session(sha: string): Session {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  return { id, userId: 'owner', repository: 'owner/repo', repositoryId: 1, installationId: 2, baseBranch: 'main', branch: `ephemeral/${id}`,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), maxExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    sandboxId: 'synthetic-vm', state: 'provisioning', endedAt: null, error: null, codexRemoteRevocation: 'unverified', cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' },
    launchSource: { url: `https://github.com/owner/repo/commit/${sha}`, kind: 'commit', ref: sha, commitSha: sha, baseBranch: 'main', checkedAt: new Date().toISOString() } };
}
it('checks the fetched clone SHA, creates the assigned branch from exactly that SHA, and quotes all paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ep-url-prepare-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const upstream = join(directory, "upstream ' $(touch PWNED)"), work = join(directory, "workspace ' $(touch PWNED)");
  await git(['init', '-b', 'main', upstream]); await git(['-C', upstream, 'config', 'user.name', 'Test']); await git(['-C', upstream, 'config', 'user.email', 'test@example.com']);
  await writeFile(join(upstream, 'file.txt'), 'reviewed contents'); await git(['-C', upstream, 'add', '.']); await git(['-C', upstream, 'commit', '-m', 'reviewed']);
  const sha = await git(['-C', upstream, 'rev-parse', 'HEAD']), launch = session(sha);
  const result = await run('sh', ['-c', prepareGitCommand(launch, upstream, work)], directory); expect(result.code, result.err).toBe(0);
  expect(await git(['-C', work, 'rev-parse', 'HEAD'])).toBe(sha); expect(await git(['-C', work, 'branch', '--show-current'])).toBe(launch.branch);
  const { access } = await import('node:fs/promises'); await expect(access(join(directory, 'PWNED'))).rejects.toThrow();
  await writeFile(join(upstream, 'file.txt'), 'moved contents'); await git(['-C', upstream, 'commit', '-am', 'moved']);
  const rejected = join(directory, 'moved-clone');
  expect((await run('sh', ['-c', prepareGitCommand(launch, upstream, rejected)], directory)).code).toBe(SOURCE_CHANGED_EXIT);
  expect(await git(['-C', rejected, 'branch', '--show-current'])).toBe('main');
});
