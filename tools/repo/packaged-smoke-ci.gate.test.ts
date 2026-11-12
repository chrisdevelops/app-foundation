// Gate tests for #17: CI packages the reference app on Windows, macOS and
// Linux and runs the smoke suite against each packaged build.
// Requirements: TST-010, TST-015 (partial: skeleton suite), PLT-007 (partial).
// ADR 0011 (human decision): the smoke suite must pass on macOS and Linux; on
// Windows it may skip (follow-up #39), but the Windows job still packages the
// reference app. No gate here needs the smoke harness to pass on Windows.
//
// Contract read from the issue (the "packaged smoke job" is any job in
// .github/workflows/ci.yml with a run step that starts the smoke suite):
// - Commands, the same a developer runs: `pnpm install --frozen-lockfile`;
//   the reference app's `package` script (`pnpm --filter @foundation/reference
//   run package`, `pnpm -C apps/reference run package`, or `pnpm run package`
//   with working-directory apps/reference); the smoke suite with
//   `pnpm run smoke` (root) and SMOKE_APP_EXECUTABLE naming the packaged
//   executable (#16). Either may be wrapped in `xvfb-run`.
// - The packaged app is copied to a folder outside the workspace (whole app,
//   symlinks kept) and the smoke suite runs against that copy.
// - Linux: the AppArmor sysctl step from #15 runs first, and the smoke suite
//   has a virtual display (`xvfb-run`, or no DISPLAY so the harness starts one).
// - A failing smoke suite or package step fails the job.
//
// Two kinds of gate:
// - Workflow shape, for all three runners: read from the workflow file.
// - Emulated run, for the runner the tests run on: the job's steps run
//   locally (tools/test-support/workflow-job-emulator.ts) with fake `pnpm`,
//   `sudo` and `xvfb-run` (test-support/fake-ci-commands.ts), so the gate sees
//   which commands the job runs, in which order, and with which environment.
//   CI runs these gates on each of its three runners.
// What only a real CI run proves (the real packaged app passes the smoke suite
// on macOS and Linux; a deliberately failing smoke test fails the job; the
// fuse gates from #15 pass on each runner) is collected with `gh run` by the
// orchestrator.
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createCleanClone, removeCleanClone } from '../test-support/clean-clone';
import {
  ciWorkflowRelativePath,
  isWorkflowMapping,
  listJobSteps,
  listRunCommandLines,
  listWorkflowJobs,
  readWorkflow,
  resolveMatrixJobs,
  splitActionReference,
  splitCommandWords,
  workflowValueText,
  type MatrixCombination,
  type WorkflowJob,
  type WorkflowMapping,
} from '../test-support/github-workflow';
import { readPackagedAppLayout } from '../test-support/packaged-app-layout';
import { repoGateRootDir } from '../test-support/run-repo-command';
import {
  buildExpressionContext,
  emulateWorkflowJob,
  evaluateWorkflowCondition,
  hostRunnerLabel,
  runnerOsOfLabel,
  type EmulatedJobResult,
  type EmulatedRunnerOs,
} from '../test-support/workflow-job-emulator';
import {
  fakeCiEnvNames,
  fakePackagedFileText,
  installFakeCiCommands,
  parsePnpmInvocation,
  readFakeCiLog,
  stripCommandWrappers,
  type FakeCiRecord,
  type PnpmInvocationKind,
} from './test-support/fake-ci-commands';

const root = repoGateRootDir;
const requiredRunners = ['windows-latest', 'macos-latest', 'ubuntu-latest'] as const;
/** Runners where the smoke suite must run (ADR 0011). */
const smokeRunners = ['macos-latest', 'ubuntu-latest'] as const;
/** The step #15 added so Chromium's sandbox works on Ubuntu 24.04. */
const sandboxSysctlLine = /^sudo\s+sysctl\s+-w\s+kernel\.apparmor_restrict_unprivileged_userns=0$/;
const hostLabel = hostRunnerLabel();
const hostRunsSmoke = (smokeRunners as readonly string[]).includes(hostLabel);
const adr0011SkipReason = 'ADR 0011: on Windows the smoke suite may skip (#39); the package gates still run here';
const slow = { timeout: 300_000 };

