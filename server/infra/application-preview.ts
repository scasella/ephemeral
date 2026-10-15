import type { PreviewTarget, Session } from '../contracts.js';
import { PREVIEW_GATEWAY_PORT, PREVIEW_GATEWAY_VERSION } from './preview-gateway.js';

export const APPLICATION_PREVIEW_UNAVAILABLE = 'Application preview is unavailable.';
export interface PreviewTokenStore {
  save(session: Session, sandboxId: string, token: string): Promise<void>;
  read(session: Session, sandboxId: string): Promise<string | null>;
  remove(sandboxId: string): Promise<void>;
}
const SANDBOX_ID = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
const DOMAIN = 'e2b.app';

/** Excludes privileged ports and E2B's envd, interpreter, and MCP control ports. */
export function isApplicationPreviewPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isSafeInteger(port) && port >= 1024 && port <= 49151;
}

export function assertApplicationPreviewSession(session: Session, port: number): void {
  const expiry = Math.min(Date.parse(session.expiresAt), Date.parse(session.maxExpiresAt));
  if (!isApplicationPreviewPort(port) || session.state !== 'running' || session.endedAt !== null ||
    !session.sandboxId || !SANDBOX_ID.test(session.sandboxId) || !Number.isFinite(expiry) || expiry <= Date.now()) {
    throw new Error(APPLICATION_PREVIEW_UNAVAILABLE);
  }
}

export interface PreviewSandboxInfo {
  sandboxID: string;
  state: string;
  endAt: string;
  domain?: string | null;
  metadata?: Record<string, string> | null;
  lifecycle?: { autoResume: boolean } | null;
  network?: { allowPublicTraffic?: boolean } | null;
}

/** A provider-owned host function is the only source of the destination; no user URL is accepted. */
export function privateApplicationPreviewTarget(session: Session, port: number, info: PreviewSandboxInfo,
  trafficAccessToken: string | undefined, getHost: () => string): PreviewTarget {
  assertApplicationPreviewSession(session, port);
  const metadata = info.metadata ?? {};
  const providerExpiry = Date.parse(info.endAt);
  if (info.sandboxID !== session.sandboxId || info.state !== 'running' || info.lifecycle?.autoResume !== false ||
    info.network?.allowPublicTraffic !== false || !Number.isFinite(providerExpiry) || providerExpiry <= Date.now() ||
    metadata.ephemeral_session_id !== session.id || metadata.ephemeral_user_id !== session.userId ||
    metadata.ephemeral_repository !== session.repository || metadata.ephemeral_repository_id !== String(session.repositoryId) ||
    metadata.ephemeral_branch !== session.branch || metadata.ephemeral_preview_gateway !== PREVIEW_GATEWAY_VERSION ||
    (info.domain != null && info.domain !== DOMAIN) ||
    !trafficAccessToken || !/^[\x21-\x7e]{1,4096}$/.test(trafficAccessToken)) throw new Error(APPLICATION_PREVIEW_UNAVAILABLE);
  const expectedHost = `${PREVIEW_GATEWAY_PORT}-${session.sandboxId}.${DOMAIN}`;
  const host = getHost();
  const url = new URL(`https://${host}`);
  if (host !== expectedHost || url.hostname !== expectedHost || url.protocol !== 'https:' || url.port ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin !== `https://${expectedHost}`) {
    throw new Error(APPLICATION_PREVIEW_UNAVAILABLE);
  }
  return { origin: url.origin, headers: { 'e2b-traffic-access-token': trafficAccessToken, 'x-ephemeral-preview-port': String(port),
    origin: `http://localhost:${port}` } };
}
