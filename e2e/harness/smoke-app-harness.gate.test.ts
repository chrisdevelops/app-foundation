// Gate tests for #16: the smoke harness, tested from outside through its
// module boundary (`launchSmokeApp`, `resolveSmokeAppTarget`,
// `SmokeHarnessError`) and through the one command that runs the smoke suite.
// - Launch: a free port and a fresh temporary user data folder each time; a
//   Playwright browser from `chromium.connectOverCDP` (playwright-core).
// - Ownership: the connection reaches the app this launch started, never
//   another process on the port (spike #5: a busy port is silent).
// - Failure modes, each a typed error: `port-not-owned` (a dummy listener and a
//   real app on the port), `startup-timeout` (the endpoint never opens, so
//   connections are refused), a modal error dialog from a top-level require()
//   (ADR 0005), `app-exited` with the exit code, `executable-not-found`.
// - Teardown kills the whole process tree, also after the app quit by itself.
// - A window opened after connection is detected.
// - `pnpm run smoke` runs the suite against the dev build; SMOKE_APP_EXECUTABLE
//   points it at a packaged executable.
// Fixture builds are copies of the Electron distribution with the app in
// resources/app, started by path like a packaged executable.
// Requirements: TST-007, TST-009 (dev build part), TST-010 (partial), XC-004.
import { existsSync, readFileSync, readdirSync, rmSync, statSync, realpathSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  listProcessesUsing,
  listRunningProcesses,
  removeAppFolderAfterExit,
} from '../../tools/test-support/app-process-cleanup';
import { describeRepoCommand, repoGateRootDir, runRepoCommand } from '../../tools/test-support/run-repo-command';
import {
  createSmokeFixtureBuild,
  smokeFixtureSecondWindowTitle,
  type SmokeFixtureBuild,
} from '../test-support/smoke-fixture-app';
import {
  isSmokeHarnessError,
  loadSmokeHarness,
  smokeAppExecutableVariableName,
  type ExpectedSmokeApp,
  type ExpectedSmokeAppLaunchOptions,
  type ExpectedSmokeHarnessError,
  type ExpectedSmokeHarnessErrorCode,
  type ExpectedSmokeHarnessModule,
} from '../test-support/smoke-harness-contract';
import {
  smokeHarnessDeferredOnWindows,
  smokeHarnessWindowsDeferralReason,
} from '../test-support/windows-smoke-deferral';

const root = repoGateRootDir;
const slow = { timeout: 300_000 };
/** Time a fixture launch gets; fixture apps open their endpoint in about one second. */
const fixtureStartupTimeoutMs = 60_000;
/** Time the harness gets, after its startup timeout, to kill the process tree and report. */
const failureCleanupGraceMs = 45_000;

// DEFERRED: TST-010 (Windows smoke harness; ADR 0011, #39): every test in this file skips on Windows.
beforeEach((context) => {
  if (smokeHarnessDeferredOnWindows) context.skip(smokeHarnessWindowsDeferralReason);
});

// ADR 0011: the Windows work is tracked in #39.
it.todo('TST-010: the smoke harness gates pass on Windows (#39, ADR 0011)');

let fixture: SmokeFixtureBuild | undefined;
const startedApps: ExpectedSmokeApp[] = [];
const userDataDirs = new Set<string>();

function requireFixture(): SmokeFixtureBuild {
  fixture ??= createSmokeFixtureBuild();
  return fixture;
}

function fixtureTarget(): ExpectedSmokeAppLaunchOptions['target'] {
  return { kind: 'packaged', executablePath: requireFixture().executablePath };
}

type Outcome<T> =
  | { readonly settled: 'resolved'; readonly value: T; readonly elapsedMs: number }
  | { readonly settled: 'rejected'; readonly error: unknown; readonly elapsedMs: number };

