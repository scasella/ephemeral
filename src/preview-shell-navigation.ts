import type { ShellSnapshot } from './shell-workspace';
import type { Session } from './api';

export function canOpenPreviewShell(session: Pick<Session, 'state' | 'expiresAt' | 'maxExpiresAt'>, now: number): boolean {
  return session.state === 'running' && Math.min(Date.parse(session.expiresAt), Date.parse(session.maxExpiresAt)) > now;
}

/** A Preview jump selects saved shells only; creating a shell remains an explicit action. */
export function previewShellDestination(snapshot: ShellSnapshot | null, selected: string): string | null {
  const open = snapshot?.shells.filter(shell => shell.kind === 'supplemental' && shell.state === 'open') || [];
  return open.find(shell => shell.id === selected)?.id || open[0]?.id || null;
}

export interface PreviewShellNavigationRequest {
  sessionId: string;
  isCurrent: () => boolean;
}
