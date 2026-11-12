// The run-level opt-out from background mode, and the foreground test group
// runner (#46; TST-018; ADR 0013 rules 2 and 3).
//
// FOUNDATION_TEST_FOREGROUND: this file is the one definition site of the name
// (CLAUDE.md "one name, one definition site"). The smoke harness reads it from
// its own environment on every launch: only the value `1` makes the launch
// normal (no FOUNDATION_TEST_BACKGROUND); any other value keeps background mode.
//
// Foreground test group: tests that need real OS focus, native menus or native
// dialogs live in `*.foreground.gate.test.ts` files and skip themselves unless
// FOUNDATION_TEST_FOREGROUND=1. Run as a script (`pnpm run test:foreground` at
// the repository root runs `node e2e/harness/foreground-test-run.ts`), this
// file prints a notice first, then runs every `*.foreground.gate.test.ts` file
// in the repository, and no other test file, with FOUNDATION_TEST_FOREGROUND=1.
// Each file runs with the Vitest of the package that holds it (the repository
// root for tools/, e2e for e2e/). The exit code is 0 only when every run passed.
// CI runs it in the check job on all three runners (.github/workflows/ci.yml).
//
// This file runs as a script under Node's type stripping: Node built-ins only.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Run-level opt-out: with this variable set to `testForegroundEnabledValue`, test launches are normal (ADR 0013 rule 2). */
export const testForegroundVariableName = 'FOUNDATION_TEST_FOREGROUND';

/** The one value of `testForegroundVariableName` that makes test launches normal. */
export const testForegroundEnabledValue = '1';

/** True when `env` asks for normal (foreground) test launches. */
export function isForegroundTestRun(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[testForegroundVariableName] === testForegroundEnabledValue;
}

/** Suffix of every file in the foreground test group. */
const foregroundTestFileSuffix = '.foreground.gate.test.ts';

/** The line the runner prints before any test starts. */
const foregroundTestGroupNotice =
  'Foreground test group: these tests show app windows and take keyboard focus. Do not type or click until they finish (ADR 0013).';

const repoRootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const skippedDirNames = new Set(['node_modules', '.git', 'out', 'dist', '.vite', '.turbo']);

/** Every foreground test file under `dir`, as absolute paths. */
function listForegroundTestFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skippedDirNames.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listForegroundTestFiles(path));
    else if (entry.isFile() && entry.name.endsWith(foregroundTestFileSuffix)) files.push(path);
  }
  return files.sort();
}

/** The folder of the package that holds `file`: the nearest folder with a package.json. */
function findOwningPackageDir(file: string): string {
  let dir = dirname(file);
  while (dir !== repoRootDir && !existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) return repoRootDir;
    dir = parent;
  }
  return dir;
}

/** Foreground test files grouped by the package folder whose Vitest runs them. */
function groupByPackage(files: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const packageDir = findOwningPackageDir(file);
    const group = groups.get(packageDir) ?? [];
    group.push(relative(packageDir, file).split('\\').join('/'));
    groups.set(packageDir, group);
  }
  return groups;
}

/** Runs `pnpm exec vitest run` in `packageDir` for `files`; returns its exit code. */
function runVitest(packageDir: string, files: readonly string[]): number {
  const args = ['exec', 'vitest', 'run', '--reporter=default', ...files];
  const env = { ...process.env, [testForegroundVariableName]: testForegroundEnabledValue };
  // On Windows pnpm is a .cmd shim, which Node starts only through cmd.exe.
  const result =
    process.platform === 'win32'
      ? spawnSync(['pnpm', ...args].join(' '), { cwd: packageDir, env, stdio: 'inherit', shell: true })
      : spawnSync('pnpm', args, { cwd: packageDir, env, stdio: 'inherit' });
  if (result.error) {
    console.error(`could not start Vitest in ${packageDir}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

/** Prints the notice, then runs every foreground test file. Returns the exit code. */
function runForegroundTestGroup(): number {
  console.log(foregroundTestGroupNotice);
  const groups = groupByPackage(listForegroundTestFiles(repoRootDir));
  if (groups.size === 0) {
    console.error(`no *${foregroundTestFileSuffix} files found in ${repoRootDir}`);
    return 1;
  }
  let exitCode = 0;
  for (const [packageDir, files] of groups) {
    const code = runVitest(packageDir, files);
    if (code !== 0 && exitCode === 0) exitCode = code;
  }
  return exitCode;
}

/** True when Node started this file as its main script (not when the harness imports it). */
function isRunAsScript(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isRunAsScript()) process.exitCode = runForegroundTestGroup();
