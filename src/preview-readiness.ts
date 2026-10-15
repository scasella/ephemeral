export const validPreviewPort = (port: unknown): port is number => typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 49151;
export interface ApplicationPreviewCheck {
  state: 'responded' | 'connection_refused' | 'timed_out' | 'unavailable' | 'unknown';
  port: number | null;
  checkedAt: string;
  httpStatus: number | null;
  reason: string | null;
  remedy: string | null;
}

const invalid = 'The application check response could not be verified.';
export function validateApplicationPreviewCheck(value: unknown, port: number, startedAt: number, now: number): ApplicationPreviewCheck {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(invalid);
  const result = value as Record<string, unknown>;
  const checkedAt = typeof result.checkedAt === 'string' && result.checkedAt.length <= 64 ? Date.parse(result.checkedAt) : NaN;
  const text = (value: unknown) => value === null || (typeof value === 'string' && value.length <= 1000);
  if (!['responded', 'connection_refused', 'timed_out', 'unavailable', 'unknown'].includes(result.state as string) ||
      !Number.isFinite(checkedAt) || checkedAt < startedAt - 2000 || checkedAt > now + 5000 ||
      !(result.port === port || (['unavailable', 'unknown'].includes(result.state as string) && result.port === null)) ||
      !(result.port === null || validPreviewPort(result.port)) || !text(result.reason) || !text(result.remedy) ||
      (result.state === 'responded' ? !(typeof result.httpStatus === 'number' && Number.isInteger(result.httpStatus) && result.httpStatus >= 200 && result.httpStatus <= 599) : result.httpStatus !== null)) throw new Error(invalid);
  return { state: result.state as ApplicationPreviewCheck['state'], port: result.port as number | null, checkedAt: result.checkedAt as string, httpStatus: result.httpStatus as number | null, reason: result.reason as string | null, remedy: result.remedy as string | null };
}

/** Read only a small JSON summary; never surface error bodies or application content. */
export async function requestApplicationPreviewCheck(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`/api${path}`, { method: 'POST', credentials: 'same-origin', signal, headers: { 'Content-Type': 'application/json', 'X-Ephemeral-Request': '1' }, body: '{}' });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(invalid); }
  const reader = response.body.getReader(), parts: Uint8Array[] = [];
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) { abort(); throw new Error(invalid); }
      const chunk = await reader.read();
      if (signal.aborted) throw new Error(invalid);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 8192) { await reader.cancel(); throw new Error(invalid); }
      parts.push(chunk.value);
    }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export const readinessStateLabel = (state: ApplicationPreviewCheck['state']) => ({ responded: 'Responded', connection_refused: 'Connection refused', timed_out: 'Timed out', unavailable: 'Unavailable', unknown: 'Unknown' })[state];
export const readinessIsStale = (result: ApplicationPreviewCheck, now: number) => now - Date.parse(result.checkedAt) >= 60_000;
