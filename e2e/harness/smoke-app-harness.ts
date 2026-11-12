// Smoke harness (#16; TST-007, TST-009 dev build part, TST-010 partial, XC-004).
// Starts the reference app (the dev command, or a packaged executable by path)
// with the DevTools port open, checks that the endpoint belongs to the app it
// started, and connects Playwright with `chromium.connectOverCDP` from
// playwright-core (spike #5; Playwright's Electron launcher is not used).
//
// Input: a target and environment. Output: a connected browser with the app's
// windows and a teardown function, or a `SmokeHarnessError` whose code names
// the cause: `port-not-owned`, `startup-timeout`, `app-exited`,
// `executable-not-found`.
//
// - Each launch gets a free port (unless the caller sets one) and a fresh
//   temporary user data folder.
// - Ownership: a busy port is silent in Chromium (spike #5), so a port that
//   is in use before the launch fails at once and starts nothing. The harness
//   connects only when the endpoint on the port names the browser that the app
//   wrote in DevToolsActivePort in its own user data folder.
// - Every wait is bounded. A main script that throws while it loads (ADR 0005)
//   shows a modal dialog on macOS and Windows and the endpoint never opens; on
//   Linux the app keeps running and opens the endpoint with no window. Both
//   fail with `startup-timeout` and the app is killed; on Linux the harness
//   reads Electron's error line instead of waiting for the timeout.
// - Any failure after the app started stops it before the error is thrown.
// - Teardown first signals the process group (POSIX) or kills the tree of the
//   started process (Windows). Then it kills every process it finds by
//   `--user-data-dir` (quoted or not) or by ancestry; on Windows a child counts
//   only when it was created after its parent, because Windows reuses pids.
//   It waits until none is left, fails with their pids otherwise, and is safe
//   to call twice.
// - Failure evidence (#17, ADR 0012): when SMOKE_EVIDENCE_DIR names a folder,
//   a failed launch writes the app's stdout and stderr and the harness events
//   (with the error code) there before it throws, and `writeEvidence(label)`
//   writes the same plus a PNG screenshot of each window. The variable is read
//   when writing; evidence never holds environment variable values
//   (smoke-evidence-folder.ts).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { readSmokeEvidenceDir, writeSmokeEvidence, type SmokeEvidenceScreenshot } from './smoke-evidence-folder';

/** What the harness starts: the reference app's dev command, or a packaged executable by path. */
export type SmokeAppTarget = { readonly kind: 'dev' } | { readonly kind: 'packaged'; readonly executablePath: string };

export interface SmokeAppLaunchOptions {
  readonly target: SmokeAppTarget;
  /** Variables added to the app's environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Time the DevTools endpoint has to become ready; then the launch fails with `startup-timeout`. */
  readonly startupTimeoutMs?: number;
  /** DevTools port to use. Default: a free port the harness picks. */
  readonly port?: number;
}

export interface SmokeApp {
  /** Playwright browser from `chromium.connectOverCDP`. */
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
  /**
   * Writes failure evidence into the folder named by SMOKE_EVIDENCE_DIR: the app's stdout and stderr so far,
   * the harness events, a PNG screenshot of each open window, and `label`. Never writes environment variable
   * values. Does nothing when the variable is not set. A screenshot that fails is recorded as an event.
   */
  writeEvidence(label: string): Promise<void>;
  /** Kills the whole process tree; resolves when no process uses the user data folder. Safe to call twice. */
  teardown(): Promise<void>;
}

export type SmokeHarnessErrorCode = 'port-not-owned' | 'startup-timeout' | 'app-exited' | 'executable-not-found';

/** The harness's typed error. The message starts with the code and ends with the captured app output. */
export class SmokeHarnessError extends Error {
  override readonly name = 'SmokeHarnessError';
  readonly code: SmokeHarnessErrorCode;
  /** Exit code of the app for `app-exited`; otherwise null. */
  readonly exitCode: number | null;
  /** Captured stdout and stderr of the app (empty when nothing started). */
  readonly output: string;
  /** User data folder of the failed launch, or undefined when the harness started no app. */
  readonly userDataDir: string | undefined;

