/** Server-owned catalog selections. A revision pins selection metadata, not an E2B build. */
export interface EnvironmentProfile {
  id: string; name: string; description: string; templateRef: string; tools: string[]; revision: string;
}
export interface EnvironmentRef { id: string; revision: string }
export interface EnvironmentCatalog { profiles: EnvironmentProfile[]; defaultId: 'default' }

const secret = /(?:e2b_|sk-|github_pat_|gh[pousr]_|bearer\s|private\s+key|(?:token|password|secret)\s*[:=])/i;
export function isEnvironmentText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value &&
    !/[\p{Cc}\p{Cf}\u2028\u2029<>`$\\;]/u.test(value) &&
    !/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(value) && !secret.test(value);
}
export function isEnvironmentId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) && value.length <= 48 && value.trim() === value;
}
/** E2B template ID/alias plus optional release tag. No URLs, paths, credentials or shell syntax. */
export function isEnvironmentTemplateRef(value: unknown, versioned = false): value is string {
  if (typeof value !== 'string' || value.length > 322 || secret.test(value)) return false;
  const match = /^((?:[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/)?[A-Za-z0-9][A-Za-z0-9_-]{0,127})(?::([A-Za-z0-9][A-Za-z0-9._-]{0,63}))?$/.exec(value);
  return !!match && match[0] === value && !value.includes('..') && (!versioned || !!match[2] && !/^(?:latest|default)$/i.test(match[2]));
}
function exactKeys(value: Record<string, unknown>, keys: string[]) { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
export function isEnvironmentRef(value: unknown): value is EnvironmentRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return exactKeys(ref, ['id', 'revision']) && isEnvironmentId(ref.id) && typeof ref.revision === 'string' && ref.revision.length === 64 && /^[a-f0-9]{64}$/.test(ref.revision);
}
export function isEnvironmentProfile(value: unknown): value is EnvironmentProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  return exactKeys(profile, ['id', 'name', 'description', 'templateRef', 'tools', 'revision']) &&
    isEnvironmentId(profile.id) && isEnvironmentText(profile.name, 80) && isEnvironmentText(profile.description, 320) &&
    isEnvironmentTemplateRef(profile.templateRef, profile.id !== 'default') && Array.isArray(profile.tools) && profile.tools.length <= 16 &&
    profile.tools.every(tool => isEnvironmentText(tool, 48)) && new Set(profile.tools).size === profile.tools.length &&
    typeof profile.revision === 'string' && profile.revision.length === 64 && /^[a-f0-9]{64}$/.test(profile.revision);
}
/** Validate and copy before async work so caller/catalog mutation cannot alter a launch. */
export function copyEnvironmentProfile(value: EnvironmentProfile): EnvironmentProfile {
  if (!isEnvironmentProfile(value)) throw new Error('Invalid environment profile.');
  return { id: value.id, name: value.name, description: value.description, templateRef: value.templateRef, tools: [...value.tools], revision: value.revision };
}
