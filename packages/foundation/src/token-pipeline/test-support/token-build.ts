// Test-only helper for the token pipeline gates (#19). It runs `tz build` the
// way a developer runs it in packages/foundation, but on a copy of a token
// system in a fresh build folder:
// - the token files are copied with their folder layout kept,
// - packages/foundation/terrazzo.config.ts is copied unchanged beside them,
// - the build folder is inside packages/foundation/node_modules/.cache/, so
//   the config resolves its packages (Terrazzo, the profile plugin) through
//   packages/foundation/node_modules by the normal parent-folder lookup, as
//   it does in place. Git, ESLint, Prettier, tsc and Vitest all skip
//   node_modules, so a build folder never shows up in the other checks.
// Terrazzo resolves `tokens` and `outDir` against the working folder, so the
// build reads the copied tokens and writes `generated/` inside the copy.
//
// Why not a temporary folder with a `node_modules` link (attempt 1): on
// Windows, Vite 8 (which Terrazzo uses to load terrazzo.config.ts) resolves
// no bare import through a `node_modules` junction, so every build failed
// with "Cannot find package '@terrazzo/cli'". Probe runs on windows-latest
// showed this for a junction on C: and on D:, with short (8.3) and long
// paths; a folder below a real node_modules resolved (#19, attempt 2).
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRepoCommand, type RepoCommandResult } from '../../../../../tools/test-support/run-repo-command';

/** Absolute path of packages/foundation. */
export const foundationDir = fileURLToPath(new URL('../../../', import.meta.url));

/** Parent of every build folder: below packages/foundation/node_modules, so package lookup finds the foundation's dependencies. */
export const tokenBuildScratchDir = join(foundationDir, 'node_modules', '.cache', 'token-pipeline-gate');

/** The fixture token system, laid out like packages/foundation (tokens/ and src/components/). */
export const fixtureSystemDir = fileURLToPath(new URL('./fixture-system/', import.meta.url));

/** The committed expected tokens.css for the fixture system (gate 1). */
export const expectedFixtureTokensCssPath = fileURLToPath(new URL('./expected-tokens.css.txt', import.meta.url));

export const foundationTerrazzoConfigPath = join(foundationDir, 'terrazzo.config.ts');

const createdBuildDirs: string[] = [];

/** Every file below `dir` as a path relative to `dir` with `/` separators, skipping `node_modules`. */
export function listFilesRelative(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return found.sort();
}

/** Path → SHA-256 of every file below `dir` (except `node_modules`). */
export function hashFilesRelative(dir: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const file of listFilesRelative(dir)) {
    hashes.set(
      file,
      createHash('sha256')
        .update(readFileSync(join(dir, file)))
        .digest('hex'),
    );
  }
  return hashes;
}

export interface TokenBuildDirOptions {
  /** Folder to copy files from. */
  readonly sourceDir: string;
  /** Paths relative to `sourceDir` (with `/`) to copy. Defaults to every file. */
  readonly files?: readonly string[];
}

/**
 * Makes a fresh build folder below `tokenBuildScratchDir`: the chosen token
 * files and a copy of packages/foundation/terrazzo.config.ts.
 * Throws with the contract text when the foundation has no config yet.
 */
export function createTokenBuildDir(options: TokenBuildDirOptions): string {
  if (!existsSync(foundationTerrazzoConfigPath)) {
    throw new Error(
      'packages/foundation/terrazzo.config.ts must exist: `tz build` in packages/foundation runs the profile plugin (TOK-111, TOK-112)',
    );
  }
  if (!existsSync(join(foundationDir, 'node_modules'))) {
    throw new Error('packages/foundation/node_modules does not exist: run `pnpm install` before the token gates');
  }
  mkdirSync(tokenBuildScratchDir, { recursive: true });
  const buildDir = mkdtempSync(join(tokenBuildScratchDir, 'build-'));
  createdBuildDirs.push(buildDir);
  for (const file of options.files ?? listFilesRelative(options.sourceDir)) {
    const target = join(buildDir, ...file.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(options.sourceDir, ...file.split('/')), target);
  }
  copyFileSync(foundationTerrazzoConfigPath, join(buildDir, 'terrazzo.config.ts'));
  return buildDir;
}

