// Test-only helper for the repo gate tests (#12, ADR 0004 decision 10).
// Finds every dependency in every workspace package.json that is not pinned
// to an exact version.
import { listWorkspaceProjects, readPackageManifest } from '../../test-support/workspace-projects';

/** Dependency fields that must hold exact versions. peerDependencies are out of scope (see envelope). */
export const exactVersionDependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
] as const;

export interface NonExactDependencyVersion {
  /** package.json path relative to the workspace root, with `/` separators. */
  readonly file: string;
  readonly field: (typeof exactVersionDependencyFields)[number];
  /** The dependency (package) name. */
  readonly packageName: string;
  readonly spec: string;
}

const exactSemverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Exact means: a full `major.minor.patch` version (optionally with a
 * prerelease or build tag), an `npm:` alias to such a version, or
 * `workspace:*` for a package inside this workspace.
 */
export function isExactDependencyVersion(spec: string): boolean {
  if (exactSemverPattern.test(spec)) return true;
  if (spec === 'workspace:*') return true;
  const alias = /^npm:(@?[^@]+)@(.+)$/.exec(spec);
  if (alias) return exactSemverPattern.test(alias[2] ?? '');
  return false;
}

export function findNonExactDependencyVersions(workspaceRootDir: string): NonExactDependencyVersion[] {
  const findings: NonExactDependencyVersion[] = [];
  for (const project of listWorkspaceProjects(workspaceRootDir)) {
    const manifest = readPackageManifest(project.manifestPath);
    const fileFromRoot =
      project.relativeDir === '.' ? 'package.json' : `${project.relativeDir}/package.json`;
    for (const field of exactVersionDependencyFields) {
      const dependencies = (manifest[field] ?? {}) as Record<string, string>;
      for (const [packageName, spec] of Object.entries(dependencies)) {
        if (!isExactDependencyVersion(spec)) {
          findings.push({ file: fileFromRoot, field, packageName, spec });
        }
      }
    }
  }
  return findings;
}

export function formatNonExactDependencyVersions(findings: readonly NonExactDependencyVersion[]): string {
  return findings
    .map(
      (finding) =>
        `${finding.file}: ${finding.field} "${finding.packageName}" is "${finding.spec}", not an exact version`,
    )
    .join('\n');
}

/** Throws one error that names every file and package with a non-exact version. */
export function assertExactDependencyVersions(workspaceRootDir: string): void {
  const findings = findNonExactDependencyVersions(workspaceRootDir);
  if (findings.length > 0) {
    throw new Error(
      `Every dependency must be pinned to an exact version (ADR 0004 decision 10):\n${formatNonExactDependencyVersions(findings)}`,
    );
  }
}
