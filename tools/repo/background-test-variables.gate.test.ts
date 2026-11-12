// Gate tests for #46: the background test switch has one name and one
// definition site, and a run's FOUNDATION_TEST_FOREGROUND reaches every test
// task (TST-018; ADR 0013 rules 1 and 2; CLAUDE.md "one name, one definition site").
// Contract:
// - FOUNDATION_TEST_BACKGROUND appears as a string literal in exactly one
//   source file of the apps, the foundation package and the e2e harness, and
//   that file is in packages/foundation/src/ (the foundation reads it; the
//   harness imports the name from there).
// - FOUNDATION_TEST_FOREGROUND appears as a string literal in exactly one
//   source file of the same folders (the harness reads it; ADR 0013 does not
//   say where it lives, so any one site passes).
// - Test files and test-support folders keep their own copy of the names
//   (tools/test-support/background-test-variables.ts), as for #18.
// - Turborepo runs tasks in strict environment mode, which drops variables it
//   is not told about. `FOUNDATION_TEST_FOREGROUND=1 pnpm turbo run test` must
//   reach every test task (the harness and gate launches read it there), so
//   turbo.json must name it for each `test` task (env or passThroughEnv,
//   per task or global). Read from `turbo run test --dry=json`.
// What the switch does is gated in tools/reference-app/ and e2e/harness/.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  testBackgroundVariableName,
  testForegroundEnabledValue,
  testForegroundVariableName,
} from '../test-support/background-test-variables';
import { describeRepoCommand, repoGateRootDir, runRepoCommand } from '../test-support/run-repo-command';

const root = repoGateRootDir;
const sourceRoots = ['apps', 'packages', 'e2e'] as const;
const skippedDirNames = new Set(['node_modules', 'out', 'dist', '.vite', '.turbo', 'test-support']);
const sourceFile = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
const testFile = /\.test\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;

/** Non-test source files under `dir`, as paths relative to the repository root with `/` separators. */
function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skippedDirNames.has(entry.name)) continue;
      const fromRoot = relative(root, path).split('\\').join('/');
      if (fromRoot === 'e2e/smoke') continue;
      files.push(...listSourceFiles(path));
    } else if (entry.isFile() && sourceFile.test(entry.name) && !testFile.test(entry.name)) {
      files.push(relative(root, path).split('\\').join('/'));
    }
  }
  return files;
}

/** Files that hold `name` as a string literal ('…', "…" or `…`). */
function filesWithNameLiteral(name: string): string[] {
  const literal = new RegExp(`(['"\`])${name}\\1`);
  return sourceRoots
    .flatMap((sourceRoot) => listSourceFiles(join(root, sourceRoot)))
    .filter((file) => literal.test(readFileSync(join(root, file), 'utf8')));
}

describe('background test switch: one name, one definition site', () => {
  // TST-018; issue #46 acceptance criterion 1; ADR 0013 rule 1
  it(`TST-018: exactly one source file defines the string "${testBackgroundVariableName}", in packages/foundation/src/`, () => {
    const files = filesWithNameLiteral(testBackgroundVariableName);
    expect(
      files,
      `the name must be defined once, in the foundation's main process; found it in ${JSON.stringify(files)}`,
    ).toHaveLength(1);
    expect(files[0], 'the definition site').toMatch(/^packages\/foundation\/src\//);
  });

  // TST-018; issue #46 acceptance criterion 4; ADR 0013 rule 2; CLAUDE.md "one name, one definition site"
  it(`TST-018: exactly one source file defines the string "${testForegroundVariableName}"`, () => {
    const files = filesWithNameLiteral(testForegroundVariableName);
    expect(
      files,
      `the harness reads the run-level opt-out, so its name must be defined once; found it in ${JSON.stringify(files)}`,
    ).toHaveLength(1);
  });
});

interface TurboDryRunTask {
  readonly taskId: string;
  readonly environmentVariables?: {
    readonly configured?: readonly string[] | null;
    readonly passthrough?: readonly string[] | null;
  };
}

interface TurboDryRun {
  readonly tasks: readonly TurboDryRunTask[];
  readonly globalCacheInputs?: {
    readonly environmentVariables?: {
      readonly configured?: readonly string[] | null;
      readonly passthrough?: readonly string[] | null;
    };
  };
}

describe('background test switch: the run-level opt-out reaches every test task', () => {
  // TST-018; issue #46 acceptance criterion 4 ("FOUNDATION_TEST_FOREGROUND=1 in the run's environment launches normally")
  it(
    `TST-018: \`pnpm turbo run test\` with ${testForegroundVariableName}=${testForegroundEnabledValue} passes the variable to every test task`,
    { timeout: 120_000 },
    () => {
      const result = runRepoCommand('pnpm', ['exec', 'turbo', 'run', 'test', '--dry=json'], {
        cwd: root,
        timeoutMs: 110_000,
        env: { [testForegroundVariableName]: testForegroundEnabledValue },
      });
      expect(result.exitCode, describeRepoCommand(result)).toBe(0);
      const dryRun = JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))) as TurboDryRun;
      const testTasks = dryRun.tasks.filter((task) => task.taskId.endsWith('#test'));
      expect(
        testTasks.map((task) => task.taskId),
        'turbo must run at least one test task',
      ).not.toEqual([]);
      const seen = (entries: readonly string[] | null | undefined): boolean =>
        (entries ?? []).some((entry) => entry.startsWith(`${testForegroundVariableName}=`));
      const global = dryRun.globalCacheInputs?.environmentVariables;
      const globallySeen = seen(global?.configured) || seen(global?.passthrough);
      const missing = testTasks
        .filter(
          (task) =>
            !globallySeen &&
            !seen(task.environmentVariables?.configured) &&
            !seen(task.environmentVariables?.passthrough),
        )
        .map((task) => task.taskId);
      expect(
        missing,
        `turbo.json must make ${testForegroundVariableName} available to these test tasks (env or passThroughEnv; strict env mode drops it otherwise)`,
      ).toEqual([]);
    },
  );
});
