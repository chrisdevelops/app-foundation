// Test-only helper for the repo gate tests (#12). Asks pnpm which workspace
// projects exist, so the tests use the same answer as `pnpm install`.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { describeRepoCommand, runRepoCommand } from './run-repo-command';

export interface WorkspaceProject {
  readonly name: string | undefined;
  /** Absolute directory of the project. */
  readonly dir: string;
  /** Directory relative to the workspace root, with `/` separators; `.` for the root. */
  readonly relativeDir: string;
  /** Absolute path of the project's package.json. */
  readonly manifestPath: string;
}

/**
 * The canonical form of an existing path, so two spellings of one folder
 * compare equal. Uses the operating system's resolver: it follows symlinks
 * (macOS /var -> /private/var) and, on Windows, expands 8.3 short names
 * (RUNNER~1 -> runneradmin), which the JavaScript realpathSync does not (#13).
 */
export function resolveCanonicalPath(path: string): string {
  return existsSync(path) ? realpathSync.native(path) : path;
}

/**
 * A path relative to the workspace root, with `/` separators; `.` for the
 * root. Throws when the path is outside the root, so a path mismatch shows
 * up as a clear error and never as a wrong relative path.
 */
export function toWorkspaceRelativePath(
  workspaceRootDir: string,
  path: string,
  pathRelative: (from: string, to: string) => string = relative,
  pathIsAbsolute: (path: string) => boolean = isAbsolute,
): string {
  const relativePath = pathRelative(workspaceRootDir, path);
  if (relativePath === '..' || /^\.\.[\\/]/.test(relativePath) || pathIsAbsolute(relativePath)) {
    throw new Error(`${path} is not inside the workspace root ${workspaceRootDir}`);
  }
  return relativePath.split('\\').join('/') || '.';
}

export function listWorkspaceProjects(workspaceDir: string): WorkspaceProject[] {
  // pnpm prints real paths; compare canonical paths on both sides.
  const workspaceRootDir = resolveCanonicalPath(workspaceDir);
  if (!existsSync(join(workspaceRootDir, 'package.json'))) {
    throw new Error(`No root package.json in ${workspaceRootDir}: the pnpm workspace does not exist`);
  }
  if (!existsSync(join(workspaceRootDir, 'pnpm-workspace.yaml'))) {
    throw new Error(`No pnpm-workspace.yaml in ${workspaceRootDir}: the pnpm workspace does not exist`);
  }
  const result = runRepoCommand('pnpm', ['ls', '--recursive', '--depth', '-1', '--json'], {
    cwd: workspaceRootDir,
  });
  if (result.exitCode !== 0) {
    throw new Error(`pnpm could not list the workspace projects:\n${describeRepoCommand(result)}`);
  }
  const listed = JSON.parse(result.stdout) as Array<{ name?: string; path: string }>;
  return listed.map((entry) => {
    const relativeDir = toWorkspaceRelativePath(workspaceRootDir, resolveCanonicalPath(entry.path));
    return {
      name: entry.name,
      dir: entry.path,
      relativeDir,
      manifestPath: join(entry.path, 'package.json'),
    };
  });
}

export function readPackageManifest(manifestPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
}
