import { defineConfig } from 'vitest/config';

// This separate config prevents the runner itself from loading repository .env files.
export default defineConfig({
  envDir: false,
  test: { include: ['tests/local-preview-e2e.test.ts'], maxWorkers: 1 },
});
