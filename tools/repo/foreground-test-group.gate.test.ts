// Gate tests for #46: the foreground test group (TST-018; ADR 0013 rule 3).
// Tests that need real OS focus, a native menu, a native dialog, or a window
// shown on screen live in `*.foreground.gate.test.ts` files and join the group
// through tools/test-support/foreground-test-group.ts (which states the
// contract). These gates check the parts outside the test files:
// - On request: `pnpm run test:foreground` at the repository root prints a
//   notice (a line that names the foreground group and says it takes focus)
//   before any test starts, and runs every `*.foreground.gate.test.ts` file in
//   the repository, and no other test file, with FOUNDATION_TEST_FOREGROUND=1.
//   Read through the group's probe mode: nothing launches.
// - CI: every check job runs `pnpm run test:foreground` at the root on
//   windows-latest, macos-latest and ubuntu-latest, after
//   `pnpm turbo run typecheck lint test`, with no `if:` and no
//   `continue-on-error`. No workflow sets FOUNDATION_TEST_BACKGROUND or
//   FOUNDATION_TEST_FOREGROUND, so every other CI launch stays in background
//   mode (ADR 0013 rule 2). Read from the workflow for all three runners, and
//   proved by an emulated run of the check job on this runner
//   (tools/test-support/workflow-job-emulator.ts with fake commands); a failing
//   foreground group fails the job.
// Default runs skip the group by the file guard itself (test code, ADR 0008),
// so no gate here starts a default run.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  testBackgroundVariableName,
  testForegroundEnabledValue,
  testForegroundVariableName,
} from '../test-support/background-test-variables';
import { createCleanClone, removeCleanClone } from '../test-support/clean-clone';
import {
  foregroundGroupProbeVariableName,
  foregroundTestFileSuffix,
  foregroundTestScriptName,
  type ForegroundGroupProbeRecord,
} from '../test-support/foreground-test-group';
import {
  ciWorkflowRelativePath,
  isWorkflowMapping,
  listJobSteps,
  listRunCommandLines,
  listWorkflowFiles,
  listWorkflowJobs,
  readWorkflow,
  resolveMatrixJobs,
  splitCommandWords,
  workflowValueText,
  type MatrixCombination,
  type WorkflowJob,
  type WorkflowMapping,
} from '../test-support/github-workflow';
import { describeRepoCommand, repoGateRootDir, runRepoCommand } from '../test-support/run-repo-command';
import {
  buildExpressionContext,
  emulateWorkflowJob,
  evaluateWorkflowCondition,
  hostRunnerLabel,
  type EmulatedJobResult,
} from '../test-support/workflow-job-emulator';
import {
  fakeCiEnvNames,
  installFakeCiCommands,
  parsePnpmInvocation,
  readFakeCiLog,
  stripCommandWrappers,
  type FakeCiRecord,
  type PnpmInvocationKind,
} from './test-support/fake-ci-commands';

const root = repoGateRootDir;
const requiredRunners = ['windows-latest', 'macos-latest', 'ubuntu-latest'] as const;
const hostLabel = hostRunnerLabel();
const slow = { timeout: 300_000 };
/** A path that stands for the workspace when a workflow is read without running it. */
const virtualWorkspace = resolve(tmpdir(), 'foreground-group-gate-virtual-workspace');
const skippedDirNames = new Set(['node_modules', 'out', 'dist', '.vite', '.turbo', '.git']);
const emulatorWindowsSkipReason =
  'the check job uses the Windows default shell (pwsh), which the workflow emulator does not run; the workflow shape gates cover windows-latest';

/** Every `*.foreground.gate.test.ts` file in the repository, relative to the root with `/` separators. */
function listForegroundTestFiles(dir = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skippedDirNames.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listForegroundTestFiles(path));
    else if (entry.isFile() && entry.name.endsWith(foregroundTestFileSuffix)) {
      files.push(relative(root, path).split('\\').join('/'));
    }
  }
  return files.sort();
}

