// Test-only helper for the token pipeline gates (#19). It runs `tz build` the
// way a developer runs it in packages/foundation, but on a copy of a token
// system in a fresh temporary folder:
// - the token files are copied with their folder layout kept,
// - packages/foundation/terrazzo.config.ts is copied unchanged beside them,
// - `node_modules` links to packages/foundation/node_modules, so the config
//   resolves its packages (Terrazzo, the profile plugin) as it does in place.
// Terrazzo resolves `tokens` and `outDir` against the working folder, so the
// build reads the copied tokens and writes `generated/` inside the copy.
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRepoCommand, type RepoCommandResult } from '../../../../../tools/test-support/run-repo-command';

/** Absolute path of packages/foundation. */
export const foundationDir = fileURLToPath(new URL('../../../', import.meta.url));

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
 * Makes a fresh build folder: the chosen token files, a copy of
 * packages/foundation/terrazzo.config.ts and a `node_modules` link.
 * Throws with the contract text when the foundation has no config yet.
 */
export function createTokenBuildDir(options: TokenBuildDirOptions): string {
  if (!existsSync(foundationTerrazzoConfigPath)) {
    throw new Error(
      'packages/foundation/terrazzo.config.ts must exist: `tz build` in packages/foundation runs the profile plugin (TOK-111, TOK-112)',
    );
  }
  const buildDir = realpathSync(mkdtempSync(join(tmpdir(), 'token-pipeline-gate-')));
  createdBuildDirs.push(buildDir);
  for (const file of options.files ?? listFilesRelative(options.sourceDir)) {
    const target = join(buildDir, ...file.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(options.sourceDir, ...file.split('/')), target);
  }
  copyFileSync(foundationTerrazzoConfigPath, join(buildDir, 'terrazzo.config.ts'));
  symlinkSync(
    join(foundationDir, 'node_modules'),
    join(buildDir, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  return buildDir;
}

/** Removes every build folder this module made. Call from `afterAll`. */
export function removeTokenBuildDirs(): void {
  for (const dir of createdBuildDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