/** Removes every build folder this module made. Call from `afterAll`. */
export function removeTokenBuildDirs(): void {
  for (const dir of createdBuildDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

const foundationGeneratedDir = join(foundationDir, 'generated');

/**
 * Runs the package's own token build script (`pnpm run tokens:build`, which is
 * `tz build`) in packages/foundation itself, as a developer does, and returns
 * what it wrote to generated/tokens.css.
 *
 * The committed generated/ folder is moved aside (into `tokenBuildScratchDir`)
 * for the build, so the result shows whether this run wrote tokens.css, and is
 * moved back afterwards. It is moved, never rewritten: on Windows checkouts
 * with core.autocrlf the committed files have CRLF line endings, and
 * rewriting them, even with the same bytes, changed the Turborepo hashes of
 * seven tasks (probe on windows-latest, #19 attempt 2), which broke the PLT-004
 * cache-hit gate. Moving the folder back keeps the files as they were.
 */
export function runFoundationTokensBuildInPlace(): {
  readonly run: RepoCommandResult;
  readonly tokensCss: Buffer | undefined;
} {
  mkdirSync(tokenBuildScratchDir, { recursive: true });
  const parkedDir = join(mkdtempSync(join(tokenBuildScratchDir, 'committed-generated-')), 'generated');
  const hadGenerated = existsSync(foundationGeneratedDir);
  if (hadGenerated) renameSync(foundationGeneratedDir, parkedDir);
  try {
    const run = runRepoCommand('pnpm', ['run', 'tokens:build'], { cwd: foundationDir, timeoutMs: 180_000 });
    const tokensCssPath = join(foundationGeneratedDir, 'tokens.css');
    return { run, tokensCss: existsSync(tokensCssPath) ? readFileSync(tokensCssPath) : undefined };
  } finally {
    rmSync(foundationGeneratedDir, { recursive: true, force: true });
    if (hadGenerated) renameSync(parkedDir, foundationGeneratedDir);
    rmSync(dirname(parkedDir), { recursive: true, force: true });
  }
}

interface PackageManifestWithBin {
  readonly bin?: string | Record<string, string>;
}

/** Absolute path of the `tz` bin script of the @terrazzo/cli that packages/foundation declares. */
export function resolveFoundationTzBin(): string {
  const requireFromFoundation = createRequire(join(foundationDir, 'package.json'));
  let manifestPath: string;
  try {
    manifestPath = requireFromFoundation.resolve('@terrazzo/cli/package.json');
  } catch (error) {
    throw new Error(
      `packages/foundation must declare @terrazzo/cli so that \`tz build\` runs there (TOK-001, TOK-111): ${(error as Error).message}`,
      { cause: error },
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifestWithBin;
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.tz;
  if (!bin) throw new Error(`@terrazzo/cli at ${manifestPath} has no \`tz\` bin`);
  return join(dirname(manifestPath), bin);
}

/** Runs `tz build` in `buildDir` with Node, as `pnpm exec tz build` would. */
export function runTzBuild(buildDir: string): RepoCommandResult {
  return runRepoCommand(process.execPath, [resolveFoundationTzBin(), 'build'], { cwd: buildDir, timeoutMs: 180_000 });
}

export interface TokenBuildResult {
  readonly buildDir: string;
  readonly run: RepoCommandResult;
  /** Files below the build folder before the build, with their hashes. */
  readonly filesBefore: Map<string, string>;
  /** Files below the build folder after the build, with their hashes. */
  readonly filesAfter: Map<string, string>;
  /** Contents of generated/tokens.css, or undefined when the build wrote none. */
  readonly tokensCss: Buffer | undefined;
}

/** Copies a token system into a fresh folder, runs `tz build` and collects what it wrote. */
export function buildTokenSystem(
  options: TokenBuildDirOptions & { readonly edit?: (buildDir: string) => void },
): TokenBuildResult {
  const buildDir = createTokenBuildDir(options);
  options.edit?.(buildDir);
  const filesBefore = hashFilesRelative(buildDir);
  const run = runTzBuild(buildDir);
  const filesAfter = hashFilesRelative(buildDir);
  const tokensCssPath = join(buildDir, 'generated', 'tokens.css');
  return {
    buildDir,
    run,
    filesBefore,
    filesAfter,
    tokensCss: existsSync(tokensCssPath) ? readFileSync(tokensCssPath) : undefined,
  };
}

/** Text for assertion messages: the command and the end of its output. */
export function describeBuild(result: TokenBuildResult): string {
  return `\`${result.run.command}\` in ${result.buildDir} exited ${result.run.exitCode}:\n${result.run.output.slice(-4000)}`;
}
