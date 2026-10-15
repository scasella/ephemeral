import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Session } from './api';
import { Cleanup } from './Cleanup';
import { EndedOutcome, type RecoveryEvidenceProps } from './EndedOutcome';
import { WorkStatusPanel, WorkStatusSummary, StopWorkCheck } from './WorkStatus';
import { compactEndedOutcome, computeOutcome, evidenceAge, needsRecoverySummary, publishedOutcome } from './ended-outcome';
import { emptyPublishedView, reducePublished, type PublishedChanges, type PublishedViewState } from './published-changes';
import type { WorkStatus } from './workflow';

const checkedAt = '2026-10-14T12:00:00Z', now = Date.parse(checkedAt);
const session: Session = { id: 'ended', userId: 'owner', repository: 'owner/repo', repositoryId: 1, installationId: 2, baseBranch: 'main', branch: 'ephemeral/session', state: 'ended', createdAt: checkedAt, expiresAt: checkedAt, maxExpiresAt: checkedAt, sandboxId: 'old', endedAt: checkedAt, error: null, cleanup: { vm: 'confirmed', github: 'confirmed', gateway: 'confirmed', codex: 'confirmed' }, codexRemoteRevocation: 'unverified' };
const comparison: PublishedChanges = { state: 'known', checkedAt, reason: null, repository: session.repository, headBranch: session.branch, baseBranch: session.baseBranch, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), mergeBaseSha: 'c'.repeat(40), aheadCommits: 1, behindCommits: 0, comparisonUrl: null, listTruncated: false, files: [{ path: 'file.ts', previousPath: null, status: 'added', additions: 1, deletions: 0, changes: 1 }], selected: null };
const clean: WorkStatus = { state: 'known', checkedAt, dirtyFiles: 0, untrackedFiles: 0, aheadCommits: 0, headSha: comparison.headSha, remoteSha: comparison.headSha, remoteCheckedAt: checkedAt, branch: session.branch, branchMatches: true, remoteExists: true, reason: null };
const loaded = (value = comparison) => reducePublished(emptyPublishedView, { type: 'result', path: null, value });
const markup = (props: RecoveryEvidenceProps & { localStatus?: WorkStatus | null } = {}, selected = session) => renderToStaticMarkup(createElement(EndedOutcome, { session: selected, now, localStatus: null, ...props }));

