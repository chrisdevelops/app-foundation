// Test-only fixture apps for the smoke harness gate tests (#16; TST-007,
// TST-010, XC-004). A fixture build is a copy of the Electron binary
// distribution with the app in `resources/app` (Electron loads it from there,
// as from app.asar in a packaged build), so the harness starts it like any
// packaged executable: by its path. The fixture main process is rewritten
// before each launch to provoke one behaviour or failure mode.
//
// The copy lives in a temporary folder whose name holds a space, so a harness
// that passes the path through a shell without quoting fails.
//
// Background mode (#46; TST-018; ADR 0013 rule 1 and amendment 1): the fixture
// follows the same switch as the foundation. With FOUNDATION_TEST_BACKGROUND=1
// (only that value) it uses the `accessory` activation policy on macOS and its
// windows are never shown; on Linux and Windows its windows are shown without
// focus (`showInactive()`). No window is ever focused on any platform.
// It writes what it did to `window-state.json`
// (`SmokeFixtureWindowState`) every 200 ms, so a gate can read, on every
// platform, which value the launch got and whether a window was ever shown
// or focused. Each process writes through its own temporary file and ignores a
// failed write, so concurrent launches of one build never collide; the file
// holds the state of the instance that wrote last (gates that read it run one
// instance at a time).
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { repoGateRootDir } from '../../tools/test-support/run-repo-command';
import { readPackagedAppLayout } from '../../tools/test-support/packaged-app-layout';
import {
  testBackgroundEnabledValue,
  testBackgroundVariableName,
} from '../../tools/test-support/background-test-variables';

export type SmokeFixtureMode =
  /** Opens one window; on `#open-second-window` in that window the main process opens a second one. */
  | 'window'
  /** Removes the DevTools switch before Chromium reads it: the endpoint never opens (connections are refused). */
  | 'refuse-devtools'
  /** A top-level require() of a module that is not packaged: a modal error dialog on macOS and Windows (ADR 0005). */
  | 'throw-on-require'
  /** Exits before ready with `exitCode`. */
  | 'exit-early'
  /**
   * Records its environment in window-state.json and opens no window (#46). It always uses the
   * `accessory` activation policy on macOS, so it never takes focus, whatever the launch mode.
   */
  | 'env-only';

export interface SmokeFixtureAppConfig {
  readonly mode: SmokeFixtureMode;
  /** Window title when the environment variable `SMOKE_FIXTURE_TITLE` is not set. */
  readonly title?: string;
  readonly exitCode?: number;
  /** When set, the main process starts a long-running child process with this text in its command line. */
  readonly grandchildMarker?: string;
}

export interface SmokeFixtureBuild {
  /** Temporary folder that holds the copy (its name holds a space). */
  readonly dir: string;
  /** The executable to start. */
  readonly executablePath: string;
  /** `resources/app` (or `Contents/Resources/app` on macOS). */
  readonly appDir: string;
  /** Text every fixture prints on stdout and on stderr before anything else. */
  readonly stdoutMarker: string;
  readonly stderrMarker: string;
  /** File the fixture main process writes on start (its process id). */
  readonly launchedFile: string;
  /** File the fixture main process writes its `SmokeFixtureWindowState` to (#46). */
  readonly windowStateFile: string;
  /** Rewrites the fixture app; only call while no process runs from the copy. */
  write(config: SmokeFixtureAppConfig): void;
}

/** Title of the window the `window` fixture opens on `#open-second-window`. */
export const smokeFixtureSecondWindowTitle = 'Smoke fixture second window';

/** Accessible name of the text input in every fixture window (#46: CDP key input). */
export const smokeFixtureInputName = 'Smoke fixture input';

