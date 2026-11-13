// Gate tests for #46: the smoke harness launches in background mode by default
// (TST-018; ADR 0013 rules 1 and 2), tested through the harness module
// boundary (`launchSmokeApp`) against the smoke fixture app.
// Contract read from the issue and ADR 0013:
// - Every launch gets FOUNDATION_TEST_BACKGROUND=1 in the app's environment
//   (local, agents, CI), unless the run's environment holds
//   FOUNDATION_TEST_FOREGROUND=1: then the app gets no FOUNDATION_TEST_BACKGROUND.
//   Only `1` opts out; `0`, an empty value or `true` keep background mode.
//   The harness reads FOUNDATION_TEST_FOREGROUND from its own process
//   environment when it launches.
// - In background mode the harness enables CDP focus emulation, so
//   `document.hasFocus()` is true in every window, also one opened after the
//   connection.
// - In background mode no fixture window is ever focused on any platform; on
//   macOS none is ever shown, on Linux and Windows each is shown without focus
//   (ADR 0013 amendment 1). Pages paint, `Page.captureScreenshot` returns a
//   real image, and CDP key input reaches a focused input. Every CDP call of
//   these probes has its own time limit, so a call that never answers fails
//   the test in seconds with the step it waited for (PR #47 CI: a screenshot of
//   a never-shown window on Linux hung until the 300 s test timeout).
// - macOS: the launch leaves the frontmost app unchanged (the front app is
//   never one of the fixture's processes), shows no window on screen and no
//   Dock icon (spike #43 method, tools/test-support/macos-window-probe.ts).
// - ADR 0016: on Linux every harness launch in background mode passes
//   `--disable-gpu` to Electron on its command line (the GPU-less Ubuntu
//   runners can draw no frame for up to 13 s while the GPU process fails); a
//   launch in a run with FOUNDATION_TEST_FOREGROUND=1 does not get it, and on
//   macOS and Windows no launch gets it. Read from the arguments the fixture's
//   main process got (packaged target) and from the command line of the running
//   Electron main process (dev target).
// The fixture app follows the same switch as the foundation and reports what
// it did (e2e/test-support/smoke-fixture-app.ts, window-state.json), so the
// launch mode is visible on every platform.
// Packaged launches set FOUNDATION_ALLOW_PACKAGED_CDP=1, as every packaged launch must (#18).
// A run with FOUNDATION_TEST_FOREGROUND=1 skips this file: it launches normally on purpose.
// Requirements: TST-018; TST-007, TST-010 (harness).
import { rmSync } from 'node:fs';
import type { Page } from 'playwright-core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  listProcessesUsing,
  removeAppFolderAfterExit,
  type RunningProcess,
} from '../../tools/test-support/app-process-cleanup';
import {
  focusProbeWatchMs,
  listPaintProbeProblems,
  listScreenshotProbeProblems,
  paintProbeExpression,
  paintScreenshotOverlayExpression,
  removeScreenshotOverlayExpression,
  withBackgroundProbeTimeout,
  type PaintProbeResult,
  type ScreenshotOverlayResult,
} from '../../tools/test-support/background-page-probes';
import {
  foregroundRunSkipReason,
  isForegroundTestRun,
  testBackgroundEnabledValue,
  testBackgroundGpuSwitch,
  testBackgroundVariableName,
  testForegroundEnabledValue,
  testForegroundVariableName,
} from '../../tools/test-support/background-test-variables';
import {
  describeFrontmostSamples,
  dockApplicationType,
  listAppProcessIds,
  macosWindowProbeAvailable,
  macosWindowProbeSkipReason,
  readMacosAppPresence,
  samplesWhereAppWasFrontmost,
  startFrontmostAppSampler,
  type FrontmostAppSample,
  type MacosAppPresence,
} from '../../tools/test-support/macos-window-probe';
import { packagedCdpEnabledValue, packagedCdpVariableName } from '../../tools/test-support/packaged-cdp-variable';
import {
  createSmokeFixtureBuild,
  readSmokeFixtureWindowState,
  smokeFixtureInputName,
  smokeFixtureSecondWindowTitle,
  type SmokeFixtureAppConfig,
  type SmokeFixtureBuild,
  type SmokeFixtureWindowState,
} from '../test-support/smoke-fixture-app';
import { loadSmokeHarness, type ExpectedSmokeApp } from '../test-support/smoke-harness-contract';
import {
  smokeHarnessDeferredOnWindows,
  smokeHarnessWindowsDeferralReason,
} from '../test-support/windows-smoke-deferral';

