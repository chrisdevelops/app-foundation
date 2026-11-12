// Gate tests for #12: the workspace configuration that a developer checks in.
// They read the real repository through pnpm and the config files; nothing is
// installed. Requirements: PLT-003, PLT-004, PLT-006, PLT-009, PLT-010.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertExactDependencyVersions } from './support/exact-dependency-versions';
import {
  readCommentedYamlSequence,
  readPnpmWorkspaceSettings,
  readPnpmWorkspaceText,
} from './support/pnpm-workspace-file';
import { publicHoistPatternAllowlist } from './support/public-hoist-allowlist';
import { repoGateRootDir, runRepoCommand } from './support/run-repo-command';
import {
  resolveEffectiveCompilerOptions,
  resolveTsconfigExtends,
} from './support/tsconfig-chain';
import { listWorkspaceProjects, readPackageManifest } from './support/workspace-projects';

const root = repoGateRootDir;
const exactSemver = /^\d+\.\d+\.\d+$/;

function readRootManifest(): Record<string, unknown> {
  const path = join(root, 'package.json');
  expect(existsSync(path), 'root package.json must exist').toBe(true);
  return readPackageManifest(path);
}

describe('pnpm workspace file', () => {
  // PLT-003
  it('PLT-003: pnpm-workspace.yaml declares exactly the apps/* and packages/* globs', () => {
    expect(existsSync(join(root, 'pnpm-workspace.yaml')), 'pnpm-workspace.yaml must exist').toBe(true);
    const settings = readPnpmWorkspaceSettings(root);
    expect(settings.packages).toEqual(expect.arrayContaining(['apps/*', 'packages/*']));
  });

  // PLT-003, ADR 0004 decision 3 A
  it('PLT-003: the isolated node layout is kept (no hoisted or pnp node linker, no shameful hoist)', () => {
    expect(existsSync(join(root, 'pnpm-workspace.yaml')), 'pnpm-workspace.yaml must exist').toBe(true);
    const text = readPnpmWorkspaceText(root);
    expect(text, 'pnpm-workspace.yaml must not set nodeLinker: hoisted').not.toMatch(
      /^\s*node-?[lL]inker\s*:\s*['"]?(hoisted|pnp)/m,
    );
    expect(text).not.toMatch(/^\s*shamefully-?[hH]oist\s*:\s*true/m);
    const settings = readPnpmWorkspaceSettings(root);
    expect(['isolated', undefined]).toContain(settings.nodeLinker ?? settings['node-linker']);
    expect(settings.shamefullyHoist ?? settings['shamefully-hoist']).not.toBe(true);
  });

  // PLT-003, ADR 0004 decision 3 A: a narrow publicHoistPattern
  it('PLT-003: publicHoistPattern is a non-empty narrow list with no match-everything entry', () => {
    const settings = readPnpmWorkspaceSettings(root);
    const patterns = settings.publicHoistPattern;
    expect(Array.isArray(patterns), 'publicHoistPattern must be set as a list').toBe(true);
    expect((patterns as string[]).length).toBeGreaterThan(0);
    for (const pattern of patterns as string[]) {
      // A narrow entry names something: it is not only wildcards or a negation of nothing.
      expect(pattern.replace(/^!/, ''), `publicHoistPattern entry "${pattern}" is too wide`).toMatch(
        /[A-Za-z0-9@/._-]/,
      );
    }
  });

  // PLT-003; ADR 0007 item 5: public hoisting is limited to an allowlist
  it('PLT-003: every publicHoistPattern entry is in the allowlist (@types/* only)', () => {
    const settings = readPnpmWorkspaceSettings(root);
    const patterns = (settings.publicHoistPattern ?? []) as string[];
    expect(patterns.length, 'publicHoistPattern must be set').toBeGreaterThan(0);
    const outside = patterns.filter((pattern) => !publicHoistPatternAllowlist.includes(pattern));
    expect(
      outside,
      `publicHoistPattern entries outside the allowlist ${JSON.stringify(publicHoistPatternAllowlist)} (ADR 0007 item 5): ${outside.join(', ')}`,
    ).toEqual([]);
  });

  // PLT-003: each publicHoistPattern entry carries its reason
  it('PLT-003: every publicHoistPattern entry has a comment that gives its reason', () => {
    expect(existsSync(join(root, 'pnpm-workspace.yaml')), 'pnpm-workspace.yaml must exist').toBe(true);
    const settings = readPnpmWorkspaceSettings(root);
    const patterns = (settings.publicHoistPattern ?? []) as string[];
    const entries = readCommentedYamlSequence(readPnpmWorkspaceText(root), 'publicHoistPattern');
    expect(
      entries.map((entry) => entry.value),
      'publicHoistPattern must be written one entry per line so each entry can carry a comment',
    ).toEqual(patterns);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(
        entry.comment,
        `pnpm-workspace.yaml line ${entry.lineNumber}: publicHoistPattern entry "${entry.value}" needs a comment with its reason`,
      ).toMatch(/\S{3,}/);
    }
  });

  // PLT-003 (pnpm 11, spike #9): build scripts are allowed by an explicit list
  it('PLT-003: allowBuilds is an explicit map of package names, with no wildcard and no allow-all', () => {
    const settings = readPnpmWorkspaceSettings(root);
    const allowBuilds = settings.allowBuilds;
    expect(
      allowBuilds !== null && typeof allowBuilds === 'object' && !Array.isArray(allowBuilds),
      'allowBuilds must be set in pnpm-workspace.yaml as a map of package name to true or false',
    ).toBe(true);
    for (const [name, allowed] of Object.entries(allowBuilds as Record<string, unknown>)) {
      expect(name, `allowBuilds entry "${name}" must name one package`).not.toMatch(/[*?]/);
      expect(typeof allowed, `allowBuilds entry "${name}" must be true or false`).toBe('boolean');
    }
    expect(settings.dangerouslyAllowAllBuilds ?? false).toBe(false);
  });
});

