// Test-only helper for the packaged smoke CI gates (#17; TST-010, TST-015).
// Fake `pnpm`, `sudo` and `xvfb-run` commands for an emulated CI job
// (tools/test-support/workflow-job-emulator.ts). They record every call in a
// JSON lines log, so a gate can read what the job ran, in which order, with
// which environment, without installing, packaging or starting Electron.
//
// - `pnpm install` links the real repository's node_modules folders into the
//   emulated workspace, so scripts in the workspace can load packages.
// - `pnpm turbo ...` passes.
// - The reference app's `package` script (`pnpm --filter @foundation/reference
//   run package`, `pnpm -C apps/reference run package`, or `pnpm run package`
//   in apps/reference) writes a fake packaged app where `electron-forge
//   package` writes the real one: `apps/reference/out/<productName>-<platform>-<arch>`,
//   in the layout of the current platform, with marker files instead of
//   binaries. `FAKE_CI_PACKAGE_EXIT_CODE` makes it fail and write nothing.
// - The smoke suite (`pnpm run smoke` at the root, or the e2e package's
//   `smoke` script) records SMOKE_APP_EXECUTABLE and what that file holds at
//   the moment of the call, and the variables named in FAKE_CI_RECORD_ENV,
//   then exits with `FAKE_CI_SMOKE_EXIT_CODE`.
// - `xvfb-run [options] <command>` runs the command with DISPLAY set and
//   records that a virtual display wrapped it. `sudo` records and passes.
// - Any other pnpm call fails with exit code 97 and says so, so a gate never
//   passes on a job it cannot read.
// This file runs as a script under Node's type stripping: Node built-ins only.
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Environment variables the fake commands read. */
export const fakeCiEnvNames = {
  log: 'FAKE_CI_LOG',
  workspace: 'FAKE_CI_WORKSPACE',
  realRepoRoot: 'FAKE_CI_REAL_REPO_ROOT',
  marker: 'FAKE_CI_MARKER',
  smokeExitCode: 'FAKE_CI_SMOKE_EXIT_CODE',
  packageExitCode: 'FAKE_CI_PACKAGE_EXIT_CODE',
  virtualDisplay: 'FAKE_CI_VIRTUAL_DISPLAY',
  /** Comma-separated names of variables whose values the smoke call records. */
  recordEnv: 'FAKE_CI_RECORD_ENV',
} as const;

const unsupportedExitCode = 97;

export type PnpmInvocationKind = 'install' | 'turbo' | 'package-reference' | 'smoke' | 'unsupported';

export interface PnpmInvocation {
  readonly kind: PnpmInvocationKind;
  /** The script or command pnpm runs, for example `package` or `install`. */
  readonly script: string | undefined;
  /** The package folder the call targets, as a path. */
  readonly targetDir: string;
}

export interface FakeCiRecord {
  readonly command: 'pnpm' | 'sudo' | 'xvfb-run';
  readonly args: readonly string[];
  readonly cwd: string;
  readonly kind?: PnpmInvocationKind;
  /** SMOKE_APP_EXECUTABLE as the smoke call saw it. */
  readonly smokeAppExecutable?: string;
  /** What SMOKE_APP_EXECUTABLE named at the moment of the smoke call. */
  readonly executableAtCall?: { readonly exists: boolean; readonly isFile: boolean; readonly content: string };
  readonly display?: string;
  readonly waylandDisplay?: string;
  /** True when `xvfb-run` started this call. */
  readonly underVirtualDisplay?: boolean;
  /** Values of the variables named in FAKE_CI_RECORD_ENV, as the smoke call saw them (null when unset). */
  readonly recordedEnv?: Readonly<Record<string, string | null>>;
}

/** Folder names of the workspace packages a filter can name. */
const workspacePackageDirs: Readonly<Record<string, string>> = {
  '@foundation/reference': 'apps/reference',
  '@foundation/e2e': 'e2e',
  '@foundation/foundation': 'packages/foundation',
};

function samePath(left: string, right: string): boolean {
  const normal = (path: string): string => {
    let full = resolve(path);
    try {
      full = realpathSync.native(full);
    } catch {
      // A path that does not exist (static reading of a workflow) compares as written.
    }
    return process.platform === 'win32' ? full.toLowerCase() : full;
  };
  return normal(left) === normal(right);
}

