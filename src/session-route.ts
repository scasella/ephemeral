export const machineTabs = ['terminal', 'files', 'changes', 'published', 'setup', 'preview', 'access', 'activity', 'notes', 'settings'] as const;
export type MachineTab = typeof machineTabs[number];
export function machineTabKey(key: string, current: MachineTab): MachineTab | null {
  const index = machineTabs.indexOf(current);
  return key === 'ArrowRight' ? machineTabs[(index + 1) % machineTabs.length] : key === 'ArrowLeft' ? machineTabs[(index + machineTabs.length - 1) % machineTabs.length] : key === 'Home' ? machineTabs[0] : key === 'End' ? machineTabs[machineTabs.length - 1] : null;
}
export const workspaceViews = ['machines', 'repositories', 'integrations'] as const;
export type WorkspaceView = typeof workspaceViews[number];
export interface SessionRoute { sessionId: string | null; tab: MachineTab; view: WorkspaceView; issue: string; invalidSession: boolean }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readSessionRoute(url: URL): SessionRoute {
  const params = url.searchParams;
  const session = params.get('session');
  const validSession = session === null || (params.getAll('session').length === 1 && uuid.test(session));
  const tab = params.get('tab');
  const validTab = tab === null || (params.getAll('tab').length === 1 && machineTabs.includes(tab as MachineTab));
  const view = params.get('view');
  const validView = view === null || (params.getAll('view').length === 1 && workspaceViews.includes(view as WorkspaceView));
  return {
    sessionId: validSession ? session?.toLowerCase() ?? null : null,
    tab: validTab && tab ? tab as MachineTab : 'terminal',
    view: validView && view ? view as WorkspaceView : 'machines',
    invalidSession: !validSession,
    issue: !validSession ? 'This link has an invalid machine ID. Select a machine from your history.' : !validTab || !validView ? 'This link has an invalid view. Showing the default view.' : '',
  };
}

export function resolveSessionRoute(route: SessionRoute, sessions: readonly { id: string }[]): { selectedId: string | null; notice: string } {
  if (route.invalidSession) return { selectedId: null, notice: route.issue };
  if (route.sessionId && !sessions.some(session => session.id === route.sessionId)) return { selectedId: null, notice: 'The machine in this link is unavailable in your workspace. It may have been removed or belong to another account. Select a machine from your history.' };
  return { selectedId: route.sessionId ?? sessions[0]?.id ?? null, notice: route.issue };
}

export function navigateSessionRoute(route: SessionRoute, changes: Partial<Pick<SessionRoute, 'sessionId' | 'tab' | 'view'>>): SessionRoute {
  return { ...route, ...changes, issue: '', invalidSession: false };
}

/** Changes only workspace navigation parameters, keeping existing flags and hashes. */
export function sessionRouteUrl(current: URL, route: Pick<SessionRoute, 'sessionId' | 'tab' | 'view'>): URL {
  const next = new URL(current);
  if (route.sessionId) next.searchParams.set('session', route.sessionId);
  else next.searchParams.delete('session');
  next.searchParams.set('tab', route.tab);
  next.searchParams.set('view', route.view);
  return next;
}
