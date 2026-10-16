import { isEnvironmentProfile, isEnvironmentRef, type EnvironmentCatalog, type EnvironmentProfile, type EnvironmentRef } from '../shared/environments';
export const environmentPreferenceKey = 'ephemeral:environment-preferences:v1';
export const maxEnvironmentPreferences = 50;
type Preference = { accountKey: string; repositoryId: number; environment: EnvironmentRef };
type StorageAccess = Pick<Storage, 'getItem' | 'setItem'>;
export function environmentRef(profile: EnvironmentRef): EnvironmentRef { return { id: profile.id, revision: profile.revision }; }
export function sameEnvironment(a: EnvironmentRef | undefined | null, b: EnvironmentRef | undefined | null) { return !!a && !!b && a.id === b.id && a.revision === b.revision; }
export function validEnvironmentCatalog(value: unknown): value is EnvironmentCatalog {
  if (!value || typeof value !== 'object') return false;
  const catalog = value as EnvironmentCatalog;
  return catalog.defaultId === 'default' && Array.isArray(catalog.profiles) && catalog.profiles.length > 0 && catalog.profiles.length <= 17 && catalog.profiles.every(isEnvironmentProfile) && new Set(catalog.profiles.map(profile => profile.id)).size === catalog.profiles.length && catalog.profiles.some(profile => profile.id === catalog.defaultId);
}
function preferences(storage: StorageAccess): Preference[] {
  try {
    const raw = storage.getItem(environmentPreferenceKey);
    if (!raw || raw.length > 40_000) return [];
    const values: unknown = JSON.parse(raw);
    return Array.isArray(values) ? values.slice(-maxEnvironmentPreferences).filter((value): value is Preference => !!value && typeof value === 'object' && Object.keys(value).length === 3 && typeof value.accountKey === 'string' && value.accountKey.length > 0 && value.accountKey.length <= 256 && Number.isSafeInteger(value.repositoryId) && value.repositoryId > 0 && isEnvironmentRef(value.environment)) : [];
  } catch { return []; }
}
export function readEnvironmentPreference(storage: StorageAccess, accountKey: string, repositoryId: number): EnvironmentRef | undefined {
  return preferences(storage).find(value => value.accountKey === accountKey && value.repositoryId === repositoryId)?.environment;
}
export function saveEnvironmentPreference(storage: StorageAccess, accountKey: string, repositoryId: number, environment: EnvironmentRef): boolean {
  if (!accountKey || accountKey.length > 256 || !Number.isSafeInteger(repositoryId) || repositoryId <= 0 || !isEnvironmentRef(environment)) return false;
  try {
    const values = preferences(storage).filter(value => value.accountKey !== accountKey || value.repositoryId !== repositoryId);
    values.push({ accountKey, repositoryId, environment: environmentRef(environment) });
    storage.setItem(environmentPreferenceKey, JSON.stringify(values.slice(-maxEnvironmentPreferences))); return true;
  } catch { return false; }
}
export interface EnvironmentSelection { profile: EnvironmentProfile | null; needsReview: boolean }
/** Stale recorded selections are never silently replaced with today's default recipe. */
export function initialEnvironmentSelection(catalog: EnvironmentCatalog, preferred?: EnvironmentRef, source?: EnvironmentRef | null): EnvironmentSelection {
  const wanted = source === null ? null : source || preferred;
  const exact = wanted && catalog.profiles.find(profile => sameEnvironment(profile, wanted));
  if (exact) return { profile: exact, needsReview: false };
  if (wanted || source === null) return { profile: null, needsReview: true };
  return { profile: catalog.profiles.find(profile => profile.id === catalog.defaultId)!, needsReview: false };
}
/** Disposal and request revisions fence late catalog responses across accounts/repositories. */
export class EnvironmentCatalogLoader {
  private revision = 0;
  private disposed = false;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private request: (signal: AbortSignal) => Promise<unknown>, private publish: (catalog: EnvironmentCatalog | null, error: string) => void) {}
  async load() {
    if (this.disposed) return;
    const revision = ++this.revision; this.controller?.abort(); clearTimeout(this.timer);
    const controller = this.controller = new AbortController(); this.publish(null, '');
    const timeout = new Promise<never>((_, reject) => { this.timer = setTimeout(() => { controller.abort(); reject(new Error('The environment catalog timed out. Check profiles again.')); }, 30_000); });
    try {
      const value = await Promise.race([this.request(controller.signal), timeout]);
      if (!validEnvironmentCatalog(value)) throw new Error('The environment catalog could not be verified. Check profiles again.');
      if (!this.disposed && revision === this.revision) this.publish(value, '');
    } catch (error) { if (!this.disposed && revision === this.revision) this.publish(null, (error as Error).message); }
    finally { if (revision === this.revision) { clearTimeout(this.timer); this.controller = null; } }
  }
  dispose() { this.disposed = true; ++this.revision; this.controller?.abort(); clearTimeout(this.timer); }
}
