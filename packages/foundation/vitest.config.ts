import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // The default reporter names every test file, also when Vitest detects an
    // agent shell, so Turborepo logs show which gate tests ran.
    reporters: ['default'],
  },
});
