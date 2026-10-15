import { defineConfig } from 'vitest/config';

// PGlite initialization, local Git, HTTP fixtures and child processes compete
// for CPU under the supported Node 24 runtime. Keep pure unit tests at 5 seconds.
const integration = [
  'tests/*-http.test.ts', 'tests/auth-admission.test.ts', 'tests/github-*.test.ts', 'tests/*authorization*.test.ts', 'tests/*cleanup*.test.ts', 'tests/config-process.test.ts', 'tests/setup-lifecycle.test.ts', 'tests/reconciliation.test.ts', 'tests/repository-retry.test.ts', 'tests/session-events.test.ts',
  'tests/{auth,auth-boundaries,batch5-handoff,continuation,db-lock,db-failure,github,github-anchors,github-boundaries,github-issuance,github-registration,handoff-continuation,handoff-notes,http,lifecycle,local-preview-e2e,local-setup-config,operator-recovery,pr-handoff,preview-gateway,provisioning-recovery,scan-secrets,session-labels,setup,setup-runner,shells,shutdown,shutdown-process,startup,terminal-shell-lifecycle,terminal-shell-processes,upgrade-disconnect,workspace-changes,workspace-status}.test.ts',
];
export default defineConfig({
  envDir: false,
  test: {
    setupFiles: ['tests/test-environment.ts'],
    projects: [
      { extends: true, test: { name: 'integration', include: integration, testTimeout: 30_000, hookTimeout: 30_000 } },
      { extends: true, test: { name: 'unit', include: ['tests/**/*.test.ts', 'src/**/*.test.ts'], exclude: integration } },
    ],
  },
});
