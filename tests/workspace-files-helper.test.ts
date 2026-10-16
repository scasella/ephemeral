import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { workspaceFilesCommand, workspaceFilesSource, WORKSPACE_FILES_FRAME, type WorkspaceFileRequest } from '../server/infra/workspace-files.js';
import { validateWorkspacePath, validateWorkspaceWrite, parseWorkspaceDirectory, parseWorkspaceFile } from '../server/workspace-files.js';
import { WORKSPACE_FILE_MAX_BYTES } from '../shared/workspace-files.js';

let root: string;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function run(request: WorkspaceFileRequest, transform = (source: string) => source) {
  const result = spawnSync('python3', ['-I', '-c', transform(workspaceFilesSource(request, root, true))], {
    input: JSON.stringify(request) + '\n', encoding: 'utf8', timeout: 12_000, maxBuffer: 2_000_000,
  });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.endsWith(WORKSPACE_FILES_FRAME), result.stderr).toBe(true);
  return JSON.parse(result.stdout.slice(0, -WORKSPACE_FILES_FRAME.length));
}
async function runOpenStdin(request: WorkspaceFileRequest, input: string, transform = (source: string) => source) {
  const child = spawn('python3', ['-I', '-c', transform(workspaceFilesSource(request, root, true))]);
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  // Consume EPIPE when deliberately malformed/over-limit input ends the reader early.
  child.stdin.on('error', () => {});
  const result = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject); child.once('close', status => resolve({ status, stdout, stderr }));
  });
  child.stdin.write(input); // Deliberately do not end stdin: framing must be sufficient.
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try { return await result; } finally { clearTimeout(timer); child.stdin.destroy(); }
}
function afterTemp(code: string) {
  return (source: string) => source.replace('os.fchmod(tempfd,mode); os.fsync(tempfd)', `os.fchmod(tempfd,mode); os.fsync(tempfd)\n                ${code}`);
}
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'ephemeral-files-'))); mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/app.ts'), 'original\n'); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('bounded descriptor-relative repository file helper', () => {
  it('lists direct entries and reads/updates UTF-8 without changing executable mode', () => {
    const path = 'src/app.ts'; chmodSync(join(root, path), 0o751);
    expect(run({ operation: 'list', path: '' }).value.entries).toEqual([{ name: 'src', path: 'src', kind: 'directory' }]);
    const before = run({ operation: 'read', path }).value;
    expect(before).toEqual({ path, content: 'original\n', version: hash('original\n'), simulation: false });
    expect(parseWorkspaceFile(before)).toEqual(before);
    const content = 'héllo 🌍\n\tline\r\n';
    expect(run({ operation: 'write', path, content, expectedVersion: before.version })).toMatchObject({ ok: true, value: { content, version: hash(content) } });
    expect(readFileSync(join(root, path), 'utf8')).toBe(content);
    expect(statSync(join(root, path)).mode & 0o777).toBe(0o751);
    expect(readdirSync(join(root, 'src'))).toEqual(['app.ts']);
  });
  it('creates a new file atomically and refuses overwrite, stale versions and deleted targets', () => {
    const request = { operation: 'write' as const, path: 'src/new ü.ts', content: 'new', expectedVersion: null };
    expect(run(request)).toMatchObject({ ok: true, value: { path: request.path, content: 'new' } });
    expect(run(request)).toEqual({ ok: false, status: 409, code: 'conflict' });
    expect(run({ ...request, path: 'src/app.ts', expectedVersion: hash('old') })).toEqual({ ok: false, status: 409, code: 'conflict' });
    expect(run({ ...request, path: 'src/missing.ts', expectedVersion: hash('old') })).toEqual({ ok: false, status: 409, code: 'conflict' });
    expect(run({ ...request, path: 'missing/file.ts' })).toEqual({ ok: false, status: 404, code: 'not_found' });
  });
  it.each(['../escape', '/etc/passwd', '.git/config', 'src/.GiT/x', 'a//b', 'a/./b', 'a/../b', 'a/', 'a\\b', 'C:foo', 'a\nfile', 'a\u0085file', '\ud800', 'a/'.repeat(33) + 'x', 'é'.repeat(513)])('rejects invalid path %j before execution', path => {
    expect(() => validateWorkspacePath(path)).toThrow();
    expect(() => workspaceFilesSource({ operation: 'read', path }, root)).toThrow();
  });
  it('also validates the Python boundary and excludes protected metadata from listing', () => {
    mkdirSync(join(root, '.git')); writeFileSync(join(root, '.git/config'), 'secret');
    expect(run({ operation: 'list', path: '' }).value.entries).toHaveLength(1);
    for (const path of ['../x', 'src/.GiT/config', 'a\\b', '/etc/passwd']) {
      expect(run({ operation: 'read', path: 'src/app.ts' }, source => source.replace('path=REQUEST.get(\'path\');', `REQUEST['path']=${JSON.stringify(path)}; path=REQUEST.get('path');`)))
        .toEqual({ ok: false, status: 400, code: 'invalid_path' });
    }
  });
  it('rejects symlink leaves, symlink ancestors, root symlinks, hard links, directories and FIFOs', () => {
    writeFileSync(join(root, 'secret'), 'private');
    symlinkSync('secret', join(root, 'link')); symlinkSync('src', join(root, 'alias')); linkSync(join(root, 'secret'), join(root, 'hard'));
    expect(spawnSync('mkfifo', [join(root, 'pipe')]).status).toBe(0);
    for (const path of ['link', 'alias/app.ts', 'hard', 'secret', 'src', 'pipe']) {
      expect(run({ operation: 'read', path })).toEqual({ ok: false, status: 415, code: 'unsupported' });
      expect(run({ operation: 'write', path, content: 'overwrite', expectedVersion: hash('private') })).toEqual({ ok: false, status: 415, code: 'unsupported' });
    }
    const entries = run({ operation: 'list', path: '' }).value.entries;
    for (const name of ['link', 'alias', 'hard', 'secret', 'pipe']) expect(entries.find((entry: { name: string }) => entry.name === name).kind).toBe('unavailable');
    const alias = `${root}-alias`; symlinkSync(root, alias);
    try {
      const result = run({ operation: 'read', path: 'src/app.ts' }, source => source.replace(`ROOT = ${JSON.stringify(root)}`, `ROOT = ${JSON.stringify(alias)}`));
      expect(result).toEqual({ ok: false, status: 415, code: 'unsupported' });
    } finally { rmSync(alias); }
    expect(readFileSync(join(root, 'secret'), 'utf8')).toBe('private');
  });
  it('detects invalid UTF-8, binary controls and over-limit bytes with bounded reads', () => {
    for (const data of [Buffer.from([0xff, 0xfe]), Buffer.from('a\0b'), Buffer.from('a\u0085b')]) {
      writeFileSync(join(root, 'binary'), data);
      expect(run({ operation: 'read', path: 'binary' })).toEqual({ ok: false, status: 415, code: 'unsupported' });
    }
    writeFileSync(join(root, 'large'), Buffer.alloc(WORKSPACE_FILE_MAX_BYTES + 1, 65));
    expect(run({ operation: 'read', path: 'large' })).toEqual({ ok: false, status: 413, code: 'too_large' });
    expect(() => validateWorkspaceWrite({ path: 'large', content: 'é'.repeat(65537), expectedVersion: null })).toThrow('128 KiB');
    expect(() => validateWorkspaceWrite({ path: 'binary', content: '\0', expectedVersion: null })).toThrow('UTF-8');
    expect(() => validateWorkspaceWrite({ path: 'binary', content: '\udfff', expectedVersion: null })).toThrow('invalid');
  });
  it('transports full-size control-rich text by stdin with a constant small command', () => {
    const content = '\t\n\r"\\'.repeat(26214) + 'ab'; // Exactly 128 KiB before JSON escaping.
    expect(Buffer.byteLength(content)).toBe(WORKSPACE_FILE_MAX_BYTES);
    const request = { operation: 'write' as const, path: 'max.txt', content, expectedVersion: null };
    expect(Buffer.byteLength(workspaceFilesCommand(request))).toBeLessThan(16_000);
    expect(workspaceFilesCommand(request)).not.toContain(content);
    expect(run(request)).toMatchObject({ ok: true, value: { content, version: hash(content) } });
    expect(readFileSync(join(root, 'max.txt'), 'utf8')).toBe(content);
  });
  it('completes a full-size stdin frame even when the writer deliberately keeps stdin open', async () => {
    const content = '\t\n\r"\\'.repeat(26214) + 'ab';
    const request = { operation: 'write' as const, path: 'open-stdin.txt', content, expectedVersion: null };
    const result = await runOpenStdin(request, JSON.stringify(request) + '\n');
    expect(result.status, result.stderr).toBe(0); expect(result.stderr).toBe('');
    expect(result.stdout.endsWith(WORKSPACE_FILES_FRAME)).toBe(true);
    expect(JSON.parse(result.stdout.slice(0, -WORKSPACE_FILES_FRAME.length))).toMatchObject({ ok: true, value: { content, version: hash(content) } });
    expect(readFileSync(join(root, request.path), 'utf8')).toBe(content);
  });
  it('frames input failures, including an incomplete open stream that reaches the helper alarm', async () => {
    const request = { operation: 'read' as const, path: 'src/app.ts' };
    const source = workspaceFilesSource(request, root, true);
    for (const input of ['{invalid}\n', JSON.stringify(request), 'x'.repeat(1_000_001) + '\n']) {
      const result = spawnSync('python3', ['-I', '-c', source], { input, encoding: 'utf8', timeout: 12_000, maxBuffer: 2_000_000 });
      expect(result.status, result.stderr).toBe(0); expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout.slice(0, -WORKSPACE_FILES_FRAME.length))).toEqual({ ok: false, status: 400, code: 'invalid_request' });
    }
    const timedOut = await runOpenStdin(request, '{"operation":', source => source.replace('signal.alarm(8)', 'signal.alarm(1)'));
    expect(timedOut.status, timedOut.stderr).toBe(0); expect(timedOut.stderr).toBe('');
    expect(timedOut.stdout.endsWith(WORKSPACE_FILES_FRAME)).toBe(true);
    expect(JSON.parse(timedOut.stdout.slice(0, -WORKSPACE_FILES_FRAME.length))).toEqual({ ok: false, status: 503, code: 'unavailable' });
  });
  it('truncates directory browsing at 200 entries', () => {
    for (let i = 0; i < 205; i++) writeFileSync(join(root, `file-${i}`), 'x');
    const result = run({ operation: 'list', path: '' }).value;
    expect(result.entries).toHaveLength(200); expect(result.truncated).toBe(true);
    expect(parseWorkspaceDirectory(result)).toEqual(result);
  });
  it('rejects in-place Codex edits and inode replacements observed before publication and cleans temp files', () => {
    const request = { operation: 'write' as const, path: 'src/app.ts', content: 'ours', expectedVersion: hash('original\n') };
    expect(run(request, afterTemp("fd=os.open(name,os.O_WRONLY|os.O_TRUNC,dir_fd=parent); os.write(fd,b'codex'); os.close(fd)")))
      .toEqual({ ok: false, status: 409, code: 'conflict' });
    expect(readFileSync(join(root, request.path), 'utf8')).toBe('codex');
    writeFileSync(join(root, request.path), 'original\n');
    expect(run(request, afterTemp("os.unlink(name,dir_fd=parent); fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644,dir_fd=parent); os.write(fd,b'original\\n'); os.close(fd)")))
      .toEqual({ ok: false, status: 409, code: 'conflict' });
    expect(readdirSync(join(root, 'src'))).toEqual(['app.ts']);
  });
  it('rejects ancestor swaps, new-file races and leaf symlink or hardlink races', () => {
    const request = { operation: 'write' as const, path: 'src/app.ts', content: 'ours', expectedVersion: hash('original\n') };
    expect(run(request, afterTemp("os.rename('src','old',src_dir_fd=root,dst_dir_fd=root); os.mkdir('src',dir_fd=root)")))
      .toEqual({ ok: false, status: 409, code: 'conflict' });
    expect(readFileSync(join(root, 'old/app.ts'), 'utf8')).toBe('original\n');
    writeFileSync(join(root, 'src/app.ts'), 'original\n');
    expect(run(request, afterTemp("os.link(name,'hard',src_dir_fd=parent,dst_dir_fd=parent)")))
      .toEqual({ ok: false, status: 415, code: 'unsupported' });
    rmSync(join(root, 'src/hard'));
    expect(run(request, afterTemp("os.unlink(name,dir_fd=parent); os.symlink('../old/app.ts',name,dir_fd=parent)")))
      .toEqual({ ok: false, status: 415, code: 'unsupported' });
    expect(readFileSync(join(root, 'old/app.ts'), 'utf8')).toBe('original\n');
    expect(run({ ...request, path: 'src/new', expectedVersion: null }, afterTemp("fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644,dir_fd=parent); os.write(fd,b'codex'); os.close(fd)")))
      .toEqual({ ok: false, status: 409, code: 'conflict' });
    expect(readFileSync(join(root, 'src/new'), 'utf8')).toBe('codex');
    expect(readdirSync(join(root, 'src')).some(name => name.startsWith('.ephemeral-save-'))).toBe(false);
  });
  it('masks unsafe wire snapshots and rejects malformed write shapes', () => {
    for (const input of [{ path: 'x', content: 'x' }, { path: 'x', content: 'x', expectedVersion: null, secret: true },
      { path: 'x', content: 'x', expectedVersion: 'wrong' }]) expect(() => validateWorkspaceWrite(input)).toThrow();
    expect(() => parseWorkspaceFile({ path: 'x', content: 'x', version: null, simulation: false })).toThrow('unavailable');
    expect(() => parseWorkspaceFile({ path: '../x', content: 'x', version: hash('x'), simulation: false })).toThrow('unavailable');
    expect(() => parseWorkspaceDirectory({ path: '', entries: [{ name: 'x', path: '../x', kind: 'file' }], truncated: false, simulation: false })).toThrow('unavailable');
  });
});