describe('scoped recovery evidence', () => {
  it('does not infer a completed shutdown from failed/ended lifecycle labels alone', () => {
    for (const state of ['ended', 'failed', 'cleanup_pending'] as const) {
      const unresolved = { ...session, state, cleanup: { ...session.cleanup, vm: 'failed' as const } };
      expect(needsRecoverySummary(unresolved)).toBe(true);
      expect(computeOutcome(unresolved).confirmed).toBe(false);
      expect(computeOutcome(unresolved).detail).toContain('has not been confirmed');
      expect(markup({}, unresolved)).not.toContain('Sandbox destruction is confirmed');
      const withLocalStatus = markup({ localStatus: clean }, unresolved);
      expect(withLocalStatus).not.toContain('when compute ended');
      expect(withLocalStatus).toContain('This does not establish that all local work was preserved');
    }
    expect(needsRecoverySummary({ ...session, state: 'running' })).toBe(false);
    expect(needsRecoverySummary({ ...session, state: 'provisioning' })).toBe(false);
    expect(computeOutcome(session).confirmed).toBe(true);
  });
  it('keeps unknown and failed published checks distinct from missing remote work', () => {
    expect(publishedOutcome(session, null, now).title).toBe('Published work not checked');
    expect(publishedOutcome(session, { ...emptyPublishedView, loading: true }, now).title).toContain('Checking');
    const failed = publishedOutcome(session, { ...emptyPublishedView, error: 'Check timed out' }, now);
    expect(failed.title).toContain('check unconfirmed'); expect(failed.detail).toBe('Check timed out'); expect(failed.confirmed).toBe(false);
    const simulation = publishedOutcome(session, { ...emptyPublishedView, error: 'Preview simulation: published comparisons are unavailable. No GitHub repository is inspected.' }, now);
    expect(simulation.confirmed).toBe(false); expect(simulation.title).not.toContain('failed');
    for (const state of ['unknown', 'unavailable', 'unpublished'] as const) {
      const result = publishedOutcome(session, loaded({ ...comparison, state, headSha: null, reason: 'Independent check result' }), now);
      expect(result.confirmed).toBe(false);
      expect(result.detail).toBe('Independent check result');
      expect(result.title).toContain(state === 'unpublished' ? 'not found at this check' : 'unconfirmed');
    }
  });
  it('makes successful pushed evidence visible without asserting local survival', () => {
    const result = publishedOutcome(session, loaded(), now);
    expect(result.confirmed).toBe(true); expect(result.headSha).toBe(comparison.headSha);
    expect(result.title).toBe('Pushed contribution independently checked');
    expect(result.detail).toContain('does not confirm that all local work survived');
    const summary = compactEndedOutcome(session, loaded(), now);
    expect(summary).toContain('Pushed contribution independently checked (0s ago)');
    expect(summary).toContain('Local work survival unconfirmed');
    expect(summary).toContain('Remote Codex revocation unverified');
    const noChanges = publishedOutcome(session, loaded({ ...comparison, state: 'no_changes', files: [], aheadCommits: 0 }), now);
    expect(noChanges.confirmed).toBe(true); expect(noChanges.title).toContain('against the base at this check');
  });
  it.each([
    ['aging', loaded(), now + 60_001],
    ['future time', loaded(), now - 6_000],
    ['invalid time', loaded({ ...comparison, checkedAt: 'invalid' }), now],
    ['revalidation', reducePublished(loaded(), { type: 'start', path: null }), now],
    ['failed revalidation', reducePublished(loaded(), { type: 'failure', message: 'Cannot check remote' }), now],
    ['invalidated', reducePublished(loaded(), { type: 'invalidate', message: 'Branches moved' }), now],
  ] as Array<[string, PublishedViewState, number]>)('does not promote %s into current evidence', (_, state, at) => {
    const result = publishedOutcome(session, state, at);
    expect(result.confirmed).toBe(false); expect(result.title.toLowerCase()).toContain('prior');
    expect(result.headSha).toBe(comparison.headSha);
  });
  it('rejects evidence for another repository, work branch or base and incomplete commits', () => {
    for (const changes of [{ repository: 'other/repo' }, { headBranch: 'other' }, { baseBranch: 'other' }]) {
      const result = publishedOutcome(session, loaded({ ...comparison, ...changes }), now);
      expect(result.confirmed).toBe(false); expect(result.checkedAt).toBeNull(); expect(result.headSha).toBeNull();
      expect(result.title).toContain('does not match');
    }
    expect(publishedOutcome(session, loaded({ ...comparison, mergeBaseSha: null }), now).confirmed).toBe(false);
    expect(evidenceAge('invalid', now)).toBe('check time unconfirmed');
    expect(evidenceAge(checkedAt, now + 120_000)).toBe('2m ago');
  });
  it('asks users to wait during revalidation instead of refreshing an active check', () => {
    const result = publishedOutcome(session, reducePublished(loaded(), { type: 'start', path: null }), now);
    expect(result.detail).toContain('Wait for the published check to finish');
    expect(result.detail).not.toContain('Refresh Published');
  });
});

