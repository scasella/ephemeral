import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContinuationForm } from './Continuation';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from './api';
import { continuationBlockedReason, ContinuationPreviewLoader, ContinuationRequestError, previewBlockedReason, readContinuationIntent, submitContinuation, type ContinuationIntent, type ContinuationPreview } from './continuation-state';
const now = Date.parse('2026-10-14T12:00:00Z');
const sha = 'a'.repeat(40);
const source: Session = { id: 'source', userId: 'owner', repository: 'owner/repo', repositoryId: 1, installationId: 2, baseBranch: 'main', branch: 'ephemeral/source', state: 'ended', createdAt: new Date(now - 3_600_000).toISOString(), expiresAt: new Date(now).toISOString(), maxExpiresAt: new Date(now).toISOString(), sandboxId: null, endedAt: new Date(now).toISOString(), error: null, cleanup: { vm: 'confirmed', github: 'confirmed', gateway: 'confirmed', codex: 'not_applicable' }, codexRemoteRevocation: 'unverified' };
const preview: ContinuationPreview = { state: 'ready', checkedAt: new Date(now).toISOString(), reason: null, sourceSessionId: source.id, repository: source.repository, sourceBranch: source.branch, baseBranch: source.baseBranch, commitSha: sha };
const intent: ContinuationIntent = { sourceSessionId: source.id, expectedHeadSha: sha, requestId: '11111111-1111-4111-8111-111111111111', createdAt: new Date(now).toISOString() };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('continuation review and recovery intent', () => {
  it('permits only fully cleaned up stopped sources', () => {
    expect(continuationBlockedReason(source)).toBeNull();
    for (const state of ['running', 'provisioning', 'cleanup_pending'] as const) expect(continuationBlockedReason({ ...source, state })).toContain('Stop');
    for (const key of ['vm', 'github', 'gateway', 'codex'] as const) expect(continuationBlockedReason({ ...source, cleanup: { ...source.cleanup, [key]: 'failed' } })).toContain('cleanup');
    expect(continuationBlockedReason({ ...source, state: 'failed' })).toBeNull();
  });
  it('rejects missing, unpublished, unknown, stale and mismatched reviews', () => {
    expect(previewBlockedReason(preview, source, now)).toBeNull();
    expect(previewBlockedReason(null, source, now)).not.toBeNull();
    for (const state of ['unpublished', 'unknown', 'unavailable'] as const) expect(previewBlockedReason({ ...preview, state, reason: 'GitHub inaccessible' }, source, now)).toBe('GitHub inaccessible');
    expect(previewBlockedReason(preview, source, now + 60_001)).toContain('expired');
    expect(previewBlockedReason({ ...preview, checkedAt: 'bad date' }, source, now)).toContain('expired');
    expect(previewBlockedReason(preview, source, now - 10_000)).toContain('expired');
    for (const [key, value] of [['sourceSessionId', 'other'], ['repository', 'owner/other'], ['sourceBranch', 'main'], ['baseBranch', 'develop'], ['commitSha', 'abc'], ['commitSha', 'a'.repeat(64)]] as const) expect(previewBlockedReason({ ...preview, [key]: value }, source, now)).toContain('does not match');
  });
  it('recovers only a valid request belonging to this source without changing its SHA or ID', () => {
    expect(readContinuationIntent(JSON.stringify(intent), source.id)).toEqual(intent);
    expect(readContinuationIntent(JSON.stringify(intent), 'other')).toBeNull();
    for (const data of [null, 'garbage', '{}', JSON.stringify({ ...intent, requestId: 'bad' }), JSON.stringify({ ...intent, expectedHeadSha: 'abc' }), JSON.stringify({ ...intent, expectedHeadSha: 'a'.repeat(64) }), JSON.stringify({ ...intent, createdAt: 'bad' })]) expect(readContinuationIntent(data, source.id)).toBeNull();
  });
});
describe('bounded preview checks', () => {
  it('coalesces refreshes and cannot publish an old source result after disposal', async () => {
    let resolve!: (value: ContinuationPreview) => void;
    const request = vi.fn(() => new Promise<ContinuationPreview>(r => { resolve = r; }));
    const publish = vi.fn(); const loader = new ContinuationPreviewLoader(source, request, publish, vi.fn());
    const first = loader.refresh(); expect(loader.refresh()).toBe(first); await Promise.resolve(); expect(request).toHaveBeenCalledTimes(1);
    loader.dispose(); resolve(preview); await first; expect(publish).not.toHaveBeenCalled();
  });
  it('aborts a hung review and reports unknown; late ready results cannot replace it', async () => {
    vi.useFakeTimers(); let resolve!: (value: ContinuationPreview) => void; let signal!: AbortSignal;
    const publish = vi.fn(); const loading = vi.fn();
    const loader = new ContinuationPreviewLoader(source, value => { signal = value; return new Promise(r => { resolve = r; }); }, publish, loading);
    const pending = loader.refresh(); await vi.advanceTimersByTimeAsync(45_000); await pending;
    expect(signal.aborted).toBe(true); expect(publish).toHaveBeenCalledWith(expect.objectContaining({ state: 'unknown', commitSha: null })); expect(loading).toHaveBeenLastCalledWith(false);
    resolve(preview); await Promise.resolve(); expect(publish).toHaveBeenCalledTimes(1); loader.dispose();
  });
});
describe('continuation POST uncertainty', () => {
  it('retries the same source, commit and request ID after a lost response', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('Network failed')).mockResolvedValueOnce({ ok: true, json: async () => ({ ...source, id: 'child', branch: 'ephemeral/child', continuation: { sourceSessionId: source.id, sourceBranch: source.branch, commitSha: sha, verifiedAt: preview.checkedAt } }) }); vi.stubGlobal('fetch', fetch);
    await expect(submitContinuation(source, intent)).rejects.toMatchObject({ definite: false });
    await expect(submitContinuation(source, intent)).resolves.toMatchObject({ id: 'child' });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const call of fetch.mock.calls) { expect(call[0]).toBe('/api/sessions/source/continue'); expect(JSON.parse(call[1].body)).toEqual({ expectedHeadSha: sha, requestId: intent.requestId }); }
  });
  it('retains the saved request when a successful response has mismatched provenance', async () => {
    const child = { ...source, id: 'child', branch: 'ephemeral/child', continuation: { sourceSessionId: source.id, sourceBranch: source.branch, commitSha: sha, verifiedAt: preview.checkedAt } };
    const badChildren = [{ ...child, id: source.id }, { ...child, branch: source.branch }, { ...child, repository: 'owner/other' }, { ...child, baseBranch: 'develop' }, { ...child, userId: 'other' }, { ...child, continuation: { ...child.continuation, sourceBranch: 'other' } }, { ...child, continuation: { ...child.continuation, commitSha: 'b'.repeat(40) } }, { ...child, continuation: { ...child.continuation, verifiedAt: 'bad date' } }];
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const value of badChildren) {
      fetch.mockResolvedValueOnce({ ok: true, json: async () => value });
      await expect(submitContinuation(source, intent)).rejects.toMatchObject({ definite: false });
    }
  });
  it('preserves generic errors and only treats tagged precreation rejection as definitive', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'Database failed' }) }).mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'Unconfirmed rejection', code: 'CONTINUATION_REJECTED' }) }).mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'Branch changed', code: 'CONTINUATION_REJECTED', outcome: 'not_created' }) }));
    await expect(submitContinuation(source, intent)).rejects.toMatchObject({ definite: false });
    await expect(submitContinuation(source, intent)).rejects.toMatchObject({ definite: false });
    await expect(submitContinuation(source, intent)).rejects.toMatchObject({ definite: true });
  });
  it('bounds a hung POST without claiming no machine was created', async () => {
    vi.useFakeTimers(); let signal!: AbortSignal; vi.stubGlobal('fetch', vi.fn((_, options) => { signal = options.signal; return new Promise(() => {}); }));
    const result = submitContinuation(source, intent).catch(error => error); await vi.advanceTimersByTimeAsync(45_000);
    const error = await result; expect(error).toBeInstanceOf(ContinuationRequestError); expect(error.definite).toBe(false); expect(signal.aborted).toBe(true);
  });
});