  constructor(details: {
    code: SmokeHarnessErrorCode;
    summary: string;
    output?: string;
    exitCode?: number | null;
    userDataDir?: string;
    cause?: unknown;
  }) {
    const output = details.output ?? '';
    super(
      `${details.code}: ${details.summary}` +
        (output.trim() === '' ? '' : `\n--- app stdout and stderr ---\n${clipOutput(output)}`),
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.code = details.code;
    this.exitCode = details.exitCode ?? null;
    this.output = output;
    this.userDataDir = details.userDataDir;
  }
}

/** Environment variable that points the smoke suite at a packaged executable instead of the dev build. */
const smokeAppExecutableVariableName = 'SMOKE_APP_EXECUTABLE';

/** Startup time for a launch that sets none: the dev command builds main and preload before Electron starts. */
const defaultStartupTimeoutMs = 120_000;
/** Time Electron gets to quit after SIGTERM before the process group is killed. */
const gracefulStopMs = 5_000;
/** Time every process that uses the user data folder gets to exit after the tree is killed. */
const processExitWaitMs = 30_000;
const pollIntervalMs = 150;
const defaultNewWindowTimeoutMs = 30_000;
/** Time one window screenshot gets before it is recorded as failed. */
const screenshotTimeoutMs = 15_000;

const repoRootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const referenceAppDir = join(repoRootDir, 'apps', 'reference');

/**
 * The target the smoke suite runs against: the packaged executable named by
 * SMOKE_APP_EXECUTABLE, or the dev build when the variable is not set. A
 * relative path is read from the folder pnpm was started in.
 */
export function resolveSmokeAppTarget(env: Readonly<Record<string, string | undefined>>): SmokeAppTarget {
  const executable = env[smokeAppExecutableVariableName];
  if (executable === undefined || executable.trim() === '') return { kind: 'dev' };
  const executablePath = isAbsolute(executable) ? executable : resolve(env.INIT_CWD ?? process.cwd(), executable);
  return { kind: 'packaged', executablePath };
}

/** Timestamped harness event lines of one launch, written into the failure evidence. */
interface HarnessEventLog {
  record(event: string): void;
  lines(): string[];
}

function createHarnessEventLog(): HarnessEventLog {
  const lines: string[] = [];
  return {
    record: (event) => lines.push(`${new Date().toISOString()} ${event}`),
    lines: () => [...lines],
  };
}

/**
 * Starts the target, checks that the DevTools endpoint is its own, and connects Playwright over CDP.
 * A failed launch writes its evidence (when SMOKE_EVIDENCE_DIR is set) before it throws.
 */
export async function launchSmokeApp(options: SmokeAppLaunchOptions): Promise<SmokeApp> {
  const events = createHarnessEventLog();
  const target = options.target.kind === 'dev' ? 'dev build' : `packaged executable ${options.target.executablePath}`;
  events.record(`launch requested: ${target}`);
  try {
    return await startSmokeApp(options, events);
  } catch (error) {
    const code = error instanceof SmokeHarnessError ? error.code : 'unexpected-error';
    const summary = errorText(error).split('\n--- app stdout and stderr ---')[0] ?? '';
    events.record(`launch failed with code ${code}: ${summary}`);
    try {
      writeSmokeEvidence({
        label: `launch failed: ${code}`,
        appOutput: error instanceof SmokeHarnessError ? error.output : '',
        events: events.lines(),
        appEnv: options.env,
      });
    } catch (evidenceError) {
      // The launch error stays the one that is thrown; the evidence problem is reported beside it.
      console.error(`the smoke harness could not write failure evidence: ${errorText(evidenceError)}`);
    }
    throw error;
  }
}

async function startSmokeApp(options: SmokeAppLaunchOptions, events: HarnessEventLog): Promise<SmokeApp> {
  const startupTimeoutMs = options.startupTimeoutMs ?? defaultStartupTimeoutMs;
  const deadline = Date.now() + startupTimeoutMs;

  if (options.target.kind === 'packaged') {
    const { executablePath } = options.target;
    if (!existsSync(executablePath) || !statSync(executablePath).isFile()) {
      throw new SmokeHarnessError({
        code: 'executable-not-found',
        summary: `the packaged executable ${executablePath} does not exist or is not a file (${smokeAppExecutableVariableName} or the launch target names it)`,
      });
    }
  }

  let port: number;
  // Port 0 means "any free port", as in Chromium's own switch.
  if (options.port === undefined || options.port === 0) {
    port = await pickFreePort();
  } else {
    port = options.port;
    if (await isPortInUse(port)) {
      throw new SmokeHarnessError({
        code: 'port-not-owned',
        summary: `port ${port} is already in use by another process, so the endpoint there would not belong to this launch; the harness started nothing`,
      });
    }
  }

  const userDataDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'smoke-user-data-')));
  events.record(`DevTools port ${port}; user data folder ${userDataDir}`);
  let processTree: ProcessTree;
  try {
    processTree = startProcessTree(options, port, userDataDir);
  } catch (error) {
    rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  }
  events.record(`started: ${processTree.commandLine}`);

  const fail = async (
    code: SmokeHarnessErrorCode,
    summary: string,
    extra: { exitCode?: number | null; cause?: unknown } = {},
  ): Promise<never> => {
    events.record(`stopping the app after ${code}`);
    let stopProblem = '';
    try {
      await processTree.stop();
      events.record('the app stopped');
    } catch (error) {
      stopProblem = `\nthe harness could not stop every process: ${errorText(error)}`;
      events.record(`the app did not stop: ${errorText(error)}`);
    }
    throw new SmokeHarnessError({
      code,
      summary: `${summary}${stopProblem}\n(command: ${processTree.commandLine})`,
      output: processTree.output(),
      exitCode: extra.exitCode,
      userDataDir,
      cause: extra.cause,
    });
  };

  let browser: Browser;
  try {
    const endpoint = await waitForOwnedEndpoint(processTree, port, userDataDir, deadline);
    if (endpoint.kind === 'failed') {
      return await fail(endpoint.code, endpoint.summary, { exitCode: endpoint.exitCode, cause: endpoint.cause });
    }
    events.record(`endpoint owned by the launched app: ${endpoint.webSocketUrl}`);
    try {
      browser = await chromium.connectOverCDP(endpoint.webSocketUrl, {
        timeout: Math.max(deadline - Date.now(), 5_000),
      });
    } catch (error) {
      return await fail(
        'startup-timeout',
        `could not connect over CDP to ${endpoint.webSocketUrl}: ${errorText(error)}`,
        { cause: error },
      );
    }
    // Electron prints the main-process error before it opens the endpoint; check once more in
    // case the output arrived while the harness connected.
    if (mainProcessStartupErrorPattern.test(processTree.output())) {
      await withTimeout(browser.close(), 5_000).catch(() => undefined);
      return await fail('startup-timeout', mainProcessStartupErrorSummary);
    }
  } catch (error) {
    if (error instanceof SmokeHarnessError) throw error;
    // Any other failure after the spawn: never leave the app running.
    return fail('startup-timeout', `the launch failed unexpectedly: ${errorText(error)}`, { cause: error });
  }
  events.record('connected over CDP');

  const windows = (): Page[] =>
    browser
      .contexts()
      .flatMap((context) => context.pages())
      .filter((page) => !page.url().startsWith('devtools://'));

  let teardownPromise: Promise<void> | undefined;

  return {
    browser,
    port,
    userDataDir,
    output: () => processTree.output(),
    windows,
    waitForNewWindow: (action, timeoutMs = defaultNewWindowTimeoutMs) => waitForNewWindow(windows, action, timeoutMs),
    async writeEvidence(label: string): Promise<void> {
      if (readSmokeEvidenceDir() === undefined) return;
      events.record(`evidence requested: ${label}`);
      const pages = windows();
      events.record(`open windows: ${pages.length}`);
      const screenshots: SmokeEvidenceScreenshot[] = [];
      for (const [index, page] of pages.entries()) {
        const fileName = `window-${index + 1}.png`;
        try {
          const png = await withTimeout(
            page.screenshot({ type: 'png', timeout: screenshotTimeoutMs }),
            screenshotTimeoutMs + 5_000,
          );
          if (png === undefined) {
            events.record(`screenshot ${fileName} timed out`);
            continue;
          }
          screenshots.push({ fileName, png });
          events.record(`screenshot ${fileName} of ${page.url()}`);
        } catch (error) {
          events.record(`screenshot ${fileName} failed: ${errorText(error)}`);
        }
      }
      writeSmokeEvidence({
        label,
        appOutput: processTree.output(),
        events: events.lines(),
        screenshots,
        appEnv: options.env,
      });
    },
    teardown(): Promise<void> {
      teardownPromise ??= (async () => {
        // For a CDP connection, close() only disconnects; the app keeps running (spike #5).
        await withTimeout(browser.close(), 5_000).catch(() => undefined);
        await processTree.stop();
      })();
      return teardownPromise;
    },
  };
}

