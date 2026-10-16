import { setAppearance, useAppearance, type AppearancePreference } from './appearance';

export function AppearanceControl() {
  const { preference } = useAppearance();
  return <label className="appearance-control">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none"/></svg>
    <span>Appearance</span>
    <select aria-label="Appearance" value={preference} onChange={event => setAppearance(event.target.value as AppearancePreference)}>
      <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
    </select>
  </label>;
}
