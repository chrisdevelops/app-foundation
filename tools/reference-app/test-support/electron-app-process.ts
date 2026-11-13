// Test-only helper for the reference app gate tests (#15; TST-011, PLT-008).
// Starts an Electron app (a packaged executable or the dev command) with the
// DevTools port on a free port, finds that port from the app's own user data
// folder (never a guessed port, which could reach another app: spike #5), and
// stops the whole process tree afterwards.
//
// Every wait is bounded: a modal error dialog in the main process makes the
// wait fail with the app's output instead of hanging (ADR 0005).
//
// Background mode (#46; TST-018; ADR 0013 rule 2): every launch gets
// FOUNDATION_TEST_BACKGROUND=1 by default, so the app shows no window and takes
// no focus. A run with FOUNDATION_TEST_FOREGROUND=1 in its environment launches
// normally. A caller that tests the switch itself sets the variable in `env`
// (its value wins) or names it in `withoutEnv` (the app gets no such variable).
// On Linux a launch in background mode also gets `--disable-gpu` as its last
// argument (ADR 0016; `testBackgroundLaunchSwitches`).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripAnsiCodes } from '../../test-support/run-repo-command';
import { removeAppFolderAfterExit } from '../../test-support/app-process-cleanup';
import {
  isForegroundTestRun,
  testBackgroundEnabledValue,
  testBackgroundLaunchSwitches,
  testBackgroundVariableName,
} from '../../test-support/background-test-variables';

export interface ElectronAppProcess {
  readonly userDataDir: string;
  /** Combined stdout and stderr so far, without ANSI codes. */
  output(): string;
  /** Stderr alone so far, without ANSI codes (#18: a refused CDP port is named on stderr). */
  errorOutput(): string;
  /** Exit code, or null while the process runs. */
  exitCode(): number | null;
  /** Resolves with the DevTools port the app opened; rejects when the app exits or the time runs out. */
  waitForDevToolsPort(timeoutMs: number): Promise<number>;
  /**
   * Stops the process and every child it started, waits until no process uses
   * the user data folder, then removes it. Rejects when a process is still
   * running after the bounded wait, or the folder cannot be removed.
   */
  stop(): Promise<void>;
  describe(): string;
}

// Variables an outer pnpm, Turborepo or Vitest sets; the app must not inherit them.
const inheritedVariablePrefixes = ['npm_', 'TURBO_', 'VITEST', 'PNPM_SCRIPT'];
const inheritedVariableNames = ['NODE_ENV', 'TEST', 'INIT_CWD', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'];

function buildAppEnv(extra: Record<string, string>, without: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (inheritedVariableNames.includes(key)) continue;
    if (inheritedVariablePrefixes.some((prefix) => key.startsWith(prefix))) continue;
    if (without.includes(key)) continue;
    // The run-level choice below decides the launch mode, not a value left in this process's environment.
    if (key === testBackgroundVariableName) continue;
    env[key] = value;
  }
  // #46 (ADR 0013 rule 2): background mode by default; FOUNDATION_TEST_FOREGROUND=1 launches normally.
  const background =
    isForegroundTestRun() || without.includes(testBackgroundVariableName)
      ? {}
      : { [testBackgroundVariableName]: testBackgroundEnabledValue };
  return { ...env, FORCE_COLOR: '0', NO_COLOR: '1', ...background, ...extra };
}

/** Chromium switches every gate launch adds: a free DevTools port and a fresh user data folder. */
export function devToolsLaunchSwitches(userDataDir: string): string[] {
  const switches = ['--remote-debugging-port=0', `--user-data-dir=${userDataDir}`];
  // macOS: keep Chromium away from the login keychain, which can prompt.
  if (process.platform === 'darwin') switches.push('--use-mock-keychain');
  return switches;
}

