import type { Session } from './api';
import type { StartupProgress } from '../server/startup';

export function canConfirmUsefulResponse(session: Session, progress: StartupProgress | null, terminalStatus: string, now: number): boolean {
  return session.state === 'running' && Date.parse(session.expiresAt) > now && progress?.mode === 'live'
    && Boolean(progress.firstTerminalAttachedAt) && !progress.firstUsefulResponseAt && terminalStatus === 'connected';
}

export function startupDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
