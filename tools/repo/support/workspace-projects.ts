// Test-only helper for the repo gate tests (#12). Asks pnpm which workspace
// projects exist, so the tests use the same answer as `pnpm install`.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
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

export function listWorkspaceProjects(workspaceDir: string): WorkspaceProject[] {
  // pnpm prints real paths; resolve symlinks (for example macOS /var -> /private/var) to match.
  const workspaceRootDir = existsSync(workspaceDir) ? realpathSync(workspaceDir) : workspaceDir;
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
    const relativeDir = relative(workspaceRootDir, entry.path).split('\\').join('/') || '.';
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
