// Foreground gate tests for #46: the failure modes of the background switch
// (TST-018; ADR 0013 rule 1). The foundation main process reads
// FOUNDATION_TEST_BACKGROUND; only the value `1` enables background mode.
// Unset, empty, `0` and `true` leave the behaviour unchanged: the window shows
// and the app has a Dock icon, as before. A launch that shows its window takes
// focus, so these tests are in the foreground test group: they run in CI and
// with `pnpm run test:foreground`, never in a default run
// (tools/test-support/foreground-test-group.ts).
// Measured on macOS with the spike #43 method (tools/test-support/macos-window-probe.ts),
// against the dev build (the switch is the same code in every build; the
// packaged build in background mode is gated in reference-app-build.gate.test.ts).
// Each failure mode is checked only after a control launch with the value `1`
// showed no window, so a build without the switch fails here too.
// Requirements: TST-018; PLT-005 (dev build).
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { testBackgroundEnabledValue, testBackgroundVariableName } from '../test-support/background-test-variables';
import { joinForegroundTestGroup } from '../test-support/foreground-test-group';
import {
  dockApplicationType,
  macosWindowProbeAvailable,
  macosWindowProbeSkipReason,
  waitForOnscreenAppWindow,
} from '../test-support/macos-window-probe';
import { packagedCdpVariableName } from '../test-support/packaged-cdp-variable';
import { repoGateRootDir } from '../test-support/run-repo-command';
import { listMacosBackgroundProblems } from './test-support/background-mode-checks';
import { waitForAppWindowTargets } from './test-support/devtools-protocol-client';
import {
  devToolsLaunchSwitches,
  startElectronAppProcess,
  type ElectronAppProcess,
} from './test-support/electron-app-process';
import { findReferenceAppDevScript, referenceAppRelativeDir } from './test-support/reference-app-paths';
import { readPackageManifest } from '../test-support/workspace-projects';

joinForegroundTestGroup(import.meta.url);

const referenceAppDir = join(repoGateRootDir, ...referenceAppRelativeDir.split('/'));
const launchTimeoutMs = 120_000;
const slow = { timeout: 300_000 };
/** Time a shown window gets to appear on screen. */
const onscreenWaitMs = 15_000;
/** Time a window that should stay hidden is watched after the app opened it (spike #43: 1.5 s). */
const hiddenWatchMs = 1_500;

const startedApps: ElectronAppProcess[] = [];

afterAll(async () => {
  for (const app of startedApps) await app.stop().catch(() => undefined);
}, 180_000);

/**
 * Starts the dev build with FOUNDATION_TEST_BACKGROUND set to `value` (undefined: not in its
 * environment at all) and waits until its window is listed over CDP.
 */
async function startDevBuild(value: string | undefined): Promise<ElectronAppProcess> {
  const manifest = readPackageManifest(join(referenceAppDir, 'package.json'));
  const script = findReferenceAppDevScript((manifest.scripts ?? {}) as Record<string, string>);
  if (!script)
    throw new Error(`${referenceAppRelativeDir}/package.json has no dev script that runs electron-forge start`);
  const app = startElectronAppProcess({
    command: 'pnpm',
    args: (userDataDir) => ['run', script, '--', ...devToolsLaunchSwitches(userDataDir)],
    cwd: referenceAppDir,
    env: value === undefined ? {} : { [testBackgroundVariableName]: value },
    withoutEnv: value === undefined ? [packagedCdpVariableName, testBackgroundVariableName] : [packagedCdpVariableName],
  });
  startedApps.push(app);
  const port = await app.waitForDevToolsPort(launchTimeoutMs);
  await waitForAppWindowTargets(port, { timeoutMs: launchTimeoutMs, describeProcess: () => app.describe() });
  return app;
}

let control: Promise<string[]> | undefined;

/** Control: with the value `1` the dev build shows no window and no Dock icon. Measured once. */
function backgroundControlProblems(): Promise<string[]> {
  control ??= (async () => {
    const app = await startDevBuild(testBackgroundEnabledValue);
    try {
      await new Promise((resolve) => setTimeout(resolve, hiddenWatchMs));
      return await listMacosBackgroundProblems(app.userDataDir);
    } finally {
      await app.stop();
    }
  })();
  return control;
}

const failureModes: ReadonlyArray<[string, string | undefined]> = [
  ['not set', undefined],
  ['set to an empty value', ''],
  ['set to 0', '0'],
  ['set to true', 'true'],
];

describe('background switch failure modes (foreground group, macOS)', () => {
  // TST-018; issue #46 acceptance criteria 2 and 7 (failure mode: "Without the variable, behaviour is unchanged")
  it.for(failureModes)(
    `TST-018: with ${testBackgroundVariableName} %s, the dev build shows its window on screen and has a Dock icon, as before`,
    slow,
    async ([, value], context) => {
      if (!macosWindowProbeAvailable) {
        context.skip(macosWindowProbeSkipReason);
        return;
      }
      expect(
        await backgroundControlProblems(),
        `control: with ${testBackgroundVariableName}=${testBackgroundEnabledValue} the dev build must show no window and no Dock icon`,
      ).toEqual([]);
      const app = await startDevBuild(value);
      try {
        const presence = await waitForOnscreenAppWindow(app.userDataDir, onscreenWaitMs);
        expect(presence.onscreenWindows.length, `the window must be on screen; ${presence.describe()}`).toBeGreaterThan(
          0,
        );
        expect(
          [...presence.applicationTypes.values()],
          `the app must have a Dock icon (ApplicationType ${dockApplicationType}); ${presence.describe()}`,
        ).toContain(dockApplicationType);
      } finally {
        await app.stop();
      }
    },
  );
});
