// Gate tests for #15: the reference app built, run and packaged from the
// outside, through its own commands and outputs.
// - Dev command: one window, a React root with a visible heading.
// - `package`: exit 0, fuses read back from the packaged binary, what app.asar
//   holds, and the packaged app started from a copy outside the repository
//   (inside it, Node's upward module lookup can hide missing files: spike #9).
// - The packaged window: loaded through app://, standard and secure scheme,
//   React heading, no Node in the main world, and the app:// failure modes
//   (traversal, absolute paths, unknown hosts) through Chromium.
// - `make`: exit 0 and a zip that holds the packaged app.
// Windows are read through the DevTools protocol on a free port. Packaged
// launches set FOUNDATION_ALLOW_PACKAGED_CDP=1 (#18; ADR 0004 decision 2 B);
// the dev launch runs without it.
// - #18, the packaged CDP guard (TST-009), tested at the boundary: does a
//   packaged app started with `--remote-debugging-port` expose a reachable
//   DevTools endpoint? Without the variable (or with any value but `1`): no
//   answer on the port at any moment, no DevToolsActivePort, a non-zero exit
//   and a refusal on stderr that names the switch and the variable. With it:
//   the endpoint answers. `--inspect` and `--inspect-brk` start no debugger,
//   with or without the variable. `--inspect-port` and `--inspect-publish-uid`
//   (which the fuse ignores without an exit) are refused with the variable set:
//   non-zero exit and the switch named on stderr. A non-loopback
//   `--remote-debugging-address` is refused with the variable set; a loopback
//   one is accepted. The dev build answers on loopback only.
// - #18, PLT-012: the smoke suite (e2e/smoke/, which holds the security
//   baseline smoke tests) passes through the harness against the packaged
//   copy. ADR 0011: that one test skips on Windows; the guard tests run there.
// Requirements: PLT-002, PLT-005, PLT-007 (partial), PLT-008 (partial),
// PLT-012, TST-009, TST-011 (partial); ADR 0004 decisions 1, 2 B and 3;
// ADR 0007 items 5 and 7; ADR 0011.
// All steps share one build, so they run in order in this one file.
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isInsideCleanClone } from '../test-support/clean-clone';
import {
  describeRepoCommand,
  repoGateRootDir,
  runRepoCommand,
  type RepoCommandResult,
} from '../test-support/run-repo-command';
import { readPackageManifest } from '../test-support/workspace-projects';
import { packagedCdpEnabledValue, packagedCdpVariableName } from '../test-support/packaged-cdp-variable';
import {
  findFreeLoopbackPort,
  listNonLoopbackIpv4Addresses,
  probeDebugEndpoint,
  waitForAppExit,
  watchDebugEndpoint,
} from './test-support/devtools-endpoint-probe';
import { listDevToolsTargets } from './test-support/devtools-protocol-client';
import {
  openAppWindow,
  readMainWorldNodeGlobals,
  readReactRootHeadings,
  waitForAccessibleHeadingNames,
  type OpenAppWindow,
} from './test-support/app-window-checks';
import { removeAppFolderAfterExit } from '../test-support/app-process-cleanup';
import { listAsarFiles, readAsarFile } from './test-support/asar-archive';
import {
  devToolsLaunchSwitches,
  startElectronAppProcess,
  type ElectronAppProcess,
} from './test-support/electron-app-process';
import { readElectronFuseWires, type ElectronFuseName } from './test-support/electron-fuse-wire';
import {
  copyPackagedAppDir,
  findPackagedAppDir,
  readPackagedAppLayout,
  type PackagedAppLayout,
} from '../test-support/packaged-app-layout';
import { findReferenceAppDevScript, referenceAppRelativeDir } from './test-support/reference-app-paths';
import { listZipEntries } from './test-support/zip-archive';

const root = repoGateRootDir;
const referenceAppDir = join(root, ...referenceAppRelativeDir.split('/'));
const forgeOutDir = join(referenceAppDir, 'out');
const slow = { timeout: 600_000 };
const launchTimeoutMs = 120_000;
// Vite 8 warning for config files it cannot load natively (spike #6 failure mode 4).
const configLoaderWarning = /configLoader/;
/** The smoke suite's packaged-target variable (e2e/test-support/smoke-harness-contract.ts, #16). */
const smokeAppExecutableVariable = 'SMOKE_APP_EXECUTABLE';
/** Environment that enables the CDP port in a packaged launch (#18; ADR 0004 decision 2 B). */
const packagedCdpEnabledEnv = { [packagedCdpVariableName]: packagedCdpEnabledValue };
/** Chromium prints this when its DevTools endpoint opens. */
const devToolsListening = /DevTools listening on/;
/** Node prints this when its inspector starts. */
const nodeInspectorListening = /Debugger listening on/;

