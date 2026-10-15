import { useRef, useState } from 'react';
import type { Session } from './api';
import { emptyHistoryFilters, filterSessionHistory, historyFocusIndex, historySearchKey, sessionName } from './session-history';
import { workspacePanelMemory } from './panel-state';
import './session-history.css';

/** Open the native disclosure before focusing a control inside it. */
export function revealSessionHistory(root: Pick<Document, 'getElementById'> = document): boolean {
  const disclosure = root.getElementById('history-details');
  if (!disclosure || disclosure.tagName !== 'DETAILS') return false;
  (disclosure as HTMLDetailsElement).open = true;
  root.getElementById('history-search')?.focus({ preventScroll: true });
  disclosure.scrollIntoView?.({ block: 'nearest' });
  return true;
}

/** Collapse even a reselected row, so its soon-hidden button cannot retain focus. */
export function selectSessionHistoryResult(id: string, scope: string, onSelect: (id: string) => boolean | void, root: Pick<Document, 'getElementById'> = document): boolean {
  if (onSelect(id) === false) return false;
  workspacePanelMemory.remember('history', scope, id, false);
  const disclosure = root.getElementById('history-details');
  if (disclosure?.tagName === 'DETAILS') (disclosure as HTMLDetailsElement).open = false;
  return true;
}

export function SessionHistory({ sessions, selectedId, onSelect, panelScope }: { sessions: Session[]; selectedId: string | null; onSelect: (id: string) => boolean | void; panelScope?: string }) {
  const [filters, setFilters] = useState(emptyHistoryFilters);
  const scope = panelScope ?? sessions[0]?.userId ?? 'workspace';
  const [disclosure, setDisclosure] = useState(() => ({ scope, selectedId, expanded: workspacePanelMemory.expanded('history', scope, selectedId) }));
  const expanded = disclosure.scope === scope && disclosure.selectedId === selectedId ? disclosure.expanded : workspacePanelMemory.expanded('history', scope, selectedId);
  const resultButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const visible = filterSessionHistory(sessions, filters);
  const selected = sessions.find(session => session.id === selectedId);
  const selectedHidden = selected && !visible.some(session => session.id === selectedId);
  const filtered = Boolean(filters.query || filters.state || filters.repository);
  const repositories = [...new Set(sessions.map(session => session.repository))].sort();
  return <section className="session-history" aria-labelledby="history-heading">
    <details id="history-details" className="panel-disclosure" open={expanded} onToggle={event => { const next = event.currentTarget.open; workspacePanelMemory.remember('history', scope, selectedId, next); setDisclosure({ scope, selectedId, expanded: next }); }}>
    <summary className="panel-disclosure-summary" aria-expanded={expanded} aria-controls="history-content"><span className="panel-disclosure-copy"><span className="panel-disclosure-title" id="history-heading" role="heading" aria-level={2}>Session history</span><span className="panel-disclosure-status" aria-live="off">{visible.length} of {sessions.length} {sessions.length === 1 ? 'machine' : 'machines'}{selected ? ` · Selected: ${sessionName(selected)} · ${selected.state.replace('_', ' ')}` : ' · No machine selected'}{filtered ? ' · Filters active' : ''}</span></span><span className="panel-disclosure-chevron" aria-hidden="true">⌄</span></summary>
    <div id="history-content" className="panel-disclosure-content">
    <div className="history-controls">
      <label className="history-search" htmlFor="history-search">Search machines<input id="history-search" type="search" value={filters.query} placeholder="Task, owner/repo, ID or branch" aria-controls="history-results" onChange={event => setFilters(current => ({ ...current, query: event.target.value }))} onKeyDown={event => { const action = historySearchKey(event.key); if (action === 'clear') { event.preventDefault(); setFilters(current => ({ ...current, query: '' })); } else if (action === 'focus-results' && visible.length) { event.preventDefault(); resultButtons.current[0]?.focus(); } }}/></label>
      <label htmlFor="history-state">Status<select id="history-state" value={filters.state} onChange={event => setFilters(current => ({ ...current, state: event.target.value }))}><option value="">All statuses</option>{(['running', 'provisioning', 'cleanup_pending', 'ended', 'failed'] as Session['state'][]).map(state => <option key={state} value={state}>{state.replace('_', ' ')}</option>)}</select></label>
      <label htmlFor="history-repository">Repository<select id="history-repository" value={filters.repository} onChange={event => setFilters(current => ({ ...current, repository: event.target.value }))}><option value="">All repositories</option>{repositories.map(repository => <option key={repository}>{repository}</option>)}</select></label>
      <button className="button subtle small history-clear" disabled={!filtered} onClick={() => setFilters(emptyHistoryFilters)}>Clear filters</button>
    </div>
    {selectedHidden && <div className="history-filter-notice" role="status">Viewing <strong>{sessionName(selected)}</strong> in {selected.repository}. This machine is hidden by your filters. <button className="text-button" onClick={() => setFilters(emptyHistoryFilters)}>Show selected machine</button></div>}
    <ul id="history-results" className="history-results" aria-label="Machine history" onKeyDown={event => { const current = resultButtons.current.indexOf(event.target as HTMLButtonElement); if (current < 0) return; const next = historyFocusIndex(event.key, current, visible.length); if (next !== null) { event.preventDefault(); resultButtons.current[next]?.focus(); } }}>
      {visible.map((session, index) => <li key={session.id}><button ref={element => { resultButtons.current[index] = element; }} className={`history-row ${session.id === selectedId ? 'selected' : ''}`} aria-current={session.id === selectedId ? 'true' : undefined} onClick={() => { if (selectSessionHistoryResult(session.id, scope, onSelect)) setDisclosure({ scope, selectedId: session.id, expanded: false }); }}>
        <span className="history-identity"><strong>{sessionName(session)}</strong><span>{session.repository}</span></span>
        <time dateTime={session.createdAt}>{new Date(session.createdAt).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
        <span className={`badge state-${session.state}`}><span className="status-dot"/>{session.state.replace('_', ' ')}</span>
        {session.id === selectedId && <span className="history-selected">Selected</span>}
      </button></li>)}
    </ul>
    {!visible.length && <p className="history-empty" role="status">{sessions.length ? 'No machines match your search and filters.' : 'No machines yet. Launch a machine to start your history.'}</p>}
    <p className="history-help">Search by task name, full repository, session ID or branch. Down arrow moves to results; Escape clears search.</p>
    </div>
    </details>
  </section>;
}
