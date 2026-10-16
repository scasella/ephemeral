import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentCatalog, EnvironmentProfile } from '../shared/environments';
import { EnvironmentSelector, RecordedEnvironment, SavedEnvironmentReference, selectedEnvironmentRef } from './EnvironmentSelection';
import { EnvironmentCatalogLoader, environmentPreferenceKey, environmentRef, initialEnvironmentSelection, maxEnvironmentPreferences, readEnvironmentPreference, sameEnvironment, saveEnvironmentPreference, validEnvironmentCatalog } from './environment-selection';
const profile: EnvironmentProfile = { id: 'default', name: 'Common tools', description: 'Common command line tools.', templateRef: 'ephemeral-default', tools: ['Git', 'Node.js'], revision: 'a'.repeat(64) };
const node: EnvironmentProfile = { ...profile, id: 'node', name: 'Node projects', templateRef: 'ephemeral-node:2026.10', revision: 'b'.repeat(64) };
const catalog: EnvironmentCatalog = { defaultId: 'default', profiles: [profile, node] };
function memory() { const data = new Map<string, string>(); return { data, getItem: (key: string) => data.get(key) || null, setItem: (key: string, value: string) => { data.set(key, value); } }; }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('account and repository profile preferences', () => {
  it('persists only the bounded profile reference for the exact account and repository', () => {
    const storage = memory();
    expect(saveEnvironmentPreference(storage, 'live:alice', 101, environmentRef(node))).toBe(true);
    expect(readEnvironmentPreference(storage, 'live:alice', 101)).toEqual(environmentRef(node));
    for (const [account, repository] of [['live:bob', 101], ['preview:alice', 101], ['live:alice', 102]] as const) expect(readEnvironmentPreference(storage, account, repository)).toBeUndefined();
    const raw = storage.getItem(environmentPreferenceKey)!;
    expect(raw).not.toContain('Node projects'); expect(raw).not.toContain('templateRef'); expect(raw).not.toContain('tools');
    saveEnvironmentPreference(storage, 'live:alice', 101, environmentRef(profile));
    expect(readEnvironmentPreference(storage, 'live:alice', 101)).toEqual(environmentRef(profile));
    for (let index = 0; index < maxEnvironmentPreferences + 5; index++) saveEnvironmentPreference(storage, 'live:alice', index + 200, environmentRef(node));
    expect(JSON.parse(storage.getItem(environmentPreferenceKey)!)).toHaveLength(maxEnvironmentPreferences);
    expect(readEnvironmentPreference(storage, 'live:alice', 101)).toBeUndefined();
  });
  it('handles denied, oversized and malformed browser storage without blocking explicit selection', () => {
    const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    expect(readEnvironmentPreference(denied, 'a', 1)).toBeUndefined(); expect(saveEnvironmentPreference(denied, 'a', 1, environmentRef(profile))).toBe(false);
    const storage = memory();
    for (const raw of ['{', 'null', '{}', 'x'.repeat(40_001), JSON.stringify([{ accountKey: 'a', repositoryId: 1, environment: { id: 'default', revision: 'bad' } }]), JSON.stringify([{ accountKey: 'a', repositoryId: 1, environment: environmentRef(profile), contents: 'private' }])]) {
      storage.setItem(environmentPreferenceKey, raw); expect(readEnvironmentPreference(storage, 'a', 1)).toBeUndefined();
    }
    for (const repositoryId of [0, -1, 1.5, NaN]) expect(saveEnvironmentPreference(storage, 'a', repositoryId, environmentRef(profile))).toBe(false);
    expect(saveEnvironmentPreference(storage, '', 1, environmentRef(profile))).toBe(false);
  });
});
describe('profile review decisions', () => {
  it('starts with the default or exact remembered recipe and fences account/repository selections', () => {
    expect(initialEnvironmentSelection(catalog).profile).toEqual(profile);
    expect(initialEnvironmentSelection(catalog, node).profile).toEqual(node);
    const selected = { accountKey: 'live:a', repositoryId: 1, profile: node };
    expect(selectedEnvironmentRef(selected, 'live:a', 1)).toEqual(environmentRef(node));
    expect(selectedEnvironmentRef(selected, 'live:b', 1)).toBeNull(); expect(selectedEnvironmentRef(selected, 'live:a', 2)).toBeNull();
  });
  it('requires choosing a current profile after a removed or changed preference', () => {
    for (const old of [{ id: 'removed', revision: 'a'.repeat(64) }, { id: 'node', revision: 'c'.repeat(64) }]) expect(initialEnvironmentSelection(catalog, old)).toEqual({ profile: null, needsReview: true });
    expect(sameEnvironment(node, { ...node, revision: 'c'.repeat(64) })).toBe(false);
  });
  it('uses the exact source recipe for continuation and refuses a legacy or stale source fallback', () => {
    expect(initialEnvironmentSelection(catalog, profile, node).profile).toEqual(node);
    expect(initialEnvironmentSelection(catalog, node, null)).toEqual({ profile: null, needsReview: true });
    expect(initialEnvironmentSelection(catalog, node, { ...node, revision: 'c'.repeat(64) })).toEqual({ profile: null, needsReview: true });
  });
  it('rejects malformed and duplicate catalogs without inferring a profile', () => {
    expect(validEnvironmentCatalog(catalog)).toBe(true);
    for (const value of [null, [], {}, { ...catalog, profiles: [] }, { ...catalog, profiles: [node] }, { ...catalog, profiles: [profile, profile] }, { ...catalog, profiles: [{ ...profile, tools: ['ghp_secret'] }] }, { ...catalog, defaultId: 'node' }]) expect(validEnvironmentCatalog(value)).toBe(false);
  });
});
describe('catalog async isolation and failure', () => {
  it('fences an older catalog and discards responses after account/repository disposal', async () => {
    let resolve!: (value: unknown) => void;
    const publish = vi.fn(), request = vi.fn().mockImplementationOnce(() => new Promise(value => { resolve = value; })).mockResolvedValueOnce(catalog);
    const loader = new EnvironmentCatalogLoader(request, publish);
    const old = loader.load(); await loader.load(); resolve({ ...catalog, profiles: [profile] }); await old;
    expect(publish).toHaveBeenLastCalledWith(catalog, ''); expect(request.mock.calls[0][0].aborted).toBe(true);
    const late = new EnvironmentCatalogLoader(() => new Promise(value => { resolve = value; }), publish);
    const pending = late.load(); late.dispose(); publish.mockClear(); resolve(catalog); await pending; expect(publish).not.toHaveBeenCalled(); loader.dispose();
  });
  it('fails closed for invalid data and bounded requests, ignoring late success', async () => {
    const publish = vi.fn(), invalid = new EnvironmentCatalogLoader(async () => ({}), publish);
    await invalid.load(); expect(publish).toHaveBeenLastCalledWith(null, expect.stringContaining('verified')); invalid.dispose();
    vi.useFakeTimers(); let resolve!: (value: unknown) => void; let signal!: AbortSignal;
    const loader = new EnvironmentCatalogLoader(value => { signal = value; return new Promise(done => { resolve = done; }); }, publish);
    const pending = loader.load(); await vi.advanceTimersByTimeAsync(30_000); await pending;
    expect(signal.aborted).toBe(true); expect(publish).toHaveBeenLastCalledWith(null, expect.stringContaining('timed out'));
    resolve(catalog); await Promise.resolve(); expect(publish).toHaveBeenLastCalledWith(null, expect.stringContaining('timed out')); loader.dispose();
  });
});
describe('environment launch and history presentation', () => {
  it('labels an accessible picker and disables launch selection until the catalog loads', () => {
    const html = renderToStaticMarkup(createElement(EnvironmentSelector, { accountKey: 'live:a', repositoryId: 1, onChange: vi.fn() }));
    expect(html).toContain('Environment profile'); expect(html).toContain('disabled=""'); expect(html).toContain('Loading profiles'); expect(html).toContain('explicit setup recipe'); expect(html).toContain('fresh Codex sign-in');
  });
  it('shows recorded recipe details and makes mutable tags and legacy history accurate', () => {
    const recorded = renderToStaticMarkup(createElement(RecordedEnvironment, { profile: node }));
    for (const text of [node.name, node.description, node.templateRef, 'Node.js', 'Catalog revision', node.revision.slice(0, 12), 'tag can change', 'does not pin an immutable E2B build', 'not an observation']) expect(recorded).toContain(text);
    const legacy = renderToStaticMarkup(createElement(RecordedEnvironment, {})); expect(legacy).toContain('not recorded'); expect(legacy).not.toContain(profile.templateRef);
  });
  it('locks a saved request to its reference while preserving older request recovery', () => {
    const saved = renderToStaticMarkup(createElement(SavedEnvironmentReference, { environment: environmentRef(node) })); expect(saved).toContain(node.id); expect(saved).toContain('Retry retains this exact selection'); expect(saved).not.toContain('<select');
    const legacy = renderToStaticMarkup(createElement(SavedEnvironmentReference, {})); expect(legacy).toContain('original server-side environment behavior'); expect(legacy).toContain('no current profile is substituted');
  });
});
