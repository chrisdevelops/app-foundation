// Test-only contract for the smoke harness gate tests (#16; TST-007, TST-009,
// TST-010, XC-004). It states the shape the gate tests expect from the
// harness module `e2e/harness/smoke-app-harness.ts` (developer) and loads that
// module at run time, so each gate test fails with a clear message while the
// harness does not exist yet, instead of one import error for the whole file.
//
// Contract (issue #16, "Contract"):
// - Input: a target (the dev build, or the path of a packaged executable) and
//   environment.
// - Output: a Playwright browser connected over CDP with the app's windows and
//   a teardown function, or a `SmokeHarnessError` whose `code` names the cause.
import type { Browser, Page } from 'playwright-core';

/** Name of the one environment variable that points the smoke suite at a packaged executable. */
export const smokeAppExecutableVariableName = 'SMOKE_APP_EXECUTABLE';

/** Path of the harness module, relative to the repository root. */
export const smokeHarnessModulePath = 'e2e/harness/smoke-app-harness.ts';

export type ExpectedSmokeAppTarget =
  { readonly kind: 'dev' } | { readonly kind: 'packaged'; readonly executablePath: string };

export interface ExpectedSmokeAppLaunchOptions {
  readonly target: ExpectedSmokeAppTarget;
  /** Variables added to the app's environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Time the DevTools endpoint has to become ready; then the launch fails with `startup-timeout`. */
  readonly startupTimeoutMs?: number;
  /** DevTools port to use. Default: a free port the harness picks. The gate tests set it only to provoke `port-not-owned`. */
  readonly port?: number;
}

export interface ExpectedSmokeApp {
  /** Playwright browser from `chromium.connectOverCDP` (playwright-core). */
  readonly browser: Browser;
  /** The DevTools port the harness connected to. */
  readonly port: number;
  /** The fresh temporary user data folder of this launch. */
  readonly userDataDir: string;
  /** Combined stdout and stderr of the app so far. */
  output(): string;
  /** The app's windows (page targets; DevTools front ends excluded). */
  windows(): Page[];
  /** Runs `action` and resolves with the window it opens; rejects when no window opens within `timeoutMs`. */
  waitForNewWindow(action: () => Promise<unknown>, timeoutMs?: number): Promise<Page>;
  /** Kills the whole process tree; resolves when no process uses the user data folder. Safe to call twice. */
  teardown(): Promise<void>;
}

export type ExpectedSmokeHarnessErrorCode =
  'port-not-owned' | 'startup-timeout' | 'app-exited' | 'executable-not-found';

export interface ExpectedSmokeHarnessError extends Error {
  readonly code: ExpectedSmokeHarnessErrorCode;
  /** Exit code of the app for `app-exited`; otherwise null or undefined. */
  readonly exitCode?: number | null;
  /** Captured stdout and stderr of the app (empty when nothing started). */
  readonly output: string;
  /** User data folder of the failed launch, or undefined when the harness started no app. */
  readonly userDataDir?: string;
}

export interface ExpectedSmokeHarnessModule {
  launchSmokeApp(options: ExpectedSmokeAppLaunchOptions): Promise<ExpectedSmokeApp>;
  resolveSmokeAppTarget(env: Readonly<Record<string, string | undefined>>): ExpectedSmokeAppTarget;
  SmokeHarnessError: abstract new (...args: never[]) => ExpectedSmokeHarnessError;
}

const expectedExports = ['launchSmokeApp', 'resolveSmokeAppTarget', 'SmokeHarnessError'] as const;

/** Loads the harness module; throws a clear message when it or one of its exports is missing. */
export async function loadSmokeHarness(): Promise<ExpectedSmokeHarnessModule> {
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import('../harness/smoke-app-harness')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `the smoke harness module ${smokeHarnessModulePath} could not be loaded (issue #16): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const missing = expectedExports.filter((name) => typeof loaded[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(`${smokeHarnessModulePath} must export ${missing.join(', ')} (issue #16 contract)`);
  }
  return loaded as unknown as ExpectedSmokeHarnessModule;
}

/** True when `error` is the harness's typed error. */
export function isSmokeHarnessError(
  harness: ExpectedSmokeHarnessModule,
  error: unknown,
): error is ExpectedSmokeHarnessError {
  return error instanceof harness.SmokeHarnessError;
}