type EndpointResult =
  | { readonly kind: 'owned'; readonly webSocketUrl: string }
  | {
      readonly kind: 'failed';
      readonly code: SmokeHarnessErrorCode;
      readonly summary: string;
      readonly exitCode?: number | null;
      readonly cause?: unknown;
    };

/**
 * Chromium's log line when the DevTools server cannot bind its port (spike #5).
 * Its general `bind() failed` line is not used: other Chromium sockets print it too.
 */
const devToolsBindFailurePattern = /Cannot start http server for devtools/i;

/**
 * Electron's output when the main script throws while it loads (ADR 0005). On
 * macOS and Windows a modal dialog then blocks the app before the endpoint
 * opens. On Linux the app keeps running and still opens the endpoint, with no
 * window; without this check the harness would report it ready.
 */
const mainProcessStartupErrorPattern = /A JavaScript error occurred in the main process|App threw an error during load/;
const mainProcessStartupErrorSummary =
  'the main process threw while it loaded (Electron printed "A JavaScript error occurred in the main process"), so the app can never become ready';

async function waitForOwnedEndpoint(
  processTree: ProcessTree,
  port: number,
  userDataDir: string,
  deadline: number,
): Promise<EndpointResult> {
  const activePortFile = join(userDataDir, 'DevToolsActivePort');
  let lastProblem = 'DevToolsActivePort was not written';
  for (;;) {
    const spawnError = processTree.spawnError();
    if (spawnError) {
      const notFound = (spawnError as NodeJS.ErrnoException).code === 'ENOENT';
      return {
        kind: 'failed',
        code: notFound ? 'executable-not-found' : 'app-exited',
        summary: `could not start ${processTree.command}: ${spawnError.message}`,
        cause: spawnError,
      };
    }
    const exit = processTree.exit();
    if (exit) {
      await processTree.outputClosed(2_000);
      return {
        kind: 'failed',
        code: 'app-exited',
        summary: `the app exited with code ${exit.code ?? 'none'}${exit.signal ? ` (signal ${exit.signal})` : ''} before its DevTools endpoint on port ${port} was ready`,
        exitCode: exit.code,
      };
    }
    if (mainProcessStartupErrorPattern.test(processTree.output())) {
      return { kind: 'failed', code: 'startup-timeout', summary: mainProcessStartupErrorSummary };
    }
    if (devToolsBindFailurePattern.test(processTree.output())) {
      return {
        kind: 'failed',
        code: 'port-not-owned',
        summary: `the app could not open its DevTools endpoint on port ${port}: another process holds the port`,
      };
    }
    const written = readActivePortFile(activePortFile);
    if (written) {
      if (written.port !== port) {
        return {
          kind: 'failed',
          code: 'port-not-owned',
          summary: `the app wrote DevTools port ${written.port} in ${activePortFile}, not the requested port ${port}`,
        };
      }
      const answered = await readEndpointBrowserUrl(port);
      if (answered.kind === 'answered') {
        if (webSocketPath(answered.webSocketUrl) !== written.browserPath) {
          return {
            kind: 'failed',
            code: 'port-not-owned',
            summary: `the endpoint on port ${port} is ${answered.webSocketUrl}, but the launched app wrote ${written.browserPath}: another process holds the port`,
          };
        }
        return { kind: 'owned', webSocketUrl: answered.webSocketUrl };
      }
      lastProblem = answered.problem;
    }
    if (Date.now() >= deadline) {
      return {
        kind: 'failed',
        code: 'startup-timeout',
        summary: `the DevTools endpoint on port ${port} was not ready within the startup time (${lastProblem}). A modal error dialog in the main process (ADR 0005) looks like this`,
      };
    }
    await delay(Math.min(pollIntervalMs, Math.max(deadline - Date.now(), 0)));
  }
}

