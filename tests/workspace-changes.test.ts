import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox } from 'e2b';
import { changeInspectionSource, CHANGES_FRAME } from '../server/infra/change-inspection.js';
import { isChangePath, parseWorkspaceChanges, unavailableWorkspaceChanges } from '../server/workspace-changes.js';
import { E2BProvider } from '../server/infra/e2b.js';
import { PreviewProvider } from '../server/preview.js';
import type { Session } from '../server/contracts.js';

const execute = promisify(execFile);
const cleanup: string[] = [];
const stubs = vi.hoisted(() => ({ get: vi.fn(), run: vi.fn() }));
vi.mock('e2b', async importOriginal => {
  const actual = await importOriginal<typeof import('e2b')>();
  return { ...actual, ApiClient: class { api = { GET: stubs.get }; }, Sandbox: class extends actual.Sandbox {
    constructor(...args: ConstructorParameters<typeof actual.Sandbox>) {
      super(...args); Object.defineProperty(this, 'commands', { value: { run: stubs.run } });
    }
  } };
});
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(cleanup.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function git(workspace: string, args: string[]) {
  return (await execute('git', ['-C', workspace, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })).stdout.trim();
}
async function fixture() {
  const work = await mkdtemp(join(tmpdir(), 'ep-changes-')); cleanup.push(work);
  await git(work, ['init']); await git(work, ['config', 'user.email', 'test@example.test']); await git(work, ['config', 'user.name', 'Test']);
  for (const name of ['tracked.txt', 'rename.txt', 'delete.txt', 'binary.bin', 'mode.txt']) await writeFile(join(work, name), name === 'binary.bin' ? Buffer.from([0, 1, 2]) : 'original\n');
  await git(work, ['add', '.']); await git(work, ['commit', '-m', 'base']);
  return work;
}
async function inspect(work: string, path?: string) {
  const { stdout } = await execute('python3', ['-I', '-c', changeInspectionSource(work, path)], { timeout: 12_000, maxBuffer: 2_000_000 });
  expect(stdout.endsWith(CHANGES_FRAME)).toBe(true);
  return parseWorkspaceChanges(JSON.parse(stdout.slice(0, -CHANGES_FRAME.length)));
}

describe('read-only bounded change snapshots', () => {
  it('combines staged and unstaged content against HEAD without changing index or HEAD', async () => {
    const work = await fixture();
    await writeFile(join(work, 'tracked.txt'), 'staged\n'); await git(work, ['add', 'tracked.txt']);
    await writeFile(join(work, 'tracked.txt'), 'final unstaged\n');
    const index = await readFile(join(work, '.git/index')), head = await git(work, ['rev-parse', 'HEAD']);
    const result = await inspect(work, 'tracked.txt');
    expect(result).toMatchObject({ state: 'known', headSha: head, listTruncated: false, selected: { state: 'text', truncated: false } });
    expect(result.files).toContainEqual({ path: 'tracked.txt', oldPath: null, status: 'MM', kind: 'tracked' });
    expect(result.selected?.text).toContain('-original'); expect(result.selected?.text).toContain('+final unstaged');
    expect(result.selected?.text).not.toContain('+staged');
    expect(await readFile(join(work, '.git/index'))).toEqual(index); expect(await git(work, ['rev-parse', 'HEAD'])).toBe(head);
  });
  it('preserves strange names and rename origins, previews deletion and missing final newline', async () => {
    const work = await fixture(), strange = "-glob*[quote]'\n.txt";
    await git(work, ['mv', '--', 'rename.txt', strange]); await writeFile(join(work, strange), 'renamed without newline');
    await rm(join(work, 'delete.txt'));
    const result = await inspect(work, strange);
    expect(result.files).toContainEqual({ path: strange, oldPath: 'rename.txt', status: 'RM', kind: 'tracked' });
    expect(result.selected?.text).toContain('-original'); expect(result.selected?.text).toContain('+renamed without newline');
    expect(result.selected?.text).toContain('\\ No newline at end of file');
    const deletion = await inspect(work, 'delete.txt'); expect(deletion.selected?.state).toBe('text'); expect(deletion.selected?.text).toContain('-original');
    await rename(join(work, strange), join(work, 'unstaged-name.txt'));
    const changed = await inspect(work, strange);
    expect(changed.files).toContainEqual({ path: strange, oldPath: 'rename.txt', status: 'RD', kind: 'tracked' });
    expect(changed.selected?.text).toContain('-original'); expect(changed.selected?.text).not.toContain('renamed without newline');
    expect((await inspect(work, 'unstaged-name.txt')).selected?.text).toBe('renamed without newline');
  });
  it('explicitly reports binary, non-UTF8, oversized, symlink and absent selections', async () => {
    const work = await fixture();
    await writeFile(join(work, 'binary.bin'), Buffer.from([0, 3]));
    await writeFile(join(work, 'invalid'), Buffer.from([255]));
    await writeFile(join(work, 'large.txt'), 'x'.repeat(65537));
    await symlink('/etc/passwd', join(work, 'link'));
    expect((await inspect(work, 'binary.bin')).selected?.state).toBe('binary');
    expect((await inspect(work, 'invalid')).selected?.state).toBe('binary');
    expect((await inspect(work, 'large.txt')).selected?.state).toBe('too_large');
    expect((await inspect(work, 'link')).selected).toMatchObject({ state: 'symlink', text: null });
    expect((await inspect(work, 'missing')).selected).toMatchObject({ state: 'unavailable', text: null });
    expect((await inspect(work, 'tracked.txt')).selected?.state).toBe('unavailable');
  });
  it('does not execute repository fsmonitor, hooks, external diff or textconv commands', async () => {
    const work = await fixture(), sentinel = join(work, 'executed');
    await writeFile(join(work, 'tracked.txt'), 'changed\n');
    await git(work, ['config', 'core.fsmonitor', `touch ${sentinel}`]);
    await git(work, ['config', 'diff.external', `touch ${sentinel}`]);
    await git(work, ['config', 'diff.attack.textconv', `touch ${sentinel}`]);
    await writeFile(join(work, '.gitattributes'), '*.txt diff=attack\n');
    expect((await inspect(work, 'tracked.txt')).selected?.text).toContain('+changed');
    await expect(readFile(sentinel)).rejects.toThrow();
  });
  it('shows deletion when the parent directory is removed and labels mode-only differences', async () => {
    const work = await fixture(); await mkdir(join(work, 'nested')); await writeFile(join(work, 'nested/file'), 'nested base\n');
    await git(work, ['add', 'nested']); await git(work, ['commit', '-m', 'nested']); await rm(join(work, 'nested'), { recursive: true });
    expect((await inspect(work, 'nested/file')).selected?.text).toContain('-nested base');
    await git(work, ['update-index', '--chmod=+x', 'mode.txt']);
    const mode = await inspect(work, 'mode.txt'); expect(mode.selected?.text).toContain('No text content difference from HEAD. Git status:');
  });
  it('declines conflict previews and reports unknown for output overflow and changing HEAD', async () => {
    const work = await fixture(), original = await git(work, ['branch', '--show-current']);
    await git(work, ['checkout', '-b', 'other']); await writeFile(join(work, 'tracked.txt'), 'other\n'); await git(work, ['commit', '-am', 'other']);
    await git(work, ['checkout', original]); await writeFile(join(work, 'tracked.txt'), 'ours\n'); await git(work, ['commit', '-am', 'ours']);
    await expect(git(work, ['merge', 'other'])).rejects.toThrow();
    expect((await inspect(work, 'tracked.txt')).selected).toMatchObject({ state: 'unavailable', text: null });
    const overflow = changeInspectionSource(work).replace('cap=1048576', 'cap=10');
    const { stdout } = await execute('python3', ['-I', '-c', overflow]);
    expect(parseWorkspaceChanges(JSON.parse(stdout.slice(0, -CHANGES_FRAME.length)))).toMatchObject({ state: 'unknown', headSha: null, files: [], selected: null });
    const moving = changeInspectionSource(work, 'tracked.txt').replace('def preview(root, file):', `def preview(root, file):\n    git(['update-ref','HEAD','HEAD~1'])`);
    const raced = await execute('python3', ['-I', '-c', moving]);
    expect(parseWorkspaceChanges(JSON.parse(raced.stdout.slice(0, -CHANGES_FRAME.length)))).toMatchObject({ state: 'unknown', files: [], selected: null });
  });
  it('caps the list and declines selected paths outside the bounded snapshot', async () => {
    const work = await fixture();
    await Promise.all(Array.from({ length: 205 }, (_, n) => writeFile(join(work, `new-${String(n).padStart(3, '0')}`), 'text')));
    const result = await inspect(work, 'new-204'); expect(result.state).toBe('known');
    expect(result.files).toHaveLength(200); expect(result.listTruncated).toBe(true); expect(result.selected?.state).toBe('unavailable');
  });
  it('rejects traversal and handles parent-directory symlink replacement without exposing external text', async () => {
    for (const path of ['', '../secret', '/etc/passwd', 'a/../secret', 'a/./b', 'a//b', 'a\0b', 'C:/secret']) {
      expect(isChangePath(path)).toBe(false); expect(() => changeInspectionSource('/workspace', path)).toThrow();
    }
    expect(isChangePath('a\\b')).toBe(true);
    const work = await fixture(); await mkdir(join(work, 'nested')); await writeFile(join(work, 'nested/passwd'), 'safe');
    // Replace an ancestor between the status observation and the secure selected read.
    const source = changeInspectionSource(work, 'nested/passwd').replace('def preview(root, file):', `def preview(root, file):\n    os.rename('nested','previous')\n    os.symlink('/etc','nested')`);
    const { stdout } = await execute('python3', ['-I', '-c', source]);
    const result = parseWorkspaceChanges(JSON.parse(stdout.slice(0, -CHANGES_FRAME.length)));
    expect(result.state).toBe('unknown'); expect(result.selected).toBeNull(); expect(stdout).not.toContain('root:');
    await rm(join(work, 'nested')); await rename(join(work, 'previous'), join(work, 'nested'));
    // Isolate the reader's safety check from the later Git coherence check.
    const readerOnly = source.replace("if git(['rev-parse','--verify','HEAD'],100).decode('ascii').strip()!=head or git(status_args)!=raw:", "if False:");
    const isolated = await execute('python3', ['-I', '-c', readerOnly]);
    const snapshot = parseWorkspaceChanges(JSON.parse(isolated.stdout.slice(0, -CHANGES_FRAME.length)));
    expect(snapshot).toMatchObject({ state: 'known', selected: { state: 'unavailable', text: null } });
    expect(isolated.stdout).not.toContain('root:');
  });
});

const session = (): Session => ({ id: 'session', userId: 'owner', sandboxId: 'sandbox', repository: 'org/repo', repositoryId: 1,
  installationId: 1, baseBranch: 'main', branch: 'work', state: 'running', createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(), maxExpiresAt: new Date(Date.now() + 120_000).toISOString(),
  endedAt: null, error: null, codexRemoteRevocation: 'unverified', cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' } });
const info = () => ({ sandboxID: 'sandbox', state: 'running', envdVersion: '0.4.0', envdAccessToken: 'SECRET', lifecycle: { autoResume: false },
  metadata: { ephemeral_session_id: 'session', ephemeral_user_id: 'owner', ephemeral_repository: 'org/repo', ephemeral_repository_id: '1', ephemeral_branch: 'work' } });
const provider = () => new E2BProvider({ apiKey: 'SECRET', templateId: 'test', gatewayUrl: 'https://gateway.example.test' });
beforeEach(() => { stubs.get.mockReset().mockResolvedValue({ data: info() }); stubs.run.mockReset(); });
describe('change inspection provider boundaries', () => {
  it('verifies exact running identity and deadlines without resuming or extending TTL', async () => {
    const connect = vi.spyOn(Sandbox, 'connect'), timeout = vi.spyOn(Sandbox, 'setTimeout'), create = vi.spyOn(Sandbox, 'create');
    const snapshot = { ...unavailableWorkspaceChanges(''), state: 'known', reason: null, headSha: 'a'.repeat(40) };
    stubs.run.mockResolvedValue({ exitCode: 0, stdout: JSON.stringify(snapshot) + CHANGES_FRAME });
    const s = session(), original = structuredClone(s);
    expect(await provider().inspectChanges(s)).toMatchObject({ state: 'known' }); expect(s).toEqual(original);
    expect(stubs.run.mock.calls[0][1]).toMatchObject({ user: 'user', timeoutMs: 10_000 });
    expect(stubs.run.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(connect).not.toHaveBeenCalled(); expect(timeout).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    stubs.run.mockClear();
    for (const data of [{ ...info(), state: 'paused' }, { ...info(), metadata: { ...info().metadata, ephemeral_repository_id: '2' } }, { ...info(), sandboxID: 'other' }, { ...info(), endAt: 'invalid' }, { ...info(), endAt: new Date(0).toISOString() }]) {
      stubs.get.mockResolvedValueOnce({ data }); expect((await provider().inspectChanges(s)).state).toBe('unavailable');
    }
    expect((await provider().inspectChanges({ ...s, maxExpiresAt: new Date(0).toISOString() })).state).toBe('unavailable');
    expect(stubs.run).not.toHaveBeenCalled();
  });
  it('masks SDK errors, rejects incomplete frames and cannot inspect invalid paths', async () => {
    stubs.run.mockRejectedValueOnce(new Error('SECRET')); const failed = await provider().inspectChanges(session());
    expect(failed.state).toBe('unknown'); expect(JSON.stringify(failed)).not.toContain('SECRET');
    stubs.run.mockResolvedValue({ exitCode: 0, stdout: '{}' }); expect((await provider().inspectChanges(session())).state).toBe('unknown');
    stubs.get.mockClear(); expect((await provider().inspectChanges(session(), '../secret')).state).toBe('unavailable'); expect(stubs.get).not.toHaveBeenCalled();
    expect((await new PreviewProvider().inspectChanges(session())).state).toBe('unavailable');
  });
});
