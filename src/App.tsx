import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api, type Bootstrap, type Repository, type Session, type SessionEventPage } from './api';
import { SessionActivity } from './SessionActivity';
import { activityRequestUrl, emptyActivity, SessionActivityLoader, type ActivityState } from './session-activity';
import { WorkStatusPanel, StopWorkCheck } from './WorkStatus';
import { Cleanup } from './Cleanup';
import type { RecoveryEvidenceProps } from './EndedOutcome';
import type { PublishedViewState } from './published-changes';
import type { HandoffNote } from './handoff-notes';
import type { SavedPullRequest } from './workflow';
import { retainPublishedObservation } from './recovery-evidence';
import { PullRequestForm, PullRequestLinks } from './PullRequests';
import { StartupGuide } from './StartupGuide';
import { RepositorySetup } from './RepositorySetup';
import { RepositoryChanges } from './RepositoryChanges';
import { PublishedChanges } from './PublishedChanges';
import { ApplicationPreview } from './ApplicationPreview';
import { ContinuationForm, ContinuationLineage, continuationBlockedReason } from './Continuation';
import { HandoffNotes } from './HandoffNotes';
import { SessionHistory, revealSessionHistory } from './SessionHistory';
import { SessionLabelEditor } from './SessionLabelEditor';
import { mergeSessionLabel, reconcileSessionRefresh, sessionName, SessionSnapshotGate, workspaceIdentity, ownedSessionHistory } from './session-history';
import { machineTabs, machineTabKey, navigateSessionRoute, readSessionRoute, resolveSessionRoute, sessionRouteUrl, type MachineTab, type SessionRoute, type WorkspaceView } from './session-route';
import { ShellWorkspace } from './ShellWorkspace';
import { canOpenPreviewShell, type PreviewShellNavigationRequest } from './preview-shell-navigation';
import { ExpiryReminders, ExpiryNotificationSettings, revealSaveGuidance } from './ExpiryReminders';
import { useExpiryReminders } from './useExpiryReminders';
import { ActiveWorkspaceContext, SelectedWorkspaceContext } from './WorkspaceContext';
import { activeOwnedSessions, focusWorkspaceTarget, deferWorkspaceFocusRestore, WorkspaceNavigationIntent, workspaceSnapshotFresh } from './workspace-navigation';
import './workspace-navigation.css';
import { WorkspaceServiceFeedback } from './ServiceFeedback';
import { ServiceCheckGate, emptyServiceObservation, configurationSidebarLabel, integrationGuidance, repositoryListFeedback, type ServiceObservation } from './service-feedback';

type View = WorkspaceView;
type Tab = MachineTab;
function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    machines: <><rect x="3" y="3" width="18" height="12" rx="2"/><path d="M8 21h8M12 15v6M6 7h.01"/></>,
    repositories: <><path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2V5Zm0 12h15M8 7h7M8 10h5"/></>,
    integrations: <><path d="M8 3v4m8-4v4M5 7h14v4a7 7 0 0 1-14 0V7Zm7 11v3"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    arrow: <path d="m5 12 14 0m-5-5 5 5-5 5"/>,
    branch: <><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10M18 7c0 5-12 3-12 8"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    external: <><path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/></>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    check: <path d="m5 12 4 4 10-10"/>,
    terminal: <><path d="m5 7 5 5-5 5M13 17h6"/></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/></>,
    github: <><path d="M9 19c-4 1-4-2-6-2m12 5v-4c0-1-.4-2-1-2 4-.5 6-2 6-6a5 5 0 0 0-1-3c.4-1 .4-3 0-4-2 0-3 1-4 2a12 12 0 0 0-6 0C8 4 6 3 4 3c-.4 1-.4 3 0 4a5 5 0 0 0-1 3c0 4 2 6 6 6-.6.6-1 1-1 2v4"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.machines}</svg>;
}
function Modal({ title, subtitle, children, onClose, opener }: { title: string; subtitle: string; children: ReactNode; onClose: () => void; opener: HTMLElement | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); deferWorkspaceFocusRestore(opener); };
  }, []);
  return <dialog ref={ref} className="modal" onCancel={event => { event.preventDefault(); onClose(); }} aria-labelledby="modal-title"><div className="modal-head"><span className="eyebrow">EPHEMERAL / WORKSPACE</span><button className="icon-button" onClick={onClose} aria-label="Close dialog"><Icon name="close"/></button></div><h2 id="modal-title">{title}</h2><p className="muted modal-subtitle">{subtitle}</p>{children}</dialog>;
}
const emptyRecoveryEvidence = { publishedState: null, savedNote: null, inheritedNotePresent: null, pullRequests: null };