function readActivePortFile(path: string): { port: number; browserPath: string } | undefined {
  if (!existsSync(path)) return undefined;
  const [portLine, browserPath] = readFileSync(path, 'utf8').split(/\r?\n/);
  const port = Number(portLine);
  // Chromium writes the file in one step; an incomplete read is retried on the next poll.
  if (!Number.isInteger(port) || port <= 0 || !browserPath) return undefined;
  return { port, browserPath };
}

async function readEndpointBrowserUrl(
  port: number,
): Promise<{ kind: 'answered'; webSocketUrl: string } | { kind: 'no-answer'; problem: string }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return { kind: 'no-answer', problem: `/json/version answered HTTP ${response.status}` };
    const body = (await response.json()) as { webSocketDebuggerUrl?: unknown };
    if (typeof body.webSocketDebuggerUrl !== 'string') {
      return { kind: 'no-answer', problem: '/json/version gave no webSocketDebuggerUrl' };
    }
    return { kind: 'answered', webSocketUrl: body.webSocketDebuggerUrl };
  } catch (error) {
    return { kind: 'no-answer', problem: `/json/version: ${errorText(error)}` };
  }
}

function webSocketPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

async function waitForNewWindow(
  windows: () => Page[],
  action: () => Promise<unknown>,
  timeoutMs: number,
): Promise<Page> {
  const before = new Set(windows());
  let actionError: { error: unknown } | undefined;
  Promise.resolve()
    .then(action)
    .catch((error: unknown) => {
      actionError = { error };
    });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (actionError) {
      throw new Error(`the action that should open a window failed: ${errorText(actionError.error)}`, {
        cause: actionError.error,
      });
    }
    const opened = windows().find((page) => !before.has(page));
    if (opened) return opened;
    if (Date.now() >= deadline) {
      throw new Error(`no new window opened within ${timeoutMs} ms (windows: ${before.size} before and after)`);
    }
    await delay(Math.min(pollIntervalMs, Math.max(deadline - Date.now(), 0)));
  }
}