function filterTargetDir(filter: string, workspaceDir: string): string | undefined {
  const byName = workspacePackageDirs[filter];
  if (byName) return join(workspaceDir, byName);
  if (/^\.{0,2}[\\/]|^[A-Za-z0-9_-]+[\\/]/.test(filter) || filter === 'e2e') return resolve(workspaceDir, filter);
  return undefined;
}

/**
 * What a pnpm call does, read from its arguments and the folder it starts in.
 * Recognises install, `turbo`, the reference app's `package` script and the
 * smoke suite; everything else is `unsupported`.
 */
export function parsePnpmInvocation(args: readonly string[], cwd: string, workspaceDir: string): PnpmInvocation {
  let filter: string | undefined;
  let dir: string | undefined;
  let recursive = false;
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === '--filter' || arg === '-F') {
      filter = args[index + 1];
      index += 1;
    } else if (arg.startsWith('--filter=')) {
      filter = arg.slice('--filter='.length);
    } else if (arg === '-C' || arg === '--dir') {
      dir = args[index + 1];
      index += 1;
    } else if (arg.startsWith('--dir=')) {
      dir = arg.slice('--dir='.length);
    } else if (arg === '-w' || arg === '--workspace-root') {
      dir = workspaceDir;
    } else if (arg === '-r' || arg === '--recursive') {
      recursive = true;
    } else if (arg.startsWith('-')) {
      // A boolean option such as --silent.
    } else {
      break;
    }
  }
  const command = args[index];
  const script = command === 'run' || command === 'run-script' ? args[index + 1] : command;
  let targetDir = dir === undefined ? cwd : resolve(cwd, dir);
  let filterKnown = true;
  if (filter !== undefined) {
    const fromFilter = filterTargetDir(filter, workspaceDir);
    filterKnown = fromFilter !== undefined;
    if (fromFilter) targetDir = fromFilter;
  }
  const result = (kind: PnpmInvocationKind): PnpmInvocation => ({ kind, script, targetDir });
  if (command === 'install' || command === 'i') return result(filter === undefined ? 'install' : 'unsupported');
  if (command === 'turbo') return result('turbo');
  if (recursive || !filterKnown) return result('unsupported');
  if (script === 'package' && samePath(targetDir, join(workspaceDir, 'apps', 'reference'))) {
    return result('package-reference');
  }
  if (script === 'smoke' && (samePath(targetDir, workspaceDir) || samePath(targetDir, join(workspaceDir, 'e2e')))) {
    return result('smoke');
  }
  return result('unsupported');
}

/** Removes leading `VAR=value` words, `env`, and `xvfb-run` with its options from a command line's words. */
export function stripCommandWrappers(words: readonly string[]): { words: string[]; underXvfb: boolean } {
  let rest = [...words];
  let underXvfb = false;
  for (;;) {
    if (rest[0] === 'env' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0] ?? '')) {
      rest = rest.slice(1);
      continue;
    }
    if (rest[0] === 'xvfb-run') {
      underXvfb = true;
      rest = skipXvfbOptions(rest.slice(1));
      continue;
    }
    return { words: rest, underXvfb };
  }
}

/** The command after `xvfb-run`'s own options. */
function skipXvfbOptions(args: readonly string[]): string[] {
  const withValue = new Set(['-e', '-f', '-n', '-p', '-s', '-w', '--error-file', '--auth-file', '--server-num']);
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (withValue.has(arg)) index += 1;
    else if (!arg.startsWith('-')) break;
  }
  return args.slice(index);
}

interface FakePackagedLayout {
  /** Files to write, relative to the packaged app folder, with their content. */
  readonly files: Readonly<Record<string, string>>;
  /** Relative path of the executable. */
  readonly executable: string;
  /** Symbolic links (macOS framework layout), relative path to target. */
  readonly symlinks: Readonly<Record<string, string>>;
}

/** Text of the fake executable and app.asar for one marker. */
export function fakePackagedFileText(marker: string): { executable: string; asar: string } {
  return { executable: `fake packaged executable ${marker}\n`, asar: `fake app.asar ${marker}\n` };
}

