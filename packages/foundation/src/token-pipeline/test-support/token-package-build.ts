// Test-only helper for the token pipeline gates of #20 (TOK-155, TOK-176,
// TOK-177). It runs a package's own token build script (`pnpm run
// tokens:build`) in a scratch package below packages/foundation/node_modules/.cache/,
// the same way as `runFoundationTokensBuildInScratchCopy` in token-build.ts
// (#19): no `node_modules` link (Windows, #19 attempt 2), and no tracked file
// is removed, moved or written.
//
// Two package shapes:
// - Foundation shape: packages/foundation's package.json and terrazzo.config.ts,
//   unchanged, beside a copy of a token system.
// - App shape: an app package (apps/<app>/) whose terrazzo.config.ts uses the
//   profile through the @foundation/config exports, as token-profile-plugin.ts
//   documents, and whose `tokens:build` script is the foundation's. Its
//   resolver also names a file outside the app package but inside the
//   monorepo, as an app resolver names foundation files (spike #7 result 8).
//
// The build boundary is the package script, not the `tz` bin: the error
// wrapper (ADR 0004 decision 6) may sit in the script's command or in the
// profile, but it may rely only on what a package holds (package.json,
// terrazzo.config.ts, token files) and on its dependencies.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative } from 'node:path';
import {
  repoGateRootDir,
  runRepoCommand,
  type RepoCommandResult,
} from '../../../../../tools/test-support/run-repo-command';
import {
  foundationDir,
  foundationTerrazzoConfigPath,
  listFilesRelative,
  resolveFoundationTzBin,
  tokenBuildScratchDir,
} from './token-build';

const createdDirs: string[] = [];

