// Gate tests for #15: the reference app as a workspace package, read from its
// package.json and from pnpm. Nothing is built here; the build, package and
// launch gates are in reference-app-build.gate.test.ts.
// Requirements: TST-011 (partial: the reference app exists), TST-013, PLT-002,
// PLT-005, PLT-007 (partial); ADR 0004 decision 10; ADR 0006 item 4; ADR 0007 item 7.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPnpmWorkspaceSettings } from '../repo/test-support/pnpm-workspace-file';
import { repoGateRootDir } from '../repo/test-support/run-repo-command';
import { listWorkspaceProjects, readPackageManifest } from '../repo/test-support/workspace-projects';
import {
  findReferenceAppDevScript,
  readReferenceAppDependencySpec,
  referenceAppRelativeDir,
  referenceAppSpikeMinimumVersions,
} from './test-support/reference-app-paths';

const root = repoGateRootDir;
const referenceAppDir = join(root, ...referenceAppRelativeDir.split('/'));
const exactSemver = /^(\d+)\.(\d+)\.(\d+)$/;

function readReferenceAppManifest(): Record<string, unknown> {
  const manifestPath = join(referenceAppDir, 'package.json');
  expect(existsSync(manifestPath), `${referenceAppRelativeDir}/package.json must exist (ADR 0006 item 4)`).toBe(true);
  return readPackageManifest(manifestPath);
}

function compareVersions(left: string, right: string): number {
  const a = (exactSemver.exec(left) ?? []).slice(1).map(Number);
  const b = (exactSemver.exec(right) ?? []).slice(1).map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

describe('reference app workspace package', () => {
  // TST-011 (partial), TST-013; ADR 0006 item 4
  it('TST-011: pnpm lists apps/reference as a named workspace project', () => {
    const project = listWorkspaceProjects(root).find((entry) => entry.relativeDir === referenceAppRelativeDir);
    expect(project, `pnpm must list ${referenceAppRelativeDir} as a workspace project`).toBeDefined();
    expect(project?.name ?? '').toMatch(/\S/);
  });

  // PLT-003, PLT-005; issue #15 acceptance criterion 1
  it('PLT-005: apps/reference depends on the foundation package through workspace:*', () => {
    const manifest = readReferenceAppManifest();
    const foundation = listWorkspaceProjects(root).find((entry) => entry.relativeDir === 'packages/foundation');
    expect(foundation?.name, 'packages/foundation must be a named workspace package').toBeDefined();
    const dependencies = (manifest.dependencies ?? {}) as Record<string, string>;
    expect(
      dependencies[foundation?.name as string],
      `${referenceAppRelativeDir}/package.json dependencies must hold "${foundation?.name}": "workspace:*"`,
    ).toBe('workspace:*');
  });

  // PLT-002, PLT-005; ADR 0004 decision 10: pinned exactly, spike versions or newer
  it.each(Object.entries(referenceAppSpikeMinimumVersions))(
    'PLT-005: apps/reference pins %s exactly, at the spike version %s or newer',
    (packageName, minimum) => {
      const manifest = readReferenceAppManifest();
      const spec = readReferenceAppDependencySpec(manifest, packageName);
      expect(spec, `${referenceAppRelativeDir}/package.json must declare ${packageName}`).toBeDefined();
      expect(spec, `${packageName} must be an exact x.y.z version`).toMatch(exactSemver);
      expect(
        compareVersions(spec as string, minimum),
        `${packageName} ${spec} is older than the spike version ${minimum}`,
      ).toBeGreaterThanOrEqual(0);
    },
  );

  // PLT-005; spike #6 failure mode 2: Forge 8 emits the main bundle as .cjs
  it('PLT-005: package.json main is .vite/build/main.cjs', () => {
    expect(readReferenceAppManifest().main).toBe('.vite/build/main.cjs');
  });

  // PLT-005, PLT-007: the app has a dev command and Forge package and make commands
  it('PLT-005: apps/reference has a dev script (dev or start) that runs electron-forge start, and package and make scripts', () => {
    const manifest = readReferenceAppManifest();
    const scripts = (manifest.scripts ?? {}) as Record<string, string>;
    const dev = findReferenceAppDevScript(scripts);
    expect(
      dev,
      `${referenceAppRelativeDir}/package.json needs a "dev" or "start" script that runs electron-forge start`,
    ).toBeDefined();
    expect(scripts.package ?? '').toMatch(/(^|\s)electron-forge\s+package(\s|$)/);
    expect(scripts.make ?? '').toMatch(/(^|\s)electron-forge\s+make(\s|$)/);
  });

  // PLT-003 (pnpm 11); ADR 0007 item 7: electron's install script is allowed by name
  it('PLT-003: pnpm-workspace.yaml allowBuilds allows the electron build script', () => {
    const allowBuilds = (readPnpmWorkspaceSettings(root).allowBuilds ?? {}) as Record<string, unknown>;
    expect(allowBuilds.electron, 'allowBuilds must hold electron: true (ADR 0007 item 7)').toBe(true);
  });
});
