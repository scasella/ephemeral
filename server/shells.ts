import { randomUUID } from 'node:crypto';
import type { Database, SandboxProvider, Session, SessionRepository, TerminalShellState } from './contracts.js';

export type ShellState = 'creating' | 'open' | 'closing' | 'closed' | 'uncertain';
export interface SessionShell {
  id: string; sessionId: string; requestId: string | null; name: string; kind: 'primary' | 'supplemental';
  state: ShellState; requiresCloseAck: boolean; intent: 'create' | 'close' | null; createdAt: string; updatedAt: string; error: string | null;
}
export interface ShellList { mode: 'live' | 'preview'; shells: SessionShell[]; canCreate: boolean; reason: string | null }
export class ShellError extends Error { constructor(public status: number, message: string) { super(message); } }
const running = (s: Session) => s.state === 'running' && !!s.sandboxId && Number.isFinite(Date.parse(s.expiresAt)) && Date.parse(s.expiresAt) > Date.now();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const validShellId = (id: string) => id === 'codex' || uuid.test(id);
export function shellName(name: string) {
  if (typeof name !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(name) || !name.trim() || name.trim().length > 80) throw new ShellError(400, 'Shell name must contain 1–80 characters without control characters.');
  return name.trim();
}

export async function createShellRepository(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS session_shells (
    id text PRIMARY KEY, session_id text NOT NULL REFERENCES ephemeral_sessions(id), request_id text NOT NULL,
    state text NOT NULL, data jsonb NOT NULL, UNIQUE(session_id,request_id))`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS session_one_supplemental_shell ON session_shells(session_id) WHERE state<>'closed'`);
  return {
    async list(sessionId: string) {
      return (await db.query<{ data: SessionShell }>('SELECT data FROM session_shells WHERE session_id=$1 ORDER BY data->>\'createdAt\',id', [sessionId])).rows.map(r => r.data);
    },
    async insert(s: Session, shell: SessionShell) {
      try {
        const { rows } = await db.query(`WITH active AS (SELECT id FROM ephemeral_sessions WHERE id=$1 AND user_id=$2
          AND state='running' AND data->>'sandboxId' IS NOT NULL AND (data->>'expiresAt')::timestamptz>clock_timestamp() FOR UPDATE)
          INSERT INTO session_shells(id,session_id,request_id,state,data) SELECT $3,id,$4,$5,$6::jsonb FROM active RETURNING id`,
        [s.id, s.userId, shell.id, shell.requestId, shell.state, JSON.stringify(shell)]);
        if (!rows.length) throw new ShellError(409, 'Session is no longer running.');
      } catch (error) { if ((error as { code?: string }).code === '23505') throw new ShellError(409, 'A supplemental shell already exists. Refresh before creating another.'); throw error; }
    },
    async rename(s: Session, shell: SessionShell) {
      const { rows } = await db.query(`WITH active AS (SELECT id FROM ephemeral_sessions WHERE id=$1 AND user_id=$2
        AND state='running' AND data->>'sandboxId' IS NOT NULL AND (data->>'expiresAt')::timestamptz>clock_timestamp() FOR UPDATE)
        UPDATE session_shells SET data=$4::jsonb FROM active WHERE session_shells.id=$3 AND session_shells.session_id=active.id AND session_shells.state='open' RETURNING session_shells.id`,
      [s.id, s.userId, shell.id, JSON.stringify(shell)]);
      if (!rows.length) throw new ShellError(409, 'Shell or session is no longer running.');
    },
    async save(shell: SessionShell) {
      await db.query('UPDATE session_shells SET state=$2,data=$3::jsonb WHERE id=$1 AND session_id=$4', [shell.id, shell.state, JSON.stringify(shell), shell.sessionId]);
    },
  };
}

