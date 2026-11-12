// Test-only helper for the repo gate tests (#12). Makes a clean clone of the
// working tree (tracked and new, not-ignored files) in a temporary folder, so
// install, Turborepo and fixtures never touch the developer's checkout.
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describeRepoCommand, runRepoCommand } from './run-repo-command';

/**
 * Marker file written at the root of every clean clone. The clean-clone gate
 * suite skips itself when it finds this file, so a nested `turbo run test`
 * inside a clone never starts another clone.
 */
export const cleanCloneMarkerFileName = '.repo-gate-clean-clone';

export function isInsideCleanClone(repoRootDir: string): boolean {
  return existsSync(join(repoRootDir, cleanCloneMarkerFileName));
}

const skippedPathSegments = new Set(['node_modules', '.turbo', '.git']);

export function createCleanClone(repoRootDir: string): string {
  const listed = runRepoCommand(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: repoRootDir },
  );
  if (listed.exitCode !== 0) {
    throw new Error(`git could not list the working tree:\n${describeRepoCommand(listed)}`);
  }
  // Real path, so it matches the paths pnpm and Turborepo print.
  const cloneDir = realpathSync(mkdtempSync(join(tmpdir(), 'repo-gate-clone-')));
  const files = listed.stdout.split('\0').filter((file) => file !== '');
  for (const file of files) {
    if (file.split('/').some((segment) => skippedPathSegments.has(segment))) continue;
    if (file === cleanCloneMarkerFileName) continue;
    const source = join(repoRootDir, file);
    if (!existsSync(source)) continue; // deleted in the working tree
    const target = join(cloneDir, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
  }
  writeFileSync(join(cloneDir, cleanCloneMarkerFileName), 'Created by tools/repo gate tests.\n');

  const gitEnv = {
    GIT_AUTHOR_NAME: 'repo-gate',
    GIT_AUTHOR_EMAIL: 'repo-gate@example.invalid',
    GIT_COMMITTER_NAME: 'repo-gate',
    GIT_COMMITTER_EMAIL: 'repo-gate@example.invalid',
  };
  for (const args of [
    ['init', '--quiet'],
    ['add', '--all'],
    ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '-m', 'clean clone'],
  ]) {
    const result = runRepoCommand('git', args, { cwd: cloneDir, env: gitEnv });
    if (result.exitCode !== 0) {
      throw new Error(`git could not prepare the clean clone:\n${describeRepoCommand(result)}`);
    }
  }
  return cloneDir;
}

export function removeCleanClone(cloneDir: string | undefined): void {
  if (cloneDir && existsSync(cloneDir)) rmSync(cloneDir, { recursive: true, force: true });
}
