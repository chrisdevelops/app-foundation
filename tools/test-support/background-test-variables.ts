// Test-only shared names for #46 (TST-018; ADR 0013 rules 1 and 2). The gate
// tests keep their own copy of the expected names (the gate contract), as for
// tools/test-support/packaged-cdp-variable.ts. Used by the reference app gates,
// the e2e harness gates, the smoke suite, the fixture app and the tools/repo gates.
//
// - FOUNDATION_TEST_BACKGROUND: read by the foundation main process. Only the
//   value `1` enables background mode: on macOS the `accessory` activation
//   policy, and every window the foundation creates (including `window.open`
//   children) is never shown and never focused. Unset, empty, `0`, `true` or
//   any other value: behaviour unchanged.
// - FOUNDATION_TEST_FOREGROUND: read by the smoke harness and the gate-test
//   launch helpers from the run's environment. Only the value `1` makes them
//   launch normally (no FOUNDATION_TEST_BACKGROUND); any other value keeps the
//   default (background). It also requests the foreground test group
//   (tools/test-support/foreground-test-group.ts).

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

/** Skip note for background-mode checks in a run that asked for normal launches. */
export const foregroundRunSkipReason = `${testForegroundVariableName}=${testForegroundEnabledValue}: this run launches apps normally, so background-mode checks do not apply (ADR 0013 rule 2)`;