export default function App() {
  const route = useRef(readSessionRoute(new URL(window.location.href)));
  const navigationIntent = useRef(new WorkspaceNavigationIntent());
  const consumedFocusRequest = useRef<object | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ revision: number; sessionId: string; tab: Tab; accountKey: string; announcement: string } | null>(null);
  const [shellNavigationRequest, setShellNavigationRequest] = useState<PreviewShellNavigationRequest | null>(null);
  const [selectionAnnouncement, setSelectionAnnouncement] = useState('');
  const sessionsRef = useRef<Session[]>([]);
  const acceptedSessionsRef = useRef<Session[]>([]);
  const confirmedAtRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const snapshotGate = useRef(new SessionSnapshotGate());
  const connectionGate = useRef(new ServiceCheckGate());
  const [configurationObservation, setConfigurationObservation] = useState<ServiceObservation>(emptyServiceObservation);
  const [connectionObservation, setConnectionObservation] = useState<ServiceObservation>(emptyServiceObservation);
  const identity = useRef<Bootstrap | null>(null);
  const loadRevision = useRef(0);
  const labelRevisions = useRef(new Map<string, number>());
  const [routeNotice, setRouteNotice] = useState(route.current.issue);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [reminderSessions, setReminderSessions] = useState<Session[]>([]);
  const [sessionsConfirmedAt, setSessionsConfirmedAt] = useState<number | null>(null);
  const [saveGuidanceTarget, setSaveGuidanceTarget] = useState<string | null>(null);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [repositoryObservation, setRepositoryObservation] = useState<ServiceObservation>(emptyServiceObservation);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<View>(route.current.view);
  const [tab, setTab] = useState<Tab>(route.current.tab);
  const [activityState, setActivityState] = useState<ActivityState & { scope: string }>({ ...emptyActivity, scope: '' });
  const activityLoader = useRef<SessionActivityLoader | null>(null);
  const modalOpener = useRef<HTMLElement | null>(null);
  const [openingActiveId, setOpeningActiveId] = useState<string | null>(null);
  const [modal, setModal] = useState<'launch' | 'stop' | 'pr' | 'continue' | null>(null);
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [repoId, setRepoId] = useState('');
  const [branches, setBranches] = useState<{ name: string }[]>([]);
  const [branch, setBranch] = useState('');
  const [branchError, setBranchError] = useState('');
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [stopReady, setStopReady] = useState(false);
  const [prRevision, setPrRevision] = useState(0);
  const [terminalConnection, setTerminalConnection] = useState<{ sessionId: string | null; status: string }>({ sessionId: null, status: 'not connected' });
  const onTerminalStatusChange = useCallback((status: string) => setTerminalConnection({ sessionId: selectedId, status }), [selectedId]);
  const selected = sessions.find(s => s.id === selectedId) || null;
  const preview = bootstrap?.mode === 'preview';
  const canUse = Boolean(preview || bootstrap?.user);
  const activityScope = canUse && selected ? JSON.stringify([workspaceIdentity(bootstrap), selected.id]) : '';
  const currentActivityScope = useRef(activityScope); currentActivityScope.current = activityScope;
  const activity = activityState.scope === activityScope ? activityState : emptyActivity;
  // Keep only the selected scope's observations; never infer preservation from lifecycle.
  const recoveryScope = selected ? JSON.stringify([workspaceIdentity(bootstrap), selected.userId, selected.id, selected.repository, selected.branch, selected.baseBranch]) : '';
  const currentRecoveryScope = useRef(recoveryScope); currentRecoveryScope.current = recoveryScope;
  const [recoveryEvidence, setRecoveryEvidence] = useState<RecoveryEvidenceProps & { scope: string }>({ scope: '', ...emptyRecoveryEvidence });
  const observeRecovery = useCallback((change: Partial<RecoveryEvidenceProps>) => {
    if (!recoveryScope || currentRecoveryScope.current !== recoveryScope) return;
    setRecoveryEvidence(previous => {
      if (currentRecoveryScope.current !== recoveryScope) return previous;
      const scoped: RecoveryEvidenceProps = previous.scope === recoveryScope ? previous : emptyRecoveryEvidence;
      // Editing a draft does not change saved evidence or rerender the workspace.
      if (previous.scope === recoveryScope && Object.entries(change).every(([key, value]) => scoped[key as keyof RecoveryEvidenceProps] === value)) return previous;
      return { ...scoped, scope: recoveryScope, ...change };
    });
  }, [recoveryScope]);
  const observePublished = useCallback((publishedState: PublishedViewState) => {
    if (!recoveryScope || currentRecoveryScope.current !== recoveryScope) return;
    setRecoveryEvidence(previous => {
      if (currentRecoveryScope.current !== recoveryScope) return previous;
      const scoped = previous.scope === recoveryScope ? previous : emptyRecoveryEvidence;
      return { ...scoped, scope: recoveryScope, publishedState: retainPublishedObservation(scoped.publishedState, publishedState) };
    });
  }, [recoveryScope]);
  const observeSavedNote = useCallback((savedNote: HandoffNote | null, inheritedNotePresent: boolean | null) => observeRecovery({ savedNote, inheritedNotePresent }), [observeRecovery]);
  const observePullRequests = useCallback((pullRequests: SavedPullRequest[] | null) => observeRecovery({ pullRequests }), [observeRecovery]);
  const recovery = recoveryEvidence.scope === recoveryScope ? recoveryEvidence : emptyRecoveryEvidence;
  const navigate = useCallback((changes: Partial<Pick<SessionRoute, 'sessionId' | 'tab' | 'view'>>) => {
    navigationIntent.current.invalidate();
    setSelectionAnnouncement('');
    const next = navigateSessionRoute(route.current, changes);
    route.current = next;
    setSelectedId(next.sessionId); setView(next.view); setTab(next.tab); setRouteNotice('');
    const url = sessionRouteUrl(new URL(window.location.href), next);
    if (url.href !== window.location.href) window.history.pushState(null, '', url);
  }, []);
  const changeView = (next: View) => navigate({ view: next });
  const changeTab = (next: Tab) => navigate({ tab: next });
  const openContinuationReview = (source: Session, opener: HTMLElement | null) => {
    const current = sessionsRef.current.find(session => session.id === source.id && session.userId === identity.current?.user?.id);
    if (busy || !current || route.current.sessionId !== source.id || !['ended', 'failed'].includes(current.state) || continuationBlockedReason(current)) return;
    modalOpener.current = opener; setError(''); setModal('continue');
  };
  const previewActionSession = () => {
    if (!selected || modal || view !== 'machines' || tab !== 'preview' || route.current.view !== 'machines' || route.current.tab !== 'preview' || route.current.sessionId !== selected.id || workspaceIdentity(bootstrap) !== workspaceIdentity(identity.current)) return null;
    return sessionsRef.current.find(session => session.id === selected.id && session.userId === identity.current?.user?.id && session.repository === selected.repository && session.branch === selected.branch && session.baseBranch === selected.baseBranch) || null;
  };
  const openPreviewShell = () => {
    const session = previewActionSession();
    if (!session || !canOpenPreviewShell(session, Date.now())) return;
    const accountKey = workspaceIdentity(identity.current);
    navigate({ sessionId: session.id, view: 'machines', tab: 'terminal' });
    const revision = navigationIntent.current.capture();
    setShellNavigationRequest({ sessionId: session.id, isCurrent: () => {
      const current = sessionsRef.current.find(item => item.id === session.id && item.userId === identity.current?.user?.id);
      return mountedRef.current && navigationIntent.current.current(revision) && accountKey === workspaceIdentity(identity.current) && route.current.sessionId === session.id && route.current.view === 'machines' && route.current.tab === 'terminal' && Boolean(current && canOpenPreviewShell(current, Date.now())) && !document.querySelector('dialog[open]');
    } });
  };
  const reviewPreviewPublished = () => {
    const session = previewActionSession();
    if (!session) return;
    navigate({ sessionId: session.id, view: 'machines', tab: 'published' });
    requestSelectionFocus(session, 'published', false);
  };
  const continuePreviewSavedWork = (opener: HTMLButtonElement) => {
    const session = previewActionSession();
    if (session) openContinuationReview(session, opener);
  };
  const selectSession = (id: string, nextTab: Tab = route.current.tab) => {
    if (!sessionsRef.current.some(session => session.id === id && session.userId === identity.current?.user?.id)) return false;
    navigate({ sessionId: id, tab: nextTab, view: 'machines' }); setModal(null); setError('');
    return true;
  };
  const requestSelectionFocus = (session: Session, nextTab: Tab, announce: boolean) => {
    setSelectionAnnouncement('');
    setFocusRequest({ revision: navigationIntent.current.capture(), sessionId: session.id, tab: nextTab, accountKey: workspaceIdentity(identity.current), announcement: announce ? `Selected ${sessionName(session)}. ${nextTab[0].toUpperCase() + nextTab.slice(1)} details.` : '' });
  };
  const selectHistorySession = (id: string) => {
    if (!selectSession(id)) return false;
    requestSelectionFocus(sessionsRef.current.find(session => session.id === id)!, route.current.tab, true);
    return true;
  };
  useLayoutEffect(() => {
    const interrupt = () => navigationIntent.current.invalidate();
    // Removing the Preview opener may return browser focus to the document.
    // An actual control receiving focus still cancels any pending jump.
    const interruptFocus = (event: FocusEvent) => {
      if (event.target !== document.body && event.target !== document.documentElement) interrupt();
    };
    document.addEventListener('pointerdown', interrupt, true);
    document.addEventListener('keydown', interrupt, true);
    document.addEventListener('focusin', interruptFocus, true);
    return () => { document.removeEventListener('pointerdown', interrupt, true); document.removeEventListener('keydown', interrupt, true); document.removeEventListener('focusin', interruptFocus, true); };
  }, []);
  useLayoutEffect(() => {
    // Only an explicit action creates this request; each request runs once after commit.
    if (!focusRequest || consumedFocusRequest.current === focusRequest) return;
    consumedFocusRequest.current = focusRequest;
    if (!navigationIntent.current.current(focusRequest.revision) || focusRequest.accountKey !== workspaceIdentity(identity.current) || selectedId !== focusRequest.sessionId || view !== 'machines' || tab !== focusRequest.tab || modal) return;
    if (focusWorkspaceTarget(`tab-${focusRequest.tab}`)) setSelectionAnnouncement(focusRequest.announcement);
  }, [focusRequest, selectedId, view, tab, modal]);
  const refresh = useCallback(async () => {
    const expectedIdentity = identity.current;
    if (!expectedIdentity?.user || !mountedRef.current) return;
    const revision = snapshotGate.current.begin();
    const check = connectionGate.current.begin(workspaceIdentity(expectedIdentity));
    setConnectionObservation(previous => ({ ...previous, checking: true }));
    const startedId = route.current.sessionId;
    let response: Session[];
    try { response = await api<Session[]>('/sessions'); } catch (failure) {
      if (!mountedRef.current || !snapshotGate.current.accepts(revision) || !connectionGate.current.commit(check, workspaceIdentity(identity.current))) return;
      confirmedAtRef.current = null; setSessionsConfirmedAt(null);
      const checking = connectionGate.current.checking();
      setConnectionObservation(previous => ({ ...previous, checking, error: (failure as Error).message }));
      throw failure;
    }
    if (!mountedRef.current || !connectionGate.current.accepts(check, workspaceIdentity(identity.current)) || !snapshotGate.current.apply(revision)) return;
    if (!connectionGate.current.commit(check, workspaceIdentity(identity.current))) return;
    const incoming = ownedSessionHistory(response, expectedIdentity);
    acceptedSessionsRef.current = incoming; confirmedAtRef.current = Date.now();
    setConnectionObservation({ checking: connectionGate.current.checking(), observedAt: confirmedAtRef.current, error: '' });
    setReminderSessions(incoming); setSessionsConfirmedAt(confirmedAtRef.current); setNow(confirmedAtRef.current);
    const data = reconcileSessionRefresh(incoming, sessionsRef.current, startedId, route.current.sessionId);
    sessionsRef.current = data; setSessions(data);
    const resolved = resolveSessionRoute(route.current, data);
    setSelectedId(resolved.selectedId); setRouteNotice(resolved.notice); setRefreshError('');
    if (!route.current.sessionId && !route.current.invalidSession && resolved.selectedId) {
      route.current = { ...route.current, sessionId: resolved.selectedId };
      window.history.replaceState(null, '', sessionRouteUrl(new URL(window.location.href), route.current));
    }
  }, []);
  useEffect(() => {
    const restore = () => {
      navigationIntent.current.invalidate();
      setSelectionAnnouncement('');
      route.current = readSessionRoute(new URL(window.location.href));
      const resolved = resolveSessionRoute(route.current, sessionsRef.current);
      setSelectedId(resolved.selectedId); setView(route.current.view); setTab(route.current.tab);
      setRouteNotice(resolved.notice); setModal(null); setError('');
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  const load = useCallback(async () => {
    navigationIntent.current.invalidate();
    const revision = ++loadRevision.current;
    setLoading(true); setError('');
    // This recheck supersedes any earlier repository read, even while bootstrap loads.
    setRepositoryObservation(previous => ({ ...previous, checking: false }));
    setConfigurationObservation(previous => ({ ...previous, checking: true }));
    let configurationAccepted = false;
    let readingRepositories = false;
    try {
      const boot = await api<Bootstrap>('/bootstrap');
      if (!mountedRef.current || revision !== loadRevision.current) return;
      if (workspaceIdentity(boot) !== workspaceIdentity(identity.current)) {
        setSelectionAnnouncement('');
        snapshotGate.current.invalidate(); connectionGate.current.invalidate(); sessionsRef.current = []; acceptedSessionsRef.current = []; confirmedAtRef.current = null; labelRevisions.current.clear();
        setConnectionObservation(emptyServiceObservation); setRepositoryObservation(emptyServiceObservation);
        setSessions([]); setReminderSessions([]); setSessionsConfirmedAt(null); setSaveGuidanceTarget(null); setRepositories([]); setSelectedId(null); setModal(null); setBusy(false);
        setRefreshError(''); setTerminalConnection({ sessionId: null, status: 'not connected' });
      }
      identity.current = boot; setBootstrap(boot);
      configurationAccepted = true;
      const observedAt = Date.now();
      setConfigurationObservation({ checking: false, observedAt, error: '' }); setNow(observedAt);
      if (boot.mode === 'preview' || boot.user) {
        await refresh();
        // A superseded recheck must not continue with another account's reads.
        if (!mountedRef.current || revision !== loadRevision.current || workspaceIdentity(boot) !== workspaceIdentity(identity.current)) return;
        readingRepositories = true;
        setRepositoryObservation(previous => ({ ...previous, checking: true }));
        const repositories = await api<Repository[]>('/repositories');
        if (mountedRef.current && revision === loadRevision.current && workspaceIdentity(boot) === workspaceIdentity(identity.current)) {
          const observedAt = Date.now();
          setRepositories(repositories); setRepositoryObservation({ checking: false, observedAt, error: '' }); setNow(observedAt);
        }
      }
    } catch (e) {
      if (!mountedRef.current || revision !== loadRevision.current) return;
      if (!configurationAccepted) setConfigurationObservation(previous => ({ ...previous, checking: false, error: (e as Error).message }));
      else if (readingRepositories) setRepositoryObservation(previous => ({ ...previous, checking: false, error: (e as Error).message }));
    }
    finally { if (mountedRef.current && revision === loadRevision.current) setLoading(false); }
  }, [refresh]);
  useEffect(() => { mountedRef.current = true; void load(); return () => { mountedRef.current = false; ++loadRevision.current; snapshotGate.current.invalidate(); connectionGate.current.invalidate(); }; }, [load]);
  useEffect(() => { const interval = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(interval); }, []);
  useEffect(() => { if (!canUse) return; const interval = setInterval(() => { void refresh().catch(() => {}); }, 3000); return () => clearInterval(interval); }, [canUse, refresh]);
  useEffect(() => {
    setActivityState({ ...emptyActivity, scope: activityScope });
    if (!activityScope || !selected) return;
    const loader = new SessionActivityLoader(
      (before, signal) => api<SessionEventPage>(activityRequestUrl(selected.id, before), undefined, { signal }),
      state => setActivityState({ ...state, scope: activityScope }),
      () => currentActivityScope.current === activityScope,
    );
    activityLoader.current = loader;
    void loader.newest();
    const interval = setInterval(() => { void loader.poll(); }, 3000);
    return () => { clearInterval(interval); loader.dispose(); if (activityLoader.current === loader) activityLoader.current = null; };
  }, [activityScope]);
  useEffect(() => {
    const repo = repositories.find(r => String(r.id) === repoId); setBranchError(''); setBranches([]); setBranch(''); if (!repo) return; let active = true; setBranchesLoading(true);
    api<{ name: string }[]>(`/repositories/${repo.installationId}/${repo.id}/branches`).then(data => { if (active) { setBranches(data); setBranch(data.some(b => b.name === repo.defaultBranch) ? repo.defaultBranch : data[0]?.name || ''); } }).catch(e => { if (active) setBranchError(e.message); }).finally(() => { if (active) setBranchesLoading(false); }); return () => { active = false; };
  }, [repoId, repositories]);
  function rememberSession(data: Session) {
    if (data.userId !== identity.current?.user?.id) return false;
    snapshotGate.current.invalidate(); connectionGate.current.invalidate();
    setConnectionObservation(previous => ({ ...previous, checking: false }));
    confirmedAtRef.current = null; setSessionsConfirmedAt(null);
    setReminderSessions(previous => previous.some(session => session.id === data.id) ? previous.map(session => session.id === data.id ? data : session) : [data, ...previous]);
    const list = sessionsRef.current;
    const next = list.some(session => session.id === data.id) ? list.map(session => session.id === data.id ? data : session) : [data, ...list];
    sessionsRef.current = next; setSessions(next); return true;
  }
  function rememberLabel(updated: Session) {
    if (updated.userId !== identity.current?.user?.id) return;
    snapshotGate.current.invalidate(); connectionGate.current.invalidate();
    setConnectionObservation(previous => ({ ...previous, checking: false }));
    confirmedAtRef.current = null; setSessionsConfirmedAt(null);
    setReminderSessions(previous => previous.map(item => mergeSessionLabel(item, updated)));
    labelRevisions.current.set(updated.id, (labelRevisions.current.get(updated.id) || 0) + 1);
    const next = sessionsRef.current.map(item => mergeSessionLabel(item, updated));
    sessionsRef.current = next; setSessions(next);
  }
  async function mutate(path: string, body: unknown = {}) {
    const expectedIdentity = workspaceIdentity(identity.current);
    const startedLabels = new Map(labelRevisions.current);
    setBusy(true); setError('');
    try {
      let data = await api<Session>(path, body);
      if (expectedIdentity !== workspaceIdentity(identity.current)) return null;
      const current = sessionsRef.current.find(session => session.id === data.id);
      if (current && startedLabels.get(data.id) !== labelRevisions.current.get(data.id)) data = mergeSessionLabel(data, current);
      if (!rememberSession(data)) return null;
      return data;
    } catch (e) { if (expectedIdentity === workspaceIdentity(identity.current)) setError((e as Error).message); return null; }
    finally { if (expectedIdentity === workspaceIdentity(identity.current)) setBusy(false); }
  }
  function openLaunch(event: React.MouseEvent<HTMLButtonElement>) { modalOpener.current = event.currentTarget; setError(''); setRepoId(String(repositories[0]?.id || '')); setModal('launch'); }
  async function launch(event: React.FormEvent) { event.preventDefault(); const repo = repositories.find(r => String(r.id) === repoId); if (!repo || !branch || sessions.some(s => ['running', 'provisioning', 'cleanup_pending'].includes(s.state)) || busy) return; const session = await mutate('/sessions', { repositoryId: repo.id, installationId: repo.installationId, baseBranch: branch }); if (session) { selectSession(session.id, 'terminal'); } }
  const maxHours = bootstrap?.sessionMaxHours ?? 1;
  const sessionMaxHours = selected ? (Date.parse(selected.maxExpiresAt) - Date.parse(selected.createdAt)) / 3_600_000 : maxHours;
  const canExtend = Boolean(maxHours > 1 && selected && selected.state === 'running' && Date.parse(selected.expiresAt) > now && Date.parse(selected.maxExpiresAt) > Date.parse(selected.expiresAt));
  const activeSessions = activeOwnedSessions(reminderSessions, bootstrap?.user?.id);
  const otherActiveSessions = view === 'machines' ? activeSessions.filter(session => session.id !== selectedId) : activeSessions;
  const showActiveContext = otherActiveSessions.length > 0;
  const activeSkipTarget = showActiveContext ? 'active-work-control' : `tab-${tab}`;
  const activeCount = sessions.filter(s => ['running', 'provisioning', 'cleanup_pending'].includes(s.state)).length;
  const canLaunch = Boolean(canUse && (preview || bootstrap?.configured));
  const canLaunchFresh = canLaunch && activeCount === 0;
  const openExpirySession = useCallback((id: string) => {
    if (!sessionsRef.current.some(session => session.id === id && session.userId === identity.current?.user?.id)) return;
    navigate({ sessionId: id, tab: 'terminal', view: 'machines' });
    setModal(null); setError(''); setSaveGuidanceTarget(id);
  }, [navigate]);
  const openActiveSession = async (id: string) => {
    if (openingActiveId !== null) return;
    const expectedIdentity = workspaceIdentity(identity.current);
    const startedRoute = route.current;
    const startedIntent = navigationIntent.current.capture();
    setOpeningActiveId(id);
    try {
      await refresh();
      if (!mountedRef.current || expectedIdentity !== workspaceIdentity(identity.current) || route.current !== startedRoute || !navigationIntent.current.current(startedIntent) || document.querySelector('dialog[open]')) return;
      const active = activeOwnedSessions(acceptedSessionsRef.current, identity.current?.user?.id).find(session => session.id === id);
      if (!workspaceSnapshotFresh(confirmedAtRef.current, Date.now())) { setRefreshError('Machine status could not be checked. Try opening active work again.'); return; }
      if (!active) { setError('That machine is no longer active. Choose it from Machines history to review its final status.'); return; }
      const nextTab = active.state === 'cleanup_pending' ? 'access' : 'terminal';
      selectSession(active.id, nextTab);
      requestSelectionFocus(active, nextTab, false);
    } catch { /* The fenced session read records its own failure. */ }
    finally { if (mountedRef.current) setOpeningActiveId(null); }
  };
  const expiry = useExpiryReminders({ bootstrap, sessions: reminderSessions, confirmedAt: sessionsConfirmedAt, now, refreshSessions: refresh, onOpenSession: openExpirySession });
  async function signOut() {
    navigationIntent.current.invalidate();
    setSelectionAnnouncement('');
    expiry.dispose(); ++loadRevision.current; snapshotGate.current.invalidate(); connectionGate.current.invalidate();
    setConfigurationObservation(emptyServiceObservation); setConnectionObservation(emptyServiceObservation); setRepositoryObservation(emptyServiceObservation);
    identity.current = null; sessionsRef.current = []; acceptedSessionsRef.current = []; confirmedAtRef.current = null; labelRevisions.current.clear();
    setBootstrap(null); setSessions([]); setReminderSessions([]); setSessionsConfirmedAt(null); setSelectedId(null); setModal(null); setLoading(true);
    try { await api('/logout', {}); location.reload(); }
    catch (failure) { await load(); setError((failure as Error).message); }
  }
  useEffect(() => {
    const target = saveGuidanceTarget ?? (window.location.hash === '#save-guidance' ? route.current.sessionId : null);
    if (!target || selectedId !== target || view !== 'machines' || tab !== 'terminal') return;
    if (revealSaveGuidance()) setSaveGuidanceTarget(null);
  }, [saveGuidanceTarget, selectedId, selected?.state, view, tab, loading]);
  const repositoryFeedback = repositoryListFeedback(repositoryObservation, repositories.length, now);
  return <div className="app-shell">
    <nav className="workspace-skip-links" aria-label="Skip links"><a href="#workspace-main" onClick={event => { event.preventDefault(); focusWorkspaceTarget('workspace-main'); }}>Skip to main content</a>{canUse && view === 'machines' && selected && <a href={`#tab-${tab}`} onClick={event => { event.preventDefault(); focusWorkspaceTarget(`tab-${tab}`); }}>Skip to selected machine details</a>}{canUse && activeSessions.length > 0 && <a href={`#${activeSkipTarget}`} onClick={event => { event.preventDefault(); focusWorkspaceTarget(activeSkipTarget); }}>Skip to active work</a>}</nav>
    <aside className="sidebar"><a className="brand" href="/" aria-label="Ephemeral home"><span className="brand-symbol">e<span>_</span></span><span>EPHEMERAL</span></a><div className="workspace-label"><span className="workspace-avatar">{bootstrap?.user?.login.slice(0, 1).toUpperCase() || 'P'}</span><div>{bootstrap?.user?.login || 'Personal workspace'}<small>{preview ? 'Preview environment' : 'Development workspace'}</small></div><span className="workspace-chevron">⌄</span></div><div className="nav-section-label">WORKSPACE</div><nav aria-label="Workspace">{(['machines', 'repositories', 'integrations'] as View[]).map(item => <button className={`nav-item ${view === item ? 'active' : ''}`} onClick={() => changeView(item)} aria-current={view === item ? 'page' : undefined} aria-label={item[0].toUpperCase() + item.slice(1)} key={item}><Icon name={item}/><span>{item[0].toUpperCase() + item.slice(1)}</span>{item === 'machines' && <span className="nav-count">{activeCount}</span>}</button>)}</nav><div className="sidebar-note"><div className="mini-symbol">[ / ]</div><p>A fresh workspace.<br/>A finite lifetime.</p><span>BUILD. SHIP. DISAPPEAR.</span></div><div className="sidebar-bottom"><span className="status-dot"/> {configurationSidebarLabel(bootstrap, configurationObservation)}<span>v0.1</span></div></aside>
    <div className="main-shell"><header className="topbar"><div><span className="breadcrumb-root">Workspace</span><span className="breadcrumb-slash">/</span><span>{view[0].toUpperCase() + view.slice(1)}</span></div><div className="topbar-right">{preview && <span className="preview-label">PREVIEW <span>• no compute or credentials</span></span>}{canUse && <button className="text-button" onClick={() => { changeView('integrations'); requestAnimationFrame(() => document.getElementById('expiry-notification-heading')?.scrollIntoView({ block: 'center' })); }}>Reminders</button>}{bootstrap?.user && !preview && <button className="text-button" onClick={() => { void signOut(); }}>Sign out</button>}<span className="profile-mark">{bootstrap?.user?.login.slice(0, 2).toUpperCase() || 'EP'}</span></div></header>
      <main id="workspace-main" tabIndex={-1}>
        <WorkspaceServiceFeedback bootstrap={bootstrap} configuration={configurationObservation} connection={connectionObservation} now={now}/>
        <div className="workspace-selection-announcement" role="status" aria-live="polite" aria-atomic="true">{selectionAnnouncement}</div>
        {canUse && showActiveContext && <ActiveWorkspaceContext sessions={otherActiveSessions} selectedId={selectedId} inMachines={view === 'machines'} now={now} confirmedAt={sessionsConfirmedAt} openingId={openingActiveId} onOpen={id => { void openActiveSession(id); }}/> }
        {canUse && <ExpiryReminders reminders={expiry.reminders} sessions={reminderSessions} now={now} preview={Boolean(preview)} confirmedAt={sessionsConfirmedAt} onOpenSession={expiry.openSession}/>}
        {(error || configurationObservation.error || connectionObservation.error || repositoryObservation.error || refreshError) && !modal && <div className="error-banner" role="alert"><span>{error || configurationObservation.error || connectionObservation.error || (repositoryObservation.error ? `Repository list unavailable: ${repositoryObservation.error}` : '') || refreshError}</span><button className="text-button" onClick={() => { setError(''); void load(); }}>Retry</button></div>}
        {bootstrap && !bootstrap.configured && !preview && <div className="setup-banner"><Icon name="integrations"/><span>Required settings were missing when configuration was recorded. Review setup before launching a machine.</span><button className="text-button" onClick={() => changeView('integrations')}>View setup <Icon name="arrow"/></button></div>}
        {loading && !bootstrap ? <div className="loading-state"><span className="loading-cursor">_</span>Connecting to your workspace…</div> : !bootstrap ? <div className="empty-state"><Icon name="machines" size={32}/><h1>Workspace unavailable</h1><p>Check the server connection, then try again.</p><button className="button primary" onClick={() => void load()}>Reconnect</button></div> : !canUse ? <div className="auth-state"><span className="eyebrow">YOUR NEXT WORKSPACE STARTS HERE</span><h1>Make room for<br/>what’s next<span className="title-cursor">_</span></h1><p>Launch an isolated environment from a GitHub repository. Work in the browser. Commit and push what matters. Let the rest disappear.</p><a className="button primary" href="/auth/github"><Icon name="github"/>Continue with GitHub<Icon name="arrow"/></a><div className="auth-facts"><span>01 / Isolated sandbox</span><span>02 / Initial lifetime: 1 hour</span><span>03 / Scoped credentials</span></div></div> : <><div className="compact-machine-workspace" hidden={view !== 'machines'}>
          <div className="page-heading"><div><span className="eyebrow">YOUR COMPUTE, ON BORROWED TIME</span><h1>Machines<span className="heading-count">{sessions.length.toString().padStart(2, '0')}</span></h1></div><button className="button primary" onClick={openLaunch} disabled={!canLaunchFresh}><Icon name="plus"/>New machine</button></div>
          <SessionHistory panelScope={workspaceIdentity(bootstrap)} sessions={sessions} selectedId={selectedId} onSelect={selectHistorySession}/>
          {routeNotice && <div className="session-route-notice" role="status"><p>{routeNotice}</p><button className="text-button" onClick={() => { revealSessionHistory(); }}>Choose from history</button></div>}
          {!selected ? <div className="empty-state"><span className="empty-glyph">[ _ ]</span><h2>{sessions.length ? 'Select a machine.' : 'A clean slate.'}</h2><p>Choose a repository to start a disposable workspace.<br/>Each machine starts with one hour.{maxHours > 1 ? ` Extend up to ${maxHours} hours.` : ' One hour is the maximum lifetime.'}</p><button className="button primary" onClick={openLaunch} disabled={!canLaunchFresh}><Icon name="plus"/>Launch your first machine</button><span className="empty-footnote">Your changes survive only when you commit and push.</span></div> : <>
            <SelectedWorkspaceContext detailTab={tab} session={selected} now={now} confirmedAt={reminderSessions.some(session => session.id === selected.id) ? sessionsConfirmedAt : null} actions={<>{canExtend && <button className="button subtle small" disabled={busy} onClick={() => void mutate(`/sessions/${selected.id}/extend`, { minutes: 30 })}><Icon name="plus"/>30 min</button>}{['ended', 'failed'].includes(selected.state) && <button className="button subtle small" disabled={busy || Boolean(continuationBlockedReason(selected))} title={continuationBlockedReason(selected) || undefined} onClick={event => openContinuationReview(selected, event.currentTarget)}>Continue saved work</button>}<button className="button subtle small" disabled={selected.state !== 'running'} onClick={event => { modalOpener.current = event.currentTarget; setError(''); setModal('pr'); }}><Icon name="github"/>Create pull request</button><button className="button subtle small" disabled={busy || !['running', 'provisioning'].includes(selected.state)} onClick={event => { modalOpener.current = event.currentTarget; setError(''); setStopReady(false); setModal('stop'); }}><span className="stop-square"/>Stop machine</button></>}/>
            <ContinuationLineage session={selected} onSelectSource={id => { if (sessions.some(session => session.id === id)) { selectSession(id); } }}/>
            {['ended', 'failed'].includes(selected.state) && continuationBlockedReason(selected) && <p className="workflow-message">{continuationBlockedReason(selected)}</p>}
            <WorkStatusPanel key={`work-${recoveryScope}`} panelScope={workspaceIdentity(bootstrap)} session={selected} now={now} {...recovery} onReviewPublished={() => { changeTab('published'); focusWorkspaceTarget('tab-published'); }} onReviewNotes={() => { changeTab('notes'); focusWorkspaceTarget('tab-notes'); }} onReviewCleanup={() => { changeTab('access'); focusWorkspaceTarget('tab-access'); }}/><PullRequestLinks key={`prs-${recoveryScope}`} session={selected} revision={prRevision} onRecordsChange={observePullRequests}/>
            <div className="tabs" role="tablist" aria-label="Machine details" onKeyDown={event => {
              const next = machineTabKey(event.key, tab);
              if (next) { event.preventDefault(); changeTab(next); document.getElementById(`tab-${next}`)?.focus(); }
            }}>{machineTabs.map(item => <button role="tab" tabIndex={tab === item ? 0 : -1} aria-selected={tab === item} aria-controls={`panel-${item}`} id={`tab-${item}`} key={item} className={tab === item ? 'active' : ''} onClick={() => changeTab(item)}>{item === 'terminal' && <Icon name="terminal"/>}{item[0].toUpperCase() + item.slice(1)}{item === 'activity' && activity.loaded && <span aria-label={`${activity.events.length} events on loaded page`}>{activity.events.length}</span>}</button>)}</div>
            <div role="tabpanel" id="panel-terminal" aria-labelledby="tab-terminal" hidden={tab !== 'terminal'}>
            {(selected.state === 'running' ? <ShellWorkspace key={`shells-${recoveryScope}`} navigationRequest={shellNavigationRequest} sessionId={selected.id} preview={Boolean(preview)} visible={tab === 'terminal' && view === 'machines'} repository={selected.repository} branch={selected.branch} expiresAt={selected.expiresAt} onStatusChange={onTerminalStatusChange}/> : <div className="terminal-placeholder"><span className="terminal-prompt">{selected.state === 'provisioning' ? '> _' : '[ / ]'}</span><h3>{selected.state === 'provisioning' ? 'Preparing your workspace' : selected.state === 'cleanup_pending' ? 'Cleaning up your workspace' : 'This machine has stopped'}</h3><p>{selected.error || (selected.state === 'provisioning' ? 'Creating a sandbox, cloning the repository, and preparing the shell.' : 'Review the access tab for the status of each cleanup operation.')}</p><button className="text-button" onClick={() => changeTab(selected.state === 'provisioning' ? 'activity' : 'access')}>View {selected.state === 'provisioning' ? 'activity' : 'cleanup'} <Icon name="arrow"/></button></div>)}
            <StartupGuide key={`startup-${selected.id}`} session={selected} preview={Boolean(preview)} terminalStatus={terminalConnection.sessionId === selected.id ? terminalConnection.status : 'not connected'} now={now}/>
            </div>
            <HandoffNotes key={`notes-${recoveryScope}`} session={selected} visible={tab === 'notes' && view === 'machines'} onSelectSource={id => selectSession(id, 'notes')} onSavedNoteChange={observeSavedNote}/>
            {tab !== 'terminal' && tab !== 'notes' && <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
            {tab === 'changes' && <RepositoryChanges key={`changes-${recoveryScope}`} session={selected} preview={Boolean(preview)} now={now} accountKey={workspaceIdentity(bootstrap)}/>}
            {tab === 'published' && <PublishedChanges key={`published-${recoveryScope}`} session={selected} preview={Boolean(preview)} now={now} accountKey={workspaceIdentity(bootstrap)} onStateChange={observePublished}/> }
            {tab === 'setup' && <RepositorySetup key={`setup-${recoveryScope}`} session={selected} preview={Boolean(preview)} now={now}/>}
            {tab === 'preview' && view === 'machines' && <ApplicationPreview key={`preview-${recoveryScope}`} session={selected} preview={Boolean(preview)} now={now} accountKey={workspaceIdentity(bootstrap)} onOpenShell={canOpenPreviewShell(selected, now) ? openPreviewShell : undefined} onReviewPublished={reviewPreviewPublished} onContinueSavedWork={!busy && ['ended', 'failed'].includes(selected.state) && !continuationBlockedReason(selected) ? continuePreviewSavedWork : undefined}/>}
            {tab === 'access' && <section className="detail-panel"><div className="detail-heading"><div><span className="eyebrow">LEAVE NO ACCESS BEHIND</span><h3>Credentials & cleanup</h3><p>Each resource is tracked independently. A stopped machine does not imply every token has been revoked.</p></div>{['cleanup_pending', 'failed', 'ended'].includes(selected.state) && Object.values(selected.cleanup).some(value => ['failed', 'pending'].includes(value)) && <button className="button subtle small" disabled={busy} onClick={() => void mutate(`/sessions/${selected.id}/retry-cleanup`)}>Retry cleanup</button>}</div><Cleanup session={selected}/></section>}
            {tab === 'activity' && <SessionActivity state={activity} onOlder={() => { void activityLoader.current?.older(); }} onNewest={() => { void activityLoader.current?.newest(); }} onRetry={() => { void activityLoader.current?.retry(); }}/>}
            {tab === 'settings' && <section className="detail-panel"><div className="detail-heading"><div><span className="eyebrow">FINITE BY DESIGN</span><h3>Machine settings</h3><p>Session lifetime and workspace identity.</p></div></div><SessionLabelEditor key={selected.id} session={selected} onSaved={rememberLabel}/><dl className="settings-list"><div><dt>Created</dt><dd>{new Date(selected.createdAt).toLocaleString()}</dd></div><div><dt>Expires</dt><dd>{new Date(selected.expiresAt).toLocaleString()}</dd></div><div><dt>Maximum lifetime</dt><dd>{sessionMaxHours} {sessionMaxHours === 1 ? 'hour' : 'hours'} from creation</dd></div><div><dt>Session ID</dt><dd>{selected.id}</dd></div><div><dt>Sandbox ID</dt><dd>{selected.sandboxId || 'Not assigned'}</dd></div><div><dt>Base branch</dt><dd>{selected.baseBranch}</dd></div><div><dt>Work branch</dt><dd>{selected.branch}</dd></div></dl><div className="notice"><Icon name="clock"/><p>Machines are automatically stopped at expiry. Commit and push intentional changes before the countdown reaches zero.</p></div></section>}
            </div>}<footer className="machine-footer"><span><Icon name="shield"/>Scoped access. Disposable compute.</span><span>{preview ? 'Preview / lifecycle is simulated' : 'Changes must be committed and pushed to persist.'}</span></footer>
          </>}
        </div>{view === 'repositories' ? <><div className="page-heading"><div><span className="eyebrow">START FROM WHAT YOU’RE BUILDING</span><h1>Repositories<span className="heading-count">{repositoryFeedback.time ? repositories.length.toString().padStart(2, '0') : '—'}</span></h1></div>{bootstrap.githubInstallUrl && <a className="button subtle" href={bootstrap.githubInstallUrl}><Icon name="github"/>Manage access<Icon name="external"/></a>}</div><section className="repository-table">{repositories.length > 0 && <div className="repository-read-feedback"><strong>{repositoryFeedback.title}</strong><p>{repositoryFeedback.detail}</p>{repositoryFeedback.time && <p className="service-feedback-time">{repositoryFeedback.timeLabel}: <time dateTime={repositoryFeedback.time.iso} title={repositoryFeedback.time.iso}>{repositoryFeedback.time.age}</time></p>}</div>}<div className="table-head"><span>REPOSITORY</span><span>DEFAULT BRANCH</span><span/></div>{repositories.map(repo => <div className="repository-row" key={`${repo.installationId}-${repo.id}`}><span><Icon name="repositories"/><strong>{repo.fullName}</strong></span><span><Icon name="branch"/>{repo.defaultBranch}</span><button className="button subtle small" disabled={!canLaunchFresh} onClick={event => { modalOpener.current = event.currentTarget; setRepoId(String(repo.id)); setError(''); setModal('launch'); }}>Launch<Icon name="arrow"/></button></div>)}{repositories.length === 0 && <div className="empty-state compact"><Icon name="repositories" size={30}/><h2>{repositoryFeedback.title}</h2><p>{repositoryFeedback.detail}</p>{repositoryFeedback.time && <p className="service-feedback-time">{repositoryFeedback.timeLabel}: <time dateTime={repositoryFeedback.time.iso} title={repositoryFeedback.time.iso}>{repositoryFeedback.time.age}</time></p>}{repositoryFeedback.showConnect && bootstrap.githubInstallUrl && <a className="button primary" href={bootstrap.githubInstallUrl}>Connect repositories</a>}</div>}</section><p className="page-footnote">Only repositories available to your GitHub identity and App installation appear here.</p></> : view === 'integrations' ? <><div className="page-heading"><div><span className="eyebrow">THE SERVICES BEHIND YOUR WORKSPACE</span><h1>Integrations</h1></div><span className="badge"><span className="status-dot"/>{configurationSidebarLabel(bootstrap, configurationObservation)}</span></div><ExpiryNotificationSettings desktop={expiry.desktop} preview={Boolean(preview)} onEnable={expiry.enableDesktop} onDisable={expiry.disableDesktop}/><section className="integration-card"><div className="integration-card-header"><span className="integration-icon"><Icon name="github" size={25}/></span><div><h3>GitHub</h3><p>Repository access through a scoped GitHub App.</p></div>{bootstrap.githubInstallUrl && <a className="button subtle small" href={bootstrap.githubInstallUrl}>Manage<Icon name="external"/></a>}</div><p className="integration-copy">Your sandbox receives a session-scoped git gateway credential. GitHub credentials remain on the server. Push access ends when the session is cleaned up.</p></section><section className="detail-panel configuration-panel"><div className="detail-heading"><div><span className="eyebrow">SERVER CONFIGURATION</span><h3>{integrationGuidance(bootstrap, configurationObservation).heading}</h3><p className="service-configuration-copy">{integrationGuidance(bootstrap, configurationObservation).detail}</p></div><div className="service-configuration-actions">{integrationGuidance(bootstrap, configurationObservation).launchRoute && <button className="button primary small" onClick={() => { changeView('machines'); focusWorkspaceTarget('workspace-main'); }}>Open Machines<Icon name="arrow"/></button>}<button className="button subtle small" disabled={configurationObservation.checking} onClick={() => void load()}>{configurationObservation.checking ? 'Checking configuration…' : 'Recheck configuration'}</button></div></div>{bootstrap.missing.length > 0 && <div className="configuration-list">{bootstrap.missing.map(name => <div key={name}><span>{name}</span><span className="config-missing">Required</span></div>)}</div>}<div className="notice"><Icon name="shield"/><p>Secrets are configured in the deployment environment. This interface does not accept or display service credentials.</p></div></section></> : null}</>}
      </main><footer className="app-footer"><span>EPHEMERAL</span><span>EVERY WORKSPACE HAS AN END.</span><span>© {new Date().getFullYear()}</span></footer>
    </div>
    {modal === 'launch' && <Modal opener={modalOpener.current} title="New machine" subtitle={preview ? 'Preview a disposable workspace. No compute or credentials are created.' : 'Start fresh from a repository and base branch.'} onClose={() => { if (!busy) setModal(null); }}><form onSubmit={launch}><label htmlFor="repository">Repository</label><select id="repository" value={repoId} onChange={e => setRepoId(e.target.value)} required disabled={busy}><option value="">Select a repository</option>{repositories.map(repo => <option value={repo.id} key={`${repo.installationId}-${repo.id}`}>{repo.fullName}</option>)}</select><label htmlFor="branch">Base branch</label><select id="branch" value={branch} onChange={e => setBranch(e.target.value)} required disabled={busy || branchesLoading || !branches.length}><option value="">{branchesLoading ? 'Loading branches…' : 'Select a branch'}</option>{branches.map(item => <option key={item.name}>{item.name}</option>)}</select>{branchError && <p className="form-error" role="alert">{branchError}</p>}<div className="launch-spec"><Icon name="clock"/><div><strong>Initial lifetime: 1 hour</strong><span>{maxHours > 1 ? `Extend in 30-minute steps. Maximum lifetime: ${maxHours} hours.` : 'Maximum lifetime: 1 hour. Extensions are unavailable.'}</span></div></div><p className="form-help">Work happens on a new session branch. Commit and push the changes you want to keep.</p>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="button subtle" onClick={() => setModal(null)} disabled={busy}>Cancel</button><button className="button primary" disabled={busy || !repoId || !branch || !canLaunchFresh}>{busy ? 'Launching…' : preview ? 'Launch preview' : 'Launch machine'}<Icon name="arrow"/></button></div></form></Modal>}
    {modal === 'stop' && selected && <Modal opener={modalOpener.current} key={`stop-${selected.id}`} title="Stop this machine?" subtitle={`${sessionName(selected)} will shut down and begin credential cleanup.`} onClose={() => { if (!busy) setModal(null); }}><StopWorkCheck session={selected} now={now} onReady={setStopReady}/><div className="stop-details"><span>Repository</span><strong>{selected.repository}</strong><span>Work branch</span><strong>{selected.branch}</strong></div>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button className="button subtle" disabled={busy} onClick={() => setModal(null)}>Keep working</button><button className="button primary" disabled={busy || !stopReady} onClick={async () => { if (await mutate(`/sessions/${selected.id}/stop`)) { setModal(null); changeTab('access'); } }}>{busy ? 'Stopping…' : 'Stop & clean up'}<Icon name="arrow"/></button></div></Modal>}
    {modal === 'continue' && selected && <Modal opener={modalOpener.current} key={`continue-${selected.id}`} title="Continue saved work" subtitle="Review published work before launching a fresh machine." onClose={() => { if (!busy) setModal(null); }}><ContinuationForm source={selected} sessions={sessions} now={now} previewMode={Boolean(preview)} canLaunch={canLaunch} refreshSessions={refresh} onBusyChange={setBusy} onClose={() => setModal(null)} onSelectSession={id => { selectSession(id, 'terminal'); }} onCreated={session => { if (!rememberSession(session)) return; selectSession(session.id, 'terminal'); setBusy(false); void refresh().catch(() => {}); }}/></Modal>}
    {modal === 'pr' && selected && <Modal opener={modalOpener.current} key={`pr-${workspaceIdentity(bootstrap)}:${selected.id}`} title="Create a pull request" subtitle="Review the pushed work before handing it off." onClose={() => { if (!busy) setModal(null); }}><PullRequestForm session={selected} accountKey={workspaceIdentity(bootstrap)} previewMode={Boolean(preview)} onBusyChange={setBusy} onClose={() => setModal(null)} onCreated={() => { setPrRevision(value => value + 1); void refresh().catch(() => {}); }}/></Modal>}
  </div>;
}