/** A fresh user data folder (and the macOS mock keychain) without any DevTools switch; `extra` follows. */
function launchSwitchesWithoutDevTools(userDataDir: string, extra: readonly string[]): string[] {
  const switches = [`--user-data-dir=${userDataDir}`];
  if (process.platform === 'darwin') switches.push('--use-mock-keychain');
  return [...switches, ...extra];
}

function pnpmInReferenceApp(args: readonly string[]): RepoCommandResult {
  return runRepoCommand('pnpm', args, { cwd: referenceAppDir, timeoutMs: 600_000 });
}

function requireReferenceApp(): Record<string, unknown> {
  const manifestPath = join(referenceAppDir, 'package.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`${referenceAppRelativeDir}/package.json does not exist: the reference app is not built yet`);
  }
  return readPackageManifest(manifestPath);
}

/** True when `path` is outside the repository (another drive on Windows counts as outside). */
function isOutsideRepository(path: string): boolean {
  const fromRoot = relative(realpathSync.native(root), realpathSync.native(path));
  return /^\.\.([\\/]|$)/.test(fromRoot) || isAbsolute(fromRoot);
}

async function expectReactRootWithVisibleHeading(window: OpenAppWindow): Promise<void> {
  const headingNames = await waitForAccessibleHeadingNames(window.session, 30_000);
  const inReact = await readReactRootHeadings(window.session);
  expect(inReact.reactRootCount, 'the page must hold a React root (react-dom createRoot)').toBeGreaterThan(0);
  const visibleInReact = inReact.headings.filter((heading) => heading.visible && headingNames.includes(heading.text));
  expect(
    visibleInReact,
    `a visible heading with an accessible name must be inside the React root; accessible headings ${JSON.stringify(headingNames)}, headings in React roots ${JSON.stringify(inReact.headings)}`,
  ).not.toEqual([]);
}