function readPackagingNames(workspaceDir: string): { productName: string; executableName: string } {
  const referenceDir = join(workspaceDir, 'apps', 'reference');
  const manifest = JSON.parse(readFileSync(join(referenceDir, 'package.json'), 'utf8')) as {
    name?: string;
    productName?: string;
  };
  const productName = manifest.productName ?? manifest.name ?? 'app';
  const forgeConfigPath = join(referenceDir, 'forge.config.ts');
  const forgeConfig = existsSync(forgeConfigPath) ? readFileSync(forgeConfigPath, 'utf8') : '';
  const executableName = /executableName:\s*['"]([^'"]+)['"]/.exec(forgeConfig)?.[1] ?? productName;
  return { productName, executableName };
}

function fakePackagedLayout(
  platform: NodeJS.Platform,
  names: { productName: string; executableName: string },
  marker: string,
): FakePackagedLayout {
  const text = fakePackagedFileText(marker);
  const common = { LICENSE: 'fake license\n', version: '0.0.0-fake\n' };
  if (platform === 'darwin') {
    const contents = `${names.productName}.app/Contents`;
    const framework = `${contents}/Frameworks/Electron Framework.framework`;
    return {
      executable: `${contents}/MacOS/${names.executableName}`,
      files: {
        ...common,
        [`${contents}/MacOS/${names.executableName}`]: text.executable,
        [`${contents}/Resources/app.asar`]: text.asar,
        [`${contents}/Info.plist`]: 'fake plist\n',
        [`${framework}/Versions/A/Electron Framework`]: `fake framework ${marker}\n`,
      },
      symlinks: {
        [`${framework}/Versions/Current`]: 'A',
        [`${framework}/Electron Framework`]: 'Versions/Current/Electron Framework',
      },
    };
  }
  if (platform === 'win32') {
    return {
      executable: `${names.executableName}.exe`,
      files: {
        ...common,
        [`${names.executableName}.exe`]: text.executable,
        'resources/app.asar': text.asar,
        'ffmpeg.dll': 'fake dll\n',
      },
      symlinks: {},
    };
  }
  return {
    executable: names.executableName,
    files: {
      ...common,
      [names.executableName]: text.executable,
      'resources/app.asar': text.asar,
      'chrome-sandbox': 'fake sandbox\n',
      chrome_crashpad_handler: 'fake crashpad\n',
      'libffmpeg.so': 'fake library\n',
    },
    symlinks: {},
  };
}

/** Writes the fake packaged app where `electron-forge package` writes the real one. Returns its folder. */
export function writeFakePackagedApp(workspaceDir: string, marker: string): string {
  const names = readPackagingNames(workspaceDir);
  const outDir = join(workspaceDir, 'apps', 'reference', 'out');
  const appDir = join(outDir, `${names.productName}-${process.platform}-${process.arch}`);
  rmSync(appDir, { recursive: true, force: true });
  const layout = fakePackagedLayout(process.platform, names, marker);
  for (const [relativePath, content] of Object.entries(layout.files)) {
    const path = join(appDir, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  for (const [relativePath, target] of Object.entries(layout.symlinks)) {
    symlinkSync(target, join(appDir, relativePath));
  }
  const executable = join(appDir, layout.executable);
  if (process.platform !== 'win32') {
    chmodSync(executable, 0o755);
    if (process.platform === 'linux') {
      chmodSync(join(appDir, 'chrome-sandbox'), 0o755);
      chmodSync(join(appDir, 'chrome_crashpad_handler'), 0o755);
    }
  }
  return appDir;
}

/** Links each node_modules folder of the real repository into the emulated workspace, as an install would make them. */
function linkNodeModules(realRepoRoot: string, workspaceDir: string): void {
  const packageDirs = ['.', 'e2e'];
  for (const group of ['apps', 'packages']) {
    const groupDir = join(realRepoRoot, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir)) packageDirs.push(`${group}/${entry}`);
  }
  for (const packageDir of packageDirs) {
    const source = join(realRepoRoot, packageDir, 'node_modules');
    const target = join(workspaceDir, packageDir, 'node_modules');
    if (!existsSync(source) || !existsSync(join(workspaceDir, packageDir)) || existsSync(target)) continue;
    symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  }
}

/** Reads every record the fake commands wrote. */
export function readFakeCiLog(logPath: string): FakeCiRecord[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as FakeCiRecord);
}

/**
 * Writes `pnpm`, `sudo` and `xvfb-run` into `dir` (as bash scripts, and as
 * `.cmd` files on Windows) that run this file with Node. Put `dir` first on PATH.
 */