describe('foreground test group: on request', () => {
  // TST-018; issue #46 acceptance criterion 6 ("runs locally on request, and prints a clear notice before it starts")
  it(
    `TST-018: \`pnpm run ${foregroundTestScriptName}\` prints the notice first, then runs every *${foregroundTestFileSuffix} file and no other test file, with ${testForegroundVariableName}=${testForegroundEnabledValue}`,
    { timeout: 600_000 },
    () => {
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      expect(
        manifest.scripts?.[foregroundTestScriptName],
        `the root package.json must define the "${foregroundTestScriptName}" script that runs the foreground test group`,
      ).toBeDefined();
      const expectedFiles = listForegroundTestFiles();
      expect(expectedFiles, `control: the repository holds *${foregroundTestFileSuffix} files`).not.toEqual([]);

      const probeDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'foreground-group-probe-')));
      try {
        const probeFile = join(probeDir, 'probe.jsonl');
        const result = runRepoCommand('pnpm', ['run', foregroundTestScriptName], {
          cwd: root,
          timeoutMs: 540_000,
          // An empty value, so the command itself must set the variable.
          env: { [foregroundGroupProbeVariableName]: probeFile, [testForegroundVariableName]: '' },
        });
        expect(result.exitCode, describeRepoCommand(result)).toBe(0);

        const records = existsSync(probeFile)
          ? readFileSync(probeFile, 'utf8')
              .split('\n')
              .filter((line) => line.trim() !== '')
              .map((line) => JSON.parse(line) as ForegroundGroupProbeRecord)
          : [];
        expect(
          [...new Set(records.map((record) => record.file))].sort(),
          `the command must load every foreground test file:\n${describeRepoCommand(result)}`,
        ).toEqual(expectedFiles);
        expect(
          records.filter((record) => record.foreground !== testForegroundEnabledValue),
          `every foreground file must run with ${testForegroundVariableName}=${testForegroundEnabledValue}`,
        ).toEqual([]);

        const testFilesNamed = [...new Set(result.output.match(/[\w./\\-]+\.test\.tsx?\b/g) ?? [])];
        expect(
          testFilesNamed.filter((file) => !file.endsWith(foregroundTestFileSuffix)),
          `the command must run no other test file:\n${describeRepoCommand(result)}`,
        ).toEqual([]);

        const lines = result.stdout.split(/\r?\n/);
        const noticeLine = lines.findIndex((line) => /foreground/i.test(line) && /focus/i.test(line));
        expect(
          noticeLine,
          `the command must print a notice line that names the foreground group and says it takes focus:\n${describeRepoCommand(result)}`,
        ).toBeGreaterThanOrEqual(0);
        const firstTestOutput = lines.findIndex(
          (line) => /\bRUN\b/.test(line) || expectedFiles.some((file) => line.includes(file.split('/').pop() ?? file)),
        );
        expect(
          firstTestOutput === -1 || noticeLine < firstTestOutput,
          `the notice must come before the test run starts (notice at stdout line ${noticeLine}, test output at line ${firstTestOutput}):\n${describeRepoCommand(result)}`,
        ).toBe(true);
      } finally {
        rmSync(probeDir, { recursive: true, force: true });
      }
    },
  );
});

// ---------------------------------------------------------------------------
// CI
// ---------------------------------------------------------------------------

function readCiWorkflow(): WorkflowMapping {
  expect(existsSync(join(root, ciWorkflowRelativePath)), `${ciWorkflowRelativePath} must exist`).toBe(true);
  return readWorkflow(root, ciWorkflowRelativePath);
}

function stepKinds(step: WorkflowMapping): PnpmInvocationKind[] {
  const workingDirectory =
    step['working-directory'] !== undefined && step['working-directory'] !== null
      ? workflowValueText(step['working-directory'])
      : '.';
  const cwd = resolve(virtualWorkspace, workingDirectory);
  return listRunCommandLines(step).flatMap((line) => {
    const { words } = stripCommandWrappers(splitCommandWords(line));
    if (words[0] !== 'pnpm') return [];
    return [parsePnpmInvocation(words.slice(1), cwd, virtualWorkspace).kind];
  });
}

interface CheckCombination {
  readonly job: WorkflowJob;
  readonly combination: MatrixCombination;
  readonly runsOn: string;
}

/** Every (job, matrix combination) of a job that runs `pnpm turbo run ...` (the check jobs of #13). */
function listCheckCombinations(workflow: WorkflowMapping): CheckCombination[] {
  const found = listWorkflowJobs(workflow)
    .filter((job) => listJobSteps(job).some((step) => stepKinds(step).includes('turbo')))
    .flatMap((job) =>
      resolveMatrixJobs(job).map((resolved) => ({ job, combination: resolved.combination, runsOn: resolved.runsOn })),
    );
  expect(found, `${ciWorkflowRelativePath} must have a check job that runs \`pnpm turbo run\``).not.toEqual([]);
  return found;
}