/** Waits for `promise` at most `limitMs`; a harness that does not settle fails the test with a clear message (ADR 0005). */
async function settleWithin<T>(promise: Promise<T>, limitMs: number, label: string): Promise<Outcome<T>> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const hang = new Promise<'hang'>((resolve) => {
    timer = setTimeout(() => resolve('hang'), limitMs);
  });
  const result = await Promise.race([
    promise.then(
      (value) => ({ settled: 'resolved' as const, value, elapsedMs: Date.now() - started }),
      (error: unknown) => ({ settled: 'rejected' as const, error, elapsedMs: Date.now() - started }),
    ),
    hang,
  ]);
  clearTimeout(timer);
  if (result === 'hang') throw new Error(`${label} did not settle within ${limitMs} ms: the harness hangs`);
  return result;
}

/** Launches through the harness and records the app for cleanup. */
async function launch(
  harness: ExpectedSmokeHarnessModule,
  options: ExpectedSmokeAppLaunchOptions,
): Promise<ExpectedSmokeApp> {
  const outcome = await settleWithin(
    harness.launchSmokeApp(options),
    (options.startupTimeoutMs ?? fixtureStartupTimeoutMs) + failureCleanupGraceMs,
    'launchSmokeApp',
  );
  if (outcome.settled === 'rejected') {
    const error = outcome.error;
    throw new Error(
      `launchSmokeApp failed: ${error instanceof Error ? error.message : String(error)}` +
        (isSmokeHarnessError(harness, error) ? `\ncode ${error.code}\noutput:\n${error.output}` : ''),
      { cause: error },
    );
  }
  startedApps.push(outcome.value);
  userDataDirs.add(outcome.value.userDataDir);
  return outcome.value;
}