export function installFakeCiCommands(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const script = fileURLToPath(import.meta.url);
  const node = process.execPath;
  const forShell = (path: string): string => path.replace(/\\/g, '/');
  for (const command of ['pnpm', 'sudo', 'xvfb-run']) {
    const shellPath = join(dir, command);
    writeFileSync(shellPath, `#!/usr/bin/env bash\nexec "${forShell(node)}" "${forShell(script)}" ${command} "$@"\n`);
    chmodSync(shellPath, 0o755);
    if (process.platform === 'win32') {
      writeFileSync(join(dir, `${command}.cmd`), `@"${node}" "${script}" ${command} %*\r\n`);
    }
  }
}

function record(entry: FakeCiRecord): void {
  const logPath = process.env[fakeCiEnvNames.log];
  if (!logPath) throw new Error(`${fakeCiEnvNames.log} is not set`);
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function exitCodeFromEnv(name: string): number {
  const value = Number(process.env[name] ?? '0');
  return Number.isInteger(value) ? value : 0;
}

function describeFile(path: string | undefined): { exists: boolean; isFile: boolean; content: string } {
  if (!path || !existsSync(path)) return { exists: false, isFile: false, content: '' };
  const isFile = statSync(path).isFile();
  return { exists: true, isFile, content: isFile ? readFileSync(path, 'utf8').slice(0, 500) : '' };
}

function runFakePnpm(args: readonly string[]): number {
  const workspaceDir = process.env[fakeCiEnvNames.workspace] ?? '';
  const invocation = parsePnpmInvocation(args, process.cwd(), workspaceDir);
  const base = {
    command: 'pnpm' as const,
    args,
    cwd: process.cwd(),
    kind: invocation.kind,
    display: process.env.DISPLAY ?? '',
    waylandDisplay: process.env.WAYLAND_DISPLAY ?? '',
    underVirtualDisplay: process.env[fakeCiEnvNames.virtualDisplay] === '1',
  };
  if (invocation.kind === 'smoke') {
    const executable = process.env.SMOKE_APP_EXECUTABLE;
    const recordedEnv = Object.fromEntries(
      (process.env[fakeCiEnvNames.recordEnv] ?? '')
        .split(',')
        .filter((name) => name !== '')
        .map((name) => [name, process.env[name] ?? null]),
    );
    record({ ...base, smokeAppExecutable: executable, executableAtCall: describeFile(executable), recordedEnv });
    const code = exitCodeFromEnv(fakeCiEnvNames.smokeExitCode);
    console.log(code === 0 ? 'fake smoke suite: passed' : `fake smoke suite: failed (exit ${code})`);
    return code;
  }
  record(base);
  if (invocation.kind === 'install') {
    linkNodeModules(process.env[fakeCiEnvNames.realRepoRoot] ?? '', workspaceDir);
    return 0;
  }
  if (invocation.kind === 'turbo') return 0;
  if (invocation.kind === 'package-reference') {
    const code = exitCodeFromEnv(fakeCiEnvNames.packageExitCode);
    if (code !== 0) {
      console.error(`fake electron-forge package: failed (exit ${code})`);
      return code;
    }
    const appDir = writeFakePackagedApp(workspaceDir, process.env[fakeCiEnvNames.marker] ?? 'no-marker');
    console.log(`fake electron-forge package: wrote ${appDir}`);
    return 0;
  }
  console.error(
    `pnpm ${args.join(' ')} (in ${process.cwd()}) is not supported by the CI emulation of #17 (tools/repo/test-support/fake-ci-commands.ts)`,
  );
  return unsupportedExitCode;
}

function runFakeXvfb(args: readonly string[]): number {
  record({ command: 'xvfb-run', args, cwd: process.cwd() });
  const [command, ...rest] = skipXvfbOptions(args);
  if (!command) return 1;
  const result = spawnSync(command, rest, {
    stdio: 'inherit',
    env: { ...process.env, DISPLAY: ':99', [fakeCiEnvNames.virtualDisplay]: '1' },
  });
  return result.status ?? 1;
}

function main(argv: readonly string[]): number {
  const [command, ...args] = argv;
  if (command === 'pnpm') return runFakePnpm(args);
  if (command === 'xvfb-run') return runFakeXvfb(args);
  if (command === 'sudo') {
    record({ command: 'sudo', args, cwd: process.cwd() });
    return 0;
  }
  console.error(`fake CI command ${String(command)} is not known`);
  return unsupportedExitCode;
}

if (process.argv[1] !== undefined && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