/** Quotes one argument for cmd.exe; throws on characters cmd.exe would expand even inside quotes. */
function quoteForWindowsShell(arg: string): string {
  if (/[%!"\r\n]/.test(arg)) throw new Error(`argument cannot be passed through cmd.exe: ${JSON.stringify(arg)}`);
  return /^[A-Za-z0-9_@+=:,./\\-]+$/.test(arg) ? arg : `"${arg}"`;
}

function hasDisplay(): boolean {
  return Boolean(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Starts `command` with `args`. Gate launches pass `devToolsLaunchSwitches`
 * themselves (in the right place for the command). `pnpm` runs through
 * cmd.exe on Windows, where it is a `.cmd` shim. On Linux without a display
 * the command runs under `xvfb-run`. On Linux in background mode (the app's
 * environment holds FOUNDATION_TEST_BACKGROUND=1) `--disable-gpu` is added after
 * `args` (ADR 0016), so a `pnpm run <script>` command must end its `args` with
 * `--` and the switches for Electron.
 */
export function startElectronAppProcess(options: {
  command: string;
  args: (userDataDir: string) => readonly string[];
  cwd: string;
  env?: Record<string, string>;
  /**
   * Variables the app must not get (#18: a launch that must run without the CDP variable). Naming
   * FOUNDATION_TEST_BACKGROUND here also drops the background default (#46).
   */
  withoutEnv?: readonly string[];
}): ElectronAppProcess {
  const userDataDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'rf-gate-user-data-')));
  const env = buildAppEnv(options.env ?? {}, options.withoutEnv ?? []);
  let command = options.command;
  // ADR 0016: on Linux, background launches run without the GPU process.
  let args = [...options.args(userDataDir), ...testBackgroundLaunchSwitches(env)];
  if (process.platform === 'linux' && !hasDisplay()) {
    args = ['--auto-servernum', '--server-args=-screen 0 1280x1024x24', command, ...args];
    command = 'xvfb-run';
  }
  const throughShell = process.platform === 'win32' && command === 'pnpm';
  const spawnOptions = {
    cwd: options.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  };
  const child: ChildProcess = throughShell
    ? spawn([command, ...args.map(quoteForWindowsShell)].join(' '), { ...spawnOptions, shell: true })
    : spawn(command, args, spawnOptions);
  let output = '';
  let errorOutput = '';
  let spawnError: Error | undefined;
  let exitCode: number | null = null;
  child.stdout?.on('data', (data: Buffer) => (output += String(data)));
  child.stderr?.on('data', (data: Buffer) => {
    output += String(data);
    errorOutput += String(data);
  });
  child.on('error', (error) => (spawnError = error));
  const exited = new Promise<void>((resolve) => {
    child.on('exit', (code, signal) => {
      exitCode = code ?? (signal ? 128 : -1);
      resolve();
    });
  });
  const commandLine = [command, ...args].join(' ');

  const describe = (): string => {
    const text = stripAnsiCodes(output).trim();
    const tail = text.length > 6000 ? `...${text.slice(-6000)}` : text;
    const state = exitCode === null ? 'still running' : `exited with code ${exitCode}`;
    return `$ ${commandLine}\n(cwd ${options.cwd}; ${state})${spawnError ? `\n[spawn error] ${spawnError.message}` : ''}\n${tail}`;
  };

  return {
    userDataDir,
    output: () => stripAnsiCodes(output),
    errorOutput: () => stripAnsiCodes(errorOutput),
    exitCode: () => exitCode,
    describe,
    async waitForDevToolsPort(timeoutMs: number): Promise<number> {
      const portFile = join(userDataDir, 'DevToolsActivePort');
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (spawnError) throw new Error(`the app could not start:\n${describe()}`);
        if (existsSync(portFile)) {
          // Windows: Chromium may still hold the file open while it writes it (EBUSY,
          // PR #47 run 43355618046); a locked or vanished file counts as "not written yet".
          let text = '';
          try {
            text = readFileSync(portFile, 'utf8');
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOENT') throw error;
          }
          const port = Number(text.split(/\r?\n/)[0]);
          if (Number.isInteger(port) && port > 0) return port;
        }
        if (exitCode !== null) throw new Error(`the app exited before it opened its DevTools port:\n${describe()}`);
        await delay(200);
      }
      throw new Error(
        `the app opened no DevTools port in ${timeoutMs} ms (a modal error dialog in the main process looks like this):\n${describe()}`,
      );
    },
    async stop(): Promise<void> {
      if (exitCode === null && child.pid !== undefined) {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            // Already gone.
          }
          await Promise.race([exited, delay(5000)]);
          if (exitCode === null) {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              // Already gone.
            }
          }
        }
        await Promise.race([exited, delay(5000)]);
      }
      // Helper processes can outlive the main process, and Windows keeps their
      // files locked; wait for every process that uses this folder, then remove it.
      await removeAppFolderAfterExit(userDataDir, 'Electron user data folder');
    },
  };
}