/** A path that stands for the workspace when a workflow is read without running it. */
const virtualWorkspace = resolve(tmpdir(), 'packaged-smoke-gate-virtual-workspace');

function readCiWorkflow(): WorkflowMapping {
  expect(existsSync(join(root, ciWorkflowRelativePath)), `${ciWorkflowRelativePath} must exist`).toBe(true);
  return readWorkflow(root, ciWorkflowRelativePath);
}

function defaultWorkingDirectory(scope: WorkflowMapping): string | undefined {
  const defaults = scope.defaults;
  if (!isWorkflowMapping(defaults) || !isWorkflowMapping(defaults.run)) return undefined;
  const value = defaults.run['working-directory'];
  return value === undefined || value === null ? undefined : workflowValueText(value);
}

/** What each pnpm command line of a step does, read without running it. */
function classifyStep(
  workflow: WorkflowMapping,
  job: WorkflowJob,
  step: WorkflowMapping,
): Array<{ kind: PnpmInvocationKind; line: string; words: string[]; underXvfb: boolean }> {
  const workingDirectory =
    step['working-directory'] !== undefined && step['working-directory'] !== null
      ? workflowValueText(step['working-directory'])
      : (defaultWorkingDirectory(job.definition) ?? defaultWorkingDirectory(workflow) ?? '.');
  const cwd = resolve(virtualWorkspace, workingDirectory);
  return listRunCommandLines(step).flatMap((line) => {
    const { words, underXvfb } = stripCommandWrappers(splitCommandWords(line));
    if (words[0] !== 'pnpm') return [];
    const invocation = parsePnpmInvocation(words.slice(1), cwd, virtualWorkspace);
    return [{ kind: invocation.kind, line, words, underXvfb }];
  });
}

function stepDoes(workflow: WorkflowMapping, job: WorkflowJob, step: WorkflowMapping, kind: PnpmInvocationKind) {
  return classifyStep(workflow, job, step).some((entry) => entry.kind === kind);
}

function isFrozenInstallStep(step: WorkflowMapping): boolean {
  return listRunCommandLines(step).some((line) => {
    const words = splitCommandWords(line);
    return words[0] === 'pnpm' && words[1] === 'install' && words.includes('--frozen-lockfile');
  });
}

function usesRepository(step: WorkflowMapping): string | undefined {
  return typeof step.uses === 'string' ? splitActionReference(step.uses)?.repository : undefined;
}

interface PackagedSmokeCombination {
  readonly job: WorkflowJob;
  readonly combination: MatrixCombination;
  readonly runsOn: string;
  readonly checkName: string;
  readonly runnerOs: EmulatedRunnerOs | undefined;
  readonly steps: WorkflowMapping[];
}

/** Every (job, matrix combination) of a job that has a step starting the smoke suite. */
function listPackagedSmokeCombinations(workflow: WorkflowMapping): PackagedSmokeCombination[] {
  return listWorkflowJobs(workflow)
    .filter((job) => listJobSteps(job).some((step) => stepDoes(workflow, job, step, 'smoke')))
    .flatMap((job) =>
      resolveMatrixJobs(job).map((resolved) => ({
        job,
        combination: resolved.combination,
        runsOn: resolved.runsOn,
        checkName: resolved.checkName,
        runnerOs: runnerOsOfLabel(resolved.runsOn),
        steps: listJobSteps(job),
      })),
    );
}

function requirePackagedSmokeCombinations(workflow: WorkflowMapping): PackagedSmokeCombination[] {
  const found = listPackagedSmokeCombinations(workflow);
  expect(
    found.map((entry) => `${entry.job.id} on ${entry.runsOn}`),
    `${ciWorkflowRelativePath} must have a job with a run step that starts the smoke suite (\`pnpm run smoke\`, TST-010)`,
  ).not.toEqual([]);
  return found;
}