function stepRuns(entry: CheckCombination, step: WorkflowMapping, index: number): boolean {
  const context = buildExpressionContext(entry.job, {
    runnerDir: virtualWorkspace,
    expressions: { 'github.event_name': 'pull_request' },
    matrix: entry.combination,
  });
  const condition = step.if === undefined || step.if === null ? undefined : workflowValueText(step.if);
  return evaluateWorkflowCondition(condition, context, { failed: false }, `jobs.${entry.job.id}.steps[${index}].if`);
}

describe('foreground test group: CI workflow shape on all three runners', () => {
  // TST-018; issue #46 acceptance criterion 6 ("runs in CI"); ADR 0013 rule 3
  it(`TST-018: every check job runs \`pnpm run ${foregroundTestScriptName}\` at the root after the turbo step, on windows-latest, macos-latest and ubuntu-latest`, () => {
    const entries = listCheckCombinations(readCiWorkflow());
    const covered = new Set<string>();
    for (const entry of entries) {
      const steps = listJobSteps(entry.job);
      const label = `jobs.${entry.job.id} on ${entry.runsOn}`;
      const turbo = steps.findIndex((step) => stepKinds(step).includes('turbo'));
      const foreground = steps.flatMap((step, index) => (stepKinds(step).includes('foreground-tests') ? [index] : []));
      expect(
        foreground,
        `${label} must have one step that runs \`pnpm run ${foregroundTestScriptName}\` at the repository root`,
      ).toHaveLength(1);
      const index = foreground[0] ?? -1;
      const step = steps[index];
      if (!step) continue;
      expect(index, `${label}: the foreground group runs after \`pnpm turbo run\``).toBeGreaterThan(turbo);
      expect(step.if, `${label} steps[${index}] must have no if: (it runs on every runner)`).toBeUndefined();
      expect(stepRuns(entry, step, index), `${label} steps[${index}] must run`).toBe(true);
      expect(step['continue-on-error'], `${label} steps[${index}]: continue-on-error would hide a failure`).toBe(
        undefined,
      );
      covered.add(entry.runsOn);
    }
    expect([...covered].sort(), 'the foreground group must run on every runner').toEqual([...requiredRunners].sort());
  });

  // TST-018; ADR 0013 rule 2 ("default on ... in CI"): CI never switches background mode off for other launches
  it(`TST-018: no workflow sets ${testBackgroundVariableName} or ${testForegroundVariableName} in env, run or with`, () => {
    const names = [testBackgroundVariableName, testForegroundVariableName];
    const found: string[] = [];
    for (const relativePath of listWorkflowFiles(root)) {
      const workflow = readWorkflow(root, relativePath);
      const inEnv = (scope: WorkflowMapping): boolean =>
        isWorkflowMapping(scope.env) && names.some((name) => name in (scope.env as WorkflowMapping));
      if (inEnv(workflow)) found.push(`${relativePath} env`);
      for (const job of listWorkflowJobs(workflow)) {
        if (inEnv(job.definition)) found.push(`${relativePath} jobs.${job.id}.env`);
        listJobSteps(job).forEach((step, index) => {
          const text = `${typeof step.run === 'string' ? step.run : ''} ${JSON.stringify(step.with ?? {})}`;
          if (inEnv(step) || names.some((name) => text.includes(name))) {
            found.push(`${relativePath} jobs.${job.id}.steps[${index}]`);
          }
        });
      }
    }
    expect(found, 'the foreground group command sets the variable itself; workflows never set either name').toEqual([]);
  });
});

let cloneDir: string | undefined;
const runRoots: string[] = [];

afterAll(() => {
  removeCleanClone(cloneDir);
  for (const dir of runRoots) rmSync(dir, { recursive: true, force: true });
});

interface HostCheckRun {
  readonly result: EmulatedJobResult;
  readonly records: FakeCiRecord[];
  readonly steps: WorkflowMapping[];
  describe(): string;
}