/** What the fixture main process reports in window-state.json (#46). */
export interface SmokeFixtureWindowState {
  /** FOUNDATION_TEST_BACKGROUND as the app saw it (null when unset). */
  readonly backgroundVariable: string | null;
  /** True when the fixture switched to background mode. */
  readonly backgroundMode: boolean;
  readonly windows: ReadonlyArray<{
    readonly title: string;
    /** BrowserWindow.isVisible() now. */
    readonly visible: boolean;
    /** BrowserWindow.isFocused() now. */
    readonly focused: boolean;
    /** True when the window was visible when created or ever fired `show`. */
    readonly everShown: boolean;
    /** True when the window was focused when created or ever fired `focus`. */
    readonly everFocused: boolean;
  }>;
}

/** Reads the fixture's window-state.json; undefined when the fixture has not written it. */
export function readSmokeFixtureWindowState(build: SmokeFixtureBuild): SmokeFixtureWindowState | undefined {
  if (!existsSync(build.windowStateFile)) return undefined;
  try {
    return JSON.parse(readFileSync(build.windowStateFile, 'utf8')) as SmokeFixtureWindowState;
  } catch {
    // Read while the fixture renamed it into place; the caller polls again.
    return undefined;
  }
}

/** The Electron distribution folder the reference app depends on (isolated pnpm layout: resolved from apps/reference). */
function findElectronDistDir(): string {
  const requireFromReferenceApp = createRequire(join(repoGateRootDir, 'apps', 'reference', 'package.json'));
  const electronPackageJson = requireFromReferenceApp.resolve('electron/package.json');
  const distDir = join(dirname(electronPackageJson), 'dist');
  if (!existsSync(distDir)) {
    throw new Error(`${distDir} does not exist: the Electron binary is not downloaded (run pnpm install)`);
  }
  return distDir;
}

const fixtureIndexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Smoke fixture</title>
    <script>document.title = new URLSearchParams(location.search).get('title') || 'Smoke fixture';</script>
  </head>
  <body style="background: #3399cc">
    <h1>Smoke fixture</h1>
    <input aria-label="Smoke fixture input" />
  </body>
</html>
`;

function fixtureMainSource(config: SmokeFixtureAppConfig, stdoutMarker: string, stderrMarker: string): string {
  const settings = {
    mode: config.mode,
    // Not 'Smoke fixture': that is the page title before its script sets the real one.
    title: config.title ?? 'Smoke fixture window',
    exitCode: config.exitCode ?? 0,
    grandchildMarker: config.grandchildMarker ?? '',
    stdoutMarker,
    stderrMarker,
    secondWindowTitle: smokeFixtureSecondWindowTitle,
    backgroundVariableName: testBackgroundVariableName,
    backgroundEnabledValue: testBackgroundEnabledValue,
  };
  return `// Generated by e2e/test-support/smoke-fixture-app.ts for the #16 gate tests.
'use strict';
const settings = ${JSON.stringify(settings)};
const { spawn } = require('node:child_process');
const { renameSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
console.log(settings.stdoutMarker);
console.error(settings.stderrMarker);
writeFileSync(join(__dirname, 'launched.txt'), String(process.pid));
const { app, BrowserWindow } = require('electron');

if (settings.grandchildMarker !== '') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', settings.grandchildMarker], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}
// #46: the foundation's background switch, mirrored (only the value '1' enables it).
const backgroundVariable = process.env[settings.backgroundVariableName];
const backgroundMode = backgroundVariable === settings.backgroundEnabledValue;
if ((backgroundMode || settings.mode === 'env-only') && process.platform === 'darwin') {
  app.setActivationPolicy('accessory');
}
const windowStates = [];
function writeWindowState() {
  const state = {
    backgroundVariable: backgroundVariable === undefined ? null : backgroundVariable,
    backgroundMode,
    windows: windowStates
      .filter((entry) => !entry.window.isDestroyed())
      .map((entry) => ({
        title: entry.title,
        visible: entry.window.isVisible(),
        focused: entry.window.isFocused(),
        everShown: entry.everShown,
        everFocused: entry.everFocused,
      })),
  };
  // Two instances of one fixture build share __dirname (TST-009: two launches at
  // the same time), so each process writes its own temporary file and renames it
  // into place: the rename is atomic and the last writer wins. A failed write
  // must never raise an uncaught main-process error: that opens the modal error
  // dialog (ADR 0005), which takes focus and stops the launch. The next write
  // (200 ms later) tries again.
  const path = join(__dirname, 'window-state.json');
  const temporaryPath = path + '.tmp.' + process.pid;
  try {
    writeFileSync(temporaryPath, JSON.stringify(state));
    renameSync(temporaryPath, path);
  } catch {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // The folder is gone or locked; nothing to clean up now.
    }
  }
}
writeWindowState();
setInterval(writeWindowState, 200);

