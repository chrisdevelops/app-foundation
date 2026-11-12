// Foreground gate test for #16, moved here by #46 (TST-018; ADR 0013 rule 3):
// a main process that throws on a top-level require() shows a native modal
// error dialog on macOS and Windows (ADR 0005), and the dialog shows and takes
// focus whatever the launch mode. The test needs that native dialog, so it is
// in the foreground test group: it runs in CI and with `pnpm run test:foreground`,
// never in a default run (tools/test-support/foreground-test-group.ts).
// Contract (issue #16, acceptance criterion 5): the launch fails within the
// startup timeout with `startup-timeout` (dialog) or `app-exited` (no dialog),
// with the captured stdout, and the app with the dialog is killed.
// Packaged launches set FOUNDATION_ALLOW_PACKAGED_CDP=1, as every packaged launch must (#18).
// Requirements: XC-004, TST-007, TST-010 (partial), TST-018.
import { rmSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listProcessesUsing, removeAppFolderAfterExit } from '../../tools/test-support/app-process-cleanup';
import { joinForegroundTestGroup } from '../../tools/test-support/foreground-test-group';
import { packagedCdpEnabledValue, packagedCdpVariableName } from '../../tools/test-support/packaged-cdp-variable';
import { createSmokeFixtureBuild, type SmokeFixtureBuild } from '../test-support/smoke-fixture-app';
import { isSmokeHarnessError, loadSmokeHarness } from '../test-support/smoke-harness-contract';
import {
  smokeHarnessDeferredOnWindows,
  smokeHarnessWindowsDeferralReason,
} from '../test-support/windows-smoke-deferral';

joinForegroundTestGroup(import.meta.url);

/** Time the harness gets, after its startup timeout, to kill the process tree and report. */
const failureCleanupGraceMs = 45_000;

// DEFERRED: TST-010 (Windows smoke harness; ADR 0011, #39): every test in this file skips on Windows.
beforeEach((context) => {
  if (smokeHarnessDeferredOnWindows) context.skip(smokeHarnessWindowsDeferralReason);
});

let fixture: SmokeFixtureBuild | undefined;
const userDataDirs = new Set<string>();

afterAll(async () => {
  for (const dir of userDataDirs) {
    for (const entry of listProcessesUsing(dir)) {
      try {
        process.kill(entry.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
  if (fixture) await removeAppFolderAfterExit(fixture.dir, 'smoke gate fixture build');
}, 180_000);

describe('smoke harness: native error dialog at startup (foreground group)', () => {
  // XC-004; issue #16 acceptance criterion 5; ADR 0005: a top-level require() of a missing module shows a modal dialog
  it(
    'XC-004: a main process that throws on a top-level require() makes the launch fail within the timeout, never hang',
    { timeout: 300_000 },
    async () => {
      const harness = await loadSmokeHarness();
      fixture ??= createSmokeFixtureBuild();
      fixture.write({ mode: 'throw-on-require' });
      const startupTimeoutMs = 10_000;
      let timer: NodeJS.Timeout | undefined;
      const hang = new Promise<'hang'>((resolve) => {
        timer = setTimeout(() => resolve('hang'), startupTimeoutMs + failureCleanupGraceMs);
      });
      const outcome = await Promise.race([
        harness
          .launchSmokeApp({
            target: { kind: 'packaged', executablePath: fixture.executablePath },
            env: { [packagedCdpVariableName]: packagedCdpEnabledValue },
            startupTimeoutMs,
          })
          .then(
            async (app) => {
              userDataDirs.add(app.userDataDir);
              await app.teardown();
              return { settled: 'resolved' as const };
            },
            (error: unknown) => ({ settled: 'rejected' as const, error }),
          ),
        hang,
      ]);
      clearTimeout(timer);
      if (outcome === 'hang') throw new Error('launchSmokeApp did not settle: the harness hangs on the dialog');
      if (outcome.settled === 'resolved') throw new Error('launchSmokeApp must fail, but it connected');
      const error = outcome.error;
      if (!isSmokeHarnessError(harness, error)) {
        throw new Error(`launchSmokeApp must reject with a SmokeHarnessError, got: ${String(error)}`);
      }
      if (error.userDataDir) userDataDirs.add(error.userDataDir);
      // macOS and Windows: a modal dialog keeps the app running (startup-timeout); without a dialog it may exit.
      expect(['startup-timeout', 'app-exited'], `error code; message: ${error.message}`).toContain(error.code);
      expect(error.output, 'captured stdout before the throw').toContain(fixture.stdoutMarker);
      const left = [
        ...listProcessesUsing(fixture.dir),
        ...(error.userDataDir ? listProcessesUsing(error.userDataDir) : []),
      ].map((entry) => `pid ${entry.pid}: ${entry.command}`);
      expect(left, 'the app with the dialog must be killed').toEqual([]);
    },
  );
});
