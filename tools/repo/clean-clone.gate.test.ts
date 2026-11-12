// Gate tests for #12: what a developer or CI sees after a clean clone.
// The suite copies the working tree to a temporary folder, runs
// `pnpm install --frozen-lockfile`, then drives Turborepo, Vitest, TypeScript
// and ESLint through their commands. Fixtures prove the failure modes.
// Requirements: PLT-003, PLT-004, PLT-006, PLT-009, PLT-010; ADR 0004 decision 3.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCleanClone, isInsideCleanClone, removeCleanClone } from './support/clean-clone';
import {
  isPublicHoistAllowed,
  listUndeclaredRootModules,
  publicHoistPatternAllowlist,
  readPublicHoistedPackages,
} from './support/public-hoist-allowlist';
import {
  describeRepoCommand,
  repoGateRootDir,
  runRepoCommand,
  type RepoCommandResult,
} from './support/run-repo-command';
import { listWorkspaceProjects, readPackageManifest, type WorkspaceProject } from './support/workspace-projects';

const slow = { timeout: 600_000 };
const turboTasks = ['typecheck', 'lint', 'test'] as const;
// Fixed log format for nested Turborepo runs. Under GitHub Actions, `auto`
// switches to grouped `::group::` output with no per-line task prefix, and
// `linesForTask` reads the prefix (#13).
const turboLogFlags = ['--ui=stream', '--log-order=stream', '--log-prefix=task'] as const;

let cloneDir = '';
let installResult: RepoCommandResult | undefined;
let firstTurboRun: RepoCommandResult | undefined;

function pnpm(args: readonly string[], cwd = cloneDir): RepoCommandResult {
  return runRepoCommand('pnpm', args, { cwd, timeoutMs: 600_000 });
}

function ensureInstalled(): RepoCommandResult {
  installResult ??= pnpm(['install', '--frozen-lockfile']);
  return installResult;
}

function requireInstalled(): void {
  const result = ensureInstalled();
  if (result.exitCode !== 0) {
    throw new Error(`pnpm install --frozen-lockfile failed, so this check cannot run:\n${describeRepoCommand(result)}`);
  }
}

function foundationProject(): WorkspaceProject {
  const project = listWorkspaceProjects(cloneDir).find((entry) => entry.relativeDir === 'packages/foundation');
  if (!project?.name) throw new Error('packages/foundation is not a named workspace package');
  return project;
}

function ensureFirstTurboRun(): RepoCommandResult {
  requireInstalled();
  firstTurboRun ??= pnpm(['turbo', 'run', ...turboTasks, ...turboLogFlags, '--output-logs=full']);
  return firstTurboRun;
}

/** Finds the folder that holds the foundation's gate tests, so fixtures sit where its tooling looks. */
function foundationGateTestDir(project: WorkspaceProject): string {
  const stack = [project.dir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (/\.gate\.test\.tsx?$/.test(entry.name)) return dir;
    }
  }
  throw new Error(`no *.gate.test.ts file in ${project.relativeDir}`);
}

