// Root Vitest run for repository-level gate tests (tools/repo). Workspace
// packages have their own vitest.config.ts and run through Turborepo.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tools/**/*.test.ts'],
    environment: 'node',
  },
});
