import type { SessionEventPageOptions } from '../contracts.js';

export const DEFAULT_EVENT_PAGE_SIZE = 50;
export const MAX_EVENT_PAGE_SIZE = 100;
const MAX_CURSOR_LENGTH = 2048;
interface EventCursor { version: 1; sessionId: string; at: string; id: string }

export class SessionEventPageError extends Error {
  readonly status = 400;
  constructor() { super('Invalid session event pagination.'); }
}

/** Accept HTTP query values without accepting arrays, objects, fractions, or coercions. */
export function parseSessionEventPageOptions(input: { limit?: unknown; before?: unknown }, sessionId: string): SessionEventPageOptions {
  let limit = input.limit;
  if (typeof limit === 'string' && /^[1-9]\d{0,2}$/.test(limit)) limit = Number(limit);
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_PAGE_SIZE)) {
    throw new SessionEventPageError();
  }
  if (input.before !== undefined) decodeSessionEventCursor(input.before, sessionId);
  return { limit: typeof limit === 'number' ? limit : DEFAULT_EVENT_PAGE_SIZE,
    ...(input.before === undefined ? {} : { before: input.before as string }) };
}

export function decodeSessionEventCursor(value: unknown, sessionId: string): EventCursor {
  if (typeof value !== 'string' || !value.length || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new SessionEventPageError();
  }
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error();
    const decoded = bytes.toString('utf8');
    if (!Buffer.from(decoded).equals(bytes)) throw new Error();
    const cursor = JSON.parse(decoded) as EventCursor;
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)
      || Object.keys(cursor).sort().join(',') !== 'at,id,sessionId,version'
      || cursor.version !== 1 || cursor.sessionId !== sessionId
      || typeof cursor.id !== 'string' || !cursor.id.length || cursor.id.length > 200 || /[\x00-\x1f\x7f]/.test(cursor.id)
      || Buffer.from(cursor.id).toString('utf8') !== cursor.id
      || typeof cursor.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.at)) throw new Error();
    // Validate the calendar value while retaining all six PostgreSQL fractional digits.
    if (cursor.at.startsWith('0000-') || new Date(cursor.at).toISOString() !== `${cursor.at.slice(0, 23)}Z`) throw new Error();
    return cursor;
  } catch { throw new SessionEventPageError(); }
}

/** The timestamp must come from SQL text, never a JavaScript Date (which truncates microseconds). */
export function encodeSessionEventCursor(sessionId: string, at: string, id: string): string {
  return Buffer.from(JSON.stringify({ version: 1, sessionId, at, id } satisfies EventCursor)).toString('base64url');
}
