import { describe, expect, it } from 'vitest';
import { saveCommands, workNeedsAcknowledgement, type WorkStatus } from './workflow';
const confirmed: WorkStatus = { state: 'known', checkedAt: '2026-10-14T00:00:00Z', dirtyFiles: 0, untrackedFiles: 0, aheadCommits: 0, headSha: 'a'.repeat(40), remoteSha: 'a'.repeat(40), remoteCheckedAt: '2026-10-14T00:00:00Z', branch: 'session/example', branchMatches: true, remoteExists: true, reason: null };
const checkedAt = Date.parse(confirmed.checkedAt);
describe('stop acknowledgement', () => {
  it('permits confirmed clean work without acknowledgement', () => { expect(workNeedsAcknowledgement(confirmed, checkedAt)).toBe(false); });
  it.each([{ dirtyFiles: 1 }, { untrackedFiles: 1 }, { aheadCommits: 1 }, { state: 'unknown' }, { state: 'unavailable' }, { aheadCommits: null }, { branchMatches: false }, { remoteExists: false }, { remoteSha: null }])('requires acknowledgement for risk or missing evidence: %j', change => { expect(workNeedsAcknowledgement({ ...confirmed, ...change } as WorkStatus, checkedAt)).toBe(true); });
  it('requires acknowledgement after a clean check becomes stale', () => {
    expect(workNeedsAcknowledgement(confirmed, checkedAt + 60_000)).toBe(false);
    expect(workNeedsAcknowledgement(confirmed, checkedAt + 60_001)).toBe(true);
  });
  it('requires acknowledgement for an implausibly future check time', () => {
    expect(workNeedsAcknowledgement(confirmed, checkedAt - 5_000)).toBe(false);
    expect(workNeedsAcknowledgement(confirmed, checkedAt - 5_001)).toBe(true);
    expect(workNeedsAcknowledgement({ ...confirmed, checkedAt: 'invalid' }, checkedAt)).toBe(true);
  });
  it('requires acknowledgement when no check is available', () => { expect(workNeedsAcknowledgement(null)).toBe(true); });
});
describe('reviewable save commands', () => {
  it('stages an explicit placeholder and pushes only to the assigned branch', () => {
    const commands = saveCommands("session/it's-safe");
    expect(commands).toContain('git add -- PATH');
    expect(commands).not.toMatch(/git add (?:-A|\.|--all)/);
    expect(commands).toContain("git push origin HEAD:refs/heads/'session/it'\\''s-safe'");
    expect(commands).toContain('git diff --cached');
  });
});
