// Vitest config for the end-to-end package (#16; TST-007, TST-010).
// - `harness-gates`: the smoke harness gate tests; the package `test` script
//   runs them, so Turborepo runs them on every platform.
// - `smoke`: the smoke suite in smoke/; only `pnpm run smoke` runs it. The
//   gate tests never run here: one of them calls `pnpm run smoke` itself.
// Tests in each file run one after another; files never run in parallel,
// because every test starts a real Electron app.
// DEFERRED: TST-010 (CI runs the smoke suite against the packaged app on three platforms; #17)
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Makes sure the Electron binary is downloaded; a fresh install has none (see the file).
    globalSetup: ['./vitest.global-setup.ts'],
    // The default reporter names every test file, also when Vitest detects an
    // agent shell, so logs show which tests ran.
    reporters: ['default'],
    fileParallelism: false,
    projects: [
      { extends: true, test: { name: 'harness-gates', include: ['harness/**/*.test.ts'] } },
      { extends: true, test: { name: 'smoke', include: ['smoke/**/*.test.ts'] } },
    ],
  },
});
