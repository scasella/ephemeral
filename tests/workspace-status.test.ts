import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox } from 'e2b';
import { inspectGitWorkspace, parsePorcelainStatus, type GitInspectionRunner } from '../server/workspace-status.js';
import { E2BProvider } from '../server/infra/e2b.js';
import { PreviewProvider } from '../server/preview.js';
import type { Session } from '../server/contracts.js';

const { inspectionGET, inspectionCommand } = vi.hoisted(() => ({ inspectionGET: vi.fn(), inspectionCommand: vi.fn() }));
vi.mock('e2b', async importOriginal => {
  const actual = await importOriginal<typeof import('e2b')>();
  return { ...actual, ApiClient: class { api = { GET: inspectionGET }; },
    Sandbox: class extends actual.Sandbox {
      constructor(...args: ConstructorParameters<typeof actual.Sandbox>) {
        super(...args); Object.defineProperty(this, 'commands', { value: { run: inspectionCommand } });
      }
    },
  };
});

const cleanups: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(cleanups.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const run: GitInspectionRunner = (args, timeoutMs) => new Promise((resolve, reject) => {
  execFile('git', args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } },
  (error, stdout) => {
    if (error && typeof error.code !== 'number') reject(error);
    else resolve({ exitCode: error ? error.code as number : 0, stdout });
  });
});
async function git(args: string[]) {
  const result = await run(args, 5_000);
  if (result.exitCode) throw new Error(`Fixture Git failed: ${args[0]}`);
  return result.stdout.trim();
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ep-work-status-')); cleanups.push(directory);
  const remote = join(directory, 'upstream.git'), work = join(directory, 'workspace'), branch = 'ephemeral/session-a';
  await git(['init', '--bare', remote]);
  await git(['init', '-b', branch, work]);
  await git(['-C', work, 'config', 'user.name', 'Status Test']);
  await git(['-C', work, 'config', 'user.email', 'status@example.test']);
  await writeFile(join(work, 'tracked.txt'), 'base\n');
  await git(['-C', work, 'add', '.']); await git(['-C', work, 'commit', '-m', 'base']);
  await git(['-C', work, 'remote', 'add', 'origin', remote]);
  await git(['-C', work, 'push', 'origin', branch]);
  return { directory, remote, work, branch, inspect: (runner = run) => inspectGitWorkspace({ workspace: work, expectedBranch: branch, expectedRemoteUrl: remote, run: runner }) };
}
const session = (): Session => ({ id: 'session-a', userId: 'user-a', repository: 'owner/repository', repositoryId: 1, installationId: 2,
  branch: 'ephemeral/session-a', baseBranch: 'main', state: 'running', createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(), maxExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  sandboxId: 'sandbox-a', endedAt: null, error: null,
  cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' }, codexRemoteRevocation: 'unverified' });

describe('read-only workspace status', () => {
  it('reports clean confirmed work and does not change HEAD, index, or remote refs', async () => {
    const f = await fixture(); const index = await readFile(join(f.work, '.git/index'));
    const beforeHead = await git(['-C', f.work, 'rev-parse', 'HEAD']);
    const status = await f.inspect();
    expect(status).toMatchObject({ state: 'known', dirtyFiles: 0, untrackedFiles: 0, aheadCommits: 0,
      headSha: beforeHead, remoteSha: beforeHead, branch: f.branch, branchMatches: true, remoteExists: true, reason: null });
    expect(status.remoteCheckedAt).toBeTruthy();
    expect(await readFile(join(f.work, '.git/index'))).toEqual(index);
    expect(await git(['-C', f.work, 'rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(await git(['--git-dir', f.remote, 'rev-parse', f.branch])).toBe(beforeHead);
  });
  it('counts staged renames once and unusual untracked filenames without staging', async () => {
    const f = await fixture();
    await git(['-C', f.work, 'mv', 'tracked.txt', 'renamed\nfile.txt']);
    await writeFile(join(f.work, 'untracked\nfile.txt'), 'new');
    await writeFile(join(f.work, ' another untracked.txt'), 'new');
    const index = await readFile(join(f.work, '.git/index'));
    expect(await f.inspect()).toMatchObject({ state: 'known', dirtyFiles: 1, untrackedFiles: 2, aheadCommits: 0 });
    expect(await readFile(join(f.work, '.git/index'))).toEqual(index);
  });
  it('reports commits unconfirmed on the assigned remote and observes the subsequent push', async () => {
    const f = await fixture(); const old = await git(['-C', f.work, 'rev-parse', 'HEAD']);
    await writeFile(join(f.work, 'tracked.txt'), 'changed'); await git(['-C', f.work, 'commit', '-am', 'change']);
    const status = await f.inspect();
    expect(status).toMatchObject({ state: 'known', aheadCommits: 1, remoteSha: old });
    expect(status.headSha).not.toBe(old);
    await git(['-C', f.work, 'push', 'origin', f.branch]);
    expect(await f.inspect()).toMatchObject({ state: 'known', aheadCommits: 0, remoteSha: status.headSha });
  });
  it('distinguishes an absent assigned branch from a failed remote lookup', async () => {
    const f = await fixture(); await git(['--git-dir', f.remote, 'update-ref', '-d', `refs/heads/${f.branch}`]);
    expect(await f.inspect()).toMatchObject({ state: 'unknown', remoteExists: false, remoteSha: null, aheadCommits: null });
    await rm(f.remote, { recursive: true });
    expect(await f.inspect()).toMatchObject({ state: 'unknown', remoteExists: null, remoteCheckedAt: null, aheadCommits: null });
  });
  it('fails closed when the remote commit is not in local object history', async () => {
    const f = await fixture(), other = join(f.directory, 'other');
    await git(['clone', '--branch', f.branch, f.remote, other]);
    await git(['-C', other, 'config', 'user.name', 'Test']); await git(['-C', other, 'config', 'user.email', 'test@example.test']);
    await writeFile(join(other, 'tracked.txt'), 'remote change'); await git(['-C', other, 'commit', '-am', 'remote change']);
    await git(['-C', other, 'push', 'origin', f.branch]);
    const status = await f.inspect();
    expect(status).toMatchObject({ state: 'unknown', remoteExists: true, aheadCommits: null });
    expect(status.remoteSha).toBe(await git(['-C', other, 'rev-parse', 'HEAD']));
    expect(status.reason).toContain('not available');
  });
  it('counts divergent local commits against observed remote history', async () => {
    const f = await fixture(); const base = await git(['-C', f.work, 'rev-parse', 'HEAD']);
    await writeFile(join(f.work, 'tracked.txt'), 'remote'); await git(['-C', f.work, 'commit', '-am', 'remote']);
    await git(['-C', f.work, 'push', 'origin', f.branch]);
    await git(['-C', f.work, 'reset', '--hard', base]);
    await writeFile(join(f.work, 'tracked.txt'), 'local'); await git(['-C', f.work, 'commit', '-am', 'local']);
    expect(await f.inspect()).toMatchObject({ state: 'known', aheadCommits: 1 });
  });
  it('declines to report safe status when another local branch retains unconfirmed commits', async () => {
    const f = await fixture();
    await git(['-C', f.work, 'checkout', '-b', 'other-work']);
    await writeFile(join(f.work, 'tracked.txt'), 'other branch work'); await git(['-C', f.work, 'commit', '-am', 'other branch']);
    await git(['-C', f.work, 'checkout', f.branch]);
    const status = await f.inspect();
    expect(status).toMatchObject({ state: 'unknown', dirtyFiles: 0, untrackedFiles: 0, aheadCommits: 0, branchMatches: true });
    expect(status.reason).toContain('Other local branches');
  });
  it('confirms identical shallow tips but declines to count incomplete divergent history', async () => {
    const f = await fixture(), shallow = join(f.directory, 'shallow'), remoteUrl = `file://${f.remote}`;
    await git(['clone', '--depth', '1', '--branch', f.branch, remoteUrl, shallow]);
    await git(['-C', shallow, 'config', 'user.name', 'Test']); await git(['-C', shallow, 'config', 'user.email', 'test@example.test']);
    const inspect = () => inspectGitWorkspace({ workspace: shallow, expectedBranch: f.branch, expectedRemoteUrl: remoteUrl, run });
    expect(await inspect()).toMatchObject({ state: 'known', aheadCommits: 0 });
    await writeFile(join(shallow, 'tracked.txt'), 'local shallow commit'); await git(['-C', shallow, 'commit', '-am', 'local']);
    expect(await inspect()).toMatchObject({ state: 'unknown', remoteExists: true, aheadCommits: null });
  });
  it('does not contact upstream for branch or gateway remote mismatch', async () => {
    const f = await fixture(); let lookups = 0;
    const counted: GitInspectionRunner = (args, ms) => { if (args.includes('ls-remote')) lookups++; return run(args, ms); };
    await git(['-C', f.work, 'checkout', '-b', 'other']);
    expect(await f.inspect(counted)).toMatchObject({ state: 'unknown', branchMatches: false, aheadCommits: null });
    await git(['-C', f.work, 'checkout', f.branch]);
    await git(['-C', f.work, 'remote', 'set-url', '--push', 'origin', '/tmp/another-session.git']);
    expect(await f.inspect(counted)).toMatchObject({ state: 'unknown', branchMatches: true, aheadCommits: null });
    expect(lookups).toBe(0);
  });
  it('fails closed on status truncation and remote timeout without reflecting error details', async () => {
    const f = await fixture();
    const truncated: GitInspectionRunner = (args, ms) => args.includes('status') ? Promise.resolve({ exitCode: 0, stdout: ' M tracked.txt' }) : run(args, ms);
    expect(await f.inspect(truncated)).toMatchObject({ state: 'unknown', dirtyFiles: null, untrackedFiles: null, aheadCommits: null });
    const timeout: GitInspectionRunner = (args, ms) => args.includes('ls-remote') ? Promise.reject(new Error('SECRET-token timed out')) : run(args, ms);
    const status = await f.inspect(timeout);
    expect(status).toMatchObject({ state: 'unknown', dirtyFiles: 0, remoteExists: null, aheadCommits: null });
    expect(status.reason).not.toContain('SECRET');
  });
  it('reports unknown when workspace files change during the remote check', async () => {
    const f = await fixture();
    const changing: GitInspectionRunner = async (args, ms) => {
      if (args.includes('ls-remote')) await writeFile(join(f.work, 'tracked.txt'), 'changed during inspection');
      return run(args, ms);
    };
    expect(await f.inspect(changing)).toMatchObject({ state: 'unknown', aheadCommits: null });
    expect((await f.inspect(changing)).reason).toBeNull(); // A subsequent stable observation succeeds.
  });
  it('rejects invalid or incomplete NUL status records', () => {
    expect(() => parsePorcelainStatus('?? filename')).toThrow();
    expect(() => parsePorcelainStatus('R  new\0')).toThrow();
    expect(() => parsePorcelainStatus('ZZ file\0')).toThrow();
    expect(parsePorcelainStatus(' M tracked\0?? new\nfile\0')).toEqual({ dirtyFiles: 1, untrackedFiles: 1 });
  });
});

describe('provider status boundaries', () => {
  const provider = () => new E2BProvider({ apiKey: 'not-a-real-key', templateId: 'template', gatewayUrl: 'https://gateway.example.test' });
  const runningInfo = () => ({ sandboxID: 'sandbox-a', state: 'running', envdVersion: '0.4.0', envdAccessToken: 'test-only-token',
    lifecycle: { autoResume: false }, metadata: { ephemeral_session_id: 'session-a', ephemeral_user_id: 'user-a',
      ephemeral_repository: 'owner/repository', ephemeral_repository_id: '1', ephemeral_branch: 'ephemeral/session-a' } });
  it('reports preview and missing sandbox as unavailable with unknown counts', async () => {
    expect(await new PreviewProvider().inspectWorkspace(session())).toMatchObject({ state: 'unavailable', dirtyFiles: null, aheadCommits: null });
    expect(await provider().inspectWorkspace({ ...session(), sandboxId: null })).toMatchObject({ state: 'unavailable', headSha: null });
  });
  it('uses a GET to decline paused workspaces without a connect or timeout mutation', async () => {
    inspectionGET.mockReset().mockResolvedValue({ data: { state: 'paused' } });
    const connect = vi.spyOn(Sandbox, 'connect'), timeout = vi.spyOn(Sandbox, 'setTimeout');
    expect(await provider().inspectWorkspace(session())).toMatchObject({ state: 'unavailable', aheadCommits: null });
    expect(inspectionGET).toHaveBeenCalledTimes(1);
    expect(inspectionGET.mock.calls[0][0]).toBe('/sandboxes/{sandboxID}');
    expect(connect).not.toHaveBeenCalled(); expect(timeout).not.toHaveBeenCalled();
  });
  it('checks exact workspace identity before accessing commands', async () => {
    inspectionGET.mockReset().mockResolvedValue({ data: { ...runningInfo(), metadata: { ephemeral_session_id: 'another-session' } } });
    inspectionCommand.mockReset();
    expect(await provider().inspectWorkspace(session())).toMatchObject({ state: 'unavailable', dirtyFiles: null });
    expect(inspectionCommand).not.toHaveBeenCalled();
  });
  it('reads a running workspace without connection or timeout mutations and rejects truncated transport', async () => {
    inspectionGET.mockReset().mockResolvedValue({ data: runningInfo() });
    const sha = 'a'.repeat(40);
    inspectionCommand.mockReset().mockImplementation(async (command: string) => {
      let stdout = '';
      if (command.includes('"symbolic-ref"')) stdout = 'ephemeral/session-a\n';
      else if (command.includes('"for-each-ref"')) stdout = `refs/heads/ephemeral/session-a\t${sha}\n`;
      else if (command.includes('"--is-shallow-repository"')) stdout = 'false\n';
      else if (command.includes('"rev-parse"')) stdout = `${sha}\n`;
      else if (command.includes('"remote"')) stdout = 'https://gateway.example.test/gateway/git/session-a.git\n';
      else if (command.includes('"ls-remote"')) stdout = `${sha}\trefs/heads/ephemeral/session-a\n`;
      else if (command.includes('"rev-list"')) stdout = '0\n';
      return { exitCode: 0, stdout: `${JSON.stringify({ exitCode: 0, stdout: Buffer.from(stdout).toString('base64') })}\nEPHEMERAL_INSPECTION_COMPLETE\n` };
    });
    const connect = vi.spyOn(Sandbox, 'connect'), timeout = vi.spyOn(Sandbox, 'setTimeout');
    expect(await provider().inspectWorkspace(session())).toMatchObject({ state: 'known', aheadCommits: 0, headSha: sha, remoteSha: sha });
    expect(connect).not.toHaveBeenCalled(); expect(timeout).not.toHaveBeenCalled();
    for (const [, options] of inspectionCommand.mock.calls) {
      expect(options.user).toBe('user'); expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.timeoutMs).toBeLessThanOrEqual(16_000);
    }
    inspectionCommand.mockResolvedValue({ exitCode: 0, stdout: '{"exitCode":0,"stdout":""}' });
    expect(await provider().inspectWorkspace(session())).toMatchObject({ state: 'unknown', dirtyFiles: null, aheadCommits: null });
  });
});
