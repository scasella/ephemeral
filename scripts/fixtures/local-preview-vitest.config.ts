import { tmpdir } from 'node:os';
import { defineConfig } from 'vitest/config';

// This separate config prevents the runner itself from loading repository .env files.
export default defineConfig({
  envDir: process.env.EPHEMERAL_LOCAL_PREVIEW_CONTROL_DIR ?? tmpdir(),
  test: { include: ['tests/local-preview-e2e.test.ts'], maxWorkers: 1 },
});
