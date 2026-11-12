// Test-only shared name for #18 (TST-009; ADR 0004 decision 2 B). Packaged
// builds refuse the Chromium DevTools port (`--remote-debugging-port`) unless
// this environment variable holds exactly `packagedCdpEnabledValue`. The app
// (foundation main process), the smoke harness launches and the CI packaged
// smoke step use this one name. Used by the reference app gates, the e2e
// harness gates and the tools/repo gates.
//
// Reading recorded on #18: the name is FOUNDATION_ALLOW_PACKAGED_CDP and only
// the value `1` enables the port; an empty value, `0`, `false` or any other
// value refuses it, so a stray or half-set variable never opens it.

/** Environment variable that lets a packaged build open the CDP port (ADR 0004 decision 2 B). */
export const packagedCdpVariableName = 'FOUNDATION_ALLOW_PACKAGED_CDP';

/** The one value of `packagedCdpVariableName` that enables the CDP port in a packaged build. */
export const packagedCdpEnabledValue = '1';
