import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { ApiClient, ConnectionConfig, Sandbox, Template, type components } from 'e2b';

type ProviderTemplate = components['schemas']['Template'];
class PreflightError extends Error {}
const allowedEnv = ['E2B_API_KEY', 'E2B_TEMPLATE_ID', 'E2B_API_URL', 'E2B_DOMAIN', 'E2B_SANDBOX_URL', 'E2B_DEBUG', 'PUBLIC_URL', 'SESSION_MAX_HOURS'] as const;
const report: { ok: boolean; checks: { name: string; status: 'pass' | 'fail' | 'unverified'; message: string }[] } = { ok: false, checks: [] };
const add = (name: string, status: 'pass' | 'fail' | 'unverified', message: string) => report.checks.push({ name, status, message });
let context = 'configuration';
try {
  // Parse dotenv as data. No shell evaluation/interpolation, no value logging.
  // Explicit process environment wins over the selected .env file.
  const envPath = process.argv[2] ?? '.env';
  try {
    const values = parseEnv(await readFile(envPath, 'utf8'));
    for (const key of allowedEnv) if (process.env[key] === undefined && values[key] !== undefined) process.env[key] = values[key];
    add('env-file', 'pass', 'Environment file parsed without evaluating shell content.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new PreflightError('Environment file could not be parsed.');
    add('env-file', 'unverified', 'Environment file absent; checking existing process environment.');
  }
  const key = process.env.E2B_API_KEY?.trim();
  const requested = process.env.E2B_TEMPLATE_ID?.trim();
  const maxHours = Number(process.env.SESSION_MAX_HOURS || 1);
  if (maxHours !== 1 && maxHours !== 4) throw new PreflightError('SESSION_MAX_HOURS must be 1 (Hobby) or 4 (Pro).');
  add('session-policy', 'pass', maxHours === 1 ? 'One-hour lifetime configured; extensions are disabled and Hobby is sufficient.' : 'Four-hour maximum configured; E2B Pro is required for extensions.');
  if (!key) throw new PreflightError('E2B_API_KEY is missing.');
  if (requested && !/^[A-Za-z0-9][A-Za-z0-9_\/-]*(?::[A-Za-z0-9_.-]+)?$/.test(requested)) throw new PreflightError('Invalid template ID or alias syntax.');
  const connection = new ConnectionConfig({ apiKey: key, requestTimeoutMs: 15_000, retries: 0 });
  const apiUrl = new URL(connection.apiUrl);
  if (connection.debug || apiUrl.protocol !== 'https:' || !['api.e2b.app', 'api.e2b.dev'].includes(apiUrl.hostname) || apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) {
    throw new PreflightError('Preflight only supports the authenticated E2B Cloud HTTPS API; clear debug/custom API overrides.');
  }
  add('sdk-config', 'pass', 'E2B SDK targets the authenticated cloud API; request timeout is 15 seconds with retries disabled.');
  if (process.env.E2B_SANDBOX_URL) add('sandbox-url-override', 'fail', 'E2B_SANDBOX_URL is set. Clear this development override before live deployment.');
  const publicUrl = process.env.PUBLIC_URL;
  try {
    const gateway = new URL(publicUrl ?? '');
    if (gateway.protocol !== 'https:' || gateway.username || gateway.password || gateway.pathname !== '/' || gateway.search || gateway.hash) throw new Error();
    add('gateway-url', 'pass', 'PUBLIC_URL is an HTTPS origin. Reachability from a VM still requires a live smoke test.');
  } catch { add('gateway-url', 'fail', 'PUBLIC_URL must be the public HTTPS deployment origin.'); }

  context = 'account-access';
  const paginator = Sandbox.list({ apiKey: key, requestTimeoutMs: 15_000, retries: 0, limit: 1 });
  await paginator.nextItems();
  add('account-access', 'pass', 'E2B accepted the API key for a read-only sandbox listing. No sandbox was created or resumed.');

  context = 'template-access';
  if (!requested) {
    throw new PreflightError('E2B_TEMPLATE_ID is missing. Account access was checked; build and save a custom template before creating a session.');
  }
  const [name, selectedTag = 'default'] = requested.split(':');
  const client = new ApiClient(connection);
  let selected: ProviderTemplate | undefined;
  let nextToken: string | undefined;
  do {
    const result = await client.api.GET('/v2/templates', {
      params: { query: { limit: 100, ...(nextToken ? { nextToken } : {}) } }, signal: connection.getSignal(),
    });
    if (!result.response.ok || !result.data) throw new PreflightError(`Template listing failed (HTTP ${result.response.status}).`);
    selected = result.data.find(template => template.templateID === name || template.names.includes(name) || template.aliases.includes(name));
    nextToken = result.response.headers.get('X-Next-Token') ?? undefined;
  } while (!selected && nextToken);
  if (!selected) throw new PreflightError('Configured custom template was not found among templates accessible to this API key.');
  add('template-access', 'pass', 'Configured custom template is visible to the selected E2B account.');
  add('template-compute', 'pass', `Template allocation: ${selected.cpuCount} vCPU, ${selected.memoryMB} MiB RAM. Compare to account defaults if using Hobby.`);
  context = 'template-readiness';
  const tags = await Template.getTags(selected.templateID, { apiKey: key, requestTimeoutMs: 15_000, retries: 0 });
  const tag = tags.find(item => item.tag === selectedTag);
  if (!tag) throw new PreflightError('Requested template tag has no assigned build.');
  const build = await Template.getBuildStatus({ templateId: selected.templateID, buildId: tag.buildId }, { apiKey: key, requestTimeoutMs: 15_000, retries: 0 });
  if (build.status !== 'ready') throw new PreflightError(`Selected template build is ${build.status}; it is not ready.`);
  add('template-readiness', 'pass', 'The configured template/tag resolves to a ready build. Runtime tools and clean auth still require live validation.');
  add('plan', 'unverified', maxHours === 1 ? 'SDK/API responses do not establish billing plan or credits. Verify Hobby/default compute and remaining credits in the dashboard.' : 'Read-only SDK/API responses do not establish billing plan. Verify E2B Pro in the dashboard for four-hour sessions and custom compute.');
  add('codex-device-auth', 'unverified', 'Enable device code login in ChatGPT security settings or workspace permissions; complete fresh login inside the eventual VM.');
  report.ok = !report.checks.some(check => check.status === 'fail');
} catch (error) {
  // Never print SDK errors/response bodies: they can include request headers.
  const message = error instanceof PreflightError ? error.message :
    'Read-only provider check did not succeed. Check credential access, template/tag configuration, and provider availability.';
  add(context, 'fail', message);
}
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
