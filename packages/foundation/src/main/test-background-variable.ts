// The name and value of the background test switch (#46; TST-018; ADR 0013
// rule 1). This file is the one definition site of the variable name
// (CLAUDE.md "one name, one definition site"): the foundation main process
// (test-background-mode.ts, app-window.ts) and the smoke harness import it
// from here. It imports nothing, so code outside Electron (the harness under
// Node) can import it too.
//
// Only the value `1` enables background mode. Unset, empty, `0`, `true` or any
// other value: behaviour unchanged.

/** Environment variable the foundation main process reads to start in background mode (ADR 0013 rule 1). */
export const testBackgroundVariableName = 'FOUNDATION_TEST_BACKGROUND';

/** The one value of `testBackgroundVariableName` that enables background mode. */
export const testBackgroundEnabledValue = '1';

/** True when `env` asks for background mode: `testBackgroundVariableName` holds exactly `testBackgroundEnabledValue`. */
export function isTestBackgroundModeRequested(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[testBackgroundVariableName] === testBackgroundEnabledValue;
}
