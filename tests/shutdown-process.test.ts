import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function run(mode: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', fileURLToPath(new URL('./fixtures/shutdown-process.ts', import.meta.url)), mode], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), env: { PATH: process.env.PATH, NODE_ENV: 'production' },
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Shutdown fixture timed out: ${mode}`)); }, 5000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
describe('process shutdown (isolated Node children)', () => {
  it('waits for initialization before closing on a startup signal', async () => {
    const result = await run('signal-during-init'); expect(result.code).toBe(0);
    expect(result.stdout).toContain('initialization completed\nclose started\nclose completed');
    expect(result.stdout).not.toContain('listening');
  });
  it('closes resources and exits nonzero when the main listener cannot start', async () => {
    const result = await run('startup-error'); expect(result.code).toBe(1); expect(result.stdout).toContain('close completed');
  });
  it('closes resources and exits nonzero on fatal database ownership loss', async () => {
    const result = await run('fatal'); expect(result.code).toBe(1); expect(result.stdout).toContain('close completed');
    expect(result.stderr).toContain('Database ownership was lost; shutting down.');
  });
  it('sanitizes unexpected application startup failures', async () => {
    const result = await run('unexpected-startup-error'); expect(result.code).toBe(1);
    expect(result.stderr).toContain('Ephemeral could not start or lost database ownership.');
    expect(result.stderr).not.toMatch(/synthetic-private-value|fixture-key|Bearer|Error: Injected/);
  });
  it('starts the hard deadline for fatal ownership loss during initialization', async () => {
    const result = await run('fatal-during-init-hang'); expect(result.code).toBe(1);
    expect(result.stderr).toContain('Database ownership was lost; shutting down.');
  });
  it('exits nonzero by its independent hard deadline if a resource never closes', async () => {
    const result = await run('hanging-close'); expect(result.code).toBe(1); expect(result.stdout).toContain('close started');
    expect(result.stdout).not.toContain('close completed');
  });
});