/** Runs the check job for this runner with the fake commands. */
function runHostCheckJob(options: { foregroundExitCode?: number } = {}): HostCheckRun {
  const workflow = readCiWorkflow();
  const entries = listCheckCombinations(workflow).filter((entry) => entry.runsOn === hostLabel);
  expect(
    entries.map((entry) => `jobs.${entry.job.id}`),
    `exactly one check job must run on ${hostLabel}, the runner these tests run on`,
  ).toHaveLength(1);
  const entry = entries[0] as CheckCombination;
  cloneDir ??= createCleanClone(root);
  const runRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'foreground-group-ci-gate-')));
  runRoots.push(runRoot);
  const runnerDir = join(runRoot, 'runner');
  mkdirSync(runnerDir);
  const fakeBin = join(runRoot, 'fake-bin');
  installFakeCiCommands(fakeBin);
  const logPath = join(runRoot, 'fake-ci.log');
  const result = emulateWorkflowJob(workflow, entry.job, {
    originDir: cloneDir,
    runnerDir,
    defaultRef: 'HEAD',
    matrix: entry.combination,
    pathPrepend: [fakeBin],
    stepTimeoutMs: 240_000,
    expressions: { 'github.event_name': 'pull_request' },
    env: {
      [fakeCiEnvNames.log]: logPath,
      [fakeCiEnvNames.workspace]: join(runnerDir, 'workspace'),
      [fakeCiEnvNames.realRepoRoot]: root,
      [fakeCiEnvNames.marker]: `gate-${randomUUID()}`,
      [fakeCiEnvNames.foregroundExitCode]: String(options.foregroundExitCode ?? 0),
      [fakeCiEnvNames.recordEnv]: `${testBackgroundVariableName},${testForegroundVariableName}`,
      // Only the workflow may set these (it must not; see the shape gate).
      [testBackgroundVariableName]: '',
      [testForegroundVariableName]: '',
      DISPLAY: '',
      WAYLAND_DISPLAY: '',
    },
  });
  const records = readFakeCiLog(logPath);
  return {
    result,
    records,
    steps: listJobSteps(entry.job),
    describe: () =>
      `jobs.${entry.job.id} on ${hostLabel} (emulated)\njob exit code: ${result.exitCode}\nrecorded calls:\n${records
        .map(
          (record) =>
            `  ${record.command} ${record.args.join(' ')} [${record.kind ?? ''}] ${JSON.stringify(record.recordedEnv ?? {})}`,
        )
        .join('\n')}\n${result.output}`,
  };
}

describe(`foreground test group: emulated check job on this runner (${hostLabel})`, () => {
  // TST-018; issue #46 acceptance criterion 6 ("runs in CI"); ADR 0013 rules 2 and 3
  it.skipIf(process.platform === 'win32')(
    `TST-018: on ${hostLabel} the check job runs the foreground group once, after the turbo checks, and the turbo checks run without ${testForegroundVariableName}`,
    slow,
    () => {
      const run = runHostCheckJob();
      expect(run.result.exitCode, run.describe()).toBe(0);
      const turbo = run.records.findIndex((record) => record.kind === 'turbo');
      const foreground = run.records.flatMap((record, index) => (record.kind === 'foreground-tests' ? [index] : []));
      expect(foreground, `the foreground group must run exactly once:\n${run.describe()}`).toHaveLength(1);
      expect(turbo, `the turbo checks must run:\n${run.describe()}`).toBeGreaterThan(-1);
      expect(foreground[0], `the foreground group runs after the turbo checks:\n${run.describe()}`).toBeGreaterThan(
        turbo,
      );
      const turboEnv = run.records[turbo]?.recordedEnv ?? {};
      expect(
        turboEnv[testForegroundVariableName] ?? '',
        `the turbo checks must keep background mode:\n${run.describe()}`,
      ).not.toBe(testForegroundEnabledValue);
    },
  );

  // TST-018 (failure mode): a failing foreground group must fail the check
  it.skipIf(process.platform === 'win32')(
    `TST-018: on ${hostLabel} a failing foreground group fails the check job`,
    slow,
    () => {
      const run = runHostCheckJob({ foregroundExitCode: 1 });
      expect(
        run.records.some((record) => record.kind === 'foreground-tests'),
        `the foreground group must run:\n${run.describe()}`,
      ).toBe(true);
      expect(run.result.exitCode, `a failing foreground group must fail the job:\n${run.describe()}`).not.toBe(0);
    },
  );

  if (process.platform === 'win32')
    it.todo(`TST-018: emulated check job on ${hostLabel} (${emulatorWindowsSkipReason})`);
});
