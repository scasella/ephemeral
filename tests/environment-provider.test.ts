import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sandbox } from 'e2b';
import type { Session, SessionRepository, SandboxProvider } from '../server/contracts.js';
import { E2BProvider } from '../server/infra/e2b.js';
import { loadEnvironmentCatalog } from '../server/environments.js';
import { SessionManager } from '../server/core/lifecycle.js';

const session = (): Session => ({ id: 'session', userId: 'owner', sandboxId: null, repository: 'org/repo', repositoryId: 12,
  installationId: 1, baseBranch: 'main', branch: 'work', state: 'provisioning', createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(), maxExpiresAt: new Date(Date.now() + 120_000).toISOString(),
  endedAt: null, error: null, codexRemoteRevocation: 'unverified', cleanup: { vm: 'pending', github: 'pending', gateway: 'pending', codex: 'pending' } });
const profile = () => loadEnvironmentCatalog({ mode: 'preview', templateId: '' }).profiles[1];
const provider = () => new E2BProvider({ apiKey: 'synthetic-api-key', templateId: 'legacy-template', gatewayUrl: 'https://gateway.example.test' });
afterEach(() => vi.restoreAllMocks());

describe('environment provider selection', () => {
  it('selects only the validated snapshot and retains private networking, secure lifecycle and account compute defaults', async () => {
    const create = vi.spyOn(Sandbox, 'create').mockResolvedValue({ sandboxId: 'new-vm' } as Sandbox);
    const environment = profile();
    await expect(provider().create({ ...session(), environment }, 'session-gateway')).resolves.toBe('new-vm');
    expect(create).toHaveBeenCalledWith(environment.templateRef, expect.objectContaining({ retries: 0, requestTimeoutMs: 60_000,
      allowInternetAccess: true, secure: true, network: { allowPublicTraffic: false, maskRequestHost: 'localhost:${PORT}' },
      lifecycle: { onTimeout: 'kill', autoResume: false }, envs: { EPHEMERAL_GATEWAY_TOKEN: 'session-gateway' },
      metadata: expect.objectContaining({ ephemeral_environment_id: environment.id, ephemeral_environment_revision: environment.revision }) }));
    const options = create.mock.calls[0][1]; expect(options).not.toHaveProperty('cpuCount'); expect(options).not.toHaveProperty('memoryMB');
    expect(options?.envs).not.toHaveProperty('E2B_API_KEY'); expect(JSON.stringify(options?.envs)).not.toContain('synthetic-api-key');
  });
  it('keeps legacy launch selection and metadata unchanged when no profile was selected', async () => {
    const create = vi.spyOn(Sandbox, 'create').mockResolvedValue({ sandboxId: 'new-vm' } as Sandbox);
    await provider().create(session(), 'gateway');
    expect(create.mock.calls[0][0]).toBe('legacy-template');
    expect(create.mock.calls[0][1]?.metadata).not.toHaveProperty('ephemeral_environment_id');
  });
  it('rejects invalid snapshots and content/revision mismatches before any API request', async () => {
    const create = vi.spyOn(Sandbox, 'create');
    for (const invalid of [{ ...profile(), templateRef: 'https://evil.test' }, { ...profile(), templateRef: 'arbitrary-template:v1' }, { ...profile(), tools: ['secret\nvalue'] }, null]) {
      await expect(provider().create({ ...session(), environment: invalid as unknown as ReturnType<typeof profile> }, 'gateway')).rejects.toMatchObject({ outcome: 'not_created', reason: 'request_not_sent' });
    }
    expect(create).not.toHaveBeenCalled();
  });
  it('copies nested profile metadata into a session before lifecycle scheduling and preserves absence', async () => {
    const stored = new Map<string, Session>();
    const repo: SessionRepository = { insert: vi.fn(async value => { stored.set(value.id, structuredClone(value)); }), get: async id => structuredClone(stored.get(id) ?? null), list: async () => [...stored.values()], update: async value => { stored.set(value.id, structuredClone(value)); }, event: async () => {}, events: async () => [], eventPage: async () => ({ events: [], nextCursor: null }) };
    const fake: SandboxProvider = { create: vi.fn(async () => 'vm'), prepare: async () => {}, setTimeout: async () => {}, kill: async () => {}, exists: async () => true, cleanupCodex: async () => true, connectTerminal: async () => ({ write: async () => {}, resize: async () => {}, disconnect: async () => {} }) };
    const manager = new SessionManager(repo, fake, { issue: async () => 'gateway', disable: async () => {}, revokeGitHub: async () => {} });
    try {
      const environment = profile(), expected = structuredClone(environment);
      const input = { userId: 'owner', repository: 'org/repo', repositoryId: 12, installationId: 1, baseBranch: 'main' };
      const created = await manager.create({ ...input, environment });
      environment.tools.push('Changed'); environment.templateRef = 'changed:v1';
      expect(created.environment).toEqual(expected); expect(stored.get(created.id)?.environment).toEqual(expected);
      const legacy = await manager.create(input); expect(legacy).not.toHaveProperty('environment');
      await expect(manager.create({ ...input, environment })).rejects.toThrow('Invalid environment');
    } finally { await manager.shutdown(); }
  });
});