const slow = { timeout: 300_000 };
const fixtureStartupTimeoutMs = 60_000;
/** Time after the window appears that the frontmost app is still sampled (spike #43: 1.5 s). */
const frontmostSettleMs = 1_500;
/** ADR 0013 amendment 1: Linux and Windows show background windows without focus; macOS never shows them. */
const backgroundWindowsAreShown = process.platform !== 'darwin';
/** ADR 0016: only Linux background launches run without the GPU process. */
const backgroundLaunchesDisableGpu = process.platform === 'linux';
/** Time the dev command gets to build main and preload and open the endpoint. */
const devStartupTimeoutMs = 180_000;

// DEFERRED: TST-010 (Windows smoke harness; ADR 0011, #39): every test in this file skips on Windows.
beforeEach((context) => {
  if (smokeHarnessDeferredOnWindows) context.skip(smokeHarnessWindowsDeferralReason);
  else if (isForegroundTestRun()) context.skip(foregroundRunSkipReason);
});

let fixture: SmokeFixtureBuild | undefined;
const startedApps: ExpectedSmokeApp[] = [];
const userDataDirs = new Set<string>();

function requireFixture(config: SmokeFixtureAppConfig): SmokeFixtureBuild {
  fixture ??= createSmokeFixtureBuild();
  rmSync(fixture.windowStateFile, { force: true });
  fixture.write(config);
  return fixture;
}

/** Launches the fixture through the harness with the default launch mode (the caller adds no background variable). */
async function launchFixture(build: SmokeFixtureBuild): Promise<ExpectedSmokeApp> {
  const harness = await loadSmokeHarness();
  const app = await harness.launchSmokeApp({
    target: { kind: 'packaged', executablePath: build.executablePath },
    env: { [packagedCdpVariableName]: packagedCdpEnabledValue },
    startupTimeoutMs: fixtureStartupTimeoutMs,
  });
  startedApps.push(app);
  userDataDirs.add(app.userDataDir);
  return app;
}