if (settings.mode === 'refuse-devtools') app.commandLine.removeSwitch('remote-debugging-port');
if (settings.mode === 'throw-on-require') require('./module-that-is-not-packaged');
if (settings.mode === 'exit-early') process.exit(settings.exitCode);

const webPreferences = { sandbox: true, contextIsolation: true, nodeIntegration: false };

function openWindow(title) {
  const window = new BrowserWindow({ title, width: 640, height: 480, show: !backgroundMode, webPreferences });
  const entry = { window, title, everShown: window.isVisible(), everFocused: window.isFocused() };
  window.on('show', () => { entry.everShown = true; writeWindowState(); });
  window.on('focus', () => { entry.everFocused = true; writeWindowState(); });
  windowStates.push(entry);
  // ADR 0013 amendment 1: on Linux and Windows a background window is shown without focus.
  if (backgroundMode && process.platform !== 'darwin') window.showInactive();
  entry.everShown = entry.everShown || window.isVisible();
  entry.everFocused = entry.everFocused || window.isFocused();
  writeWindowState();
  void window.loadFile(join(__dirname, 'index.html'), { query: { title } });
  return window;
}

app.whenReady().then(() => {
  if (settings.mode === 'env-only') return;
  const main = openWindow(process.env.SMOKE_FIXTURE_TITLE || settings.title);
  main.webContents.on('did-navigate-in-page', (_event, url) => {
    if (url.endsWith('#open-second-window')) openWindow(settings.secondWindowTitle);
  });
});
app.on('window-all-closed', () => app.quit());
`;
}

/** Copies the Electron distribution to a temporary folder and returns the fixture build in it. */
export function createSmokeFixtureBuild(): SmokeFixtureBuild {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'smoke gate fixture ')));
  const copyDir = join(dir, 'electron');
  // Keep symlinks as they are: macOS frameworks rely on them.
  cpSync(findElectronDistDir(), copyDir, { recursive: true, verbatimSymlinks: true });
  const layout = readPackagedAppLayout(copyDir);
  const appDir = join(layout.resourcesDir, 'app');
  const token = Math.random().toString(36).slice(2, 10);
  const stdoutMarker = `smoke-fixture-stdout-${token}`;
  const stderrMarker = `smoke-fixture-stderr-${token}`;
  const launchedFile = join(appDir, 'launched.txt');
  return {
    dir,
    executablePath: layout.executablePath,
    appDir,
    stdoutMarker,
    stderrMarker,
    launchedFile,
    windowStateFile: join(appDir, 'window-state.json'),
    write(config: SmokeFixtureAppConfig): void {
      rmSync(appDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      mkdirSync(appDir, { recursive: true });
      writeFileSync(
        join(appDir, 'package.json'),
        JSON.stringify({ name: 'smoke-fixture', version: '0.0.0', private: true, main: 'main.cjs' }),
      );
      writeFileSync(join(appDir, 'main.cjs'), fixtureMainSource(config, stdoutMarker, stderrMarker));
      writeFileSync(join(appDir, 'index.html'), fixtureIndexHtml);
    },
  };
}
