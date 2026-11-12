// Vitest config for the reference app. The app's build, package and launch
// gates run from the repository root (tools/reference-app).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
    passWithNoTests: true,
    reporters: ['default'],
  },
});