function linesForTask(output: string, packageName: string, task: string): string[] {
  const prefix = `${packageName}:${task}:`;
  return output
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

// A nested `turbo run test` inside a clone must never start another clone.
describe.skipIf(isInsideCleanClone(repoGateRootDir))('clean clone of the workspace', () => {
  beforeAll(() => {
    cloneDir = createCleanClone(repoGateRootDir);
  }, slow.timeout);

  afterAll(() => {
    removeCleanClone(cloneDir);
  });

  // PLT-003, PLT-010
  it('PLT-003: pnpm install --frozen-lockfile passes from a clean clone with no ignored build scripts', slow, () => {
    const result = ensureInstalled();
    expect(result.exitCode, describeRepoCommand(result)).toBe(0);
    expect(result.output).not.toMatch(/ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/);
  });

  // PLT-003, ADR 0004 decision 3 A
  it('PLT-003: the installed layout is isolated and public hoisting is limited to the declared patterns', slow, () => {
    requireInstalled();
    const modulesFile = join(cloneDir, 'node_modules', '.modules.yaml');
    expect(existsSync(modulesFile), 'node_modules/.modules.yaml must exist after install').toBe(true);
    const modules = readFileSync(modulesFile, 'utf8');
    expect(modules).toMatch(/"?nodeLinker"?\s*:\s*"?isolated/);
    expect(modules).not.toMatch(/"?shamefullyHoist"?\s*:\s*true/);
    expect(existsSync(join(cloneDir, 'node_modules', '.pnpm')), 'the virtual store node_modules/.pnpm must exist').toBe(true);
    const nodeLinker = pnpm(['config', 'get', 'node-linker']).stdout.trim();
    expect(['isolated', 'undefined', '']).toContain(nodeLinker);
  });

  // PLT-003; ADR 0007 item 5
  it('PLT-003: every package pnpm records as publicly hoisted matches the @types/* allowlist', slow, () => {
    requireInstalled();
    const hoisted = readPublicHoistedPackages(cloneDir);
    const outside = hoisted.filter((name) => !isPublicHoistAllowed(name));
    expect(
      outside,
      `node_modules/.modules.yaml records these public hoists outside ${JSON.stringify(publicHoistPatternAllowlist)}: ${outside.join(', ')}`,
    ).toEqual([]);
  });

  // PLT-003; ADR 0007 item 5
  it('PLT-003: the root node_modules holds only root-declared packages and @types/* packages', slow, () => {
    requireInstalled();
    const undeclared = listUndeclaredRootModules(cloneDir);
    const outside = undeclared.filter((name) => !isPublicHoistAllowed(name));
    expect(
      outside,
      `the root node_modules holds packages the root does not declare, outside ${JSON.stringify(publicHoistPatternAllowlist)}: ${outside.join(', ')}`,
    ).toEqual([]);
  });

  // PLT-004
  it('PLT-004: turbo plans typecheck, lint and test as real scripts in every workspace package', slow, () => {
    requireInstalled();
    const dry = pnpm(['turbo', 'run', ...turboTasks, '--dry=json']);
    expect(dry.exitCode, describeRepoCommand(dry)).toBe(0);
    const plan = JSON.parse(dry.stdout.slice(dry.stdout.indexOf('{'))) as {
      tasks: Array<{ package: string; task: string; command: string }>;
    };
    const packages = listWorkspaceProjects(cloneDir).filter((project) => project.relativeDir !== '.');
    expect(packages.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const project of packages) {
      for (const task of turboTasks) {
        const planned = plan.tasks.find((entry) => entry.package === project.name && entry.task === task);
        if (!planned || planned.command === '<NONEXISTENT>' || planned.command.trim() === '') {
          missing.push(`${project.name}#${task} (${project.relativeDir}/package.json)`);
        }
      }
    }
    expect(missing, 'every workspace package must have a typecheck, lint and test script').toEqual([]);
  });

  // PLT-004, PLT-006, PLT-009
  it('PLT-004: pnpm turbo run typecheck lint test passes from the root', slow, () => {
    const result = ensureFirstTurboRun();
    expect(result.exitCode, describeRepoCommand(result)).toBe(0);
    const foundation = foundationProject();
    for (const task of turboTasks) {
      expect(
        linesForTask(result.output, foundation.name as string, task).length,
        `turbo must run ${foundation.name}#${task}`,
      ).toBeGreaterThan(0);
    }
  });

  // PLT-003, PLT-004; ADR 0004 decisions 3 and 10: Vitest 5 under the isolated layout through Turborepo
  it('PLT-004: Vitest 5 runs a foundation gate test through Turborepo with the isolated layout', slow, () => {
    const result = ensureFirstTurboRun();
    const foundation = foundationProject();
    const manifest = readPackageManifest(foundation.manifestPath);
    const devDependencies = (manifest.devDependencies ?? {}) as Record<string, string>;
    const dependencies = (manifest.dependencies ?? {}) as Record<string, string>;
    expect(
      devDependencies.vitest ?? dependencies.vitest,
      'packages/foundation must declare vitest itself, pinned to an exact 5.x.y version',
    ).toMatch(/^5\.\d+\.\d+$/);

    const testLines = linesForTask(result.output, foundation.name as string, 'test').join('\n');
    expect(testLines, describeRepoCommand(result)).toMatch(/RUN\s+v5\.\d+\.\d+/);
    expect(testLines).toMatch(/\.gate\.test\.tsx?/);
    expect(testLines).toMatch(/Test Files\s+\d+ passed/);
    expect(testLines).not.toMatch(/Test Files\s+.*failed/);
  });

  // PLT-004
  it('PLT-004: a second run with no changes is a full cache hit', slow, () => {
    const first = ensureFirstTurboRun();
    expect(first.exitCode, 'the first run must pass before the cache can be checked').toBe(0);
    const second = pnpm(['turbo', 'run', ...turboTasks, ...turboLogFlags]);
    expect(second.exitCode, describeRepoCommand(second)).toBe(0);
    const cached = /Cached:\s+(\d+) cached, (\d+) total/.exec(second.output);
    expect(cached, describeRepoCommand(second)).not.toBeNull();
    expect(Number(cached?.[2])).toBeGreaterThanOrEqual(turboTasks.length);
    expect(cached?.[1], describeRepoCommand(second)).toBe(cached?.[2]);
    expect(second.output).toMatch(/FULL TURBO/);
  });

  // PLT-006
  it('PLT-006: ESLint and Prettier in packages/foundation resolve the root configs', slow, () => {
    requireInstalled();
    const foundation = foundationProject();
    const prettier = pnpm(['exec', 'prettier', '--find-config-path', 'package.json'], foundation.dir);
    expect(prettier.exitCode, describeRepoCommand(prettier)).toBe(0);
    const prettierConfig = prettier.stdout.trim().split('\n').pop() ?? '';
    expect(
      relative(cloneDir, join(foundation.dir, prettierConfig)).includes('/'),
      `Prettier must use the root config, not ${prettierConfig}`,
    ).toBe(false);

    const sampleFile = readdirSync(foundationGateTestDir(foundation)).find((entry) => /\.gate\.test\.tsx?$/.test(entry));
    const samplePath = join(foundationGateTestDir(foundation), sampleFile as string);
    const eslint = pnpm(['exec', 'eslint', '--print-config', samplePath], foundation.dir);
    expect(eslint.exitCode, describeRepoCommand(eslint)).toBe(0);
    const config = JSON.parse(eslint.stdout) as { rules?: Record<string, unknown> };
    expect(Object.keys(config.rules ?? {}).length, 'ESLint must apply base rules to foundation TypeScript files').toBeGreaterThan(0);
  });

  // PLT-006, failure mode: a lint error fails the lint task
  it('PLT-006: a lint error in packages/foundation makes pnpm turbo run lint exit non-zero and names the rule', slow, () => {
    requireInstalled();
    const foundation = foundationProject();
    const fixturePath = join(foundationGateTestDir(foundation), 'lint-error-fixture.ts');
    writeFileSync(fixturePath, 'export function lintErrorFixture(): number {\n  debugger;\n  return 1;\n}\n');
    try {
      const result = pnpm(['turbo', 'run', 'lint', `--filter=${foundation.name}`, ...turboLogFlags, '--output-logs=full']);
      expect(result.exitCode, describeRepoCommand(result)).not.toBe(0);
      expect(result.output).toContain('lint-error-fixture.ts');
      expect(result.output).toContain('no-debugger');
    } finally {
      rmSync(fixturePath, { force: true });
    }
  });

  // PLT-003, ADR 0004 decision 3 A, failure mode: pnpm isolation blocks undeclared imports
  describe('isolation fixture: importing an undeclared package', () => {
    const fixtureFileName = 'undeclared-import-fixture.gate.test.ts';

    function writeImportFixture(project: WorkspaceProject, moduleName: string): string {
      const path = join(foundationGateTestDir(project), fixtureFileName);
      writeFileSync(
        path,
        [
          "import { expect, it } from 'vitest';",
          `import * as importedModule from '${moduleName}';`,
          '',
          "it('loads the imported module', () => {",
          "  expect(typeof importedModule).toBe('object');",
          '});',
          '',
        ].join('\n'),
      );
      return path;
    }

    function runTypecheckAndTest(project: WorkspaceProject): RepoCommandResult {
      return pnpm([
        'turbo',
        'run',
        'typecheck',
        'test',
        `--filter=${project.name}`,
        '--continue',
        ...turboLogFlags,
        '--output-logs=full',
      ]);
    }

    /**
     * A package that is installed in the virtual store but that neither
     * packages/foundation nor the root declares, and that no hoist pattern
     * exposes. Found from the installed layout, not hard-coded.
     */
    function findUndeclaredInstalledPackage(project: WorkspaceProject): string {
      const virtualStore = join(cloneDir, 'node_modules', '.pnpm');
      expect(existsSync(virtualStore), 'node_modules/.pnpm must exist in the isolated layout').toBe(true);
      // Virtual store entries look like `name@1.2.3` or `@scope+name@1.2.3_peer-suffix`.
      const names = new Set<string>();
      for (const entry of readdirSync(virtualStore)) {
        const match = /^(@[^+]+\+)?([^@]+)@/.exec(entry);
        if (!match) continue;
        const name = match[1] ? `${match[1].slice(0, -1)}/${match[2]}` : (match[2] as string);
        if (existsSync(join(virtualStore, entry, 'node_modules', name, 'package.json'))) names.add(name);
      }
      // Node resolution walks up from packages/foundation to the workspace root.
      const lookupDirs = [project.dir, join(project.dir, '..'), cloneDir].map((dir) => join(dir, 'node_modules'));
      const reachable = (name: string): boolean => lookupDirs.some((dir) => existsSync(join(dir, name)));
      const candidate = [...names]
        .sort()
        .find((name) => !name.startsWith('@types/') && !builtinModules.includes(name) && !reachable(name));
      if (!candidate) {
        throw new Error(
          'Every installed package is reachable from packages/foundation, so the layout is not isolated (ADR 0004 decision 3)',
        );
      }
      return candidate;
    }

    it('PLT-003: control: the same fixture importing a declared package passes typecheck and test', slow, () => {
      requireInstalled();
      const foundation = foundationProject();
      const path = writeImportFixture(foundation, 'vitest');
      try {
        const result = runTypecheckAndTest(foundation);
        expect(result.exitCode, describeRepoCommand(result)).toBe(0);
        expect(result.output).toContain(fixtureFileName);
      } finally {
        rmSync(path, { force: true });
      }
    });

    it('PLT-003: an import of a package that packages/foundation does not declare fails typecheck or test', slow, () => {
      requireInstalled();
      const foundation = foundationProject();
      const undeclared = findUndeclaredInstalledPackage(foundation);
      const path = writeImportFixture(foundation, undeclared);
      try {
        const result = runTypecheckAndTest(foundation);
        expect(result.exitCode, describeRepoCommand(result)).not.toBe(0);
        const escaped = undeclared.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
        // tsc: TS2307 Cannot find module 'x'. Vitest or Vite: cannot resolve or find package 'x'.
        expect(result.output, describeRepoCommand(result)).toMatch(
          new RegExp(
            `TS2307[^\\n]*['"]${escaped}['"]|Failed to resolve (?:import|entry)[^\\n]*${escaped}|Cannot find (?:package|module) ['"]${escaped}['"]`,
          ),
        );
      } finally {
        rmSync(path, { force: true });
      }
    });
  });
});