// A nested `turbo run test` inside a clean clone (tools/repo) must not build,
// package and launch the app a second time.
describe.skipIf(isInsideCleanClone(root))('reference app: dev, package, launch and make', () => {
  describe('dev command', () => {
    let devApp: ElectronAppProcess | undefined;
    let devWindow: Promise<OpenAppWindow> | undefined;

    function ensureDevWindow(): Promise<OpenAppWindow> {
      devWindow ??= (async () => {
        const scripts = (requireReferenceApp().scripts ?? {}) as Record<string, string>;
        const script = findReferenceAppDevScript(scripts);
        if (!script)
          throw new Error(
            `${referenceAppRelativeDir}/package.json has no dev or start script that runs electron-forge start`,
          );
        // `pnpm run <script> -- <switches>`: Forge passes the switches after `--` to Electron.
        // #18: the dev build accepts the port without the packaged CDP variable.
        devApp = startElectronAppProcess({
          command: 'pnpm',
          args: (userDataDir) => ['run', script, '--', ...devToolsLaunchSwitches(userDataDir)],
          cwd: referenceAppDir,
          withoutEnv: [packagedCdpVariableName],
        });
        return openAppWindow(devApp, launchTimeoutMs);
      })();
      return devWindow;
    }

    afterAll(async () => {
      if (devWindow) (await devWindow.catch(() => undefined))?.session.close();
      await devApp?.stop();
    }, 180_000);

    // PLT-005; issue #15 acceptance criterion 2
    it('PLT-005: the dev command opens exactly one window', slow, async () => {
      const window = await ensureDevWindow();
      expect(
        window.windows.map((target) => target.url),
        `the dev command must open one window:\n${devApp?.describe() ?? ''}`,
      ).toHaveLength(1);
    });

    // PLT-002; issue #15 acceptance criterion 2
    it('PLT-002: the dev window renders a React root with a visible, named heading', slow, async () => {
      await expectReactRootWithVisibleHeading(await ensureDevWindow());
    });

    // PLT-005; spike #6 failure mode 4
    it('PLT-005: the dev command prints no Vite configLoader warning', slow, async () => {
      await ensureDevWindow();
      expect(devApp?.output() ?? '', devApp?.describe()).not.toMatch(configLoaderWarning);
    });

    // TST-009; issue #18 acceptance criterion 6: dev builds accept the port, on localhost only
    it(
      `TST-009: the dev build, started without ${packagedCdpVariableName}, answers on its DevTools port on 127.0.0.1 and on no other IPv4 address of this machine`,
      slow,
      async (context) => {
        const { port } = await ensureDevWindow();
        const loopback = await probeDebugEndpoint('127.0.0.1', port);
        expect(loopback.answered, `control: the dev DevTools endpoint must answer on 127.0.0.1:${port}`).toBe(true);
        const addresses = listNonLoopbackIpv4Addresses();
        if (addresses.length === 0) {
          context.skip('this machine has no non-loopback IPv4 address to probe');
          return;
        }
        const reachable: string[] = [];
        for (const address of addresses) {
          const answer = await probeDebugEndpoint(address, port, 2_000);
          if (answer.answered) reachable.push(`${address}:${port} ${answer.detail}`);
        }
        expect(reachable, 'the DevTools endpoint must listen on loopback only').toEqual([]);
      },
    );
  });

  describe('electron-forge package and the packaged app', () => {
    let packageResult: RepoCommandResult | undefined;
    let copyDir: string | undefined;
    let layout: PackagedAppLayout | undefined;
    let packagedApp: ElectronAppProcess | undefined;
    let packagedWindow: Promise<OpenAppWindow> | undefined;

    function ensurePackaged(): RepoCommandResult {
      if (!packageResult) {
        requireReferenceApp();
        // No stale output can pass the gate.
        rmSync(forgeOutDir, { recursive: true, force: true });
        packageResult = pnpmInReferenceApp(['run', 'package']);
      }
      return packageResult;
    }

    /** The packaged app, copied to a temporary folder outside the repository. */
    function requirePackagedCopy(): PackagedAppLayout {
      if (!layout) {
        const result = ensurePackaged();
        if (result.exitCode !== 0)
          throw new Error(`electron-forge package failed, so this check cannot run:\n${describeRepoCommand(result)}`);
        const packagedDir = findPackagedAppDir(forgeOutDir);
        copyDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'rf-gate-packaged-')));
        const target = join(copyDir, basename(packagedDir));
        copyPackagedAppDir(packagedDir, target);
        layout = readPackagedAppLayout(target);
      }
      return layout;
    }

    function ensurePackagedWindow(): Promise<OpenAppWindow> {
      packagedWindow ??= (async () => {
        const copy = requirePackagedCopy();
        // #18: packaged builds open the CDP port only with the variable (ADR 0004 decision 2 B).
        packagedApp = startElectronAppProcess({
          command: copy.executablePath,
          args: (userDataDir) => devToolsLaunchSwitches(userDataDir),
          cwd: copy.rootDir,
          env: packagedCdpEnabledEnv,
        });
        return openAppWindow(packagedApp, launchTimeoutMs);
      })();
      return packagedWindow;
    }

    afterAll(async () => {
      if (packagedWindow) (await packagedWindow.catch(() => undefined))?.session.close();
      await packagedApp?.stop();
      // Waits for every process started from the copy (Windows locks running executables), then removes it.
      if (copyDir) await removeAppFolderAfterExit(copyDir, 'packaged app copy');
    }, 180_000);

    // PLT-007, PLT-003; ADR 0007 item 5: Forge packages with publicHoistPattern '@types/*' only
    it('PLT-007: pnpm run package (electron-forge package) exits 0', slow, () => {
      const result = ensurePackaged();
      expect(result.exitCode, describeRepoCommand(result)).toBe(0);
    });

    // PLT-005; spike #6 failure mode 4
    it('PLT-005: electron-forge package prints no Vite configLoader warning', slow, () => {
      const result = ensurePackaged();
      expect(result.output, describeRepoCommand(result)).not.toMatch(configLoaderWarning);
    });

    // PLT-008; issue #15 acceptance criterion 8; ADR 0004 decision 1 A
    const expectedFuses: ReadonlyArray<[ElectronFuseName, 'enabled' | 'disabled']> = [
      ['RunAsNode', 'disabled'],
      ['EnableNodeOptionsEnvironmentVariable', 'disabled'],
      ['EnableNodeCliInspectArguments', 'disabled'],
      ['EnableCookieEncryption', 'enabled'],
      ['EnableEmbeddedAsarIntegrityValidation', 'enabled'],
      ['OnlyLoadAppFromAsar', 'enabled'],
      ['GrantFileProtocolExtraPrivileges', 'disabled'],
    ];
    it.each(expectedFuses)('PLT-008: the packaged binary has the %s fuse %s', slow, (fuse, expected) => {
      const copy = requirePackagedCopy();
      const wires = readElectronFuseWires(copy.fuseBinaryPath);
      for (const wire of wires) {
        expect(wire.version, `fuse wire version in ${copy.fuseBinaryPath}`).toBe(1);
        expect(wire.fuses[fuse], `${fuse} in ${copy.fuseBinaryPath} at offset ${wire.offset}`).toBe(expected);
      }
    });

    // PLT-008: OnlyLoadAppFromAsar needs the app in app.asar
    it('PLT-008: the app is packed in resources/app.asar, with no resources/app folder', slow, () => {
      const copy = requirePackagedCopy();
      expect(existsSync(copy.asarPath), `${copy.asarPath} must exist`).toBe(true);
      expect(statSync(copy.asarPath).isFile()).toBe(true);
      expect(existsSync(join(copy.resourcesDir, 'app')), 'resources/app must not exist').toBe(false);
    });

    // PLT-005, PLT-007; spike #6 failure mode 2
    it('PLT-007: app.asar holds package.json with main .vite/build/main.cjs, and that file', slow, () => {
      const copy = requirePackagedCopy();
      const files = listAsarFiles(copy.asarPath);
      expect(files).toContain('/package.json');
      const manifest = JSON.parse(readAsarFile(copy.asarPath, '/package.json').toString('utf8')) as { main?: string };
      expect(manifest.main).toBe('.vite/build/main.cjs');
      expect(files).toContain('/.vite/build/main.cjs');
    });

    // PLT-007
    it('PLT-007: app.asar holds the built renderer (an index.html under .vite/renderer/)', slow, () => {
      const files = listAsarFiles(requirePackagedCopy().asarPath);
      expect(
        files.filter((file) => /^\/\.vite\/renderer\/[^/]+\/index\.html$/.test(file)),
        JSON.stringify(files),
      ).not.toEqual([]);
    });

    // PLT-007: the package holds built output only
    it('PLT-007: app.asar holds no TypeScript sources, build configs or devDependency packages', slow, () => {
      const files = listAsarFiles(requirePackagedCopy().asarPath);
      const sources = files.filter((file) => /\.(ts|tsx|mts|cts)$/.test(file) && !/\.d\.(ts|mts|cts)$/.test(file));
      expect(sources, 'TypeScript sources must not be packaged').toEqual([]);
      const configs = files.filter((file) =>
        /\/(forge\.config|vite\.[^/]*config|vitest\.config|tsconfig)[^/]*$/.test(file),
      );
      expect(configs, 'build configs must not be packaged').toEqual([]);
      const devDependencies = Object.keys(requireReferenceApp().devDependencies ?? {});
      const packagedDevDependencies = devDependencies.filter((name) =>
        files.some((file) => file.startsWith(`/node_modules/${name}/`)),
      );
      expect(packagedDevDependencies, 'devDependencies must not be packaged').toEqual([]);
    });

    // PLT-007; spike #9: run packaged apps outside the repository
    it(
      'PLT-007: the packaged app, copied outside the repository, starts and opens exactly one window',
      slow,
      async () => {
        const copy = requirePackagedCopy();
        expect(isOutsideRepository(copy.rootDir), `${copy.rootDir} must be outside ${root}`).toBe(true);
        const window = await ensurePackagedWindow();
        expect(
          window.windows.map((target) => target.url),
          packagedApp?.describe(),
        ).toHaveLength(1);
      },
    );

    // PLT-008; issue #15 acceptance criterion 4
    it('PLT-008: the packaged main window URL starts with app://', slow, async () => {
      const window = await ensurePackagedWindow();
      expect(window.windows[0]?.url ?? '').toMatch(/^app:\/\/[^/]+\//);
    });

    // PLT-008; issue #15 acceptance criterion 4: privileged (standard, secure) before ready, and the page loads
    it(
      'PLT-008: the packaged page loads with an app:// origin (standard scheme) in a secure context',
      slow,
      async () => {
        const { session, windows } = await ensurePackagedWindow();
        const host = new URL(windows[0]?.url ?? 'app://missing/').host;
        await session.waitForValue('document.readyState === "complete"', 30_000);
        const page = await session.evaluate<{ protocol: string; origin: string; secure: boolean }>(
          '({ protocol: location.protocol, origin: location.origin, secure: window.isSecureContext })',
        );
        expect(page.protocol).toBe('app:');
        expect(page.origin, 'a standard scheme gives a real origin, not "null"').toBe(`app://${host}`);
        expect(page.secure, 'the app scheme must be registered as secure').toBe(true);
      },
    );

    // PLT-002; issue #15 acceptance criteria 2 and 4: the renderer loads through app://
    it('PLT-002: the packaged window renders a React root with a visible, named heading', slow, async () => {
      await expectReactRootWithVisibleHeading(await ensurePackagedWindow());
    });

    // PLT-008 (partial; the isolation and sandbox gate tests come in #18)
    it(
      'PLT-008: the packaged page main world has no Node globals (require, process, module, global)',
      slow,
      async () => {
        const globals = await readMainWorldNodeGlobals((await ensurePackagedWindow()).session);
        expect(globals).toEqual({
          require: 'undefined',
          process: 'undefined',
          module: 'undefined',
          global: 'undefined',
        });
      },
    );

    describe('packaged CDP guard (TST-009; ADR 0004 decision 2 B)', () => {
      /** Time a refused launch has to exit; the guard runs before Chromium opens the port. */
      const refusalExitMs = 30_000;
      /** Time an `--inspect` launch is watched for a debugger. */
      const inspectWatchMs = 12_000;
      const guardedApps: ElectronAppProcess[] = [];

      afterAll(async () => {
        for (const app of guardedApps) await app.stop().catch(() => undefined);
      }, 180_000);

      /** Starts the packaged copy with `extra` switches; `cdpValue` undefined means the variable is not in its environment. */
      function startPackagedCopy(extra: readonly string[], cdpValue: string | undefined): ElectronAppProcess {
        const copy = requirePackagedCopy();
        const app = startElectronAppProcess({
          command: copy.executablePath,
          args: (userDataDir) => launchSwitchesWithoutDevTools(userDataDir, extra),
          cwd: copy.rootDir,
          env: cdpValue === undefined ? {} : { [packagedCdpVariableName]: cdpValue },
          withoutEnv: [packagedCdpVariableName],
        });
        guardedApps.push(app);
        return app;
      }

      const refusedSettings: ReadonlyArray<[string, string | undefined]> = [
        ['not set', undefined],
        ['set to an empty value', ''],
        ['set to 0', '0'],
        ['set to false', 'false'],
      ];

      // TST-009; issue #18 acceptance criterion 5 (failure mode); ADR 0004 decision 2 B
      it.each(refusedSettings)(
        `TST-009: with ${packagedCdpVariableName} %s, a packaged app started with --remote-debugging-port=<free port> never answers on that port, writes no DevToolsActivePort and exits non-zero`,
        slow,
        async (_label, cdpValue) => {
          const port = await findFreeLoopbackPort();
          const app = startPackagedCopy([`--remote-debugging-port=${port}`], cdpValue);
          try {
            const watch = await watchDebugEndpoint(app, port, { windowMs: refusalExitMs });
            expect(
              watch.answers,
              `no DevTools endpoint may answer on 127.0.0.1:${port} (${watch.probes} probes in ${watch.elapsedMs} ms):\n${app.describe()}`,
            ).toEqual([]);
            expect(
              existsSync(join(app.userDataDir, 'DevToolsActivePort')),
              `the refused app must not write DevToolsActivePort:\n${app.describe()}`,
            ).toBe(false);
            expect(app.output(), 'Chromium must not report an open DevTools endpoint').not.toMatch(devToolsListening);
            const exitCode = await waitForAppExit(app, 5_000);
            expect(exitCode, `the refused app must exit within ${refusalExitMs} ms:\n${app.describe()}`).not.toBeNull();
            expect(exitCode, `the refused app must exit with a non-zero code:\n${app.describe()}`).not.toBe(0);
          } finally {
            await app.stop();
          }
        },
      );

      // TST-009; issue #18 acceptance criterion 5: stderr names the refusal
      it(
        `TST-009: a refused packaged launch names --remote-debugging-port and ${packagedCdpVariableName} on stderr`,
        slow,
        async () => {
          const port = await findFreeLoopbackPort();
          const app = startPackagedCopy([`--remote-debugging-port=${port}`], undefined);
          try {
            const exitCode = await waitForAppExit(app, refusalExitMs);
            expect(exitCode, `the refused app must exit:\n${app.describe()}`).not.toBeNull();
            const stderr = app.errorOutput();
            expect(stderr, `stderr must name the refused switch:\n${app.describe()}`).toContain(
              '--remote-debugging-port',
            );
            expect(stderr, `stderr must name the variable that enables it:\n${app.describe()}`).toContain(
              packagedCdpVariableName,
            );
          } finally {
            await app.stop();
          }
        },
      );

      // TST-009; issue #18 acceptance criterion 5: the port-0 form the gates and the harness use
      it(
        `TST-009: without ${packagedCdpVariableName}, --remote-debugging-port=0 writes no DevToolsActivePort and the packaged app exits non-zero`,
        slow,
        async () => {
          const app = startPackagedCopy(['--remote-debugging-port=0'], undefined);
          try {
            const exitCode = await waitForAppExit(app, refusalExitMs);
            expect(
              existsSync(join(app.userDataDir, 'DevToolsActivePort')),
              `the refused app must not write DevToolsActivePort:\n${app.describe()}`,
            ).toBe(false);
            expect(app.output()).not.toMatch(devToolsListening);
            expect(exitCode, `the refused app must exit within ${refusalExitMs} ms:\n${app.describe()}`).not.toBeNull();
            expect(exitCode, app.describe()).not.toBe(0);
          } finally {
            await app.stop();
          }
        },
      );

      // TST-009; issue #18 acceptance criterion 6 (control for the refusals above)
      it(
        `TST-009: with ${packagedCdpVariableName}=${packagedCdpEnabledValue}, the packaged app answers on 127.0.0.1 at the requested port and lists its window`,
        slow,
        async () => {
          const port = await findFreeLoopbackPort();
          const app = startPackagedCopy([`--remote-debugging-port=${port}`], packagedCdpEnabledValue);
          try {
            const reported = await app.waitForDevToolsPort(launchTimeoutMs);
            expect(reported, 'the app must open the requested port').toBe(port);
            const answer = await probeDebugEndpoint('127.0.0.1', port);
            expect(answer.answered, `the DevTools endpoint must answer: ${answer.detail}`).toBe(true);
            await expect
              .poll(async () => (await listDevToolsTargets(port)).filter((target) => target.type === 'page').length, {
                timeout: 30_000,
              })
              .toBeGreaterThan(0);
          } finally {
            await app.stop();
          }
        },
      );

      // TST-009, PLT-008; issue #18 acceptance criterion 7: no Node debugger in a packaged build, with or without the variable
      it.each([
        ['--inspect', 'not set'],
        ['--inspect-brk', 'not set'],
        ['--inspect', `set to ${packagedCdpEnabledValue}`],
        ['--inspect-brk', `set to ${packagedCdpEnabledValue}`],
      ])(
        `PLT-008: a packaged app started with %s=<free port> and ${packagedCdpVariableName} %s starts no debugger on that port`,
        slow,
        async (inspectSwitch, setting) => {
          const port = await findFreeLoopbackPort();
          const enabled = setting !== 'not set';
          const app = startPackagedCopy([`${inspectSwitch}=${port}`], enabled ? packagedCdpEnabledValue : undefined);
          try {
            const watch = await watchDebugEndpoint(app, port, { windowMs: inspectWatchMs });
            expect(
              watch.answers,
              `no debugger may answer on 127.0.0.1:${port} (${watch.probes} probes):\n${app.describe()}`,
            ).toEqual([]);
            expect(app.output(), app.describe()).not.toMatch(nodeInspectorListening);
          } finally {
            await app.stop();
          }
        },
      );

      // TST-009, PLT-008; issue #18 reading 13 (reviewer finding 2): the port listens on localhost only,
      // so a non-loopback address is refused even when the variable enables the port.
      it(
        `TST-009: with ${packagedCdpVariableName}=${packagedCdpEnabledValue}, a packaged app started with --remote-debugging-address=0.0.0.0 --remote-debugging-port=<free port> never answers on that port, writes no DevToolsActivePort, names the refused address switch on stderr and exits non-zero`,
        slow,
        async () => {
          const port = await findFreeLoopbackPort();
          const app = startPackagedCopy(
            ['--remote-debugging-address=0.0.0.0', `--remote-debugging-port=${port}`],
            packagedCdpEnabledValue,
          );
          try {
            const watch = await watchDebugEndpoint(app, port, { windowMs: refusalExitMs });
            expect(
              watch.answers,
              `no DevTools endpoint may answer on 127.0.0.1:${port} (${watch.probes} probes in ${watch.elapsedMs} ms):\n${app.describe()}`,
            ).toEqual([]);
            const reachable: string[] = [];
            for (const address of listNonLoopbackIpv4Addresses()) {
              const answer = await probeDebugEndpoint(address, port, 1_000);
              if (answer.answered) reachable.push(`${address}:${port} ${answer.detail}`);
            }
            expect(reachable, `no DevTools endpoint may answer on another address:\n${app.describe()}`).toEqual([]);
            expect(
              existsSync(join(app.userDataDir, 'DevToolsActivePort')),
              `the refused app must not write DevToolsActivePort:\n${app.describe()}`,
            ).toBe(false);
            expect(app.output(), 'Chromium must not report an open DevTools endpoint').not.toMatch(devToolsListening);
            const exitCode = await waitForAppExit(app, 5_000);
            expect(exitCode, `the refused app must exit within ${refusalExitMs} ms:\n${app.describe()}`).not.toBeNull();
            expect(exitCode, `the refused app must exit with a non-zero code:\n${app.describe()}`).not.toBe(0);
            expect(app.errorOutput(), `stderr must name the refused switch:\n${app.describe()}`).toContain(
              '--remote-debugging-address',
            );
          } finally {
            await app.stop();
          }
        },
      );

      // TST-009; issue #18 reading 13 (control for the refusal above): a loopback address is allowed
      it(
        `TST-009: with ${packagedCdpVariableName}=${packagedCdpEnabledValue}, a packaged app started with --remote-debugging-address=127.0.0.1 answers on 127.0.0.1 at the requested port`,
        slow,
        async () => {
          const port = await findFreeLoopbackPort();
          const app = startPackagedCopy(
            ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`],
            packagedCdpEnabledValue,
          );
          try {
            const reported = await app.waitForDevToolsPort(launchTimeoutMs);
            expect(reported, 'the app must open the requested port').toBe(port);
            const answer = await probeDebugEndpoint('127.0.0.1', port);
            expect(answer.answered, `the DevTools endpoint must answer: ${answer.detail}`).toBe(true);
          } finally {
            await app.stop();
          }
        },
      );

      // TST-009, PLT-008; issue #18 reading 12 (reviewer finding 2): the guard refuses the inspector switches the
      // EnableNodeCliInspectArguments fuse already ignores. The fuse stops the debugger but never exits the app,
      // so the non-zero exit and the refusal on stderr come from the guard alone. The variable is set to 1,
      // so only the inspector rule can refuse the launch.
      it.each([['--inspect-port'], ['--inspect-publish-uid']])(
        `PLT-008: a packaged app started with %s and ${packagedCdpVariableName}=${packagedCdpEnabledValue} starts no debugger, names the refused switch on stderr and exits non-zero`,
        slow,
        async (inspectSwitch) => {
          const port = await findFreeLoopbackPort();
          const value = inspectSwitch === '--inspect-port' ? String(port) : 'stderr,http';
          const app = startPackagedCopy([`${inspectSwitch}=${value}`], packagedCdpEnabledValue);
          try {
            const watch = await watchDebugEndpoint(app, port, { windowMs: refusalExitMs });
            expect(
              watch.answers,
              `no debugger may answer on 127.0.0.1:${port} (${watch.probes} probes):\n${app.describe()}`,
            ).toEqual([]);
            expect(app.output(), app.describe()).not.toMatch(nodeInspectorListening);
            const exitCode = await waitForAppExit(app, 5_000);
            expect(exitCode, `the refused app must exit within ${refusalExitMs} ms:\n${app.describe()}`).not.toBeNull();
            expect(exitCode, `the refused app must exit with a non-zero code:\n${app.describe()}`).not.toBe(0);
            expect(app.errorOutput(), `stderr must name the refused switch:\n${app.describe()}`).toContain(
              inspectSwitch,
            );
          } finally {
            await app.stop();
          }
        },
      );
    });

    // PLT-012, TST-009, TST-010; issue #18: the security baseline smoke tests pass through the harness in a packaged build
    it.skipIf(process.platform === 'win32')(
      `PLT-012: pnpm run smoke passes through the harness against the packaged copy with ${packagedCdpVariableName}=${packagedCdpEnabledValue} (skipped on Windows: ADR 0011, #39)`,
      { timeout: 900_000 },
      () => {
        const copy = requirePackagedCopy();
        const result = runRepoCommand('pnpm', ['run', 'smoke'], {
          cwd: root,
          timeoutMs: 840_000,
          env: { [smokeAppExecutableVariable]: copy.executablePath, ...packagedCdpEnabledEnv },
        });
        expect(result.exitCode, describeRepoCommand(result)).toBe(0);
        expect(result.output, describeRepoCommand(result)).toContain('security-baseline.smoke.test.ts');
        expect(result.output, describeRepoCommand(result)).not.toMatch(/no test files found/i);
      },
    );

    describe('app:// failure modes in the packaged app', () => {
      interface ProbeContext {
        readonly mainUrl: string;
        readonly host: string;
        /** `app://<host>/<folder of the main page>/` */
        readonly baseUrl: string;
        readonly asarPackageJsonPath: string;
        readonly rendererAssetMarkers: readonly string[];
      }

      let probeContext: ProbeContext | undefined;

      async function requireProbeContext(): Promise<ProbeContext> {
        if (!probeContext) {
          const { windows } = await ensurePackagedWindow();
          const copy = requirePackagedCopy();
          const mainUrl = windows[0]?.url ?? '';
          const parsed = new URL(mainUrl);
          const files = listAsarFiles(copy.asarPath);
          // Hashed asset names from every built index.html: they appear in the page HTML only when index.html is served.
          const rendererAssetMarkers = files
            .filter((file) => /^\/\.vite\/renderer\/[^/]+\/index\.html$/.test(file))
            .flatMap((file) => [
              ...readAsarFile(copy.asarPath, file)
                .toString('utf8')
                .matchAll(/assets\/[\w.-]+\.(?:js|css)/g),
            ])
            .map((match) => match[0]);
          probeContext = {
            mainUrl,
            host: parsed.host,
            baseUrl: `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/[^/]*$/, '')}`,
            asarPackageJsonPath: join(copy.asarPath, 'package.json'),
            rendererAssetMarkers,
          };
          expect(rendererAssetMarkers.length, 'the built index.html must reference hashed assets').toBeGreaterThan(0);
        }
        return probeContext;
      }

      /** What the window shows for `url`; `servedPackageJson` is true when the asar package.json reached the page. */
      async function probe(
        url: string,
      ): Promise<{ url: string; servedPackageJson: boolean; servedIndex: boolean; summary: string }> {
        const { session } = await ensurePackagedWindow();
        const context = await requireProbeContext();
        const shown = await session.navigate(url);
        const servedPackageJson = /"main"\s*:\s*"\.vite\/build\/main\.cjs"/.test(shown.html);
        const servedIndex = context.rendererAssetMarkers.some((marker) => shown.html.includes(marker));
        return {
          url,
          servedPackageJson,
          servedIndex,
          summary: `${url} -> ${shown.href} ${shown.errorText ?? ''} ${JSON.stringify(shown.text.slice(0, 200))}`,
        };
      }

      afterAll(async () => {
        // Leave the window on its main page.
        if (probeContext && packagedWindow) {
          const window = await packagedWindow.catch(() => undefined);
          await window?.session.navigate(probeContext.mainUrl).catch(() => undefined);
        }
      }, 60_000);

      const traversalForms: ReadonlyArray<[string, string]> = [
        ['.. segments', '../'],
        ['%2e%2e segments', '%2e%2e/'],
        ['.. with an encoded slash', '..%2f'],
        ['%2e%2e with an encoded slash', '%2e%2e%2f'],
        ['.. with an encoded backslash', '..%5c'],
        ['double-encoded traversal', '%252e%252e%252f'],
      ];

      // PLT-008; issue #15 acceptance criterion 5 (each failure mode tested)
      it.each(traversalForms)(
        'PLT-008: traversal with %s does not reach app.asar/package.json from the packaged page',
        slow,
        async (_label, step) => {
          const { baseUrl } = await requireProbeContext();
          for (let depth = 1; depth <= 4; depth += 1) {
            const result = await probe(`${baseUrl}${step.repeat(depth)}package.json`);
            expect(result.servedPackageJson, `must be refused: ${result.summary}`).toBe(false);
          }
        },
      );

      // PLT-008; issue #15 acceptance criterion 5
      it(
        'PLT-008: an absolute path to app.asar/package.json, raw or encoded, is refused in the packaged app',
        slow,
        async () => {
          const { host, asarPackageJsonPath } = await requireProbeContext();
          const forward = asarPackageJsonPath.split('\\').join('/');
          for (const url of [
            `app://${host}/${forward}`,
            `app://${host}/${encodeURIComponent(asarPackageJsonPath)}`,
            `app://${host}/${encodeURIComponent(forward)}`,
          ]) {
            const result = await probe(url);
            expect(result.servedPackageJson, `must be refused: ${result.summary}`).toBe(false);
          }
        },
      );

      // PLT-008; issue #15 acceptance criterion 5
      it.each([
        ['another name', 'rf-gate-unknown-host'],
        ['a longer name', '{host}-evil'],
      ])(
        'PLT-008: an unknown host (%s) does not serve the renderer in the packaged app',
        slow,
        async (_label, hostPattern) => {
          const { host, mainUrl } = await requireProbeContext();
          const otherHost = hostPattern.replace('{host}', host);
          const parsed = new URL(mainUrl);
          const result = await probe(`app://${otherHost}${parsed.pathname}`);
          expect(result.servedIndex, `must be refused: ${result.summary}`).toBe(false);
        },
      );

      // Control: the probes can see served content.
      it('PLT-008: control: the same probe sees the renderer at the main window URL', slow, async () => {
        const { mainUrl } = await requireProbeContext();
        const result = await probe(mainUrl);
        expect(result.servedIndex, `the main page must be served: ${result.summary}`).toBe(true);
      });
    });
  });

  describe('electron-forge make (zip)', () => {
    let makeResult: RepoCommandResult | undefined;

    function ensureMade(): RepoCommandResult {
      requireReferenceApp();
      makeResult ??= pnpmInReferenceApp(['run', 'make']);
      return makeResult;
    }

    /** Every .zip under out/make, as paths. */
    function listMadeZips(): string[] {
      const zips: string[] = [];
      const stack = [join(forgeOutDir, 'make')];
      while (stack.length > 0) {
        const dir = stack.pop() as string;
        if (!existsSync(dir)) continue;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) stack.push(path);
          else if (entry.name.endsWith('.zip')) zips.push(path);
        }
      }
      return zips;
    }

    // PLT-007; issue #15 acceptance criterion 7
    it('PLT-007: pnpm run make (electron-forge make) exits 0', slow, () => {
      const result = ensureMade();
      expect(result.exitCode, describeRepoCommand(result)).toBe(0);
    });

    // PLT-007; issue #15 acceptance criterion 7
    it(
      `PLT-007: make writes a zip for ${process.platform}-${process.arch} that holds the app executable and app.asar`,
      slow,
      () => {
        const result = ensureMade();
        if (result.exitCode !== 0)
          throw new Error(`electron-forge make failed, so this check cannot run:\n${describeRepoCommand(result)}`);
        const zips = listMadeZips().filter(
          (zip) => zip.split(/[\\/]/).includes(process.platform) || zip.includes(`-${process.platform}-`),
        );
        expect(
          zips,
          `out/make must hold a zip for ${process.platform}; found ${JSON.stringify(listMadeZips())}`,
        ).not.toEqual([]);
        const layout = readPackagedAppLayout(findPackagedAppDir(forgeOutDir));
        const executableEntry = relative(layout.rootDir, layout.executablePath).split('\\').join('/');
        const entries = zips.flatMap((zip) => listZipEntries(zip));
        // JSON-quoted so a backslash separator is visible; ZIP entry names use '/' (APPNOTE 4.4.17).
        const shownEntries = `zips ${JSON.stringify(zips)}; first 50 of ${entries.length} entries ${JSON.stringify(entries.slice(0, 50))}; entries containing "asar" ${JSON.stringify(entries.filter((entry) => entry.includes('asar')))}`;
        expect(
          entries.some((entry) => entry.endsWith(executableEntry)),
          `a zip must hold ${executableEntry}; ${shownEntries}`,
        ).toBe(true);
        expect(
          entries.some((entry) => entry.endsWith('/app.asar')),
          `a zip must hold app.asar; ${shownEntries}`,
        ).toBe(true);
      },
    );
  });
});
