import type { Bootstrap } from './api';
import { workspaceSnapshotFresh } from './workspace-navigation';

export interface ServiceObservation { checking: boolean; observedAt: number | null; error: string }
export const emptyServiceObservation: ServiceObservation = { checking: false, observedAt: null, error: '' };
interface CheckRevision { request: number; generation: number; identity: string }
/** Newer completions own feedback; a pending read does not discard older completions. */
export class ServiceCheckGate {
  private request = 0;
  private generation = 0;
  private completedRequest = 0;
  begin(identity: string): CheckRevision { return { request: ++this.request, generation: this.generation, identity }; }
  invalidate(): void { this.generation++; this.completedRequest = this.request; }
  accepts(check: CheckRevision, identity: string): boolean { return check.generation === this.generation && check.identity === identity && check.request > this.completedRequest; }
  /** Both successful and failed reads must commit before updating their presentation. */
  commit(check: CheckRevision, identity: string): boolean {
    if (!this.accepts(check, identity)) return false;
    this.completedRequest = check.request;
    return true;
  }
  checking(): boolean { return this.request > this.completedRequest; }
}
export interface ObservationTime { iso: string; age: string }
export function observationTime(observedAt: number | null, now: number): ObservationTime | null {
  if (observedAt === null || !Number.isFinite(observedAt) || !Number.isFinite(now) || observedAt < 0 || observedAt > now) return null;
  const date = new Date(observedAt);
  if (!Number.isFinite(date.getTime())) return null;
  const seconds = Math.floor((now - observedAt) / 1000);
  const amount = seconds < 60 ? seconds : seconds < 3600 ? Math.floor(seconds / 60) : Math.floor(seconds / 3600);
  const unit = seconds < 60 ? 'second' : seconds < 3600 ? 'minute' : 'hour';
  return { iso: date.toISOString(), age: `${amount} ${unit}${amount === 1 ? '' : 's'} ago` };
}
export interface ServiceFeedback { title: string; detail: string; time: ObservationTime | null; timeLabel: string; tone: 'neutral' | 'warning' }
export function configurationFeedback(bootstrap: Bootstrap | null, observation: ServiceObservation, now: number): ServiceFeedback {
  const time = observationTime(observation.observedAt, now);
  const base = { time, timeLabel: 'Configuration recorded', tone: 'neutral' as const };
  const preview = bootstrap?.mode === 'preview';
  const simulation = preview ? ' Simulation only; no real provider or GitHub checks.' : '';
  const recorded = bootstrap ? `Last recorded: ${preview ? 'preview simulation' : bootstrap.configured ? 'required settings present' : 'setup incomplete'}. ` : '';
  if (observation.error) return { ...base, tone: 'warning', title: observation.checking ? (bootstrap ? 'Rechecking server configuration' : 'Retrying configuration check') : bootstrap ? 'Configuration recheck unavailable' : 'Configuration check unavailable', detail: `${recorded}${observation.error}${simulation}` };
  if (observation.checking) return { ...base, title: 'Checking server configuration', detail: `${bootstrap ? recorded : ''}Waiting for the server response.${simulation}` };
  if (!bootstrap) return { ...base, title: 'Server configuration unavailable', detail: 'No configuration response has been accepted.' };
  if (preview) return { ...base, title: 'Preview configuration recorded', detail: `Simulation only; no real provider or GitHub checks.${time ? '' : ' Observation time unavailable.'}` };
  return { ...base, title: bootstrap.configured ? 'Server configuration recorded' : 'Server setup required', detail: `${bootstrap.configured ? 'Required settings present.' : 'Required settings are missing.'} Service health is not checked.${time ? '' : ' Observation time unavailable.'}` };
}
export function connectionFeedback(bootstrap: Bootstrap | null, observation: ServiceObservation, now: number): ServiceFeedback {
  const time = observationTime(observation.observedAt, now);
  const base = { time, timeLabel: 'Last accepted session snapshot', tone: 'neutral' as const };
  const preview = bootstrap?.mode === 'preview';
  const simulation = preview ? ' Machine status is simulated; no real provider or GitHub checks.' : '';
  if (!bootstrap?.user && !preview) return { ...base, time: null, title: 'App connection: machine status not checked', detail: bootstrap ? 'Sign in to read your machine status.' : 'Waiting for workspace access.' };
  if (observation.error) return { ...base, tone: 'warning', title: observation.checking ? 'App connection: rechecking machine status' : 'App connection: machine status unavailable', detail: `${time ? 'Showing last known machine status. ' : 'No dated session snapshot is available. '}${observation.error}${simulation}` };
  if (observation.checking) return { ...base, title: 'App connection: checking machine status', detail: `${time ? 'Showing the last accepted snapshot while waiting.' : 'Waiting for the first accepted session snapshot.'}${simulation}` };
  if (!time) return { ...base, tone: 'warning', title: 'App connection: machine status unconfirmed', detail: `No dated session snapshot is available.${simulation}` };
  if (!workspaceSnapshotFresh(observation.observedAt, now)) return { ...base, tone: 'warning', title: 'App connection: machine status may be stale', detail: `Showing last known machine status; background reads may be delayed.${simulation}` };
  return { ...base, title: preview ? 'App connection: simulated machine status read' : 'App connection: machine status read', detail: preview ? `Session list received.${simulation}` : 'Session list received. Provider, GitHub and terminal health are not checked.' };
}
export function configurationSidebarLabel(bootstrap: Bootstrap | null, observation: ServiceObservation): string {
  if (observation.error) return 'Configuration unconfirmed';
  if (observation.checking) return 'Checking configuration';
  if (!bootstrap) return 'Configuration unavailable';
  if (bootstrap.mode === 'preview') return 'Preview configuration';
  return bootstrap.configured ? 'Settings recorded' : 'Setup required';
}
export function integrationGuidance(bootstrap: Bootstrap, observation: ServiceObservation = emptyServiceObservation): { heading: string; detail: string; launchRoute: boolean } {
  if (bootstrap.mode === 'preview') return { heading: 'Explore the workspace', detail: 'This environment simulates machines, terminals, and cleanup. It creates no compute or credentials.', launchRoute: true };
  const retained = observation.error ? 'Configuration could not be rechecked. Based on the last recorded settings: ' : observation.checking ? 'Rechecking configuration. Based on the last recorded settings: ' : '';
  if (bootstrap.configured) return { heading: 'Launch from Machines', detail: `${retained}Required server settings were recorded. Open Machines to choose a repository and base branch. Configuration does not confirm service health.`, launchRoute: true };
  return { heading: 'Finish connecting your services', detail: `${retained}Configure the missing service credentials on the server, then recheck configuration.`, launchRoute: false };
}
export function repositoryListFeedback(observation: ServiceObservation, count: number, now: number): ServiceFeedback & { showConnect: boolean } {
  const time = observationTime(observation.observedAt, now);
  const base = { time, timeLabel: 'Last accepted repository list', tone: 'neutral' as const, showConnect: false };
  if (observation.checking) return { ...base, title: 'Checking repository access', detail: `${time ? 'Showing the last known repository list while waiting.' : 'Waiting for the repository access response.'}${observation.error ? ` Previous read unavailable: ${observation.error}` : ''}` };
  if (observation.error) return { ...base, tone: 'warning', title: 'Repository list unavailable', detail: `${time ? 'Showing last known repository access. ' : 'No connected-repository count is confirmed. '}${observation.error}` };
  if (!time) return { ...base, title: 'Repository access not checked', detail: 'No dated repository list has been accepted yet.' };
  if (count === 0) return { ...base, title: 'No repositories connected', detail: 'Install the GitHub App and grant access to the repositories you want to work on.', showConnect: true };
  return { ...base, title: 'Repository list received', detail: 'Repositories available in the last accepted access response.' };
}