describe('ended recovery presentation and running boundaries', () => {
  it('never calls a clean former-local result proof that work survived', () => {
    const html = markup({ localStatus: clean, publishedState: loaded() });
    expect(html).toContain('Former local inspection'); expect(html).toContain('Last reported local status: known');
    expect(html).toContain('No current local check proves that no work was lost');
    expect(html).toContain('This is a status response time');
    expect(html).not.toContain('No unsaved work detected'); expect(html).not.toContain('Review before teardown');
    expect(html).not.toContain('Save your work');
  });
  it('retains unknown local diagnostics as a dated response without future teardown advice', () => {
    const html = markup({ localStatus: { ...clean, state: 'unknown', dirtyFiles: null, untrackedFiles: 2, aheadCommits: null, branchMatches: false, remoteExists: null, reason: 'The former workspace could not be inspected.' } });
    expect(html).toContain('<summary>Last local status response</summary>');
    expect(html).toContain('Reason reported in that response: The former workspace could not be inspected.');
    expect(html).toContain('Changed tracked files reported</dt><dd>Unknown');
    expect(html).toContain('Untracked files reported</dt><dd>2');
    expect(html).toContain('Unpushed commits reported on assigned branch</dt><dd>Unknown');
    expect(html).toContain('Different branch');
    expect(html).toContain('Remote commit observed in that response');
    expect(html).toContain('diagnostics from a dated response, not final shutdown evidence');
    expect(html).not.toContain('Review before teardown');
    expect(html).not.toContain('acknowledge the uncertainty before stopping');
    expect(html).not.toContain('Work may be lost on teardown');
  });
  it('distinguishes factual notes/PR presence from unknown, never-saved and cleared notes', () => {
    expect(markup()).toContain('Saved-note presence unconfirmed');
    expect(markup()).toContain('Linked-PR presence unconfirmed');
    const empty = { nextStep: '', unresolvedIssues: '', verification: '', revision: 0, updatedAt: null };
    expect(markup({ savedNote: empty, pullRequests: [] })).toContain('No note saved yet');
    expect(markup({ savedNote: empty, pullRequests: [] })).toContain('No saved PR links');
    const inherited = markup({ savedNote: empty, inheritedNotePresent: true });
    expect(inherited).toContain('No note saved yet');
    expect(inherited).toContain('Inherited note: </strong>Present.');
    expect(markup({ inheritedNotePresent: false })).toContain('Inherited note: </strong>None.');
    expect(markup()).toContain('Inherited note: </strong>Unconfirmed.');
    expect(markup({ savedNote: { ...empty, revision: 2, updatedAt: checkedAt } })).toContain('Saved note is empty');
    const html = markup({ savedNote: { ...empty, nextStep: 'Review', revision: 1, updatedAt: checkedAt }, pullRequests: [{ url: 'https://github.com/owner/repo/pull/1', number: 1, headSha: comparison.headSha!, baseSha: comparison.baseSha!, headBranch: session.branch, baseBranch: session.baseBranch, createdAt: checkedAt }] });
    expect(html).toContain('Saved note present'); expect(html).toContain('1 saved PR link present');
    expect(html).toContain('do not verify current code or continuation readiness');
  });
  it('offers the factual review destinations and handles recovery lifecycle states', () => {
    const html = markup({ onReviewPublished: () => {}, onReviewNotes: () => {}, onReviewCleanup: () => {} });
    expect(html).toContain('Review published work'); expect(html).toContain('Review Notes'); expect(html).toContain('Review Access');
    for (const state of ['ended', 'failed', 'cleanup_pending'] as const) {
      const panel = renderToStaticMarkup(createElement(WorkStatusPanel, { session: { ...session, state }, now, publishedState: loaded(), forceExpanded: true }));
      expect(panel).toContain('Recovery &amp; cleanup'); expect(panel).toContain('Pushed contribution independently checked');
      expect(panel).not.toContain('Review before teardown'); expect(panel).not.toContain('id="save-guidance"');
    }
  });
  it('preserves running save and stop-risk guidance', () => {
    const running = { ...session, state: 'running' as const, endedAt: null };
    const panel = renderToStaticMarkup(createElement(WorkStatusPanel, { session: running, now }));
    expect(panel).toContain('Save your work'); expect(panel).toContain('id="save-guidance"');
    expect(panel).not.toContain('Recovery &amp; cleanup');
    const local = renderToStaticMarkup(createElement(WorkStatusSummary, { status: { ...clean, dirtyFiles: 1 }, loading: false, now }));
    expect(local).toContain('Work may be lost on teardown');
    const stop = renderToStaticMarkup(createElement(StopWorkCheck, { session: running, now, onReady: () => {} }));
    expect(stop).toContain('Stopping destroys this sandbox and begins credential cleanup');
  });
  it('keeps remote revocation equally explicit even if all four local resources are confirmed', () => {
    const html = renderToStaticMarkup(createElement(Cleanup, { session }));
    expect(html.match(/class="cleanup-row/g)).toHaveLength(5);
    for (const resource of ['Sandbox destruction', 'GitHub token revocation', 'Git gateway access', 'Local Codex credentials', 'Remote Codex revocation']) expect(html).toContain(resource);
    expect(html).toContain('cleanup-row remote-codex-result'); expect(html).toContain('Unverified');
    expect(html).toContain('Last reported resource outcomes');
    expect(html).toContain('Review connected sessions in your Codex account');
    expect(html).not.toContain('all safe'); expect(html).not.toContain('compromised');
    const failed = renderToStaticMarkup(createElement(Cleanup, { session: { ...session, cleanup: { vm: 'confirmed', github: 'failed', gateway: 'pending', codex: 'not_applicable' } } }));
    expect(failed).toContain('cleanup-status failed'); expect(failed).toContain('cleanup-status pending'); expect(failed).toContain('not applicable'); expect(failed).toContain('Unverified');
    const summary = compactEndedOutcome({ ...session, cleanup: { ...session.cleanup, github: 'failed', gateway: 'pending' } }, loaded(), now);
    expect(summary).toContain('Reported resource cleanup: 1 failed, 1 pending, 2 confirmed');
  });
});
