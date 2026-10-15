import { describe, expect, it } from 'vitest';
import { canOpenPreviewShell, previewShellDestination } from './preview-shell-navigation';
import type { ShellSnapshot, WorkspaceShell } from './shell-workspace';

const primary: WorkspaceShell = { id: 'codex', name: 'Codex', kind: 'primary', state: 'open', requestId: null, error: null, createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z' };
const supplemental: WorkspaceShell = { ...primary, id: 'server', name: 'Server', kind: 'supplemental' };
const snapshot = (...shells: WorkspaceShell[]): ShellSnapshot => ({ mode: 'live', shells: [primary, ...shells], canCreate: !shells.length, reason: null });

describe('Preview shell navigation', () => {
  it('reuses the selected open supplemental shell, otherwise selects an existing one without changing saved state', () => {
    const other = { ...supplemental, id: 'other' };
    const saved = snapshot(supplemental, other);
    const before = structuredClone(saved);
    expect(previewShellDestination(saved, 'other')).toBe('other');
    expect(previewShellDestination(saved, 'codex')).toBe('server');
    expect(previewShellDestination(saved, 'removed')).toBe('server');
    expect(saved).toEqual(before);
  });
  it('uses the explicit open-shell control when no supplemental shell is open, never targeting Codex or unresolved shells', () => {
    expect(previewShellDestination(null, 'codex')).toBeNull();
    expect(previewShellDestination(snapshot(), 'codex')).toBeNull();
    for (const state of ['creating', 'closing', 'closed', 'uncertain'] as const) {
      expect(previewShellDestination(snapshot({ ...supplemental, state }), supplemental.id)).toBeNull();
    }
  });
  it('allows the jump only during the running machine’s bounded lifetime', () => {
    const now = Date.parse('2026-10-14T12:00:00Z');
    const session = { state: 'running' as const, expiresAt: new Date(now + 60_000).toISOString(), maxExpiresAt: new Date(now + 30_000).toISOString() };
    expect(canOpenPreviewShell(session, now)).toBe(true);
    expect(canOpenPreviewShell(session, now + 30_000)).toBe(false);
    expect(canOpenPreviewShell({ ...session, expiresAt: 'invalid' }, now)).toBe(false);
    expect(canOpenPreviewShell({ ...session, maxExpiresAt: 'invalid' }, now)).toBe(false);
    for (const state of ['provisioning', 'cleanup_pending', 'failed', 'ended'] as const) {
      expect(canOpenPreviewShell({ ...session, state }, now)).toBe(false);
    }
  });
});
