// Test-only switch for ADR 0011 (#16): the smoke harness gates
// (e2e/harness/*.gate.test.ts) and the smoke suite (e2e/smoke/) skip on
// Windows for phase 1. Every other Windows check stays required.
// DEFERRED: TST-010 (smoke harness and smoke suite on Windows; #39, ADR 0011)

/** True on Windows, where the smoke harness gates and smoke tests are deferred (ADR 0011). */
export const smokeHarnessDeferredOnWindows = process.platform === 'win32';

/** Skip note shown for each skipped test on Windows. */
export const smokeHarnessWindowsDeferralReason =
  'skipped on Windows: ADR 0011 defers the Windows smoke harness to #39 (DEFERRED: TST-010)';