// ---------------------------------------------------------------------------
// Ports

/** A port the operating system reports as free on 127.0.0.1 at this moment. */
function pickFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolvePort(port) : reject(new Error('the OS gave no free port'))));
    });
  });
}

/** True when a process listens on the port, or the port cannot be bound on 127.0.0.1. Never sends HTTP. */
async function isPortInUse(port: number): Promise<boolean> {
  const accepts = await new Promise<boolean>((resolveAccepts) => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (value: boolean): void => {
      socket.destroy();
      resolveAccepts(value);
    };
    socket.setTimeout(2_000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
  if (accepts) return true;
  return new Promise<boolean>((resolveBindable) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolveBindable(true));
    server.listen(port, '127.0.0.1', () => server.close(() => resolveBindable(false)));
  });
}

// ---------------------------------------------------------------------------
// Processes

interface ProcessTree {
  readonly command: string;
  readonly commandLine: string;
  output(): string;
  spawnError(): Error | undefined;
  exit(): { code: number | null; signal: NodeJS.Signals | null } | undefined;
  /** Resolves when stdout and stderr are closed, or after `timeoutMs`. */
  outputClosed(timeoutMs: number): Promise<void>;
  /** Kills the whole tree and waits until no process uses the user data folder; then removes the folder. */
  stop(): Promise<void>;
}

