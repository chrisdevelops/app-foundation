// The foundation's background test mode (#46; TST-018; ADR 0013 rules 1 and 4).
// Automated test runs start the app with FOUNDATION_TEST_BACKGROUND=1, so a
// person can keep using the machine while tests run.
//
// Input: the main process environment (test-background-variable.ts).
// Output, when the variable holds exactly `1`:
// - macOS: the `accessory` activation policy, set before `ready`, so the app
//   gets no Dock icon and never activates (spike #43).
// - Every platform: every window the foundation creates, and every
//   `window.open` child, is created hidden and never shown or focused
//   (app-window.ts reads `isTestBackgroundModeEnabled()`).
// Without the variable (or with any other value) nothing changes.
// The switch does not touch fuses, CSP, the `app://` loader or the CDP guard,
// and it exposes no code or data.
import { app } from 'electron';
import { isTestBackgroundModeRequested } from './test-background-variable';

/** True when this main process runs in background test mode. Reads the environment on every call. */
export function isTestBackgroundModeEnabled(): boolean {
  return isTestBackgroundModeRequested(process.env);
}

/**
 * Applies background test mode to the app when the environment asks for it (see the file header).
 * Call it once at the top of the main process, before `ready`, right after `enforcePackagedCdpGuard()`.
 */
export function applyTestBackgroundMode(): void {
  if (!isTestBackgroundModeEnabled()) return;
  if (process.platform === 'darwin') app.setActivationPolicy('accessory');
}
