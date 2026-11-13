// Test-only shared names for #46 (TST-018; ADR 0013 rules 1 and 2). The gate
// tests keep their own copy of the expected names (the gate contract), as for
// tools/test-support/packaged-cdp-variable.ts. Used by the reference app gates,
// the e2e harness gates, the smoke suite, the fixture app and the tools/repo gates.
//
// - FOUNDATION_TEST_BACKGROUND: read by the foundation main process. Only the
//   value `1` enables background mode: on macOS the `accessory` activation
//   policy, and every window the foundation creates (including `window.open`
//   children) is never shown; on Linux and Windows every such window is shown
//   without focus (ADR 0013 amendment 1); no window is ever focused on any
//   platform. Unset, empty, `0`, `true` or
//   any other value: behaviour unchanged.
// - FOUNDATION_TEST_FOREGROUND: read by the smoke harness and the gate-test
//   launch helpers from the run's environment. Only the value `1` makes them
//   launch normally (no FOUNDATION_TEST_BACKGROUND); any other value keeps the
//   default (background). It also requests the foreground test group
//   (tools/test-support/foreground-test-group.ts).
// - `--disable-gpu` (ADR 0016): on Linux, every launch in background mode by
//   the smoke harness and by the gate-test launch helpers passes it to
//   Electron; foreground launches, macOS and Windows do not.

/** Environment variable the foundation main process reads to start in background mode (ADR 0013 rule 1). */
export const testBackgroundVariableName = 'FOUNDATION_TEST_BACKGROUND';

/** The one value of `testBackgroundVariableName` that enables background mode. */
export const testBackgroundEnabledValue = '1';

/** Run-level opt-out: with this variable set to `testForegroundEnabledValue`, test launches are normal (ADR 0013 rule 2). */
export const testForegroundVariableName = 'FOUNDATION_TEST_FOREGROUND';

/** The one value of `testForegroundVariableName` that makes test launches normal. */
export const testForegroundEnabledValue = '1';

/** True when this run asked for normal (foreground) launches. */
export function isForegroundTestRun(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[testForegroundVariableName] === testForegroundEnabledValue;
}

/**
 * Chromium switch every Linux launch in background mode gets (ADR 0016): on the GPU-less Ubuntu runners the
 * GPU process can fail again and again at startup, and no frame is drawn until Chromium falls back to software
 * compositing (4.5 to 13.4 s). Foreground launches, macOS and Windows do not get it.
 */
export const testBackgroundGpuSwitch = '--disable-gpu';

/**
 * Switches a gate-test launch adds for its launch mode (ADR 0016): `testBackgroundGpuSwitch` on Linux when the
 * app's environment `appEnv` puts it in background mode (`testBackgroundVariableName` set to
 * `testBackgroundEnabledValue`); none otherwise.
 */
export function testBackgroundLaunchSwitches(
  appEnv: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const background = appEnv[testBackgroundVariableName] === testBackgroundEnabledValue;
  return platform === 'linux' && background ? [testBackgroundGpuSwitch] : [];
}

/** Skip note for background-mode checks in a run that asked for normal launches. */
export const foregroundRunSkipReason = `${testForegroundVariableName}=${testForegroundEnabledValue}: this run launches apps normally, so background-mode checks do not apply (ADR 0013 rule 2)`;