describe('saved note continuation intent', () => {
  const note = { revision: 3, updatedAt: new Date(now).toISOString(), nextStep: 'Exact saved text', unresolvedIssues: 'Issue', verification: 'Tests passed' };
  it('retains the exact reviewed version and rejects malformed or mismatched note revisions', () => {
    const reviewed = { ...intent, expectedNoteRevision: 3, reviewedNote: note };
    expect(readContinuationIntent(JSON.stringify(reviewed), source.id)).toEqual(reviewed);
    expect(readContinuationIntent(JSON.stringify(intent), source.id)).toEqual(intent);
    for (const expectedNoteRevision of [-1, 0.5, 2147483647, '3', null]) expect(readContinuationIntent(JSON.stringify({ ...intent, expectedNoteRevision }), source.id)).toBeNull();
    expect(readContinuationIntent(JSON.stringify({ ...reviewed, expectedNoteRevision: 2 }), source.id)).toBeNull();
    expect(readContinuationIntent(JSON.stringify({ ...reviewed, reviewedNote: { ...note, nextStep: 'x'.repeat(2001) } }), source.id)).toBeNull();
  });
  it('sends the saved revision while retaining legacy request compatibility', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...source, id: 'child', branch: 'ephemeral/child', continuation: { sourceSessionId: source.id, sourceBranch: source.branch, commitSha: sha, verifiedAt: preview.checkedAt } }) }); vi.stubGlobal('fetch', fetch);
    await submitContinuation(source, { ...intent, expectedNoteRevision: 3, reviewedNote: note });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ expectedHeadSha: sha, requestId: intent.requestId, expectedNoteRevision: 3 });
    expect(fetch.mock.calls[0][1].body).not.toContain('Exact saved text');
  });
});

