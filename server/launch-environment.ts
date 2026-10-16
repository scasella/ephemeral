import { isEnvironmentRef, type EnvironmentCatalog, type EnvironmentProfile, type EnvironmentRef } from '../shared/environments.js';
import { EnvironmentError, copyResolvedEnvironmentProfile, resolveEnvironmentRef } from './environments.js';

/** SQL NULL is the legacy launch behavior, distinct from an explicit default selection. */
export function savedEnvironment(value: unknown): EnvironmentProfile | undefined {
  if (value == null) return undefined;
  try {
    return copyResolvedEnvironmentProfile(value as EnvironmentProfile);
  } catch { throw new EnvironmentError(); }
}
export function sameEnvironment(left: unknown, right: unknown): boolean {
  const a = savedEnvironment(left), b = savedEnvironment(right);
  return JSON.stringify(a) === JSON.stringify(b);
}
export function matchesEnvironmentRef(snapshot: unknown, ref?: EnvironmentRef): boolean {
  const saved = savedEnvironment(snapshot);
  return ref === undefined ? saved === undefined : isEnvironmentRef(ref) && saved?.id === ref.id && saved.revision === ref.revision;
}
export function selectEnvironment(catalog: EnvironmentCatalog | undefined, ref?: EnvironmentRef): EnvironmentProfile | undefined {
  if (ref === undefined) return undefined;
  if (!catalog) throw new EnvironmentError();
  return resolveEnvironmentRef(catalog, ref);
}
/** Recreating an absent target requires today's catalog to still permit the recorded snapshot. */
export function allowedSavedEnvironment(catalog: EnvironmentCatalog | undefined, value: unknown): EnvironmentProfile | undefined {
  const saved = savedEnvironment(value);
  if (!saved) return undefined;
  const current = selectEnvironment(catalog, { id: saved.id, revision: saved.revision });
  if (!sameEnvironment(saved, current)) throw new EnvironmentError();
  return saved;
}
