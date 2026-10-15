import type { PreviewTarget, SandboxProvider, Session } from './contracts.js';
import { assertApplicationPreviewSession, isApplicationPreviewPort } from './infra/application-preview.js';
import { PREVIEW_DIAGNOSTIC_HEADER, PREVIEW_DIAGNOSTIC_PATH, PREVIEW_GATEWAY_PORT } from './infra/preview-gateway.js';

export interface ApplicationPreviewCheck {
  state: 'responded' | 'connection_refused' | 'timed_out' | 'unavailable' | 'unknown';
  port: number | null;
  checkedAt: string;
  httpStatus: number | null;
  reason: string | null;
  remedy: string | null;
}
export const PREVIEW_CHECK_TIMEOUT_MS = 5000;
const MAX_DIAGNOSTIC_BYTES = 1024;

/** Static descriptions never expose native credentials, provider errors, or app response content. */
export function previewCheckResult(state: ApplicationPreviewCheck['state'], port: number | null,
  httpStatus: number | null = null): ApplicationPreviewCheck {
  const details: Record<ApplicationPreviewCheck['state'], [string, string]> = {
    responded: [`The application returned HTTP ${httpStatus} for HEAD /.`,
      httpStatus !== null && httpStatus >= 400 ? 'Inspect the application in your terminal, correct the HTTP error, and check again.' :
        'Open the preview to inspect the application. Verify hot reload by editing a file and observing the browser.'],
    connection_refused: ['No application accepted the connection on the selected port.',
      'Start the development server in your terminal on the saved port, check its actual listening port, and check again.'],
    timed_out: ['The preview check did not receive a response within its time limit.',
      'Inspect the development server in your terminal for startup delays or blocked requests, then check again.'],
    unavailable: ['Private preview diagnostics are unavailable for this session.',
      'Check that the session is running and a preview port is saved. Older sessions may require a new session for diagnostics.'],
    unknown: ['The preview check could not confirm whether the application responded.',
      'Inspect the development server in your terminal, confirm the saved port, and check again.'],
  };
  const [reason, remedy] = details[state];
  return { state, port, checkedAt: new Date().toISOString(), httpStatus: state === 'responded' ? httpStatus : null, reason, remedy };
}

function diagnosticTarget(target: PreviewTarget, session: Session, port: number): URL {
  const expected = `https://${PREVIEW_GATEWAY_PORT}-${session.sandboxId}.e2b.app`;
  const url = new URL(target.origin);
  if (target.origin !== expected || url.origin !== expected || url.pathname !== '/' || url.username || url.password ||
    url.port || url.search || url.hash || !/^[\x21-\x7e]{1,4096}$/.test(target.headers['e2b-traffic-access-token'] ?? '') ||
    target.headers['x-ephemeral-preview-port'] !== String(port)) throw new Error('Invalid diagnostic target.');
  return new URL(PREVIEW_DIAGNOSTIC_PATH, url);
}

async function diagnosticBody(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_DIAGNOSTIC_BYTES)) {
    void response.body?.cancel().catch(() => {}); throw new Error('Invalid diagnostic size.');
  }
  if (!response.body) throw new Error('Missing diagnostic result.');
  const reader = response.body.getReader(), parts: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_DIAGNOSTIC_BYTES) throw new Error('Invalid diagnostic size.');
      parts.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
  } finally {
    signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock();
  }
}

/** Read-only provider detail lookup followed by one fixed private gateway request. */
export async function probeApplicationPreview(provider: Pick<SandboxProvider, 'previewTarget'>, session: Session, port: number,
  options: { signal?: AbortSignal; fetch?: typeof fetch } = {}): Promise<ApplicationPreviewCheck> {
  const checkedPort = isApplicationPreviewPort(port) ? port : null;
  if (!provider.previewTarget || checkedPort === null) return previewCheckResult('unavailable', checkedPort);
  try { assertApplicationPreviewSession(session, checkedPort); }
  catch { return previewCheckResult('unavailable', checkedPort); }
  const controller = new AbortController();
  let timedOut = false, phase: 'target' | 'diagnostic' = 'target';
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, PREVIEW_CHECK_TIMEOUT_MS);
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) controller.abort();
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('Diagnostic cancelled.'));
    controller.signal.addEventListener('abort', abort, { once: true });
    if (controller.signal.aborted) abort();
  });
  try {
    return await Promise.race([cancelled, (async () => {
      controller.signal.throwIfAborted();
      const target = await provider.previewTarget!(session, checkedPort, controller.signal);
      controller.signal.throwIfAborted();
      assertApplicationPreviewSession(session, checkedPort);
      const url = diagnosticTarget(target, session, checkedPort);
      phase = 'diagnostic';
      const response = await (options.fetch ?? fetch)(url, { method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { 'e2b-traffic-access-token': target.headers['e2b-traffic-access-token'],
          'x-ephemeral-preview-port': String(checkedPort), [PREVIEW_DIAGNOSTIC_HEADER]: '1' } });
      if (response.status !== 200 || response.headers.get(PREVIEW_DIAGNOSTIC_HEADER) !== '1' ||
        response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
        void response.body?.cancel().catch(() => {});
        return previewCheckResult('unavailable', checkedPort);
      }
      const data = await diagnosticBody(response, controller.signal) as Record<string, unknown> | null;
      controller.signal.throwIfAborted();
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 4 ||
        !Object.keys(data).every(key => ['protocol', 'state', 'port', 'httpStatus'].includes(key)) || data.protocol !== 1 || data.port !== checkedPort ||
        !['responded', 'connection_refused', 'timed_out', 'unknown'].includes(String(data.state)) ||
        (data.state === 'responded' ? !Number.isInteger(data.httpStatus) || Number(data.httpStatus) < 200 || Number(data.httpStatus) > 599 : data.httpStatus !== null)) {
        return previewCheckResult('unknown', checkedPort);
      }
      return previewCheckResult(data.state as ApplicationPreviewCheck['state'], checkedPort, data.httpStatus as number | null);
    })()]);
  } catch {
    controller.abort();
    if (timedOut && phase === 'target') return { ...previewCheckResult('unavailable', checkedPort),
      reason: 'Private preview lookup did not finish within its time limit. The application was not checked.' };
    return previewCheckResult(timedOut ? 'timed_out' : options.signal?.aborted || phase === 'target' ? 'unavailable' : 'unknown', checkedPort);
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', cancel);
    if (abort) controller.signal.removeEventListener('abort', abort);
  }
}