/** True when the step runs on this combination while every earlier step passed. */
function stepRuns(entry: PackagedSmokeCombination, step: WorkflowMapping, index: number): boolean {
  const context = buildExpressionContext(entry.job, {
    runnerDir: virtualWorkspace,
    expressions: { 'github.event_name': 'pull_request' },
    matrix: entry.combination,
  });
  const condition = step.if === undefined || step.if === null ? undefined : workflowValueText(step.if);
  return evaluateWorkflowCondition(
    condition,
    context,
    { failed: false },
    `jobs.${entry.job.id}.steps[${index}].if on ${entry.runsOn}`,
  );
}

function indexesWhere(
  entry: PackagedSmokeCombination,
  predicate: (step: WorkflowMapping, index: number) => boolean,
): number[] {
  return entry.steps.flatMap((step, index) => (predicate(step, index) && stepRuns(entry, step, index) ? [index] : []));
}

function label(entry: PackagedSmokeCombination): string {
  return `jobs.${entry.job.id} on ${entry.runsOn}`;
}

describe('packaged smoke job: workflow shape on all three runners', () => {
  // TST-010, TST-015; issue #17 acceptance criterion 1 (a CI job per OS)
  it('TST-010: a CI job starts the smoke suite once on each of windows-latest, macos-latest and ubuntu-latest', () => {
    const runners = requirePackagedSmokeCombinations(readCiWorkflow()).map((entry) => entry.runsOn);
    expect([...runners].sort(), `the packaged smoke job runs on ${runners.join(', ')}`).toEqual(
      [...requiredRunners].sort(),
    );
  });

  // TST-015 (failure mode): one failing platform must not cancel or hide the others
  it('TST-015: packaged smoke jobs set fail-fast to false and have no job-level if or continue-on-error', () => {
    const workflow = readCiWorkflow();
    for (const job of new Set(requirePackagedSmokeCombinations(workflow).map((entry) => entry.job))) {
      const strategy = job.definition.strategy;
      if (resolveMatrixJobs(job).length > 1) {
        expect(
          isWorkflowMapping(strategy) ? strategy['fail-fast'] : undefined,
          `jobs.${job.id}.strategy.fail-fast must be false`,
        ).toBe(false);
      }
      expect(job.definition.if, `jobs.${job.id}.if could skip the packaged smoke check`).toBeUndefined();
      expect(job.definition['continue-on-error'], `jobs.${job.id}.continue-on-error would hide a failure`).toBe(
        undefined,
      );
      listJobSteps(job).forEach((step, index) => {
        expect(
          step['continue-on-error'],
          `jobs.${job.id}.steps[${index}].continue-on-error would hide a failing step`,
        ).toBeUndefined();
      });
    }
  });

  // TST-015: `gh pr checks` shows one named result per OS (ADR 0009 item 4 reads these names)
  it('TST-015: each packaged smoke check name is unique in the workflow and names its own OS only', () => {
    const workflow = readCiWorkflow();
    const entries = requirePackagedSmokeCombinations(workflow);
    const allNames = listWorkflowJobs(workflow).flatMap((job) =>
      resolveMatrixJobs(job).map((resolved) => resolved.checkName),
    );
    const osWords: Record<string, RegExp> = {
      'windows-latest': /windows/i,
      'macos-latest': /mac/i,
      'ubuntu-latest': /ubuntu|linux/i,
    };
    for (const entry of entries) {
      expect(
        allNames.filter((name) => name === entry.checkName),
        `check name "${entry.checkName}" must be unique in ${ciWorkflowRelativePath}`,
      ).toHaveLength(1);
      for (const [runner, word] of Object.entries(osWords)) {
        if (runner === entry.runsOn) expect(entry.checkName, `${label(entry)} check name`).toMatch(word);
        else expect(entry.checkName, `${label(entry)} check name must not name ${runner}`).not.toMatch(word);
      }
    }
  });

  // TST-010, PLT-007; ADR 0011: Windows still packages; issue #17 acceptance criterion 1
  it('TST-010: on every runner the job checks out, sets up pnpm and Node, installs with --frozen-lockfile, then runs the reference app package script', () => {
    const workflow = readCiWorkflow();
    for (const entry of requirePackagedSmokeCombinations(workflow)) {
      const checkout = indexesWhere(entry, (step) => usesRepository(step) === 'actions/checkout');
      const setupPnpm = indexesWhere(entry, (step) => usesRepository(step) === 'pnpm/action-setup');
      const setupNode = indexesWhere(entry, (step) => usesRepository(step) === 'actions/setup-node');
      const install = indexesWhere(entry, (step) => isFrozenInstallStep(step));
      const packaging = indexesWhere(entry, (step) => stepDoes(workflow, entry.job, step, 'package-reference'));
      expect(checkout[0], `${label(entry)}: the first step must be actions/checkout`).toBe(0);
      expect(setupPnpm.length, `${label(entry)} must set up pnpm with pnpm/action-setup`).toBeGreaterThan(0);
      expect(setupNode.length, `${label(entry)} must set up Node with actions/setup-node`).toBeGreaterThan(0);
      expect(install.length, `${label(entry)} must run \`pnpm install --frozen-lockfile\``).toBeGreaterThan(0);
      expect(
        packaging.length,
        `${label(entry)} must run the reference app's package script (for example \`pnpm --filter @foundation/reference run package\`) on this runner`,
      ).toBeGreaterThan(0);
      expect(Math.max(setupPnpm[0] ?? 99, setupNode[0] ?? 99), `${label(entry)}: set up before install`).toBeLessThan(
        install[0] ?? -1,
      );
      expect(install[0], `${label(entry)}: install before packaging`).toBeLessThan(packaging[0] ?? -1);
    }
  });

  // TST-010; ADR 0011: the smoke suite runs on macOS and Linux
  it('TST-010: on macos-latest and ubuntu-latest the smoke step runs after the package step', () => {
    const workflow = readCiWorkflow();
    const entries = requirePackagedSmokeCombinations(workflow);
    for (const runner of smokeRunners) {
      const entry = entries.find((candidate) => candidate.runsOn === runner);
      expect(entry, `a packaged smoke job must run on ${runner}`).toBeDefined();
      if (!entry) continue;
      const packaging = indexesWhere(entry, (step) => stepDoes(workflow, entry.job, step, 'package-reference'));
      const smoke = indexesWhere(entry, (step) => stepDoes(workflow, entry.job, step, 'smoke'));
      expect(smoke.length, `${label(entry)}: the smoke step must run on ${runner} (no if: that skips it)`).toBe(1);
      expect(packaging[0] ?? 99, `${label(entry)}: package before smoke`).toBeLessThan(smoke[0] ?? -1);
    }
  });

  // TST-010; issue #17 acceptance criterion 3; #15: the Chromium sandbox on Ubuntu 24.04
  it('TST-010: on ubuntu-latest the AppArmor sysctl step runs before the smoke step, and no step passes --no-sandbox', () => {
    const workflow = readCiWorkflow();
    const entry = requirePackagedSmokeCombinations(workflow).find((candidate) => candidate.runsOn === 'ubuntu-latest');
    expect(entry, 'a packaged smoke job must run on ubuntu-latest').toBeDefined();
    if (!entry) return;
    const sysctl = indexesWhere(entry, (step) =>
      listRunCommandLines(step).some((line) => sandboxSysctlLine.test(line)),
    );
    const smoke = indexesWhere(entry, (step) => stepDoes(workflow, entry.job, step, 'smoke'));
    expect(
      sysctl.length,
      `${label(entry)} must run \`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0\``,
    ).toBeGreaterThan(0);
    expect(sysctl[0], `${label(entry)}: the sysctl step must run before the smoke step`).toBeLessThan(smoke[0] ?? -1);
    for (const step of entry.steps) {
      expect(typeof step.run === 'string' ? step.run : '', '`--no-sandbox` is never used').not.toMatch(/--no-sandbox/);
    }
  });

  // TST-015: the same bash steps run on all three runners, and stop at the first failing command
  it('TST-015: every run step of the packaged smoke job that runs on windows-latest uses bash', () => {
    const workflow = readCiWorkflow();
    const entry = requirePackagedSmokeCombinations(workflow).find((candidate) => candidate.runsOn === 'windows-latest');
    expect(entry, 'a packaged smoke job must run on windows-latest').toBeDefined();
    if (!entry) return;
    const defaultShell = (scope: WorkflowMapping): unknown =>
      isWorkflowMapping(scope.defaults) && isWorkflowMapping(scope.defaults.run) ? scope.defaults.run.shell : undefined;
    entry.steps.forEach((step, index) => {
      if (typeof step.run !== 'string' || !stepRuns(entry, step, index)) return;
      const shell = step.shell ?? defaultShell(entry.job.definition) ?? defaultShell(workflow);
      expect(shell, `${label(entry)} steps[${index}] must use shell: bash (the default on Windows is pwsh)`).toBe(
        'bash',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Emulated run on this runner
// ---------------------------------------------------------------------------

interface HostJobRun {
  readonly result: EmulatedJobResult;
  readonly records: FakeCiRecord[];
  readonly marker: string;
  readonly workspace: string;
  readonly entry: PackagedSmokeCombination;
  readonly workflow: WorkflowMapping;
  describe(): string;
}

let cloneDir: string | undefined;
const runRoots: string[] = [];

afterAll(() => {
  removeCleanClone(cloneDir);
  for (const dir of runRoots) rmSync(dir, { recursive: true, force: true });
});

function hostCombination(workflow: WorkflowMapping): PackagedSmokeCombination {
  const entries = requirePackagedSmokeCombinations(workflow).filter((entry) => entry.runsOn === hostLabel);
  expect(
    entries.map(label),
    `exactly one packaged smoke job must run on ${hostLabel}, the runner these tests run on`,
  ).toHaveLength(1);
  return entries[0] as PackagedSmokeCombination;
}

/** Runs the packaged smoke job for this runner with the fake commands. */
function runHostJob(options: { smokeExitCode?: number; packageExitCode?: number } = {}): HostJobRun {
  const workflow = readCiWorkflow();
  const entry = hostCombination(workflow);
  cloneDir ??= createCleanClone(root);
  const runRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'packaged-smoke-ci-gate-')));
  runRoots.push(runRoot);
  const runnerDir = join(runRoot, 'runner');
  mkdirSync(runnerDir);
  const fakeBin = join(runRoot, 'fake-bin');
  installFakeCiCommands(fakeBin);
  const logPath = join(runRoot, 'fake-ci.log');
  const marker = `gate-${randomUUID()}`;
  const workspace = join(runnerDir, 'workspace');
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
      [fakeCiEnvNames.workspace]: workspace,
      [fakeCiEnvNames.realRepoRoot]: root,
      [fakeCiEnvNames.marker]: marker,
      [fakeCiEnvNames.smokeExitCode]: String(options.smokeExitCode ?? 0),
      [fakeCiEnvNames.packageExitCode]: String(options.packageExitCode ?? 0),
      // GitHub-hosted runners have no display; only the workflow can provide one.
      DISPLAY: '',
      WAYLAND_DISPLAY: '',
    },
  });
  const records = readFakeCiLog(logPath);
  return {
    result,
    records,
    marker,
    workspace,
    entry,
    workflow,
    describe: () =>
      `${label(entry)} (emulated)\njob exit code: ${result.exitCode}\nskipped steps: ${JSON.stringify(result.skippedStepIndexes)}\nrecorded calls:\n${records
        .map((record) => `  ${record.command} ${record.args.join(' ')} [${record.kind ?? ''}] in ${record.cwd}`)
        .join('\n')}\n${result.output}`,
  };
}

function isInside(parent: string, child: string): boolean {
  const fromParent = relative(realpathSync.native(parent), child);
  return fromParent === '' || (!fromParent.startsWith(`..${sep}`) && fromParent !== '..' && !isAbsolute(fromParent));
}

/** The packaged app folder that holds `executable` (the folder above the .app bundle on macOS). */
function packagedAppFolderOf(executable: string): string {
  if (process.platform === 'darwin') {
    const bundleIndex = executable.split(sep).findIndex((part) => part.endsWith('.app'));
    return executable.split(sep).slice(0, Math.max(bundleIndex, 0)).join(sep);
  }
  return dirname(executable);
}

describe(`packaged smoke job: emulated run on this runner (${hostLabel})`, () => {
  // TST-010, PLT-007; issue #17 acceptance criterion 1; ADR 0011 (Windows still packages)
  it(
    `TST-010: on ${hostLabel} the job passes when packaging and the smoke suite pass, and it packages the reference app before any smoke run`,
    slow,
    () => {
      const run = runHostJob();
      expect(run.result.exitCode, run.describe()).toBe(0);
      expect(
        run.records.filter((record) => record.kind === 'unsupported'),
        `the job ran pnpm commands the contract does not name:\n${run.describe()}`,
      ).toEqual([]);
      const firstPackage = run.records.findIndex((record) => record.kind === 'package-reference');
      expect(firstPackage, `the job must run the reference app's package script:\n${run.describe()}`).toBeGreaterThan(
        -1,
      );
      const firstSmoke = run.records.findIndex((record) => record.kind === 'smoke');
      if (firstSmoke !== -1) {
        expect(firstSmoke, `the smoke suite must run after packaging:\n${run.describe()}`).toBeGreaterThan(
          firstPackage,
        );
      }
    },
  );

  // TST-010; issue #17 acceptance criterion 1 (copy outside the workspace; spike #9)
  it.skipIf(!hostRunsSmoke)(
    `TST-010: on ${hostLabel} the smoke suite runs once, against the packaged executable copied to a folder outside the workspace`,
    slow,
    () => {
      const run = runHostJob();
      const smoke = run.records.filter((record) => record.kind === 'smoke');
      expect(smoke, `the smoke suite must run exactly once:\n${run.describe()}`).toHaveLength(1);
      const call = smoke[0] as FakeCiRecord;
      const executable = call.smokeAppExecutable ?? '';
      expect(executable, `SMOKE_APP_EXECUTABLE must be set for the smoke suite:\n${run.describe()}`).not.toBe('');
      expect(isAbsolute(executable), `SMOKE_APP_EXECUTABLE must be an absolute path, not ${executable}`).toBe(true);
      expect(
        call.executableAtCall,
        `SMOKE_APP_EXECUTABLE (${executable}) must name the packaged executable when the smoke suite starts:\n${run.describe()}`,
      ).toEqual({ exists: true, isFile: true, content: fakePackagedFileText(run.marker).executable });
      expect(
        isInside(run.workspace, executable),
        `${executable} must be outside the workspace ${run.workspace}: the smoke suite runs against a copy (spike #9)`,
      ).toBe(false);
      expect(isInside(root, executable), `${executable} must be outside the repository ${root}`).toBe(false);

      const copyDir = packagedAppFolderOf(executable);
      expect(existsSync(copyDir), `the copied app folder ${copyDir} must still exist after the job`).toBe(true);
      const layout = readPackagedAppLayout(copyDir);
      expect(layout.executablePath, 'the copied app layout must lead to the same executable').toBe(executable);
      expect(existsSync(layout.asarPath), `the whole app must be copied: ${layout.asarPath} is missing`).toBe(true);
      expect(readFileSync(layout.asarPath, 'utf8'), 'app.asar in the copy must be the packaged one').toBe(
        fakePackagedFileText(run.marker).asar,
      );
      if (process.platform === 'darwin') {
        const current = join(
          dirname(dirname(dirname(layout.executablePath))),
          'Contents',
          'Frameworks',
          'Electron Framework.framework',
          'Versions',
          'Current',
        );
        expect(
          existsSync(current) && lstatSync(current).isSymbolicLink(),
          `${current} must stay a symbolic link in the copy (macOS frameworks rely on them)`,
        ).toBe(true);
      }
    },
  );

  // TST-010; issue #17 acceptance criterion 3 (Linux runs under a virtual display); #15 sandbox step
  it.runIf(process.platform === 'linux')(
    'TST-010: on ubuntu-latest the smoke suite has a virtual display and runs after the AppArmor sysctl call',
    slow,
    () => {
      const run = runHostJob();
      const smokeIndex = run.records.findIndex((record) => record.kind === 'smoke');
      expect(smokeIndex, `the smoke suite must run:\n${run.describe()}`).toBeGreaterThan(-1);
      const call = run.records[smokeIndex] as FakeCiRecord;
      expect(
        call.underVirtualDisplay === true || (call.display === '' && call.waylandDisplay === ''),
        `the smoke suite needs xvfb-run, or no DISPLAY so the harness starts one; it saw DISPLAY=${JSON.stringify(call.display)}:\n${run.describe()}`,
      ).toBe(true);
      const sysctlIndex = run.records.findIndex(
        (record) => record.command === 'sudo' && sandboxSysctlLine.test(`sudo ${record.args.join(' ')}`),
      );
      expect(sysctlIndex, `the AppArmor sysctl must run before the smoke suite:\n${run.describe()}`).toBeGreaterThan(
        -1,
      );
      expect(sysctlIndex).toBeLessThan(smokeIndex);
    },
  );

  // TST-010 (failure mode); issue #17 acceptance criterion 5
  it.skipIf(!hostRunsSmoke)(
    `TST-010: on ${hostLabel} a failing smoke suite fails the job, at the smoke step`,
    slow,
    () => {
      const run = runHostJob({ smokeExitCode: 1 });
      expect(
        run.records.some((record) => record.kind === 'smoke'),
        `the smoke suite must run:\n${run.describe()}`,
      ).toBe(true);
      expect(run.result.exitCode, `a failing smoke suite must fail the job:\n${run.describe()}`).not.toBe(0);
      const failing = run.result.steps.find((step) => step.exitCode !== 0);
      const failingStep = run.entry.steps[failing?.index ?? -1];
      expect(
        failingStep !== undefined && stepDoes(run.workflow, run.entry.job, failingStep, 'smoke'),
        `the first failing step must be the smoke step, not step ${String(failing?.index)}:\n${run.describe()}`,
      ).toBe(true);
    },
  );

  // TST-010 (failure mode): a failed package must never be smoke-tested or pass
  it(`TST-010: on ${hostLabel} a failing package step fails the job and the smoke suite never runs`, slow, () => {
    const run = runHostJob({ packageExitCode: 1 });
    expect(
      run.records.some((record) => record.kind === 'package-reference'),
      `the job must run the reference app's package script:\n${run.describe()}`,
    ).toBe(true);
    expect(run.result.exitCode, `a failing package step must fail the job:\n${run.describe()}`).not.toBe(0);
    expect(
      run.records.filter((record) => record.kind === 'smoke'),
      `the smoke suite must not run after packaging failed:\n${run.describe()}`,
    ).toEqual([]);
  });

  if (!hostRunsSmoke) {
    it.todo(`TST-010: smoke suite on ${hostLabel} (${adr0011SkipReason}; DEFERRED: TST-010)`);
  }

  // DEFERRED: TST-010 (issue #17 acceptance criterion 2): the CDP variable's name is defined in #18.
  it.todo('TST-010: the smoke step sets the variable that enables CDP in packaged builds (name defined in #18)');

  // Needs a decision (issue #17 acceptance criterion 6): uploading artifacts needs actions/upload-artifact,
  // which is not on the CI action allowlist (#13).
  it.todo('TST-010: on failure, harness logs and screenshots are uploaded as artifacts');
});