describe('root package.json', () => {
  // PLT-010
  it('PLT-010: packageManager pins an exact pnpm 11 version', () => {
    const manifest = readRootManifest();
    expect(manifest.packageManager).toMatch(/^pnpm@11\.\d+\.\d+(\+sha\d+\.[0-9a-f]+)?$/);
  });

  // PLT-003 (Node version pinned)
  it('PLT-003: the Node version is pinned to an exact version in engines.node or devEngines.runtime', () => {
    const manifest = readRootManifest();
    const engines = (manifest.engines ?? {}) as Record<string, unknown>;
    const runtime = (manifest.devEngines as Record<string, unknown> | undefined)?.runtime;
    const runtimes = (runtime === undefined ? [] : [runtime].flat()) as Array<{ name?: string; version?: string }>;
    const pinned = [engines.node, ...runtimes.filter((entry) => entry.name === 'node').map((entry) => entry.version)];
    expect(
      pinned.some((version) => typeof version === 'string' && exactSemver.test(version)),
      `Node must be pinned to an exact x.y.z version; found ${JSON.stringify(pinned)}`,
    ).toBe(true);
  });

  // ADR 0004 decision 10; PLT-003
  it('ADR-0004-10: every dependency in every workspace package.json is an exact version', () => {
    expect(() => assertExactDependencyVersions(root)).not.toThrow();
  });
});

describe('foundation package and TypeScript', () => {
  // PLT-003
  it('PLT-003: packages/foundation is a named workspace package', () => {
    const projects = listWorkspaceProjects(root);
    const foundation = projects.find((project) => project.relativeDir === 'packages/foundation');
    expect(foundation, 'pnpm must list packages/foundation as a workspace project').toBeDefined();
    expect(foundation?.name).toMatch(/\S/);
  });

  // PLT-003, PLT-009
  it('PLT-009: packages/foundation has a strict tsconfig that extends one shared base config outside the package', () => {
    const tsconfigPath = join(root, 'packages', 'foundation', 'tsconfig.json');
    expect(existsSync(tsconfigPath), 'packages/foundation/tsconfig.json must exist').toBe(true);
    const parents = resolveTsconfigExtends(tsconfigPath);
    expect(parents, 'packages/foundation/tsconfig.json must extend exactly one base config').toHaveLength(1);
    const base = parents[0] ?? '';
    expect(
      relative(join(root, 'packages', 'foundation'), base).startsWith('..'),
      `the base config (${base}) must be shared, not inside packages/foundation`,
    ).toBe(true);
    expect(resolveEffectiveCompilerOptions(base).strict, 'the shared base config must set strict: true').toBe(true);
    expect(resolveEffectiveCompilerOptions(tsconfigPath).strict).toBe(true);
  });

  // PLT-003: one shared base for every workspace package
  it('PLT-003: every workspace package tsconfig extends the same shared base config', () => {
    const projects = listWorkspaceProjects(root).filter((project) => project.relativeDir !== '.');
    const bases = new Set<string>();
    for (const project of projects) {
      const tsconfigPath = join(project.dir, 'tsconfig.json');
      if (!existsSync(tsconfigPath)) continue;
      for (const parent of resolveTsconfigExtends(tsconfigPath)) bases.add(parent);
    }
    expect(bases.size, `workspace packages extend these base configs: ${[...bases].join(', ')}`).toBe(1);
  });
});

