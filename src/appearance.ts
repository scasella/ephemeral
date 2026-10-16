import { useSyncExternalStore } from 'react';

export type AppearancePreference = 'system' | 'light' | 'dark';
export type ResolvedAppearance = 'light' | 'dark';
export type AppearanceSnapshot = Readonly<{ preference: AppearancePreference; resolved: ResolvedAppearance }>;
type AppearanceController = {
  getSnapshot(): AppearanceSnapshot;
  setPreference(value: AppearancePreference): void;
  subscribe(listener: () => void): () => void;
};
declare global { interface Window { ephemeralAppearance: AppearanceController } }
const fallback: AppearanceSnapshot = { preference: 'system', resolved: 'light' };
const getSnapshot = () => typeof window === 'undefined' ? fallback : window.ephemeralAppearance.getSnapshot();
const subscribe = (listener: () => void) => typeof window === 'undefined' ? () => {} : window.ephemeralAppearance.subscribe(listener);
export function useAppearance() {
  return useSyncExternalStore(subscribe, getSnapshot, () => fallback);
}
export function setAppearance(value: AppearancePreference) { window.ephemeralAppearance.setPreference(value); }
