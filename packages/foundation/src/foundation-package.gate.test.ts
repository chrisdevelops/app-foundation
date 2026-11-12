// Gate test for the foundation workspace package (#12; PLT-003, PLT-004;
// ADR 0004 decisions 3 and 10). It runs inside packages/foundation through
// Turborepo and proves, from where the package sits, that:
// - the Vitest that runs it is the exact 5.x.y version the package declares,
// - that Vitest is linked from pnpm's virtual store (the isolated layout), and
// - a package that only Vitest depends on is out of the foundation's reach.
// The package has no public systems yet; later tasks add gate tests beside
// the systems they build. The repo gate in tools/repo needs this file to exist.
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const foundationDir = fileURLToPath(new URL('..', import.meta.url));
const foundationManifestPath = join(foundationDir, 'package.json');

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
}

/** Folder of the vitest package that this test file imports, with symlinks resolved. */
function resolveRunningVitestDir(): string {
  let dir = dirname(fileURLToPath(import.meta.resolve('vitest')));
  while (!existsSync(join(dir, 'package.json')) || readManifest(join(dir, 'package.json')).name !== 'vitest') {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('could not find the package.json of the running vitest');
    dir = parent;
  }
  return realpathSync(dir);
}

/**
 * True when an ES module import of `packageName` from `fromDir` would find it:
 * Node looks in `node_modules` of the folder and of every parent folder.
 * (CommonJS lookup paths also include NODE_PATH, which pnpm's bin shims set
 * and ES module resolution ignores, so they are not used here.)
 */
function isReachableFrom(fromDir: string, packageName: string): boolean {
  let dir = fromDir;
  for (;;) {
    if (existsSync(join(dir, 'node_modules', packageName, 'package.json'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

describe('foundation workspace package', () => {
  // PLT-004; ADR 0004 decision 10
  it('PLT-004: the Vitest running this test is the exact 5.x.y version that packages/foundation declares', () => {
    const declared = readManifest(foundationManifestPath).devDependencies?.vitest;
    expect(declared, 'packages/foundation must declare vitest as an exact 5.x.y version').toMatch(/^5\.\d+\.\d+$/);
    const running = readManifest(join(resolveRunningVitestDir(), 'package.json')).version;
    expect(running).toBe(declared);
  });

  // PLT-003; ADR 0004 decision 3
  it('PLT-003: vitest is linked into packages/foundation from the pnpm virtual store', () => {
    const linked = join(foundationDir, 'node_modules', 'vitest');
    expect(existsSync(linked), 'packages/foundation/node_modules/vitest must exist (not hoisted away)').toBe(true);
    expect(lstatSync(linked).isSymbolicLink(), 'packages/foundation/node_modules/vitest must be a link').toBe(true);
    const target = realpathSync(linked);
    expect(target).toContain(`${sep}node_modules${sep}.pnpm${sep}vitest@`);
    expect(resolveRunningVitestDir()).toBe(target);
  });

  // PLT-003; ADR 0004 decision 3
  it('PLT-003: chai, a dependency of vitest only, is reachable from vitest but not from packages/foundation', () => {
    const vitestDir = resolveRunningVitestDir();
    expect(Object.keys(readManifest(join(vitestDir, 'package.json')).dependencies ?? {})).toContain('chai');
    expect(isReachableFrom(vitestDir, 'chai'), 'control: vitest must reach its own dependency').toBe(true);
    expect(
      isReachableFrom(foundationDir, 'chai'),
      'packages/foundation does not declare chai, so the isolated layout must keep it out of reach',
    ).toBe(false);
  });
});
