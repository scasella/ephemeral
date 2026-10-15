import type { Session, SessionEvent, SessionEventPage } from '../server/contracts';
export type { Session, SessionEvent, SessionEventPage };
export interface Bootstrap { user: { id: string; login: string; avatarUrl: string } | null; mode: 'live' | 'preview'; configured: boolean; sessionMaxHours: number; missing: string[]; githubInstallUrl: string | null }
export interface Repository { id: number; fullName: string; defaultBranch: string; installationId: number }
export async function api<T>(path: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', signal: options?.signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1' }, body: JSON.stringify(body) }) });
  const data = await response.json().catch(e => { if (options?.signal?.aborted) throw e; return { error: `Server returned ${response.status}` }; });
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}