/** Removes every folder this module made. Call from `afterAll`. */
export function removeTokenPackageDirs(): void {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

function makeScratchDir(prefix: string): string {
  mkdirSync(tokenBuildScratchDir, { recursive: true });
  const dir = mkdtempSync(join(tokenBuildScratchDir, prefix));
  createdDirs.push(dir);
  return dir;
}

function copyFiles(sourceDir: string, targetDir: string, files: readonly string[]): void {
  for (const file of files) {
    const target = join(targetDir, ...file.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(sourceDir, ...file.split('/')), target);
  }
}

/** Reads a JSON file of a package, changes it and writes it back. */
export function editPackageJson(packageDir: string, file: string, change: (json: unknown) => void): void {
  const path = join(packageDir, ...file.split('/'));
  const json: unknown = JSON.parse(readFileSync(path, 'utf8'));
  change(json);
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}

/**
 * Reads a text file of a package, changes the raw text and writes it back.
 * For token files that `JSON.parse` cannot round-trip: comments, duplicate keys.
 */
export function editPackageText(packageDir: string, file: string, change: (text: string) => string): void {
  const path = join(packageDir, ...file.split('/'));
  writeFileSync(path, change(readFileSync(path, 'utf8')));
}

/** Writes a new file into a package (`file` relative to the package, with `/`). */
export function writePackageFile(packageDir: string, file: string, text: string): void {
  const path = join(packageDir, ...file.split('/'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/**
 * A scratch package in the foundation shape: packages/foundation/package.json
 * and terrazzo.config.ts, unchanged, plus every file of `sourceDir`.
 */
export function createFoundationShapedPackage(sourceDir: string): string {
  const packageDir = makeScratchDir('package-');
  copyFiles(sourceDir, packageDir, listFilesRelative(sourceDir));
  copyFileSync(join(foundationDir, 'package.json'), join(packageDir, 'package.json'));
  copyFileSync(foundationTerrazzoConfigPath, join(packageDir, 'terrazzo.config.ts'));
  return packageDir;
}

/**
 * An app terrazzo.config.ts that uses the profile as token-profile-plugin.ts
 * documents, with `tokensEntries` as its `tokens` field, written as given.
 */
export function appTerrazzoConfigSourceWithTokens(tokensEntries: readonly string[]): string {
  return `// App-shaped token build for the #20 gates: the app uses the token profile
// through the @foundation/config exports.
import { defineConfig } from '@terrazzo/cli';
import css from '@terrazzo/plugin-css';
import { tokenProfileCssPluginOptions, tokenProfilePlugin } from '@foundation/config/token-profile-plugin';

export default defineConfig({
  tokens: [${tokensEntries.map((entry) => `'${entry}'`).join(', ')}],
  outDir: './generated/',
  plugins: [css(tokenProfileCssPluginOptions), tokenProfilePlugin({ packageRoot: new URL('./', import.meta.url) })],
});
`;
}

/** The app package's terrazzo.config.ts: the profile as token-profile-plugin.ts documents its use. */
export const appTerrazzoConfigSource = appTerrazzoConfigSourceWithTokens(['./tokens/app.resolver.json']);

/**
 * Replaces an app package's terrazzo.config.ts with one whose `tokens` field
 * is `tokensEntries` (finding 2 of #20 review 1: `config.tokens` entries are
 * checked like resolver `$ref`s). Entries must not hold `'` or `\`.
 */
export function setAppConfigTokens(appDir: string, tokensEntries: readonly string[]): void {
  for (const entry of tokensEntries) {
    if (/['\\]/.test(entry)) throw new Error(`test precondition: no quote or backslash in ${entry}`);
  }
  writeFileSync(join(appDir, 'terrazzo.config.ts'), appTerrazzoConfigSourceWithTokens(tokensEntries));
}

/** The shared file that the app resolver names outside the app package (relative to the scratch root). */
export const appSharedFile = 'foundation/tokens/ref/color.tokens.json';

export interface AppShapedPackage {
  /** Scratch root: holds `foundation/` and `apps/demo/`, like the monorepo. */
  readonly rootDir: string;
  /** The app package: `<rootDir>/apps/demo`. */
  readonly appDir: string;
}

interface PackageManifest {
  readonly scripts?: Record<string, string>;
}

/**
 * A scratch app package built from a token system in the foundation layout
 * (`tokens/ui.resolver.json`, `tokens/ref/color.tokens.json`, ...):
 * - `<root>/foundation/tokens/ref/color.tokens.json` is the system's colour file;
 * - `<root>/apps/demo/` holds every other file, the resolver as
 *   `tokens/app.resolver.json` with the colour `$ref` pointing to
 *   `../../../foundation/tokens/ref/color.tokens.json`, a package.json whose
 *   `tokens:build` script is the foundation's, and `appTerrazzoConfigSource`.
 */
export function createAppShapedPackage(sourceDir: string): AppShapedPackage {
  const rootDir = makeScratchDir('app-');
  const appDir = join(rootDir, 'apps', 'demo');
  const colourFile = 'tokens/ref/color.tokens.json';
  const resolverFile = 'tokens/ui.resolver.json';
  const files = listFilesRelative(sourceDir);
  mkdirSync(dirname(join(rootDir, ...appSharedFile.split('/'))), { recursive: true });
  copyFileSync(join(sourceDir, ...colourFile.split('/')), join(rootDir, ...appSharedFile.split('/')));
  copyFiles(
    sourceDir,
    appDir,
    files.filter((file) => file !== colourFile && file !== resolverFile),
  );
  const resolverText = readFileSync(join(sourceDir, ...resolverFile.split('/')), 'utf8');
  const colourRef = '"ref/color.tokens.json"';
  if (!resolverText.includes(colourRef)) {
    throw new Error(`fixture precondition: ${resolverFile} names ${colourRef}`);
  }
  mkdirSync(join(appDir, 'tokens'), { recursive: true });
  writeFileSync(
    join(appDir, 'tokens', 'app.resolver.json'),
    resolverText.replace(colourRef, '"../../../foundation/tokens/ref/color.tokens.json"'),
  );
  const foundationManifest = JSON.parse(readFileSync(join(foundationDir, 'package.json'), 'utf8')) as PackageManifest;
  const tokensBuildScript = foundationManifest.scripts?.['tokens:build'];
  if (!tokensBuildScript) throw new Error('packages/foundation/package.json must have a tokens:build script (TOK-111)');
  writeFileSync(
    join(appDir, 'package.json'),
    `${JSON.stringify(
      {
        name: '@foundation/token-gate-app',
        version: '0.0.0',
        private: true,
        type: 'module',
        scripts: { 'tokens:build': tokensBuildScript },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(appDir, 'terrazzo.config.ts'), appTerrazzoConfigSource);
  return { rootDir, appDir };
}

export interface TokenPackageBuildResult {
  readonly packageDir: string;
  readonly run: RepoCommandResult;
  /** Files below `generated/` after the build, relative to the package, with `/`. */
  readonly generatedFiles: readonly string[];
  /** generated/tokens.css, or undefined when the build wrote none. */
  readonly tokensCss: string | undefined;
}

/** Runs the package's own `pnpm run tokens:build` in `packageDir`. */
export function runTokensBuildScript(packageDir: string, env?: Record<string, string>): TokenPackageBuildResult {
  const run = runRepoCommand('pnpm', ['run', 'tokens:build'], { cwd: packageDir, env, timeoutMs: 180_000 });
  const generatedFiles = listFilesRelative(packageDir).filter((file) => file.startsWith('generated/'));
  let tokensCss: string | undefined;
  try {
    tokensCss = readFileSync(join(packageDir, 'generated', 'tokens.css'), 'utf8');
  } catch {
    tokensCss = undefined;
  }
  return { packageDir, run, generatedFiles, tokensCss };
}

/** Text for assertion messages: the command, its exit code, and stdout and stderr apart. */
export function describePackageBuild(result: TokenPackageBuildResult): string {
  const tail = (text: string): string => (text.length > 4000 ? `...${text.slice(-4000)}` : text);
  return [
    `\`${result.run.command}\` in ${result.packageDir} exited ${result.run.exitCode}`,
    `--- stdout:\n${tail(result.run.stdout.trim())}`,
    `--- stderr:\n${tail(result.run.stderr.trim())}`,
  ].join('\n');
}

/**
 * Control build: `tz build` in `packageDir` with a config that has
 * @terrazzo/plugin-css and no token profile. It shows what Terrazzo does on
 * its own with the same token files (spike #7 result 9), so a gate can show
 * that its probe (server, read trace) sees Terrazzo's requests and reads.
 */
export function runTerrazzoWithoutProfile(
  packageDir: string,
  resolverFile: string,
  env?: Record<string, string>,
): RepoCommandResult {
  return runTerrazzoWithoutProfileOnTokens(packageDir, [`./${resolverFile}`], env);
}

/**
 * Control build as `runTerrazzoWithoutProfile`, with `tokensEntries` as the
 * config's `tokens` field, written as given (a URL, a relative path, ...).
 */
export function runTerrazzoWithoutProfileOnTokens(
  packageDir: string,
  tokensEntries: readonly string[],
  env?: Record<string, string>,
): RepoCommandResult {
  const configFile = 'control-without-profile.terrazzo.config.ts';
  writeFileSync(
    join(packageDir, configFile),
    [
      "import { defineConfig } from '@terrazzo/cli';",
      "import css from '@terrazzo/plugin-css';",
      '',
      'export default defineConfig({',
      `  tokens: [${tokensEntries.map((entry) => JSON.stringify(entry)).join(', ')}],`,
      "  outDir: './control-generated/',",
      '  plugins: [css({ skipBuild: true })],',
      '});',
      '',
    ].join('\n'),
  );
  return runRepoCommand(process.execPath, [resolveFoundationTzBin(), 'build', '--config', configFile], {
    cwd: packageDir,
    env,
    timeoutMs: 180_000,
  });
}

/** Is `path` inside the repository checkout? */
export function isInsideRepo(path: string): boolean {
  const fromRoot = relative(realpathSync(repoGateRootDir), path);
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
}

/**
 * A fresh folder outside the repository checkout (real path, no symlinks),
 * for `$ref` targets that escape the repo root. It is below the system
 * temporary folder, or beside the checkout when the temporary folder is on
 * another drive (Windows), so a relative path from the checkout reaches it.
 */
export function createOutsideRepoDir(): string {
  const repoRoot = realpathSync(repoGateRootDir);
  const temp = realpathSync(tmpdir());
  const base = parse(temp).root.toLowerCase() === parse(repoRoot).root.toLowerCase() ? temp : dirname(repoRoot);
  const dir = realpathSync(mkdtempSync(join(base, 'token-gate-outside-repo-')));
  createdDirs.push(dir);
  if (isInsideRepo(dir)) throw new Error(`test precondition: ${dir} must be outside the checkout ${repoRoot}`);
  return dir;
}

/** The `$ref` text from a resolver in `resolverDir` to `target`: relative, with `/`. */
export function relativeRefFrom(resolverDir: string, target: string): string {
  const ref = relative(realpathSync(resolverDir), target).split('\\').join('/');
  if (isAbsolute(ref)) throw new Error(`test precondition: no relative path from ${resolverDir} to ${target}`);
  return ref;
}

/** An absolute path as a `$ref` would carry it: the native path with `/`. */
export function absoluteRefOf(target: string): string {
  return target.split('\\').join('/');
}

export interface FsReadTrace {
  /** Environment for the build: NODE_OPTIONS loads the trace preload. */
  readonly env: Record<string, string>;
  /** The trace lines so far: `<function> <path>` for each read of a watched file. */
  lines(): string[];
}

/**
 * Watches reads of `paths` in every Node process of a build (pnpm, `tz`, and
 * any process they start), through test-support/fs-read-trace-preload.ts.
 */
export function createFsReadTrace(paths: readonly string[]): FsReadTrace {
  const logDir = makeScratchDir('fs-trace-');
  const logPath = join(logDir, 'reads.log');
  writeFileSync(logPath, '');
  const preloadUrl = new URL('./fs-read-trace-preload.ts', import.meta.url).href;
  const inherited = process.env.NODE_OPTIONS?.trim();
  return {
    env: {
      NODE_OPTIONS: `${inherited ? `${inherited} ` : ''}--import=${preloadUrl}`,
      TOKEN_GATE_FS_TRACE_PATHS: JSON.stringify(paths),
      TOKEN_GATE_FS_TRACE_LOG: logPath,
    },
    lines: () =>
      readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((line) => line !== ''),
  };
}