/** Polls window-state.json until `ready` holds; returns the last state read. */
async function waitForFixtureState(
  build: SmokeFixtureBuild,
  ready: (state: SmokeFixtureWindowState) => boolean,
  timeoutMs = 30_000,
): Promise<SmokeFixtureWindowState> {
  const deadline = Date.now() + timeoutMs;
  let state = readSmokeFixtureWindowState(build);
  while ((state === undefined || !ready(state)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    state = readSmokeFixtureWindowState(build);
  }
  if (state === undefined) throw new Error(`the fixture wrote no ${build.windowStateFile} within ${timeoutMs} ms`);
  return state;
}

/** The launch got FOUNDATION_TEST_BACKGROUND=1 (fixture report); fails with what it got otherwise. */
function expectBackgroundLaunch(state: SmokeFixtureWindowState): void {
  expect(
    state.backgroundVariable,
    `the harness must launch with ${testBackgroundVariableName}=${testBackgroundEnabledValue} by default; the app got ${JSON.stringify(state.backgroundVariable)} (fixture state ${JSON.stringify(state)})`,
  ).toBe(testBackgroundEnabledValue);
}

async function waitForTitledWindow(app: ExpectedSmokeApp, title: string, timeoutMs = 30_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      if ((await page.title().catch(() => '')) === title) return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no window titled ${title} within ${timeoutMs} ms`);
}

/** Runs `action` with FOUNDATION_TEST_FOREGROUND set to `value` (undefined: unset) in this process, then restores it. */
async function withRunForegroundValue<T>(value: string | undefined, action: () => Promise<T>): Promise<T> {
  const saved = process.env[testForegroundVariableName];
  if (value === undefined) delete process.env[testForegroundVariableName];
  else process.env[testForegroundVariableName] = value;
  try {
    return await action();
  } finally {
    if (saved === undefined) delete process.env[testForegroundVariableName];
    else process.env[testForegroundVariableName] = saved;
  }
}

/** True when `args` holds the ADR 0016 switch as one whole argument. */
function hasGpuSwitch(args: readonly string[]): boolean {
  return args.includes(testBackgroundGpuSwitch);
}

/**
 * The Electron main (browser) processes among `processes`: the executable is Electron itself (not pnpm,
 * node, a shell or xvfb-run, which may carry the same arguments) and it is not a Chromium helper (`--type=`).
 */
function electronMainProcesses(processes: readonly RunningProcess[]): RunningProcess[] {
  return processes.filter(
    (entry) => !/(^|\s)--type=/.test(entry.command) && /[\\/]electron(\.exe)?(\s|$)/i.test(entry.command),
  );
}

afterAll(async () => {
  for (const app of startedApps) await app.teardown().catch(() => undefined);
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

describe('smoke harness: background mode by default', () => {
  // TST-018; issue #46 acceptance criteria 2 and 4; ADR 0013 rules 1 and 2
  it(
    `TST-018: by default the harness launches with ${testBackgroundVariableName}=${testBackgroundEnabledValue}, and no fixture window, also one opened later, is ever focused; ${backgroundWindowsAreShown ? 'each is shown without focus (Linux, Windows)' : 'none is ever shown (macOS)'}`,
    slow,
    async () => {
      const build = requireFixture({ mode: 'window', title: 'Smoke fixture background' });
      const app = await launchFixture(build);
      try {
        const first = await waitForTitledWindow(app, 'Smoke fixture background');
        await first.evaluate('location.hash = "open-second-window"');
        await waitForTitledWindow(app, smokeFixtureSecondWindowTitle);
        await waitForFixtureState(build, (current) => current.windows.length >= 2);
        // A shown window takes focus within this time when it takes it at all (spike #43: 1.5 s).
        await new Promise((resolve) => setTimeout(resolve, focusProbeWatchMs));
        const state = await waitForFixtureState(build, (current) => current.windows.length >= 2);
        expectBackgroundLaunch(state);
        expect(state.windows, 'the fixture must report both windows').toHaveLength(2);
        expect(
          state.windows.filter((window) => window.everFocused || window.focused),
          `in background mode no window may ever be focused, on any platform (fixture state ${JSON.stringify(state)})`,
        ).toEqual([]);
        if (backgroundWindowsAreShown) {
          expect(
            state.windows.filter((window) => !window.everShown || !window.visible),
            `on ${process.platform} every background window must be shown without focus (ADR 0013 amendment 1; fixture state ${JSON.stringify(state)})`,
          ).toEqual([]);
        } else {
          expect(
            state.windows.filter((window) => window.everShown || window.visible),
            `on macOS no background window may ever be shown (fixture state ${JSON.stringify(state)})`,
          ).toEqual([]);
        }
      } finally {
        await app.teardown();
      }
    },
  );

  // TST-018; issue #46 acceptance criterion 4 (run-level opt-out and its failure modes)
  it(
    `TST-018: ${testForegroundVariableName}=${testForegroundEnabledValue} in the run's environment launches without ${testBackgroundVariableName}; unset, empty, 0 and true keep background mode`,
    slow,
    async () => {
      const cases: ReadonlyArray<[string | undefined, string | null]> = [
        [undefined, testBackgroundEnabledValue],
        [testForegroundEnabledValue, null],
        ['', testBackgroundEnabledValue],
        ['0', testBackgroundEnabledValue],
        ['true', testBackgroundEnabledValue],
      ];
      const seen: string[] = [];
      for (const [runValue, expected] of cases) {
        // env-only: records its environment and opens no window, so no launch here takes focus.
        const build = requireFixture({ mode: 'env-only' });
        const app = await withRunForegroundValue(runValue, () => launchFixture(build));
        try {
          const state = await waitForFixtureState(build, () => true);
          seen.push(
            `${testForegroundVariableName}=${JSON.stringify(runValue ?? null)} -> ${testBackgroundVariableName}=${JSON.stringify(state.backgroundVariable)}`,
          );
          expect(
            state.backgroundVariable,
            `with ${testForegroundVariableName}=${JSON.stringify(runValue ?? null)} in the run's environment the app must get ${testBackgroundVariableName}=${JSON.stringify(expected)}; launches so far:\n${seen.join('\n')}`,
          ).toBe(expected);
        } finally {
          await app.teardown();
        }
      }
    },
  );

  // TST-018; ADR 0016 rules 1 to 3 (packaged target: the fixture reports the arguments its main process got)
  it(
    backgroundLaunchesDisableGpu
      ? `TST-018: on Linux a background harness launch passes ${testBackgroundGpuSwitch} to Electron, and a launch with ${testForegroundVariableName}=${testForegroundEnabledValue} does not`
      : `TST-018: on ${process.platform} no harness launch passes ${testBackgroundGpuSwitch} to Electron, in background mode or with ${testForegroundVariableName}=${testForegroundEnabledValue}`,
    slow,
    async () => {
      const cases: ReadonlyArray<[string | undefined, boolean]> = [
        [undefined, backgroundLaunchesDisableGpu],
        [testForegroundEnabledValue, false],
        ['0', backgroundLaunchesDisableGpu],
      ];
      const seen: string[] = [];
      for (const [runValue, expected] of cases) {
        // env-only: records its environment and arguments and opens no window, so no launch here takes focus.
        const build = requireFixture({ mode: 'env-only' });
        const app = await withRunForegroundValue(runValue, () => launchFixture(build));
        try {
          const state = await waitForFixtureState(build, () => true);
          const args = state.launchArguments;
          expect(
            Array.isArray(args),
            `control: the fixture must report its arguments (fixture state ${JSON.stringify(state)})`,
          ).toBe(true);
          seen.push(
            `${testForegroundVariableName}=${JSON.stringify(runValue ?? null)} -> ${testBackgroundVariableName}=${JSON.stringify(state.backgroundVariable)}, arguments ${JSON.stringify(args)}`,
          );
          expect(
            hasGpuSwitch(args),
            `on ${process.platform}, with ${testForegroundVariableName}=${JSON.stringify(runValue ?? null)} in the run's environment, the harness must ${expected ? '' : 'not '}pass ${testBackgroundGpuSwitch} to Electron (ADR 0016); launches so far:\n${seen.join('\n')}`,
          ).toBe(expected);
        } finally {
          await app.teardown();
        }
      }
    },
  );

  // TST-018; ADR 0016 rules 1 and 3 (dev target: the command line of the running Electron main process)
  it(
    backgroundLaunchesDisableGpu
      ? `TST-018: on Linux a background harness launch of the dev build runs the Electron main process with ${testBackgroundGpuSwitch}`
      : `TST-018: on ${process.platform} a background harness launch of the dev build runs the Electron main process without ${testBackgroundGpuSwitch}`,
    { timeout: 600_000 },
    async () => {
      const harness = await loadSmokeHarness();
      const app = await harness.launchSmokeApp({ target: { kind: 'dev' }, startupTimeoutMs: devStartupTimeoutMs });
      startedApps.push(app);
      userDataDirs.add(app.userDataDir);
      try {
        const processes = listProcessesUsing(app.userDataDir);
        const mains = electronMainProcesses(processes);
        const listing = processes.map((entry) => `  ${entry.pid} ${entry.command}`).join('\n');
        expect(
          mains,
          `control: the Electron main process of the dev launch must run with the harness user data folder; processes:\n${listing}`,
        ).not.toEqual([]);
        expect(
          mains.filter((entry) => hasGpuSwitch(entry.command.split(/\s+/)) !== backgroundLaunchesDisableGpu),
          `on ${process.platform} the dev build's Electron main process must run ${backgroundLaunchesDisableGpu ? 'with' : 'without'} ${testBackgroundGpuSwitch} in background mode (ADR 0016); processes:\n${listing}`,
        ).toEqual([]);
      } finally {
        await app.teardown();
      }
    },
  );

  // TST-018; issue #46 acceptance criterion 5; ADR 0013 rule 2
  it(
    'TST-018: in background mode document.hasFocus() is true in the first window and in a window opened after the connection (CDP focus emulation)',
    slow,
    async () => {
      const build = requireFixture({ mode: 'window', title: 'Smoke fixture focus' });
      const app = await launchFixture(build);
      try {
        const first = await waitForTitledWindow(app, 'Smoke fixture focus');
        expectBackgroundLaunch(await waitForFixtureState(build, (state) => state.windows.length >= 1));
        expect(
          await withBackgroundProbeTimeout(
            'document.hasFocus() in the first window',
            first.evaluate('document.hasFocus()'),
          ),
          'the first window',
        ).toBe(true);
        const second = await app.waitForNewWindow(() => first.evaluate('location.hash = "open-second-window"'), 30_000);
        await expect.poll(() => second.title(), { timeout: 30_000 }).toBe(smokeFixtureSecondWindowTitle);
        expect(
          await withBackgroundProbeTimeout(
            'document.hasFocus() in the second window',
            second.evaluate('document.hasFocus()'),
          ),
          'the window opened after the connection',
        ).toBe(true);
      } finally {
        await app.teardown();
      }
    },
  );

  // TST-018; issue #46 acceptance criterion 3 (the smoke fixture app)
  it(
    'TST-018: in background mode the fixture page paints, Page.captureScreenshot shows the painted colour, and CDP key input reaches the focused input',
    slow,
    async () => {
      const build = requireFixture({ mode: 'window', title: 'Smoke fixture paint' });
      const app = await launchFixture(build);
      try {
        const page = await waitForTitledWindow(app, 'Smoke fixture paint');
        await page.waitForLoadState('load');
        expectBackgroundLaunch(await waitForFixtureState(build, (state) => state.windows.length >= 1));

        const paint = await withBackgroundProbeTimeout(
          'paint probe (page.evaluate)',
          page.evaluate<PaintProbeResult>(paintProbeExpression),
        );
        expect(listPaintProbeProblems(paint), 'a background window must keep painting').toEqual([]);

        const overlay = await withBackgroundProbeTimeout(
          'screenshot overlay (page.evaluate)',
          page.evaluate<ScreenshotOverlayResult>(paintScreenshotOverlayExpression),
        );
        const session = await withBackgroundProbeTimeout('CDP session', page.context().newCDPSession(page));
        try {
          const shot = await withBackgroundProbeTimeout(
            'Page.captureScreenshot',
            session.send('Page.captureScreenshot', { format: 'png' }),
          );
          expect(
            listScreenshotProbeProblems(Buffer.from(shot.data, 'base64')),
            `screenshot overlay: ${JSON.stringify(overlay)}`,
          ).toEqual([]);
        } finally {
          await session.detach().catch(() => undefined);
        }
        await withBackgroundProbeTimeout(
          'remove screenshot overlay (page.evaluate)',
          page.evaluate(removeScreenshotOverlayExpression),
        );

        const input = page.getByRole('textbox', { name: 'Smoke fixture input' });
        await input.focus({ timeout: 20_000 });
        await withBackgroundProbeTimeout('CDP key input (page.keyboard.type)', page.keyboard.type('tst018'));
        expect(
          await input.inputValue({ timeout: 20_000 }),
          `CDP key input must reach the focused input "${smokeFixtureInputName}"`,
        ).toBe('tst018');
      } finally {
        await app.teardown();
      }
    },
  );
});