export async function createShellController(db: Database, sessions: SessionRepository, provider: SandboxProvider, mode: 'live' | 'preview', authorize: (s: Session) => Promise<void>, onClosing: (sessionId: string, shellId: string) => void = () => {}) {
  const store = await createShellRepository(db);
  let mutations = Promise.resolve(); let pending = 0; let stopped = false;
  async function serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (stopped) throw new ShellError(409, 'Server is restarting. Reconnect to manage shells.');
    if (pending >= 32) throw new ShellError(429, 'Too many shell requests. Retry shortly.');
    pending++;
    const task = mutations.then(() => { if (stopped) throw new ShellError(409, 'Server is restarting. Reconnect to manage shells.'); return operation(); }); mutations = task.then(() => {}, () => {});
    try { return await task; } finally { pending--; }
  }
  async function current(s: Session) {
    const latest = await sessions.get(s.id);
    if (!latest || latest.userId !== s.userId || !running(latest)) throw new ShellError(409, 'Shells are available only while the session is running.');
    if (mode === 'live') await authorize(latest);
    const checked = await sessions.get(s.id);
    if (!checked || checked.userId !== s.userId || !running(checked)) throw new ShellError(409, 'Session ended while shell access was being authorized.');
    return checked;
  }
  const update = async (shell: SessionShell, state: ShellState, intent: SessionShell['intent'], error: string | null) => {
    const value = { ...shell, state, requiresCloseAck: state === 'closed' ? false : shell.requiresCloseAck, intent, error, updatedAt: new Date().toISOString() }; await store.save(value); return value;
  };
  async function inspect(s: Session, shell: SessionShell) {
    let observed: TerminalShellState = 'unknown';
    try { observed = await provider.inspectShell?.(s, shell.id) ?? 'unknown'; } catch { /* Upstream failures cannot establish absence. */ }
    // Absence cannot fence an ensure request whose transport reply was lost.
    // Only an acknowledged outcome or an explicit close fences that generation.
    if (observed === 'closed' && !shell.requiresCloseAck && shell.intent !== 'create') return update(shell, 'closed', null, null);
    if (observed === 'open' && shell.intent !== 'close') return update(shell, 'open', null, null);
    return update(shell, 'uncertain', shell.intent, shell.intent === 'close' ? 'Shell closure is not confirmed. Explicitly close this shell again to retry.' : 'Shell creation could not be confirmed. Refresh to inspect or explicitly close this shell.');
  }
  async function listValue(s: Session): Promise<ShellList> {
    const shells = await store.list(s.id);
    const supported = !!provider.ensureShell && !!provider.inspectShell && !!provider.closeShell;
    return { mode, shells: [{ id: 'codex', sessionId: s.id, requestId: null, name: 'Codex', kind: 'primary', state: running(s) ? 'open' : 'closed', requiresCloseAck: false, intent: null, createdAt: s.createdAt, updatedAt: s.createdAt, error: null }, ...shells],
      canCreate: running(s) && supported && !shells.some(shell => shell.state !== 'closed'),
      reason: !running(s) ? 'Shells are available only while the session is running.' : !supported ? 'Supplemental shells are unavailable for this provider.' : mode === 'preview' ? 'Preview simulates shell controls; no real persistent shell is created.' : null };
  }
  async function getSupplemental(s: Session, id: string) {
    if (id === 'codex') throw new ShellError(409, 'The Codex shell is protected.');
    if (!validShellId(id)) throw new ShellError(404, 'Shell not found.');
    const shell = (await store.list(s.id)).find(value => value.id === id);
    if (!shell) throw new ShellError(404, 'Shell not found.');
    return shell;
  }
  return {
    store,
    async list(s: Session) { return serialize(async () => {
      const latest = await sessions.get(s.id);
      if (!latest || latest.userId !== s.userId) throw new ShellError(404, 'Session not found.');
      if (running(latest)) {
        const checked = await current(latest);
        for (const shell of await store.list(s.id)) if (shell.state !== 'closed') await inspect(checked, shell);
      }
      return listValue(await sessions.get(s.id) ?? latest);
    }); },
    async create(s: Session, requestId: string, name: string) { return serialize(async () => {
      if (!uuid.test(requestId)) throw new ShellError(400, 'A UUID requestId is required.');
      name = shellName(name); requestId = requestId.toLowerCase();
      const checked = await current(s);
      const existing = (await store.list(s.id)).find(shell => shell.requestId === requestId);
      if (existing) { if (existing.state !== 'closed') await inspect(checked, existing); return listValue(checked); }
      if (!provider.ensureShell || !provider.inspectShell || !provider.closeShell) throw new ShellError(409, 'Supplemental shells are unavailable for this provider.');
      const now = new Date().toISOString();
      const shell: SessionShell = { id: randomUUID(), sessionId: s.id, requestId, name, kind: 'supplemental', state: 'creating', requiresCloseAck: true, intent: 'create', createdAt: now, updatedAt: now, error: null };
      await store.insert(checked, shell);
      let observed: TerminalShellState = 'unknown';
      try { observed = await provider.ensureShell(checked, shell.id); } catch { /* Inspect before deciding whether this request took effect. */ }
      const latest = await sessions.get(s.id);
      if (!latest || !running(latest)) {
        const closing = await update(shell, 'closing', 'close', null); onClosing(s.id, shell.id);
        try { const result = await provider.closeShell(checked, shell.id); if (result === 'closed') await update(closing, 'closed', null, null); else await inspect(checked, closing); }
        catch { await update(closing, 'uncertain', 'close', 'Session ended before shell closure could be confirmed.'); }
        return listValue(latest ?? { ...checked, state: 'ended' });
      }
      if (observed === 'open') await update({ ...shell, requiresCloseAck: false }, 'open', null, null);
      else if (observed === 'closed') await update(shell, 'closed', null, 'Shell creation did not leave a running shell.');
      else await inspect(latest, shell);
      return listValue(latest);
    }); },
    async rename(s: Session, id: string, name: string) { return serialize(async () => {
      name = shellName(name); id = id.toLowerCase(); const checked = await current(s); const shell = await getSupplemental(checked, id);
      if (shell.state !== 'open') throw new ShellError(409, 'Rename an open supplemental shell.');
      await store.rename(checked, { ...shell, name, updatedAt: new Date().toISOString() }); return listValue(await sessions.get(s.id) ?? checked);
    }); },
    async closeShell(s: Session, id: string) { return serialize(async () => {
      id = id.toLowerCase(); const checked = await current(s); const shell = await getSupplemental(checked, id);
      if (shell.state === 'closed') return listValue(checked);
      if (!provider.closeShell) throw new ShellError(409, 'Shell closure is unavailable.');
      const closing = await update(shell, 'closing', 'close', null); onClosing(s.id, id);
      try { const result = await provider.closeShell(checked, id); if (result === 'closed') await update(closing, 'closed', null, null); else await inspect(checked, closing); }
      catch { await inspect(checked, closing); }
      return listValue(await sessions.get(s.id) ?? checked);
    }); },
    async attachable(s: Session, id: string) {
      id = id.toLowerCase(); if (!validShellId(id)) return false;
      if (id === 'codex') return true;
      return (await store.list(s.id)).some(shell => shell.id === id && shell.state === 'open');
    },
    async reconcile() { return serialize(async () => {
      for (const s of await sessions.list()) {
        if (!running(s)) continue;
        const recovering = (await store.list(s.id)).filter(shell => ['creating', 'closing', 'uncertain'].includes(shell.state));
        if (!recovering.length) continue;
        // Recovery observes the existing target only; it never launches or closes a shell.
        try { const checked = await current(s); for (const shell of recovering) await inspect(checked, shell); } catch { /* Keep durable uncertainty until an authorized refresh. */ }
      }
    }); },
    async close() { stopped = true; await mutations; },
  };
}