describe('continuation environment binding', () => {
  const environment = { id: 'python', revision: 'b'.repeat(64) };
  const child = { ...source, id: 'child', branch: 'ephemeral/child', environment, continuation: { sourceSessionId: source.id, sourceBranch: source.branch, commitSha: sha, verifiedAt: preview.checkedAt } };
  it('restores exact selected references and keeps legacy request absence intact', () => {
    const selected = { ...intent, environment };
    expect(readContinuationIntent(JSON.stringify(selected), source.id)).toEqual(selected);
    expect(readContinuationIntent(JSON.stringify(intent), source.id)).not.toHaveProperty('environment');
    for (const invalid of [null, {}, { ...environment, revision: 'bad' }, { ...environment, tools: [] }]) expect(readContinuationIntent(JSON.stringify({ ...intent, environment: invalid }), source.id)).toBeNull();
  });
  it('retries with the exact original profile despite a changed source or current catalog', async () => {
    const selected = { ...intent, environment };
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('Lost response')).mockResolvedValueOnce({ ok: true, json: async () => child }); vi.stubGlobal('fetch', fetch);
    await expect(submitContinuation(source, selected)).rejects.toMatchObject({ definite: false });
    await expect(submitContinuation(source, readContinuationIntent(JSON.stringify(selected), source.id)!)).resolves.toMatchObject({ environment });
    expect(fetch.mock.calls.map(call => JSON.parse(call[1].body).environment)).toEqual([environment, environment]);
  });
  it('preserves saved recovery when successful response profile is missing or different', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const response of [undefined, { ...environment, id: 'default' }, { ...environment, revision: 'c'.repeat(64) }]) {
      fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ...child, environment: response }) });
      await expect(submitContinuation(source, { ...intent, environment })).rejects.toMatchObject({ definite: false });
    }
  });
});


describe('continuation saved selection recovery presentation', () => {
  const props = { accountKey: 'live:owner', source, sessions: [{ ...source, id: 'active', state: 'running' as const }], now, previewMode: false, canLaunch: false, refreshSessions: vi.fn(), onBusyChange: vi.fn(), onCreated: vi.fn(), onClose: vi.fn(), onSelectSession: vi.fn() };
  it('allows retry of the original environment reference despite an active machine and unavailable new-launch configuration', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => JSON.stringify({ ...intent, environment: { id: 'python', revision: 'b'.repeat(64) } }) });
    const html = renderToStaticMarkup(createElement(ContinuationForm, props));
    expect(html).toContain('Retry retains this exact selection'); expect(html).not.toContain('<select'); expect(html).toContain('class="button primary">Check or retry saved request');
  });
  it('preserves recovery of legacy requests without inventing a historical profile', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => JSON.stringify(intent) });
    const html = renderToStaticMarkup(createElement(ContinuationForm, props));
    expect(html).toContain('original server-side environment behavior'); expect(html).toContain('class="button primary">Check or retry saved request');
  });
  it('blocks corrupted stored environment references instead of replacing an accepted pending request', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => JSON.stringify({ ...intent, environment: { id: 'python', revision: 'bad' } }) });
    const html = renderToStaticMarkup(createElement(ContinuationForm, props));
    expect(html).toContain('could not be safely restored'); expect(html).toContain('Check machine list'); expect(html).toContain('class="button primary" disabled=""'); expect(html).not.toContain('<select');
  });
});
