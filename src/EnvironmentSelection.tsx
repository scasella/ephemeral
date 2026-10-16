import { useEffect, useId, useRef, useState } from 'react';
import { isEnvironmentProfile, type EnvironmentCatalog, type EnvironmentProfile, type EnvironmentRef } from '../shared/environments';
import { api } from './api';
import { EnvironmentCatalogLoader, environmentRef, initialEnvironmentSelection, readEnvironmentPreference, saveEnvironmentPreference } from './environment-selection';
import './environment-selection.css';
export interface SelectedEnvironment { accountKey: string; repositoryId: number; profile: EnvironmentProfile }
export function EnvironmentSelector({ accountKey, repositoryId, source, disabled = false, onChange }: { accountKey: string; repositoryId: number; source?: EnvironmentRef | null; disabled?: boolean; onChange: (selection: SelectedEnvironment | null) => void }) {
  const id = useId();
  const [catalog, setCatalog] = useState<EnvironmentCatalog | null>(null);
  const [profile, setProfile] = useState<EnvironmentProfile | null>(null);
  const [needsReview, setNeedsReview] = useState(false);
  const [error, setError] = useState('');
  const [storageNotice, setStorageNotice] = useState('');
  const loader = useRef<EnvironmentCatalogLoader | null>(null);
  const latestChange = useRef(onChange); latestChange.current = onChange;
  const selectedRef = useRef<EnvironmentRef | undefined>(undefined);
  useEffect(() => {
    setCatalog(null); setProfile(null); setError(''); setNeedsReview(false); setStorageNotice(''); selectedRef.current = undefined; latestChange.current(null);
    const current = new EnvironmentCatalogLoader(signal => api('/environments', undefined, { signal }), (value, failure) => {
      setCatalog(value); setError(failure); latestChange.current(null);
      if (!value) { setProfile(null); return; }
      let preference: EnvironmentRef | undefined;
      try { preference = readEnvironmentPreference(localStorage, accountKey, repositoryId); } catch { /* Preference storage is optional. */ }
      const selection = initialEnvironmentSelection(value, selectedRef.current || preference, selectedRef.current ? undefined : source);
      setProfile(selection.profile); setNeedsReview(selection.needsReview);
      if (selection.profile) {
        selectedRef.current = environmentRef(selection.profile);
        latestChange.current({ accountKey, repositoryId, profile: selection.profile });
        // Remember the displayed default as well, so a future recipe change needs review.
        try { saveEnvironmentPreference(localStorage, accountKey, repositoryId, selectedRef.current); } catch { /* Preference storage remains optional. */ }
      }
    });
    loader.current = current;
    if (accountKey && repositoryId > 0) void current.load();
    return () => { current.dispose(); if (loader.current === current) loader.current = null; };
  }, [accountKey, repositoryId, source?.id, source?.revision, source === null]);
  function select(value: string) {
    const next = catalog?.profiles.find(item => item.id === value) || null;
    setProfile(next); setNeedsReview(false); selectedRef.current = next ? environmentRef(next) : undefined;
    latestChange.current(next ? { accountKey, repositoryId, profile: next } : null);
    if (next) {
      let saved = false;
      try { saved = saveEnvironmentPreference(localStorage, accountKey, repositoryId, environmentRef(next)); } catch { /* Denied storage must not block an explicit selection. */ }
      setStorageNotice(saved ? '' : 'This browser could not remember your profile preference. Your current selection is still available.');
    }
  }
  return <section className="environment-selection" aria-label="Environment profile">
    <label htmlFor={id}>Environment profile</label>
    <select id={id} value={profile?.id || ''} disabled={disabled || !catalog} onChange={event => select(event.target.value)} aria-describedby={`${id}-help`}>
      <option value="">{catalog ? 'Choose a current profile' : error ? 'Profiles unavailable' : repositoryId > 0 ? 'Loading profiles…' : 'Choose a repository first'}</option>
      {catalog?.profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select>
    {profile && <EnvironmentProfileDetails profile={profile}/>}
    {needsReview && <p className="form-help" role="status">The saved or source profile is unavailable or its recipe has changed. Choose a current profile and review its details before launching.</p>}
    <p className="form-help" id={`${id}-help`}>Profiles supply common tools before launch. Install repository dependencies with your explicit setup recipe. Each launch starts fresh and requires a fresh Codex sign-in.</p>
    {error && <p className="form-error" role="alert">{error} New launches require a verified catalog.</p>}
    {storageNotice && <p className="form-help" role="status">{storageNotice}</p>}
    {repositoryId > 0 && <button type="button" className="text-button" disabled={disabled} onClick={() => void loader.current?.load()}>Check profiles again</button>}
  </section>;
}
export function EnvironmentProfileDetails({ profile }: { profile: EnvironmentProfile }) {
  return <div className="environment-details"><strong>{profile.name}</strong><p>{profile.description}</p><p>Common tools: {profile.tools.length ? profile.tools.join(', ') : 'No tools declared'}</p><details><summary>Advanced profile details</summary><dl className="settings-list"><div><dt>Profile ID</dt><dd>{profile.id}</dd></div><div><dt>Template reference</dt><dd><code>{profile.templateRef}</code></dd></div><div><dt>Catalog revision</dt><dd><code title={profile.revision}>{profile.revision.slice(0, 12)}</code></dd></div></dl><p>The revision records this catalog recipe and template reference. A template tag can change; this does not pin an immutable E2B build or promise compute resources.</p></details></div>;
}
export function RecordedEnvironment({ profile }: { profile?: EnvironmentProfile }) {
  return <section className="recorded-environment" aria-label="Recorded environment profile"><h4>Environment profile</h4>{profile ? <><p>Recorded at launch. These are the selected recipe details, not an observation of installed tools or compute.</p><EnvironmentProfileDetails profile={profile}/></> : <p>Environment profile not recorded for this older machine. Its template and tool versions cannot be inferred from the current catalog.</p>}</section>;
}
export function SavedEnvironmentReference({ environment }: { environment?: EnvironmentRef }) {
  return <section className="environment-selection" aria-label="Saved environment selection"><strong>Saved environment selection</strong>{environment ? <p>Profile <code>{environment.id}</code> · catalog revision <code title={environment.revision}>{environment.revision.slice(0, 12)}</code>. Retry retains this exact selection even if the catalog changes.</p> : <p>This older request did not record a profile selection. Retry retains its original server-side environment behavior; no current profile is substituted.</p>}</section>;
}
export function selectedEnvironmentRef(selection: SelectedEnvironment | null, accountKey: string, repositoryId: number): EnvironmentRef | null {
  return selection?.accountKey === accountKey && selection.repositoryId === repositoryId && isEnvironmentProfile(selection.profile) ? environmentRef(selection.profile) : null;
}