// Variables an outer pnpm, Turborepo or Vitest process sets; the app must not inherit them.
const inheritedVariablePrefixes = ['npm_', 'TURBO_', 'VITEST', 'PNPM_SCRIPT'];
const inheritedVariableNames = new Set(['NODE_ENV', 'TEST', 'INIT_CWD', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']);

function buildAppEnv(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (inheritedVariableNames.has(key)) continue;
    if (inheritedVariablePrefixes.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }
  return { ...env, FORCE_COLOR: '0', NO_COLOR: '1', ...extra };
}

/** Chromium switches of every launch: the DevTools port and the fresh user data folder. */
function devToolsSwitches(port: number, userDataDir: string): string[] {
  // DEFERRED: TST-009 (packaged builds refuse --remote-debugging-port unless a test build enables it; #18)
  const switches = [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`];
  // macOS: keep Chromium away from the login keychain, which can prompt.
  if (process.platform === 'darwin') switches.push('--use-mock-keychain');
  return switches;
}

/** Quotes one argument for cmd.exe; throws on characters cmd.exe expands even inside quotes. */
function quoteForWindowsShell(arg: string): string {
  if (/[%!"\r\n]/.test(arg)) throw new Error(`argument cannot be passed through cmd.exe: ${JSON.stringify(arg)}`);
  return /^[A-Za-z0-9_@+=:,./\\-]+$/.test(arg) ? arg : `"${arg}"`;
}

function startProcessTree(options: SmokeAppLaunchOptions, port: number, userDataDir: string): ProcessTree {
  const switches = devToolsSwitches(port, userDataDir);
  // Dev build: `pnpm run dev -- <switches>` in the reference app; Forge passes the switches after `--` to Electron.
  let command = options.target.kind === 'dev' ? 'pnpm' : options.target.executablePath;
  let args = options.target.kind === 'dev' ? ['run', 'dev', '--', ...switches] : switches;
  const cwd = options.target.kind === 'dev' ? referenceAppDir : dirname(options.target.executablePath);
  // Linux without a display (CI): run under a virtual X server.
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    args = ['--auto-servernum', '--server-args=-screen 0 1280x1024x24', command, ...args];
    command = 'xvfb-run';
  }
  // On Windows pnpm is a .cmd shim, which Node starts only through cmd.exe.
  const throughShell = process.platform === 'win32' && command === 'pnpm';
  const spawnOptions = {
    cwd,
    env: buildAppEnv(options.env ?? {}),
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    // POSIX: its own process group, so one signal reaches every process of the tree.
    detached: process.platform !== 'win32',
    windowsHide: true,
  };
  const child: ChildProcess = throughShell
    ? spawn([command, ...args.map(quoteForWindowsShell)].join(' '), { ...spawnOptions, shell: true })
    : spawn(command, args, spawnOptions);

  let output = '';
  let spawnError: Error | undefined;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.stdout?.on('data', (data: Buffer) => (output += String(data)));
  child.stderr?.on('data', (data: Buffer) => (output += String(data)));
  child.on('error', (error) => (spawnError ??= error));
  const exited = new Promise<void>((resolveExit) => {
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      resolveExit();
    });
    child.on('error', () => resolveExit());
  });
  const closed = new Promise<void>((resolveClose) => {
    child.on('close', () => resolveClose());
    child.on('error', () => resolveClose());
  });

  let stopPromise: Promise<void> | undefined;
  const stop = async (): Promise<void> => {
    const rootPid = exit === undefined ? child.pid : undefined;
    // 1. The tree or group kill comes first, so a process list that cannot be read never stops it.
    if (process.platform === 'win32') {
      if (rootPid !== undefined) {
        spawnSync('taskkill', ['/pid', String(rootPid), '/T', '/F'], { windowsHide: true, timeout: 30_000 });
      }
    } else if (rootPid !== undefined) {
      signalProcessGroup(rootPid, 'SIGTERM');
    }
    // 2. A best-effort snapshot finds processes the first kill did not reach (an empty map when
    //    the list cannot be read; the wait below then reports the listing error).
    const known = collectAppProcessesBestEffort(rootPid, userDataDir);
    if (process.platform === 'win32') {
      for (const pid of known.keys()) killProcess(pid);
      await Promise.race([exited, delay(gracefulStopMs)]);
    } else {
      for (const pid of known.keys()) signalProcess(pid, 'SIGTERM');
      if (rootPid !== undefined) await Promise.race([exited, delay(gracefulStopMs)]);
      // The group signal reaches every process that stayed in the group; the snapshot
      // reaches any process that left it.
      if (child.pid !== undefined) signalProcessGroup(child.pid, 'SIGKILL');
      for (const pid of known.keys()) signalProcess(pid, 'SIGKILL');
      await Promise.race([exited, delay(gracefulStopMs)]);
    }
    // 3. Bounded wait; a process list that cannot be read fails the teardown here, after the kill.
    await waitUntilAppProcessesExit(userDataDir, known);
    await Promise.race([closed, delay(2_000)]);
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  };

  return {
    command,
    commandLine: [command, ...args].join(' '),
    output: () => stripAnsiCodes(output),
    spawnError: () => spawnError,
    exit: () => exit,
    outputClosed: (timeoutMs) => Promise.race([closed, delay(timeoutMs)]),
    stop: () => (stopPromise ??= stop()),
  };
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is gone.
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * Kills one process. On Windows never with `/T`: Windows keeps a parent pid after
 * the parent exits and reuses pids, so a tree kill of a found pid could reach
 * processes outside the app. The process walk already finds the descendants.
 */
function killProcess(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/F'], { windowsHide: true, timeout: 30_000 });
    return;
  }
  signalProcess(pid, 'SIGKILL');
}

/** collectAppProcesses that never throws: an unreadable process list gives an empty map. */
function collectAppProcessesBestEffort(rootPid: number | undefined, userDataDir: string): Map<number, string> {
  try {
    return collectAppProcesses(rootPid, userDataDir, new Map());
  } catch {
    return new Map();
  }
}

/**
 * Waits until no process of the app is left: none runs with
 * `--user-data-dir=<dir>`, none from the snapshot taken after the first kill, and
 * no descendant of either. Processes still there after half the wait are killed
 * one by one; any that survive fail the teardown with their pids and command lines.
 */
async function waitUntilAppProcessesExit(userDataDir: string, known: ReadonlyMap<number, string>): Promise<void> {
  const firstWaitEnds = Date.now() + processExitWaitMs / 2;
  let running = collectAppProcesses(undefined, userDataDir, known);
  while (running.size > 0 && Date.now() < firstWaitEnds) {
    await delay(500);
    running = collectAppProcesses(undefined, userDataDir, known);
  }
  if (running.size === 0) return;
  for (const pid of running.keys()) killProcess(pid);
  const secondWaitEnds = Date.now() + processExitWaitMs / 2;
  while (running.size > 0 && Date.now() < secondWaitEnds) {
    await delay(500);
    running = collectAppProcesses(undefined, userDataDir, known);
  }
  if (running.size > 0) {
    throw new Error(
      `${running.size} process(es) of the app that used ${userDataDir} are still running after teardown:\n` +
        [...running].map(([pid, command]) => `  pid ${pid}: ${command}`).join('\n'),
    );
  }
}

interface ListedProcess {
  readonly pid: number;
  readonly parentPid: number;
  readonly command: string;
  /** Windows only: creation time in ms since 1970, or undefined when the OS does not report it. */
  readonly createdMs?: number;
}

/** True when `command` holds `--user-data-dir=<dir>`, with or without quotes around the path (Chromium helpers on Windows quote it). */
function usesUserDataDir(command: string, userDataDir: string, windows: boolean): boolean {
  const fold = (text: string): string => (windows ? text.toLowerCase() : text);
  const text = fold(command);
  const dir = fold(userDataDir);
  for (const form of [`--user-data-dir=${dir}`, `--user-data-dir="${dir}"`]) {
    let index = text.indexOf(form);
    while (index >= 0) {
      const next = text.charAt(index + form.length);
      // The path must end here, so /tmp/a never matches /tmp/ab.
      if (next === '' || next === ' ' || next === '"' || next === '\t') return true;
      index = text.indexOf(form, index + 1);
    }
  }
  return false;
}

/**
 * True when `child` is a real child of `parent`. POSIX re-parents orphans, so the
 * parent pid is current. Windows keeps a stale parent pid and reuses pids, so the
 * child must also be created at or after the parent.
 */
function isChildOf(child: ListedProcess, parent: ListedProcess | undefined, windows: boolean): boolean {
  if (!parent || child.parentPid !== parent.pid) return false;
  if (!windows) return true;
  return child.createdMs !== undefined && parent.createdMs !== undefined && child.createdMs >= parent.createdMs;
}

/**
 * The app's processes (pid to command line): the root process (when given),
 * every process with `--user-data-dir=<dir>` (case-insensitive on Windows),
 * every process in `known` that still runs with the same command line (so a
 * reused pid never counts), and every descendant of these. Linux zygotes and
 * renderers carry no `--user-data-dir`; they are found as descendants.
 */
function collectAppProcesses(
  rootPid: number | undefined,
  userDataDir: string,
  known: ReadonlyMap<number, string>,
): Map<number, string> {
  const windows = process.platform === 'win32';
  const listed = listProcesses().filter((entry) => entry.pid !== process.pid);
  const byPid = new Map(listed.map((entry) => [entry.pid, entry]));
  const found = new Map<number, string>();
  for (const entry of listed) {
    if (
      entry.pid === rootPid ||
      usesUserDataDir(entry.command, userDataDir, windows) ||
      known.get(entry.pid) === entry.command
    ) {
      found.set(entry.pid, entry.command);
    }
  }
  let added = true;
  while (added) {
    added = false;
    for (const entry of listed) {
      if (
        !found.has(entry.pid) &&
        found.has(entry.parentPid) &&
        isChildOf(entry, byPid.get(entry.parentPid), windows)
      ) {
        found.set(entry.pid, entry.command);
        added = true;
      }
    }
  }
  return found;
}

// CreatedMs: creation time in ms since 1970 (a JSON-safe number), or null when not reported.
const windowsProcessQuery =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,' +
  "@{Name='CreatedMs';Expression={if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { $null }}}" +
  ' | ConvertTo-Json -Compress';

interface WindowsProcessEntry {
  readonly ProcessId: number;
  readonly ParentProcessId: number;
  readonly CommandLine: string | null;
  readonly CreatedMs: number | null;
}

/** Every running process, from PowerShell on Windows and `ps` elsewhere. */
function listProcesses(): ListedProcess[] {
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsProcessQuery], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
    });
    if (result.status !== 0) throw new Error(`could not list processes with PowerShell: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout || '[]') as WindowsProcessEntry[] | WindowsProcessEntry;
    return [parsed].flat().map((entry) => ({
      pid: entry.ProcessId,
      parentPid: entry.ParentProcessId,
      command: entry.CommandLine ?? '',
      createdMs: typeof entry.CreatedMs === 'number' ? entry.CreatedMs : undefined,
    }));
  }
  // -ww: never cut long command lines.
  const result = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 60_000 });
  if (result.status !== 0) throw new Error(`could not list processes with ps: ${result.stderr}`);
  return result.stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] ?? '' }));
}

// ---------------------------------------------------------------------------
// Small helpers

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(undefined), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ANSI colour codes start with the ESC control character.
// eslint-disable-next-line no-control-regex
const ansiPattern = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function stripAnsiCodes(text: string): string {
  return text.replace(ansiPattern, '');
}

/** Keeps the start (where startup errors are) and the end of long output. */
function clipOutput(output: string): string {
  const text = output.trim();
  if (text.length <= 16_000) return text;
  return `${text.slice(0, 6_000)}\n...[${text.length - 16_000} characters cut]...\n${text.slice(-10_000)}`;
}