describe.skipIf(!macosWindowProbeAvailable)('smoke harness: background mode on macOS (spike #43 method)', () => {
  interface MeasuredLaunch {
    readonly samples: FrontmostAppSample[];
    readonly appPids: number[];
    readonly presence: MacosAppPresence;
    readonly state: SmokeFixtureWindowState;
  }

  let measured: Promise<MeasuredLaunch> | undefined;

  /** One harness launch of the fixture, measured from just before the launch to 1.5 s after its window appeared. */
  function measureLaunch(): Promise<MeasuredLaunch> {
    measured ??= (async () => {
      const build = requireFixture({ mode: 'window', title: 'Smoke fixture macOS' });
      const sampler = startFrontmostAppSampler();
      const app = await launchFixture(build);
      try {
        await waitForTitledWindow(app, 'Smoke fixture macOS');
        await new Promise((resolve) => setTimeout(resolve, frontmostSettleMs));
        const appPids = listAppProcessIds(app.userDataDir);
        const presence = await readMacosAppPresence(app.userDataDir);
        const samples = await sampler.stop();
        const state = await waitForFixtureState(build, (current) => current.windows.length >= 1);
        return { samples, appPids, presence, state };
      } finally {
        await sampler.stop();
        await app.teardown();
      }
    })();
    return measured;
  }

  // TST-018; issue #46 acceptance criteria 2 and 7 (macOS gate: no window, accessory policy)
  it(
    'TST-018: a harness launch shows no window on screen and no Dock icon (accessory activation policy)',
    slow,
    async () => {
      const { presence, state } = await measureLaunch();
      expectBackgroundLaunch(state);
      expect(presence.pids, `control: the fixture processes must be found; ${presence.describe()}`).not.toEqual([]);
      expect(presence.onscreenWindows, `no fixture window may be on screen; ${presence.describe()}`).toEqual([]);
      expect(
        [...presence.applicationTypes.values()],
        `no fixture process may have a Dock icon (ApplicationType ${dockApplicationType}); ${presence.describe()}`,
      ).not.toContain(dockApplicationType);
    },
  );

  // TST-018; issue #46 acceptance criterion 7 (macOS gate: the frontmost app is unchanged)
  it(
    'TST-018: during a harness launch the frontmost app is never one of the fixture processes',
    slow,
    async (context) => {
      const { samples, appPids, state } = await measureLaunch();
      expectBackgroundLaunch(state);
      if (!samples.some((sample) => sample.pid !== undefined)) {
        context.skip(
          `macOS reported no frontmost app in ${samples.length} samples, so focus cannot be measured in this session`,
        );
        return;
      }
      expect(
        samplesWhereAppWasFrontmost(samples, appPids),
        `the fixture (processes ${JSON.stringify(appPids)}) took focus; ${describeFrontmostSamples(samples)}`,
      ).toEqual([]);
    },
  );
});

if (!macosWindowProbeAvailable) {
  it.todo(`TST-018: macOS window and focus checks (${macosWindowProbeSkipReason})`);
}
