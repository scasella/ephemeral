import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyEnvironmentProfile, isEnvironmentProfile, isEnvironmentRef } from '../shared/environments.js';
import { copyResolvedEnvironmentProfile, EnvironmentError, environmentProfileRevision, loadEnvironmentCatalog, resolveEnvironmentRef } from '../server/environments.js';
import { readConfig, ConfigurationError } from '../server/config.js';

const directories: string[] = [];
function catalogFile(input: unknown, raw = false) {
  const directory = mkdtempSync(join(tmpdir(), 'ephemeral-environments-')); directories.push(directory);
  const path = join(directory, 'profiles.json'); writeFileSync(path, raw ? String(input) : JSON.stringify(input)); return path;
}
const custom = () => ({ id: 'node', name: 'Node.js', description: 'Node.js with pinned TypeScript.', templateRef: 'team/ephemeral-node:release-oak', tools: ['Node.js', 'TypeScript 7.0.2'] });
const load = (input: unknown) => loadEnvironmentCatalog({ mode: 'live', templateId: 'legacy-template', profilesFile: catalogFile(input) });
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('server-owned environment catalog', () => {
  it('preserves default aliases and namespaced/tagged references and adds validated operator profiles', () => {
    const catalog = load([custom()]);
    expect(catalog.defaultId).toBe('default'); expect(catalog.profiles.map(p => p.id)).toEqual(['default', 'node']);
    expect(catalog.profiles[0].templateRef).toBe('legacy-template');
    expect(loadEnvironmentCatalog({ mode: 'live', templateId: 'team/legacy-template:default' }).profiles[0].templateRef).toBe('team/legacy-template:default');
    const selected = catalog.profiles[1];
    expect(resolveEnvironmentRef(catalog, { id: selected.id, revision: selected.revision })).toEqual(selected);
  });
  it('hashes canonical profile data independent of object/tool order and changes when data changes', () => {
    const source = custom(), reordered = { ...source, tools: [...source.tools].reverse() };
    const digest = environmentProfileRevision(source);
    expect(digest).toBe(environmentProfileRevision(reordered));
    expect(digest).toBe(createHash('sha256').update(JSON.stringify({ id: source.id, name: source.name, description: source.description, templateRef: source.templateRef, tools: [...source.tools].sort() })).digest('hex'));
    for (const field of ['id', 'name', 'description', 'templateRef'] as const) expect(environmentProfileRevision({ ...source, [field]: `${source[field]}x` })).not.toBe(digest);
    expect(environmentProfileRevision({ ...source, tools: ['Python'] })).not.toBe(digest);
  });
  it('returns copies and detects unknown, stale, malformed and arbitrary browser template overrides', () => {
    const catalog = load([custom()]), profile = catalog.profiles[1];
    const resolved = resolveEnvironmentRef(catalog, { id: profile.id, revision: profile.revision });
    resolved.tools.push('Other'); resolved.templateRef = 'changed:v1'; expect(profile.tools).not.toContain('Other');
    for (const ref of [{ id: 'unknown', revision: profile.revision }, { id: profile.id, revision: '0'.repeat(64) }, { id: profile.id, revision: profile.revision + '\n' }, { id: profile.id, revision: profile.revision, templateRef: 'attacker:v1' }, null, 'node', {}]) {
      expect(() => resolveEnvironmentRef(catalog, ref)).toThrow(EnvironmentError);
      try { resolveEnvironmentRef(catalog, ref); } catch (error) { expect(error).toMatchObject({ status: 409 }); }
    }
    expect(isEnvironmentRef({ id: profile.id, revision: profile.revision })).toBe(true);
  });
  it('validates snapshot content and tools without retaining aliases', () => {
    const profile = load([custom()]).profiles[1], copy = copyEnvironmentProfile(profile);
    profile.tools.push('Python'); expect(copy.tools).not.toContain('Python');
    expect(() => copyResolvedEnvironmentProfile(profile)).toThrow(EnvironmentError);
    expect(isEnvironmentProfile({ ...copy, tools: ['bad\nvalue'] })).toBe(false);
    expect(() => copyEnvironmentProfile({ ...copy, extra: 'field' } as typeof copy)).toThrow();
  });
  it('publishes only explicit simulation examples in preview without reading a supplied private file', () => {
    const catalog = loadEnvironmentCatalog({ mode: 'preview', templateId: 'private-operator-template', profilesFile: '/nonexistent/private/catalog' });
    expect(catalog.profiles).toHaveLength(3);
    for (const profile of catalog.profiles) { expect(profile.name).toContain('simulation'); expect(profile.description).toContain('Simulated'); }
    expect(JSON.stringify(catalog)).not.toContain('private-operator-template');
  });
  it.each([
    null, {}, [custom(), custom()], [{ ...custom(), id: 'default' }], [{ ...custom(), id: 'node\n' }], [{ ...custom(), id: '../node' }], [{ ...custom(), id: 'a'.repeat(49) }],
    [{ ...custom(), templateRef: 'template:v1\n' }], [{ ...custom(), templateRef: 'untagged' }], [{ ...custom(), templateRef: 'template:latest' }], [{ ...custom(), templateRef: 'template:default' }],
    [{ ...custom(), templateRef: 'https://evil.test/template:v1' }], [{ ...custom(), templateRef: '../template:v1' }], [{ ...custom(), templateRef: 'team/nested/template:v1' }],
    [{ ...custom(), templateRef: 'template:$(touch)' }], [{ ...custom(), templateRef: 'e2b_private_value:v1' }],
    [{ ...custom(), name: 'x\u0000y' }], [{ ...custom(), description: 'x\u200by' }], [{ ...custom(), description: 'https://private.test' }],
    [{ ...custom(), tools: ['sk-private-key'] }], [{ ...custom(), tools: ['Node', 'Node'] }], [{ ...custom(), tools: [null] }],
    [{ ...custom(), revision: 'caller-supplied' }], [{ ...custom(), command: 'install' }],
  ])('rejects unsafe catalog input without echoing it (%j)', input => { expect(() => load(input)).toThrow(EnvironmentError); });
  it('bounds bytes and profile counts, rejects nonfiles, and sanitizes configuration errors', () => {
    expect(load(Array.from({ length: 16 }, (_, i) => ({ ...custom(), id: `node-${i}` }))).profiles).toHaveLength(17);
    const padded = '[]' + ' '.repeat(65536 - 2);
    expect(loadEnvironmentCatalog({ mode: 'live', templateId: 'base', profilesFile: catalogFile(padded, true) }).profiles).toHaveLength(1);
    expect(() => load(Array.from({ length: 17 }, (_, i) => ({ ...custom(), id: `node-${i}` })))).toThrow(EnvironmentError);
    expect(() => loadEnvironmentCatalog({ mode: 'live', templateId: 'base', profilesFile: catalogFile(' '.repeat(65537), true) })).toThrow(EnvironmentError);
    expect(() => loadEnvironmentCatalog({ mode: 'live', templateId: 'base', profilesFile: directories[0] })).toThrow(EnvironmentError);
    expect(() => readConfig({ EPHEMERAL_MODE: 'live', NODE_ENV: 'production', PUBLIC_URL: 'https://control.test', E2B_API_KEY: 'test', E2B_TEMPLATE_ID: 'base', GITHUB_APP_ID: '1', GITHUB_APP_SLUG: 'test', GITHUB_CLIENT_ID: 'test', GITHUB_CLIENT_SECRET: 'test', GITHUB_APP_PRIVATE_KEY: 'test', ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'), ALLOWED_GITHUB_IDS: '1', ENVIRONMENT_PROFILES_FILE: '/private-catalog-secret' })).toThrow(ConfigurationError);
  });
  it('rejects symbolic links and FIFOs without opening a blocking stream', () => {
    const target = catalogFile([custom()]), directory = directories.at(-1)!;
    const link = join(directory, 'catalog-link.json'); symlinkSync(target, link);
    expect(() => loadEnvironmentCatalog({ mode: 'live', templateId: 'base', profilesFile: link })).toThrow(EnvironmentError);
    const fifo = join(directory, 'catalog-fifo');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    expect(() => loadEnvironmentCatalog({ mode: 'live', templateId: 'base', profilesFile: fifo })).toThrow(EnvironmentError);
  });

});