/** Launches through the harness and expects a typed error with `code`; returns the error. */
async function expectLaunchFailure(
  harness: ExpectedSmokeHarnessModule,
  options: ExpectedSmokeAppLaunchOptions,
  codes: readonly ExpectedSmokeHarnessErrorCode[],
): Promise<{ error: ExpectedSmokeHarnessError; elapsedMs: number }> {
  const limitMs = (options.startupTimeoutMs ?? fixtureStartupTimeoutMs) + failureCleanupGraceMs;
  const outcome = await settleWithin(harness.launchSmokeApp(options), limitMs, 'launchSmokeApp');
  if (outcome.settled === 'resolved') {
    startedApps.push(outcome.value);
    userDataDirs.add(outcome.value.userDataDir);
    throw new Error(
      `launchSmokeApp must fail with ${codes.join(' or ')}, but it connected (port ${outcome.value.port}, windows ${JSON.stringify(outcome.value.windows().map((page) => page.url()))})`,
    );
  }
  const error = outcome.error;
  if (!isSmokeHarnessError(harness, error)) {
    throw new Error(
      `launchSmokeApp must reject with a SmokeHarnessError (${codes.join(' or ')}), got: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
  }
  if (error.userDataDir) userDataDirs.add(error.userDataDir);
  expect(codes, `error code; message: ${error.message}\noutput:\n${error.output}`).toContain(error.code);
  return { error, elapsedMs: outcome.elapsedMs };
}

/** Processes started from the fixture copy (the app, its helpers and its grandchild) or using `userDataDir`. */
function processesLeft(userDataDir?: string): string[] {
  const fromFixture = fixture ? listProcessesUsing(fixture.dir) : [];
  const usingUserData = userDataDir ? listProcessesUsing(userDataDir) : [];
  return [...new Map([...fromFixture, ...usingUserData].map((entry) => [entry.pid, entry])).values()].map(
    (entry) => `pid ${entry.pid}: ${entry.command}`,
  );
}

function processesWithMarker(marker: string): string[] {
  return listRunningProcesses()
    .filter((entry) => entry.command.includes(marker))
    .map((entry) => `pid ${entry.pid}: ${entry.command}`);
}

function uniqueMarker(label: string): string {
  return `smoke-gate-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

/** True when `path` is inside `dir` (case-insensitive on Windows; both resolved to their long, real form). */
function isInside(dir: string, path: string): boolean {
  const fromDir = relative(realpathSync.native(dir), realpathSync.native(path));
  const fold = process.platform === 'win32' ? fromDir.toLowerCase() : fromDir;
  return fold !== '' && !/^\.\.([\\/]|$)/.test(fold) && !isAbsolute(fold);
}

async function waitForWindowTitles(app: ExpectedSmokeApp, count: number, timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let titles: string[] = [];
  while (Date.now() < deadline) {
    const windows = app.windows();
    titles = await Promise.all(windows.map((page) => page.title().catch(() => '')));
    if (windows.length >= count && titles.every((title) => title !== '' && title !== 'Smoke fixture')) return titles;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`expected ${count} window(s) with a title within ${timeoutMs} ms; saw ${JSON.stringify(titles)}`);
}

/** Last-resort cleanup so a failing harness leaves nothing running; never part of an assertion. */
function killProcessesFromFixture(): void {
  if (!fixture) return;
  for (const entry of listProcessesUsing(fixture.dir)) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(entry.pid), '/T', '/F'], { windowsHide: true });
    } else {
      try {
        process.kill(entry.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
}

afterAll(async () => {
  for (const app of startedApps) await app.teardown().catch(() => undefined);
  killProcessesFromFixture();
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

describe('smoke harness: playwright-core over CDP', () => {
  // TST-007; issue #16 acceptance criterion 2
  it('TST-007: e2e/package.json declares playwright-core pinned to an exact version, 1.65.0 or newer', () => {
    const manifestPath = join(root, 'e2e', 'package.json');
    expect(existsSync(manifestPath), 'e2e/package.json must exist').toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    const spec = manifest.dependencies?.['playwright-core'] ?? manifest.devDependencies?.['playwright-core'];
    expect(spec, 'e2e/package.json must declare playwright-core').toBeDefined();
    expect(spec, 'playwright-core must be pinned exactly (ADR 0004 decision 10)').toMatch(/^\d+\.\d+\.\d+$/);
    const [major, minor] = (spec ?? '0.0.0').split('.').map(Number) as [number, number];
    expect(major > 1 || (major === 1 && minor >= 65), `spike #5 proved playwright-core 1.65.0; found ${spec}`).toBe(
      true,
    );
  });

  // TST-007; issue #16 acceptance criterion 2: connectOverCDP, never _electron.launch
  it('TST-007: the harness sources call chromium.connectOverCDP and never use the _electron API', () => {
    const harnessDir = join(root, 'e2e', 'harness');
    const sources = existsSync(harnessDir)
      ? readdirSync(harnessDir, { recursive: true, encoding: 'utf8' })
          .filter((file) => /\.(ts|mts|cts|js|mjs|cjs)$/.test(file) && !/\.test\.[cm]?[jt]s$/.test(file))
          .filter((file) => statSync(join(harnessDir, file)).isFile())
          .map((file) => ({ file, text: readFileSync(join(harnessDir, file), 'utf8') }))
      : [];
    expect(
      sources.map((source) => source.file),
      'e2e/harness must hold the harness sources',
    ).not.toEqual([]);
    expect(
      sources.filter((source) => /\b_electron\b/.test(source.text)).map((source) => source.file),
      'the harness must not use playwright _electron',
    ).toEqual([]);
    expect(
      sources.some((source) => /\bconnectOverCDP\b/.test(source.text)),
      'the harness must connect with chromium.connectOverCDP',
    ).toBe(true);
  });

  // TST-007; issue #16 contract (output: a connected browser with its pages)
  it(
    'TST-007: a launch returns a connected Chromium browser whose window is the fixture app window',
    slow,
    async () => {
      const harness = await loadSmokeHarness();
      requireFixture().write({ mode: 'window', title: 'Smoke fixture connected' });
      const app = await launch(harness, { target: fixtureTarget(), startupTimeoutMs: fixtureStartupTimeoutMs });
      try {
        expect(app.browser.isConnected(), 'the browser must be connected').toBe(true);
        expect(app.browser.browserType().name()).toBe('chromium');
        const titles = await waitForWindowTitles(app, 1, 30_000);
        expect(titles).toEqual(['Smoke fixture connected']);
        expect(
          app.windows().every((page) => !page.url().startsWith('devtools://')),
          'DevTools pages are not windows',
        ).toBe(true);
      } finally {
        await app.teardown();
      }
    },
  );
});

describe('smoke harness: free port, fresh user data folder, ownership', () => {
  // TST-007, TST-009; issue #16 acceptance criteria 1 and 3
  it(
    'TST-009: the port the harness connected to is the DevTools port the launched app wrote in its own user data folder',
    slow,
    async () => {
      const harness = await loadSmokeHarness();
      requireFixture().write({ mode: 'window' });
      const app = await launch(harness, { target: fixtureTarget(), startupTimeoutMs: fixtureStartupTimeoutMs });
      try {
        const activePortFile = join(app.userDataDir, 'DevToolsActivePort');
        expect(existsSync(activePortFile), `${activePortFile} must exist: the app must use this user data folder`).toBe(
          true,
        );
        const [portLine, browserPath] = readFileSync(activePortFile, 'utf8').split(/\r?\n/);
        expect(app.port, 'the harness port must be the one the app opened').toBe(Number(portLine));
        const version = (await (await fetch(`http://127.0.0.1:${app.port}/json/version`)).json()) as {
          webSocketDebuggerUrl?: string;
        };
        expect(version.webSocketDebuggerUrl ?? '', 'the endpoint on the port must be this app').toMatch(
          new RegExp(`${(browserPath ?? '<missing>').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
        );
      } finally {
        await app.teardown();
      }
    },
  );

  // TST-007; issue #16 acceptance criterion 1
  it('TST-007: each launch uses a fresh temporary user data folder that the running app uses', slow, async () => {
    const harness = await loadSmokeHarness();
    requireFixture().write({ mode: 'window' });
    const first = await launch(harness, { target: fixtureTarget(), startupTimeoutMs: fixtureStartupTimeoutMs });
    const firstDir = first.userDataDir;
    try {
      expect(isInside(tmpdir(), firstDir), `${firstDir} must be inside the temporary folder ${tmpdir()}`).toBe(true);
      expect(listProcessesUsing(firstDir), `the app must run with --user-data-dir=${firstDir}`).not.toEqual([]);
    } finally {
      await first.teardown();
    }
    const second = await launch(harness, { target: fixtureTarget(), startupTimeoutMs: fixtureStartupTimeoutMs });
    try {
      expect(second.userDataDir, 'each launch must get its own user data folder').not.toBe(firstDir);
      expect(isInside(tmpdir(), second.userDataDir)).toBe(true);
      expect(listProcessesUsing(second.userDataDir)).not.toEqual([]);
    } finally {
      await second.teardown();
    }
  });

  // TST-007, TST-009; issue #16 acceptance criteria 1 and 3: two apps at once, each connection reaches its own app
  it(
    'TST-009: two launches at the same time get different ports and each browser reaches the app it started (env passed through)',
    slow,
    async () => {
      const harness = await loadSmokeHarness();
      requireFixture().write({ mode: 'window' });
      const [alpha, beta] = await Promise.all([
        launch(harness, {
          target: fixtureTarget(),
          env: { SMOKE_FIXTURE_TITLE: 'Smoke fixture alpha' },
          startupTimeoutMs: fixtureStartupTimeoutMs,
        }),
        launch(harness, {
          target: fixtureTarget(),
          env: { SMOKE_FIXTURE_TITLE: 'Smoke fixture beta' },
          startupTimeoutMs: fixtureStartupTimeoutMs,
        }),
      ]);
      try {
        expect(alpha.port).not.toBe(beta.port);
        expect(alpha.userDataDir).not.toBe(beta.userDataDir);
        expect(await waitForWindowTitles(alpha, 1, 30_000)).toEqual(['Smoke fixture alpha']);
        expect(await waitForWindowTitles(beta, 1, 30_000)).toEqual(['Smoke fixture beta']);
      } finally {
        await Promise.all([alpha.teardown(), beta.teardown()]);
      }
    },
  );

  // XC-004, TST-009; issue #16 acceptance criterion 3, tested with a dummy listener (spike #5: a busy port is silent)
  it(
    'XC-004: a dummy listener on the port gives port-not-owned before the startup timeout, and the harness never opens its WebSocket',
    slow,
    async () => {
      const harness = await loadSmokeHarness();
      requireFixture().write({ mode: 'window' });
      let webSocketUpgrades = 0;
      const requests: string[] = [];
      const dummy: Server = createServer((request, response) => {
        requests.push(request.url ?? '');
        const { port } = dummy.address() as AddressInfo;
        const browserUrl = `ws://127.0.0.1:${port}/devtools/browser/dummy-listener`;
        response.setHeader('content-type', 'application/json');
        if (request.url?.startsWith('/json/version')) {
          response.end(
            JSON.stringify({
              Browser: 'Chrome/156.0.0.0',
              'Protocol-Version': '1.3',
              webSocketDebuggerUrl: browserUrl,
            }),
          );
        } else if (request.url?.startsWith('/json')) {
          response.end('[]');
        } else {
          response.statusCode = 404;
          response.end();
        }
      });
      dummy.on('upgrade', (_request, socket) => {
        webSocketUpgrades += 1;
        socket.destroy();
      });
      await new Promise<void>((resolve) => dummy.listen(0, '127.0.0.1', resolve));
      const { port } = dummy.address() as AddressInfo;
      try {
        const { error, elapsedMs } = await expectLaunchFailure(
          harness,
          { target: fixtureTarget(), port, startupTimeoutMs: fixtureStartupTimeoutMs },
          ['port-not-owned'],
        );
        expect(elapsedMs, 'port-not-owned must not wait for the startup timeout').toBeLessThan(fixtureStartupTimeoutMs);
        expect(error.message, 'the message must name the port').toContain(String(port));
        expect(
          webSocketUpgrades,
          `the harness must not connect to a port it does not own; requests ${JSON.stringify(requests)}`,
        ).toBe(0);
        expect(processesLeft(error.userDataDir), 'no fixture process may be left running').toEqual([]);
      } finally {
        await new Promise<void>((resolve) => dummy.close(() => resolve()));
      }
    },
  );

  // XC-004, TST-009; issue #16 acceptance criterion 3; spike #5: a second app on a busy port silently reaches the first
  it(
    'XC-004: a launch on the port of another running app gives port-not-owned and leaves that app untouched',
    slow,
    async () => {
      const harness = await loadSmokeHarness();
      requireFixture().write({ mode: 'window' });
      const holder = await launch(harness, {
        target: fixtureTarget(),
        env: { SMOKE_FIXTURE_TITLE: 'Smoke fixture port holder' },
        startupTimeoutMs: fixtureStartupTimeoutMs,
      });
      try {
        await waitForWindowTitles(holder, 1, 30_000);
        const { error, elapsedMs } = await expectLaunchFailure(
          harness,
          {
            target: fixtureTarget(),
            port: holder.port,
            env: { SMOKE_FIXTURE_TITLE: 'Smoke fixture intruder' },
            startupTimeoutMs: fixtureStartupTimeoutMs,
          },
          ['port-not-owned'],
        );
        expect(elapsedMs, 'port-not-owned must not wait for the startup timeout').toBeLessThan(fixtureStartupTimeoutMs);
        expect(error.message).toContain(String(holder.port));
        if (error.userDataDir) {
          expect(listProcessesUsing(error.userDataDir), 'the failed launch must leave no process').toEqual([]);
        }
        expect(holder.browser.isConnected(), 'the app that holds the port keeps its connection').toBe(true);
        expect(await waitForWindowTitles(holder, 1, 10_000)).toEqual(['Smoke fixture port holder']);
      } finally {
        await holder.teardown();
      }
    },
  );
});

describe('smoke harness: startup failure modes', () => {
  // XC-004; issue #16 acceptance criterion 4: the endpoint never opens (connections refused)
  it(
    'XC-004: an endpoint that never opens gives startup-timeout after the set time, with stdout and stderr, and kills the process tree',
    slow,
    async () => {
      const harness = await loadSmokeHarness();
      const build = requireFixture();
      const grandchildMarker = uniqueMarker('refused-grandchild');
      build.write({ mode: 'refuse-devtools', grandchildMarker });
      const startupTimeoutMs = 10_000;
      const { error, elapsedMs } = await expectLaunchFailure(harness, { target: fixtureTarget(), startupTimeoutMs }, [
        'startup-timeout',
      ]);
      expect(elapsedMs, 'the harness must wait the set time before startup-timeout').toBeGreaterThanOrEqual(
        startupTimeoutMs - 500,
      );
      expect(error.output, 'captured stdout').toContain(build.stdoutMarker);
      expect(error.output, 'captured stderr').toContain(build.stderrMarker);
      expect(error.message, 'the report must show the captured stdout').toContain(build.stdoutMarker);
      expect(error.message, 'the report must show the captured stderr').toContain(build.stderrMarker);
      expect(processesWithMarker(grandchildMarker), 'the app child process must be killed with the tree').toEqual([]);
      expect(processesLeft(error.userDataDir), 'no process of the app may be left').toEqual([]);
    },
  );

  // XC-004; issue #16 acceptance criterion 5; ADR 0005: a top-level require() of a missing module shows a modal dialog
  it(
    'XC-004: a main process that throws on a top-level require() makes the launch fail within the timeout, never hang',
    slow,
    async () => {
      const harness = await loadSmokeHarness();
      const build = requireFixture();
      build.write({ mode: 'throw-on-require' });
      const startupTimeoutMs = 10_000;
      // macOS and Windows: a modal dialog keeps the app running (startup-timeout); without a dialog it may exit.
      const { error } = await expectLaunchFailure(harness, { target: fixtureTarget(), startupTimeoutMs }, [
        'startup-timeout',
        'app-exited',
      ]);
      expect(error.output, 'captured stdout before the throw').toContain(build.stdoutMarker);
      expect(processesLeft(error.userDataDir), 'the app with the dialog must be killed').toEqual([]);
    },
  );

  // XC-004; issue #16 acceptance criterion 6
  it(
    'XC-004: an app that exits before its endpoint opens gives app-exited with its exit code and output',
    slow,
    async () => {
      const harness = await loadSmokeHarness();
      const build = requireFixture();
      build.write({ mode: 'exit-early', exitCode: 7 });
      const { error, elapsedMs } = await expectLaunchFailure(
        harness,
        { target: fixtureTarget(), startupTimeoutMs: fixtureStartupTimeoutMs },
        ['app-exited'],
      );
      expect(error.exitCode, error.message).toBe(7);
      expect(error.message, 'the message must name the exit code').toMatch(/\b7\b/);
      expect(error.output).toContain(build.stdoutMarker);
      expect(elapsedMs, 'app-exited must not wait for the startup timeout').toBeLessThan(fixtureStartupTimeoutMs);
      expect(processesLeft(error.userDataDir)).toEqual([]);
    },
  );

  // XC-004; issue #16 contract (typed error that names the cause); the SMOKE_APP_EXECUTABLE input
  it(
    'XC-004: a packaged executable path that does not exist gives executable-not-found naming the path',
    slow,
    async () => {
      const harness = await loadSmokeHarness();
      const missing = join(
        tmpdir(),
        `smoke gate missing ${uniqueMarker('exe')}`,
        process.platform === 'win32' ? 'App.exe' : 'App',
      );
      const { error, elapsedMs } = await expectLaunchFailure(
        harness,
        { target: { kind: 'packaged', executablePath: missing }, startupTimeoutMs: fixtureStartupTimeoutMs },
        ['executable-not-found'],
      );
      expect(error.message).toContain(missing);
      expect(elapsedMs).toBeLessThan(fixtureStartupTimeoutMs);
    },
  );
});

describe('smoke harness: teardown and windows', () => {
  // TST-010; issue #16 acceptance criterion 7
  it(
    'TST-010: teardown kills the whole process tree, including a child of the main process; no process uses the user data folder',
    slow,
    async () => {
      const harness = await loadSmokeHarness();
      const grandchildMarker = uniqueMarker('teardown-grandchild');
      requireFixture().write({ mode: 'window', grandchildMarker });
      const app = await launch(harness, { target: fixtureTarget(), startupTimeoutMs: fixtureStartupTimeoutMs });
      await waitForWindowTitles(app, 1, 30_000);
      const deadline = Date.now() + 15_000;
      while (processesWithMarker(grandchildMarker).length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(processesWithMarker(grandchildMarker), 'control: the fixture child process must run').not.toEqual([]);
      const outcome = await settleWithin(app.teardown(), 60_000, 'teardown');
      expect(outcome.settled, outcome.settled === 'rejected' ? String(outcome.error) : '').toBe('resolved');
      expect(processesWithMarker(grandchildMarker), 'the child of the main process must be killed').toEqual([]);
      expect(listProcessesUsing(app.userDataDir), 'no process may use the user data folder').toEqual([]);
      expect(processesLeft(), 'no process may run from the fixture build').toEqual([]);
      const again = await settleWithin(app.teardown(), 30_000, 'second teardown');
      expect(again.settled, 'teardown must be safe to call twice').toBe('resolved');
    },
  );

  // XC-004, TST-010; spike #5: an app that quits during a test
  it('XC-004: teardown after the app quit during the test resolves and leaves no process', slow, async () => {
    const harness = await loadSmokeHarness();
    requireFixture().write({ mode: 'window' });
    const app = await launch(harness, { target: fixtureTarget(), startupTimeoutMs: fixtureStartupTimeoutMs });
    await waitForWindowTitles(app, 1, 30_000);
    const disconnected = new Promise<void>((resolve) => app.browser.once('disconnected', () => resolve()));
    const session = await app.browser.newBrowserCDPSession();
    // CDP Browser.close quits the app (spike #5); errors from the closing connection do not matter here.
    await session.send('Browser.close').catch(() => undefined);
    await settleWithin(disconnected, 30_000, 'browser disconnect after the app quit');
    const outcome = await settleWithin(app.teardown(), 60_000, 'teardown after quit');
    expect(outcome.settled, outcome.settled === 'rejected' ? String(outcome.error) : '').toBe('resolved');
    expect(listProcessesUsing(app.userDataDir)).toEqual([]);
    expect(processesLeft()).toEqual([]);
  });

  // TST-010; issue #16 acceptance criterion 8 (helper for later tear-off tests)
  it('TST-010: a window the main process opens after connection is detected and returned', slow, async () => {
    const harness = await loadSmokeHarness();
    requireFixture().write({ mode: 'window', title: 'Smoke fixture first window' });
    const app = await launch(harness, { target: fixtureTarget(), startupTimeoutMs: fixtureStartupTimeoutMs });
    try {
      await waitForWindowTitles(app, 1, 30_000);
      const first = app.windows()[0];
      if (!first) throw new Error('no first window');
      const second = await app.waitForNewWindow(
        // A string expression: the e2e TypeScript config has no DOM types.
        () => first.evaluate('location.hash = "open-second-window"'),
        30_000,
      );
      await expect.poll(() => second.title(), { timeout: 30_000 }).toBe(smokeFixtureSecondWindowTitle);
      expect(app.windows()).toHaveLength(2);
    } finally {
      await app.teardown();
    }
  });

  // XC-004; issue #16 acceptance criterion 8: the helper fails instead of hanging
  it('XC-004: waitForNewWindow rejects within its timeout when no window opens', slow, async () => {
    const harness = await loadSmokeHarness();
    requireFixture().write({ mode: 'window' });
    const app = await launch(harness, { target: fixtureTarget(), startupTimeoutMs: fixtureStartupTimeoutMs });
    try {
      await waitForWindowTitles(app, 1, 30_000);
      const outcome = await settleWithin(
        app.waitForNewWindow(() => Promise.resolve(), 3_000),
        3_000 + 15_000,
        'waitForNewWindow',
      );
      expect(outcome.settled).toBe('rejected');
    } finally {
      await app.teardown();
    }
  });
});

describe('smoke harness: targets and the smoke command', () => {
  // TST-010; issue #16 acceptance criterion 10
  it(`TST-010: resolveSmokeAppTarget gives the dev build without ${smokeAppExecutableVariableName}`, async () => {
    const harness = await loadSmokeHarness();
    expect(harness.resolveSmokeAppTarget({})).toEqual({ kind: 'dev' });
  });

  // TST-010; issue #16 acceptance criterion 10
  it(`TST-010: ${smokeAppExecutableVariableName} makes resolveSmokeAppTarget give that packaged executable`, async () => {
    const harness = await loadSmokeHarness();
    const executablePath = requireFixture().executablePath;
    expect(harness.resolveSmokeAppTarget({ [smokeAppExecutableVariableName]: executablePath })).toEqual({
      kind: 'packaged',
      executablePath,
    });
  });

  // TST-009 (dev build part), TST-010; issue #16 acceptance criterion 7 for the dev command tree (pnpm, Forge, Vite, Electron)
  it(
    'TST-009: the dev build target opens the reference app window over CDP, and teardown leaves no process of the dev command',
    { timeout: 600_000 },
    async () => {
      const harness = await loadSmokeHarness();
      const app = await launch(harness, { target: { kind: 'dev' }, startupTimeoutMs: 180_000 });
      try {
        expect(await waitForWindowTitles(app, 1, 120_000)).toContain('Reference');
        expect(
          listProcessesUsing(app.userDataDir),
          'the dev app must run with the harness user data folder',
        ).not.toEqual([]);
      } finally {
        const outcome = await settleWithin(app.teardown(), 120_000, 'dev teardown');
        expect(outcome.settled, outcome.settled === 'rejected' ? String(outcome.error) : '').toBe('resolved');
      }
      expect(listProcessesUsing(app.userDataDir), 'pnpm, Forge and Electron must all be stopped').toEqual([]);
    },
  );

  // TST-010; issue #16 acceptance criterion 10: one command runs the smoke suite against the dev build
  it(
    'TST-010: pnpm run smoke at the repository root runs the smoke suite against the dev build and passes',
    { timeout: 900_000 },
    () => {
      const result = runRepoCommand('pnpm', ['run', 'smoke'], { cwd: root, timeoutMs: 840_000 });
      expect(result.exitCode, describeRepoCommand(result)).toBe(0);
      expect(result.output, `the smoke suite must run the first smoke test:\n${describeRepoCommand(result)}`).toContain(
        'main-window.smoke.test.ts',
      );
      expect(result.output).not.toMatch(/no test files found/i);
    },
  );

  // TST-010; issue #16 acceptance criterion 10: one variable points the suite at a packaged executable
  it(
    `TST-010: pnpm run smoke with ${smokeAppExecutableVariableName} launches that executable (a fixture that is not the reference app fails the suite)`,
    { timeout: 900_000 },
    () => {
      const build = requireFixture();
      build.write({ mode: 'window', title: 'Not the reference app' });
      rmSync(build.launchedFile, { force: true });
      const result = runRepoCommand('pnpm', ['run', 'smoke'], {
        cwd: root,
        timeoutMs: 840_000,
        env: { [smokeAppExecutableVariableName]: build.executablePath },
      });
      expect(
        existsSync(build.launchedFile),
        `the smoke suite must start ${build.executablePath}:\n${describeRepoCommand(result)}`,
      ).toBe(true);
      expect(
        result.exitCode,
        `the fixture is not the reference app, so the smoke test must fail:\n${describeRepoCommand(result)}`,
      ).not.toBe(0);
      expect(processesLeft(), 'the smoke suite must tear the app down').toEqual([]);
    },
  );

  // XC-004; issue #16 acceptance criterion 10, failure mode
  it(
    `XC-004: pnpm run smoke with ${smokeAppExecutableVariableName} set to a missing file fails with executable-not-found and the path`,
    { timeout: 600_000 },
    () => {
      const missing = join(
        tmpdir(),
        uniqueMarker('missing-executable'),
        process.platform === 'win32' ? 'App.exe' : 'App',
      );
      const result = runRepoCommand('pnpm', ['run', 'smoke'], {
        cwd: root,
        timeoutMs: 540_000,
        env: { [smokeAppExecutableVariableName]: missing },
      });
      expect(result.exitCode, describeRepoCommand(result)).not.toBe(0);
      expect(result.output, describeRepoCommand(result)).toContain('executable-not-found');
      expect(result.output, describeRepoCommand(result)).toContain(missing);
    },
  );
});