describe('lint, format and test tooling at the root', () => {
  // PLT-006
  it('PLT-006: ESLint uses a flat config at the root and no legacy .eslintrc file', () => {
    const entries = readdirSync(root);
    const flat = entries.filter((entry) => /^eslint\.config\.(js|mjs|cjs|ts|mts|cts)$/.test(entry));
    expect(flat, 'the root must have one eslint.config.* file').toHaveLength(1);
    expect(entries.filter((entry) => entry.startsWith('.eslintrc'))).toEqual([]);
  });

  // PLT-006
  it('PLT-006: Prettier has one config at the root', () => {
    const entries = readdirSync(root);
    const configFiles = entries.filter((entry) =>
      /^(\.prettierrc(\.(json|json5|ya?ml|toml|js|cjs|mjs|ts|cts|mts))?|prettier\.config\.(js|cjs|mjs|ts|cts|mts))$/.test(entry),
    );
    const inManifest = existsSync(join(root, 'package.json')) && 'prettier' in readRootManifest();
    expect(configFiles.length + (inManifest ? 1 : 0), 'the root must have exactly one Prettier config').toBe(1);
  });

  // PLT-004
  it('PLT-004: turbo.json at the root defines the typecheck, lint and test tasks', () => {
    const path = join(root, 'turbo.json');
    expect(existsSync(path), 'turbo.json must exist').toBe(true);
    const turbo = JSON.parse(readFileSync(path, 'utf8')) as { tasks?: Record<string, unknown> };
    const taskNames = Object.keys(turbo.tasks ?? {}).map((name) => name.replace(/^.*#/, ''));
    expect(taskNames).toEqual(expect.arrayContaining(['typecheck', 'lint', 'test']));
  });

  // PLT-009
  it('PLT-009: tooling is TypeScript or JavaScript: no Python files are tracked and the foundation Vitest config is TypeScript', () => {
    const tracked = runRepoCommand('git', ['ls-files'], { cwd: root }).stdout.split('\n');
    expect(tracked.filter((file) => /\.py$/.test(file))).toEqual([]);
    const foundationDir = join(root, 'packages', 'foundation');
    const vitestConfigs = existsSync(foundationDir)
      ? readdirSync(foundationDir).filter((entry) => /^vitest\.config\.(ts|mts|cts)$/.test(entry))
      : [];
    expect(vitestConfigs, 'packages/foundation must have a vitest.config.ts').toHaveLength(1);
  });

  // PLT-010 (pnpm part)
  it('PLT-010: pnpm is the only package manager: pnpm-lock.yaml is tracked and no other lockfile exists', () => {
    const tracked = runRepoCommand('git', ['ls-files'], { cwd: root }).stdout.split('\n');
    expect(tracked, 'pnpm-lock.yaml must be committed').toContain('pnpm-lock.yaml');
    const otherLockfiles = tracked.filter((file) =>
      /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?)$/.test(file),
    );
    expect(otherLockfiles).toEqual([]);
  });

  // PLT-009, PLT-010: scripts are TypeScript or JavaScript, run with pnpm
  it('PLT-010: no workspace script calls npm, yarn, npx or Python', () => {
    const offending: string[] = [];
    for (const project of listWorkspaceProjects(root)) {
      const scripts = (readPackageManifest(project.manifestPath).scripts ?? {}) as Record<string, string>;
      for (const [name, script] of Object.entries(scripts)) {
        if (/(^|[\s;&|(])(npm|npx|yarn|python3?)(\s|$)/.test(script)) {
          offending.push(`${project.relativeDir}/package.json scripts.${name}: ${script}`);
        }
      }
    }
    expect(offending).toEqual([]);
  });
});

