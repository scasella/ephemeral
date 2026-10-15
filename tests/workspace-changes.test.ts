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
  it('compares an explicit eol=crlf file as one edited line, without modifying bytes or the index', async () => {
    const work = await fixture();
    await writeFile(join(work, '.gitattributes'), 'tracked.txt text eol=crlf\n');
    await writeFile(join(work, 'tracked.txt'), 'one\ntwo\nthree\n');
    await git(work, ['add', '.gitattributes', 'tracked.txt']); await git(work, ['commit', '-m', 'explicit crlf']);
    await writeFile(join(work, 'tracked.txt'), 'one\r\nchanged\r\nthree\r\n');
    const expected = await git(work, ['diff', '--numstat', '--', 'tracked.txt']); expect(expected).toBe('1\t1\ttracked.txt');
    const index = await readFile(join(work, '.git/index')), bytes = await readFile(join(work, 'tracked.txt'));
    const result = await inspect(work, 'tracked.txt');
    expect(result.selected?.state).toBe('text'); expect(result.selected?.reason).toContain('EOL-normalized');
    expect(result.selected?.text).toContain('-two\n+changed\n');
    expect(result.selected?.text).not.toContain('-one'); expect(result.selected?.text).not.toContain('+three');
    expect(result.selected?.text).not.toContain('\r');
    expect(await readFile(join(work, '.git/index'))).toEqual(index); expect(await readFile(join(work, 'tracked.txt'))).toEqual(bytes);
  });
  it('preserves missing final newline and UTF-8 text under an explicit EOL rule', async () => {
    const work = await fixture();
    await writeFile(join(work, '.gitattributes'), 'tracked.txt text eol=crlf\n');
    await writeFile(join(work, 'tracked.txt'), 'café\n日本語');
    await git(work, ['add', '.gitattributes', 'tracked.txt']); await git(work, ['commit', '-m', 'utf8 no final newline']);
    await writeFile(join(work, 'tracked.txt'), 'café\r\n日本語 changed');
    const result = await inspect(work, 'tracked.txt');
    expect(result.selected?.reason).toContain('EOL-normalized'); expect(result.selected?.text).toContain(' café\n');
    expect(result.selected?.text).toContain('-日本語\n\\ No newline at end of file\n+日本語 changed\n\\ No newline at end of file');
    await writeFile(join(work, 'tracked.txt'), Buffer.from([0, 1, 2]));
    expect((await inspect(work, 'tracked.txt')).selected?.state).toBe('binary');
    await writeFile(join(work, 'tracked.txt'), Buffer.from([255]));
    expect((await inspect(work, 'tracked.txt')).selected?.state).toBe('binary');
  });
  it('honestly labels mixed EOL, lone CR, unspecified normalization and unsupported attributes as raw', async () => {
    const work = await fixture();
    await writeFile(join(work, '.gitattributes'), 'tracked.txt text eol=crlf\n');
    await writeFile(join(work, 'tracked.txt'), 'one\ntwo\n');
    await git(work, ['add', '.gitattributes', 'tracked.txt']); await git(work, ['commit', '-m', 'canonical']);
    for (const content of ['one\r\nchanged\n', 'one\rchanged\r']) {
      await writeFile(join(work, 'tracked.txt'), content);
      const result = await inspect(work, 'tracked.txt');
      expect(result.selected?.reason).toContain('Raw UTF-8 byte comparison'); expect(result.selected?.text).toContain(content.replaceAll('\n', '\n+').replace(/\+$/, ''));
    }
    for (const attrs of ['', 'tracked.txt text eol=crlf ident\n', 'tracked.txt text=auto eol=crlf\n', 'tracked.txt -text eol=crlf\n', 'tracked.txt text eol=crlf filter=custom\n', 'tracked.txt text eol=crlf diff=custom\n', 'tracked.txt text eol=crlf -diff\n', 'tracked.txt text eol=crlf working-tree-encoding=UTF-8\n']) {
      await writeFile(join(work, '.gitattributes'), attrs); await writeFile(join(work, 'tracked.txt'), 'one\r\nchanged\r\n');
      const result = await inspect(work, 'tracked.txt');
      expect(result.selected?.reason).toContain('Raw UTF-8 byte comparison'); expect(result.selected?.text).toContain('+one\r\n');
    }
  });
  it('never executes configured clean, smudge or process filters, including while checking status', async () => {
    const work = await fixture(), sentinel = join(work, 'filter-executed');
    // Configure filters only after staging, so the fixture setup cannot run them.
    await writeFile(join(work, '.gitattributes'), 'tracked.txt filter=attack text eol=crlf\n');
    await git(work, ['add', '.gitattributes']); await git(work, ['commit', '-m', 'filter attrs']);
    for (const setting of ['clean', 'smudge', 'process']) await git(work, ['config', `filter.attack.${setting}`, `touch '${sentinel}'; cat`]);
    await git(work, ['config', 'filter.attack.required', 'true']);
    await writeFile(join(work, 'tracked.txt'), 'changed\r\n');
    const index = await readFile(join(work, '.git/index')), bytes = await readFile(join(work, 'tracked.txt'));
    const listed = await inspect(work); expect(listed.state).toBe('known'); expect(listed.files.some(file => file.path === 'tracked.txt')).toBe(true);
    const result = await inspect(work, 'tracked.txt');
    expect(result.selected?.state).toBe('text'); expect(result.selected?.reason).toContain('Raw UTF-8 byte comparison'); expect(result.selected?.text).toContain('+changed\r\n');
    expect(await readFile(join(work, '.git/index'))).toEqual(index); expect(await readFile(join(work, 'tracked.txt'))).toEqual(bytes);
    await expect(readFile(sentinel)).rejects.toThrow();
  });
  it('keeps newly introduced filter configuration inert during a status race', async () => {
    const work = await fixture(), sentinel = join(work, 'raced-filter-executed');
    await writeFile(join(work, '.gitattributes'), 'tracked.txt filter=late\n');
    await git(work, ['add', '.gitattributes']); await git(work, ['commit', '-m', 'late filter attrs']);
    await writeFile(join(work, 'tracked.txt'), 'changed by user\n');
    const source = changeInspectionSource(work, 'tracked.txt').replace('raw=git(status_args)', `
        for setting in ('clean','smudge','process'):
            subprocess.run(['/usr/bin/git','config','filter.late.'+setting,${JSON.stringify(`touch '${sentinel}'; cat`)}],env=env,check=True)
        subprocess.run(['/usr/bin/git','config','filter.late.required','true'],env=env,check=True)
        raw=git(status_args)`);
    const { stdout } = await execute('python3', ['-I', '-c', source]);
    const result = parseWorkspaceChanges(JSON.parse(stdout.slice(0, -CHANGES_FRAME.length)));
    expect(result).toMatchObject({ state: 'known', selected: { state: 'text' } });
    expect(result.selected?.text).toContain('+changed by user'); await expect(readFile(sentinel)).rejects.toThrow();
  });
  it('supports linked worktree gitfiles without using their repository filter configuration', async () => {
    const original = await fixture(), work = await mkdtemp(join(tmpdir(), 'ep-linked-changes-')); cleanup.push(work);
    await git(original, ['worktree', 'add', '-b', 'linked-review', work]);
    await writeFile(join(work, 'tracked.txt'), 'linked worktree edit\n');
    const result = await inspect(work, 'tracked.txt');
    expect(result).toMatchObject({ state: 'known', selected: { state: 'text' } });
    expect(result.selected?.text).toContain('+linked worktree edit');
  });
  it('declines oversized index metadata before running any worktree status', async () => {
    const work = await fixture();
    const source = changeInspectionSource(work, 'tracked.txt').replace('cap=16777216', 'cap=10');
    const { stdout } = await execute('python3', ['-I', '-c', source]);
    expect(parseWorkspaceChanges(JSON.parse(stdout.slice(0, -CHANGES_FRAME.length))))
      .toMatchObject({ state: 'unknown', files: [], selected: null });
  });
  it('uses bounded info attributes as data and rejects metadata changes during inspection', async () => {
    const work = await fixture();
    await writeFile(join(work, '.git/info/attributes'), 'tracked.txt text eol=crlf\n');
    await writeFile(join(work, 'tracked.txt'), 'changed metadata preview\r\n');
    expect((await inspect(work, 'tracked.txt')).selected?.reason).toContain('EOL-normalized');
    for (const mutation of ["open(index_path,'ab').write(b'changed')", "open(info_path,'wb').write(b'tracked.txt -text\\n')"]) {
      const index = await readFile(join(work, '.git/index')), info = await readFile(join(work, '.git/info/attributes'));
      const source = changeInspectionSource(work, 'tracked.txt').replace('def preview(root, file):', `def preview(root, file):\n    ${mutation}`);
      const { stdout } = await execute('python3', ['-I', '-c', source]);
      expect(parseWorkspaceChanges(JSON.parse(stdout.slice(0, -CHANGES_FRAME.length)))).toMatchObject({ state: 'unknown', files: [], selected: null });
      await writeFile(join(work, '.git/index'), index); await writeFile(join(work, '.git/info/attributes'), info);
    }
  });
  it('preserves bounded local info/exclude rules and declines a changing exclude snapshot', async () => {
    const work = await fixture(), excludedText = 'LOCAL-SECRET-TEXT';
    await writeFile(join(work, '.git/info/exclude'), 'local-secret.txt\n');
    await writeFile(join(work, '.gitignore'), 'ignored-by-worktree.txt\n');
    await writeFile(join(work, 'local-secret.txt'), excludedText);
    await writeFile(join(work, 'ignored-by-worktree.txt'), excludedText);
    await writeFile(join(work, 'visible.txt'), 'visible');
    const exclude = await readFile(join(work, '.git/info/exclude'));
    const result = await inspect(work, 'local-secret.txt');
    expect(result).toMatchObject({ state: 'known', selected: { state: 'unavailable', text: null } });
    expect(result.files.map(file => file.path)).toEqual(['.gitignore', 'visible.txt']);
    expect(JSON.stringify(result)).not.toContain(excludedText);
    expect(await readFile(join(work, '.git/info/exclude'))).toEqual(exclude);
    const source = changeInspectionSource(work, 'visible.txt').replace('def preview(root, file):', `def preview(root, file):\n    open(exclude_path,'wb').write(b'new-rule\\n')`);
    const { stdout } = await execute('python3', ['-I', '-c', source]);
    expect(parseWorkspaceChanges(JSON.parse(stdout.slice(0, -CHANGES_FRAME.length))))
      .toMatchObject({ state: 'unknown', files: [], selected: null });
    expect(stdout).not.toContain(excludedText);
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
    const moving = changeInspectionSource(work, 'tracked.txt').replace('def preview(root, file):', `def preview(root, file):\n    subprocess.run(['/usr/bin/git','update-ref','HEAD','HEAD~1'],env=env,check=True)`);
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
    const readerOnly = source.replace("if git(status_args)!=raw or metadata_bytes(index_path)!=index or metadata_bytes(info_path,65536)!=info:", "if False:");
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
