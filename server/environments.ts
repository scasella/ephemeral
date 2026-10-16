import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { copyEnvironmentProfile, isEnvironmentId, isEnvironmentProfile, isEnvironmentRef, type EnvironmentCatalog, type EnvironmentProfile } from '../shared/environments.js';

export class EnvironmentError extends Error {
  readonly status = 409;
  constructor() { super('Environment selection is unavailable or changed. Refresh the environment list and select again.'); this.name = 'EnvironmentError'; }
}
const MAX_CATALOG_BYTES = 64 * 1024;
type ProfileData = Omit<EnvironmentProfile, 'revision'>;
/** Fixed field order and normalized tools make object-key/tool order irrelevant to the digest. */
export function environmentProfileRevision(profile: ProfileData): string {
  return createHash('sha256').update(JSON.stringify({ id: profile.id, name: profile.name, description: profile.description,
    templateRef: profile.templateRef, tools: [...profile.tools].sort() })).digest('hex');
}
function profile(data: ProfileData): EnvironmentProfile {
  const value = { ...data, tools: [...data.tools].sort(), revision: environmentProfileRevision(data) };
  if (!isEnvironmentProfile(value)) throw new EnvironmentError();
  return value;
}
function readProfiles(path: string): EnvironmentProfile[] {
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new EnvironmentError();
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev || info.size > MAX_CATALOG_BYTES) throw new EnvironmentError();
    const bytes = Buffer.alloc(MAX_CATALOG_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > MAX_CATALOG_BYTES) throw new EnvironmentError();
    const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
    if (!Array.isArray(input) || input.length > 16) throw new EnvironmentError();
    const ids = new Set<string>();
    return input.map((data: unknown) => {
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new EnvironmentError();
      const raw = data as Record<string, unknown>;
      if (Object.keys(raw).length !== 5 || !['id', 'name', 'description', 'templateRef', 'tools'].every(key => Object.hasOwn(raw, key)) ||
        !isEnvironmentId(raw.id) || raw.id === 'default' || ids.has(raw.id) || !Array.isArray(raw.tools)) throw new EnvironmentError();
      ids.add(raw.id);
      // Validate before hashing, including untrusted tool element types.
      const checked = { ...raw, revision: '0'.repeat(64) };
      if (!isEnvironmentProfile(checked)) throw new EnvironmentError();
      return profile(raw as unknown as ProfileData);
    });
  } catch { throw new EnvironmentError(); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function loadEnvironmentCatalog(options: { mode: 'live' | 'preview'; templateId: string; profilesFile?: string }): EnvironmentCatalog {
  if (options.mode === 'preview') return { defaultId: 'default', profiles: [
    profile({ id: 'default', name: 'Base (simulation)', description: 'Simulated base environment. No VM or tools are started.', templateRef: 'preview-base', tools: ['Node.js', 'Python', 'Git', 'Codex'] }),
    profile({ id: 'node', name: 'Node.js (simulation)', description: 'Simulated Node.js profile with TypeScript. No workload runs.', templateRef: 'preview-node:v1', tools: ['Node.js', 'TypeScript 7.0.2', 'Git', 'Codex'] }),
    profile({ id: 'python', name: 'Python (simulation)', description: 'Simulated Python profile with venv and build tools. No workload runs.', templateRef: 'preview-python:v1', tools: ['Python', 'venv', 'build-essential', 'Node.js', 'Codex'] }),
  ] };
  return { defaultId: 'default', profiles: [profile({ id: 'default', name: 'Base', description: 'Operator-configured base environment.',
    templateRef: options.templateId, tools: ['Node.js', 'Python', 'Git', 'Codex'] }), ...(options.profilesFile ? readProfiles(options.profilesFile) : [])] };
}
export function resolveEnvironmentRef(catalog: EnvironmentCatalog, value: unknown): EnvironmentProfile {
  if (!isEnvironmentRef(value)) throw new EnvironmentError();
  const found = catalog.profiles.find(profile => profile.id === value.id && profile.revision === value.revision);
  if (!found) throw new EnvironmentError();
  return copyResolvedEnvironmentProfile(found);
}

/** Check a persisted/internal snapshot against its content digest without consulting a changed catalog. */
export function copyResolvedEnvironmentProfile(value: EnvironmentProfile): EnvironmentProfile {
  const copied = copyEnvironmentProfile(value);
  if (environmentProfileRevision(copied) !== copied.revision) throw new EnvironmentError();
  return { ...copied, tools: copied.tools.sort() };
}
