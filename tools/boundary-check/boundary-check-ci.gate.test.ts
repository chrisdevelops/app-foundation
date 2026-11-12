// Gate tests for #14: CI runs the boundary check as its own job on every pull
// request, on one OS, with a stable check name. They read `.github/workflows/`
// and work out what GitHub would run, like tools/repo/ci-workflow.gate.test.ts.
// The job may live in ci.yml or in its own workflow file. What only a real run
// can prove (the check appears in `gh pr checks` and fails a bad pull request)
// is collected from `gh run` by the orchestrator.
//
// ADR 0008 item 2: the job runs the script as it exists on the base commit,
// and the pull request version only when the base has none, with a visible
// notice. The "script source" gates run the job's steps locally against a
// fixture repository (see test-support/workflow-job-emulator.ts).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isExpressionValue,
  isWorkflowMapping,
  listJobSteps,
  listRunCommandLines,
  listWorkflowFiles,
  listWorkflowJobs,
  readWorkflow,
  resolveMatrixJobs,
  splitActionReference,
  splitCommandWords,
  workflowValueText,
  type WorkflowJob,
  type WorkflowMapping,
} from '../repo/test-support/github-workflow';
import { describeRepoCommand, repoGateRootDir, runRepoCommand } from '../repo/test-support/run-repo-command';
import type { WorkflowYamlValue } from '../repo/test-support/workflow-yaml-reader';
import { emulateWorkflowJob, type EmulatedJobResult } from './test-support/workflow-job-emulator';

const root = repoGateRootDir;

/** The script the boundary check job runs, as it appears in the run command. */
const boundaryCheckEntryRelativePath = 'tools/boundary-check/boundary-check.ts';

/** The check name `gh pr checks` lists and branch protection requires. */
const boundaryCheckName = 'boundary-check';

const hostedRunners = ['ubuntu-latest', 'macos-latest', 'windows-latest'] as const;

/** Where each input comes from in a pull_request event. */
const inputExpressions: Readonly<Record<'--base' | '--head' | '--branch', RegExp>> = {
  '--base': /^\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}$/,
  '--head': /^\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}$/,
  '--branch': /^\$\{\{\s*(github\.head_ref|github\.event\.pull_request\.head\.ref)\s*\}\}$/,
};

/** The only condition the job may have: run for pull requests. */
const pullRequestCondition = /^\s*(\$\{\{\s*)?github\.event_name\s*==\s*'pull_request'\s*(\}\}\s*)?$/;

/** The only token permissions the job may have (as for #13). */
const allowedTokenPermissions: Readonly<Record<string, readonly string[]>> = { contents: ['read', 'none'] };

interface BoundaryCheckJob {
  readonly file: string;
  readonly workflow: WorkflowMapping;
  readonly job: WorkflowJob;
  readonly steps: WorkflowMapping[];
  /** Index of the step that runs the check. */
  readonly checkStepIndex: number;
}

/** A command line that starts the check: `node <script> ... --base ...`, whichever copy of the script it runs. */
function runsBoundaryCheck(line: string): boolean {
  const words = splitCommandWords(line);
  return words[0] === 'node' && words.includes('--base');
}

/** True when the job names the script anywhere in a run step or env value. */
function namesBoundaryCheckScript(job: WorkflowJob): boolean {
  return listJobSteps(job).some(
    (step) =>
      (typeof step.run === 'string' && step.run.includes(boundaryCheckEntryRelativePath)) ||
      Object.values(isWorkflowMapping(step.env) ? step.env : {}).some((value) =>
        workflowValueText(value).includes(boundaryCheckEntryRelativePath),
      ),
  );
}

function listBoundaryCheckJobs(): BoundaryCheckJob[] {
  return listWorkflowFiles(root).flatMap((file) => {
    const workflow = readWorkflow(root, file);
    return listWorkflowJobs(workflow).flatMap((job) => {
      const steps = listJobSteps(job);
      if (!namesBoundaryCheckScript(job)) return [];
      const checkStepIndex = steps.findIndex((step) => listRunCommandLines(step).some(runsBoundaryCheck));
      return [{ file, workflow, job, steps, checkStepIndex }];
    });
  });
}

function readBoundaryCheckJob(): BoundaryCheckJob {
  const jobs = listBoundaryCheckJobs();
  expect(
    jobs.map((entry) => `${entry.file} jobs.${entry.job.id}`),
    `exactly one job in .github/workflows must run \`node ${boundaryCheckEntryRelativePath}\` (#14)`,
  ).toHaveLength(1);
  const entry = jobs[0] as BoundaryCheckJob;
  expect(
    entry.checkStepIndex,
    `${label(entry)} must have a run step with a line \`node <script> --base ... --head ... --branch ...\``,
  ).toBeGreaterThan(-1);
  return entry;
}

function label(entry: BoundaryCheckJob, index?: number): string {
  return index === undefined
    ? `${entry.file} jobs.${entry.job.id}`
    : `${entry.file} jobs.${entry.job.id}.steps[${index}]`;
}

function readTrigger(workflow: WorkflowMapping, event: string): WorkflowMapping | undefined {
  const on = workflow.on;
  if (typeof on === 'string') return on === event ? {} : undefined;
  if (Array.isArray(on)) return on.includes(event) ? {} : undefined;
  if (!isWorkflowMapping(on) || !(event in on)) return undefined;
  const settings = on[event];
  return isWorkflowMapping(settings) ? settings : {};
}

function listTriggerEvents(workflow: WorkflowMapping): string[] {
  const on = workflow.on;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map((event) => workflowValueText(event));
  return isWorkflowMapping(on) ? Object.keys(on) : [];
}

function usesRepository(step: WorkflowMapping): string | undefined {
  return typeof step.uses === 'string' ? splitActionReference(step.uses)?.repository : undefined;
}

function stepInputs(step: WorkflowMapping): WorkflowMapping {
  return isWorkflowMapping(step.with) ? step.with : {};
}

function envOf(scope: WorkflowMapping): WorkflowMapping {
  return isWorkflowMapping(scope.env) ? scope.env : {};
}

/** The env value a step sees: step env over job env over workflow env. */
function resolveEnv(entry: BoundaryCheckJob, step: WorkflowMapping, name: string): WorkflowYamlValue | undefined {
  return envOf(step)[name] ?? envOf(entry.job.definition)[name] ?? envOf(entry.workflow)[name];
}

/** The variable name in `$NAME`, `${NAME}` or `$env:NAME`, or undefined for anything else. */
function referencedVariable(word: string | undefined): string | undefined {
  return /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|env:([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))$/
    .exec(word ?? '')
    ?.slice(1)
    .find((name) => name !== undefined);
}

describe('boundary check CI job', () => {
  // #14: CI runs the check as its own job
  it('#14: exactly one workflow job runs tools/boundary-check/boundary-check.ts with node --base --head --branch', () => {
    const entry = readBoundaryCheckJob();
    const lines = listRunCommandLines(entry.steps[entry.checkStepIndex] as WorkflowMapping).filter(runsBoundaryCheck);
    for (const line of lines) {
      const words = splitCommandWords(line);
      for (const option of ['--head', '--branch']) {
        expect(words, `${label(entry, entry.checkStepIndex)}: "${line}" must pass ${option}`).toContain(option);
      }
    }
  });

  // #14: on every pull request
  it('#14: the job runs on every pull request to main, with no path filter and no narrowed event types', () => {
    const entry = readBoundaryCheckJob();
    const trigger = readTrigger(entry.workflow, 'pull_request');
    expect(trigger, `${entry.file} must trigger on pull_request`).toBeDefined();
    if (trigger?.branches !== undefined) {
      expect(trigger.branches, `${entry.file} on.pull_request.branches must include main`).toEqual(
        expect.arrayContaining(['main']),
      );
    }
    for (const filter of ['branches-ignore', 'paths', 'paths-ignore']) {
      expect(trigger?.[filter], `${entry.file} on.pull_request.${filter} would skip the check`).toBeUndefined();
    }
    if (trigger?.types !== undefined) {
      expect(
        trigger.types,
        `${entry.file} on.pull_request.types must include opened, synchronize and reopened`,
      ).toEqual(expect.arrayContaining(['opened', 'synchronize', 'reopened']));
    }
  });

  // #14: only pull requests carry a base and head SHA
  it('#14: the job runs only for pull_request events, with no other job condition', () => {
    const entry = readBoundaryCheckJob();
    const condition = entry.job.definition.if;
    const otherEvents = listTriggerEvents(entry.workflow).filter((event) => event !== 'pull_request');
    if (otherEvents.length > 0) {
      expect(
        condition,
        `${label(entry)}.if must be github.event_name == 'pull_request', because ${entry.file} also runs on ${otherEvents.join(', ')}`,
      ).toBeDefined();
    }
    if (condition !== undefined) {
      expect(workflowValueText(condition), `${label(entry)}.if may only limit the job to pull requests`).toMatch(
        pullRequestCondition,
      );
    }
  });

  // #14: one OS is enough, and the check name is stable
  it('#14: the job runs once on one literal hosted runner, with the literal check name boundary-check', () => {
    const entry = readBoundaryCheckJob();
    expect(entry.job.definition.strategy, `${label(entry)} must not use a strategy or matrix`).toBeUndefined();
    const resolved = resolveMatrixJobs(entry.job);
    expect(resolved, `${label(entry)} must run exactly once`).toHaveLength(1);
    expect(isExpressionValue(entry.job.definition['runs-on']), `${label(entry)}.runs-on must be literal`).toBe(false);
    expect(hostedRunners as readonly string[], `${label(entry)}.runs-on`).toContain(resolved[0]?.runsOn);
    expect(isExpressionValue(entry.job.definition.name), `${label(entry)}.name must be literal`).toBe(false);
    expect(resolved[0]?.checkName, `${label(entry)} check name`).toBe(boundaryCheckName);
  });

  // #14: the check needs the base commit, which a depth-1 checkout lacks
  it('#14: the job first checks out the full history, with persist-credentials: false', () => {
    const entry = readBoundaryCheckJob();
    const checkoutIndex = entry.steps.findIndex((step) => usesRepository(step) === 'actions/checkout');
    expect(checkoutIndex, `${label(entry)}: the first step must be actions/checkout`).toBe(0);
    const inputs = stepInputs(entry.steps[0] as WorkflowMapping);
    expect(
      workflowValueText(inputs['fetch-depth'] ?? null),
      `${label(entry, 0)} with.fetch-depth must be 0, or the base commit is missing`,
    ).toBe('0');
    expect(
      inputs['persist-credentials'] === false || inputs['persist-credentials'] === 'false',
      `${label(entry, 0)} with.persist-credentials must be false`,
    ).toBe(true);
    expect(checkoutIndex).toBeLessThan(entry.checkStepIndex);
  });

  // #14, TOK-128: the check runs on the pinned Node, which strips TypeScript types
  it('#14: the job sets up the pinned Node version with actions/setup-node before the check step', () => {
    const entry = readBoundaryCheckJob();
    const pinnedNode = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { engines?: { node?: string } })
      .engines?.node;
    const setupIndex = entry.steps.findIndex((step) => usesRepository(step) === 'actions/setup-node');
    expect(setupIndex, `${label(entry)} must use actions/setup-node`).toBeGreaterThan(-1);
    expect(setupIndex, `${label(entry)}: actions/setup-node must run before the check`).toBeLessThan(
      entry.checkStepIndex,
    );
    const inputs = stepInputs(entry.steps[setupIndex] as WorkflowMapping);
    const fromFile = inputs['node-version'] === undefined && inputs['node-version-file'] === 'package.json';
    if (!fromFile) {
      expect(
        workflowValueText(inputs['node-version'] ?? null),
        `${label(entry, setupIndex)}: node-version-file must be package.json, or node-version must be ${pinnedNode}`,
      ).toBe(pinnedNode);
    }
  });

  // #14 (security): a branch name is attacker-controlled text; it must not be pasted into the script
  it('#14: the check step reads base SHA, head SHA and branch from env variables, never from inline expressions', () => {
    const entry = readBoundaryCheckJob();
    entry.steps.forEach((anyStep, index) => {
      for (const line of listRunCommandLines(anyStep)) {
        expect(line, `${label(entry, index)}: pass values through env, not \${{ }} in run`).not.toContain('${{');
      }
    });
    const step = entry.steps[entry.checkStepIndex] as WorkflowMapping;
    for (const line of listRunCommandLines(step).filter(runsBoundaryCheck)) {
      const words = splitCommandWords(line);
      for (const [option, expression] of Object.entries(inputExpressions)) {
        const index = words.indexOf(option);
        expect(index, `${label(entry, entry.checkStepIndex)} must pass ${option}`).toBeGreaterThan(-1);
        const variable = referencedVariable(words[index + 1]);
        expect(variable, `${option} must be followed by an env variable such as "$BASE_SHA"`).toBeDefined();
        const value = resolveEnv(entry, step, variable as string);
        expect(
          workflowValueText(value ?? null).trim(),
          `env ${variable} for ${option} must be set to the pull request value ${expression.source}`,
        ).toMatch(expression);
      }
    }
  });

  // #14 (failure mode): a failing check fails the job
  it('#14: the job and its check step cannot pass when the check fails', () => {
    const entry = readBoundaryCheckJob();
    expect(entry.job.definition['continue-on-error'] ?? false, `${label(entry)}.continue-on-error`).toBe(false);
    entry.steps.forEach((step, index) => {
      expect(step['continue-on-error'] ?? false, `${label(entry, index)}.continue-on-error`).toBe(false);
    });
    // ADR 0008 item 2: the choice of script is made in shell, never by a step condition
    entry.steps.forEach((step, index) => {
      expect(step.if, `${label(entry, index)}.if could skip a step of the check`).toBeUndefined();
      const lines = listRunCommandLines(step);
      if (lines.length === 0) return;
      expect(
        lines.length === 1 || step.shell === 'bash',
        `${label(entry, index)} runs ${lines.length} commands; use one command or shell: bash`,
      ).toBe(true);
      for (const line of lines) {
        expect(line, `${label(entry, index)}: "${line}" must not mask the exit code`).not.toMatch(
          /\|\||(^|[;&]\s*)exit\s+0\b|\bset\s+\+e\b|\btrue\s*$/,
        );
        if (runsBoundaryCheck(line)) {
          expect(line, `"${line}" must not be piped, chained or run in the background`).not.toMatch(/[|;&]/);
        }
      }
    });
  });

  // #14, TST-015 (#13 review, finding 4): least-privilege token
  it('#14: the job token is limited to contents: read', () => {
    const entry = readBoundaryCheckJob();
    expect(entry.workflow.permissions, `${entry.file} must set top-level permissions to { contents: read }`).toEqual({
      contents: 'read',
    });
    const permissions = entry.job.definition.permissions;
    if (permissions === undefined) return;
    expect(isWorkflowMapping(permissions), `${label(entry)}.permissions must be a mapping`).toBe(true);
    const wider = Object.entries(permissions as WorkflowMapping).filter(
      ([scope, level]) => !(allowedTokenPermissions[scope] ?? ['none']).includes(workflowValueText(level)),
    );
    expect(
      wider.map(([scope, level]) => `${scope}: ${workflowValueText(level)}`),
      `${label(entry)}.permissions is wider than { contents: read }`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ADR 0008 item 2: which copy of the script the job runs.

const fixtureBranch = 'task/14-fixture';
const markerModuleRelativePath = 'tools/boundary-check/boundary-check-stub-marker.ts';
const baseScriptMarker = 'BASE-SCRIPT-RAN';
const pullRequestScriptMarker = 'PULL-REQUEST-SCRIPT-RAN';

/** A GitHub annotation line, which shows in the job summary: `::notice ...::text` or `::warning ...::text`. */
const fallbackNoticePattern = /^::(notice|warning)( [^:]*)?::\S/m;

const emulationRoots: string[] = [];

afterEach(() => {
  while (emulationRoots.length > 0) {
    const dir = emulationRoots.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A stand-in for the boundary check script. It imports a sibling module, as a
 * real script split into modules would, so the job must run a whole copy of
 * the base tree, not one file. It prints its marker, its arguments and whether
 * the head commit is reachable from its working folder, then exits with the
 * given code.
 */
function stubScriptText(exitCode: number): string {
  return [
    "import { spawnSync } from 'node:child_process';",
    "import { scriptMarker } from './boundary-check-stub-marker.ts';",
    'const args = process.argv.slice(2);',
    "const head = args[args.indexOf('--head') + 1] ?? '';",
    "const reachable = spawnSync('git', ['cat-file', '-e', head + '^{commit}']).status === 0;",
    "console.log(scriptMarker + ' args=' + JSON.stringify(args) + ' head-reachable=' + String(reachable));",
    `process.exit(${exitCode});`,
    '',
  ].join('\n');
}

function markerModuleText(marker: string): string {
  return `export const scriptMarker = '${marker}';\n`;
}

interface ScriptSourceFixture {
  readonly baseSha: string;
  readonly headSha: string;
  readonly result: EmulatedJobResult;
}

/**
 * Builds a repository whose main has the base script (or none) and whose task
 * branch changes or adds it, then runs the boundary check job against it.
 */
function runJobAgainstFixture(
  entry: BoundaryCheckJob,
  options: {
    baseScriptExitCode?: number;
    pullRequestScriptExitCode: number;
    /** A base SHA to pass instead of the real base commit, for example one that is not in the repository. */
    eventBaseSha?: string;
  },
): ScriptSourceFixture {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'boundary-check-ci-gate-')));
  emulationRoots.push(root);
  writeFileSync(join(root, 'empty.gitconfig'), '');
  const env = {
    GIT_CONFIG_GLOBAL: join(root, 'empty.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CEILING_DIRECTORIES: root,
    GIT_AUTHOR_NAME: 'boundary-gate',
    GIT_AUTHOR_EMAIL: 'boundary-gate@example.invalid',
    GIT_COMMITTER_NAME: 'boundary-gate',
    GIT_COMMITTER_EMAIL: 'boundary-gate@example.invalid',
  };
  const origin = join(root, 'origin');
  mkdirSync(origin);
  const git = (args: readonly string[]): string => {
    const result = runRepoCommand('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
      cwd: origin,
      env,
    });
    if (result.exitCode !== 0) throw new Error(`fixture git command failed:\n${describeRepoCommand(result)}`);
    return result.stdout.trim();
  };
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(origin, path)), { recursive: true });
    writeFileSync(join(origin, path), text);
  };
  const commit = (message: string): string => {
    git(['add', '--all']);
    git(['commit', '--quiet', '--no-verify', '-m', message]);
    return git(['rev-parse', 'HEAD']);
  };

  git(['init', '--quiet', '--initial-branch=main']);
  write('package.json', '{ "private": true, "type": "module" }\n');
  write('README.md', 'fixture\n');
  if (options.baseScriptExitCode !== undefined) {
    write(boundaryCheckEntryRelativePath, stubScriptText(options.baseScriptExitCode));
    write(markerModuleRelativePath, markerModuleText(baseScriptMarker));
  }
  const baseSha = commit('base');
  git(['checkout', '--quiet', '-b', fixtureBranch]);
  write(boundaryCheckEntryRelativePath, stubScriptText(options.pullRequestScriptExitCode));
  write(markerModuleRelativePath, markerModuleText(pullRequestScriptMarker));
  const headSha = commit('pull request changes the script');

  const runnerDir = join(root, 'runner');
  mkdirSync(runnerDir);
  const result = emulateWorkflowJob(entry.workflow, entry.job, {
    originDir: origin,
    runnerDir,
    defaultRef: headSha,
    env,
    expressions: {
      'github.event.pull_request.base.sha': options.eventBaseSha ?? baseSha,
      'github.event.pull_request.head.sha': headSha,
      'github.event.pull_request.head.ref': fixtureBranch,
      'github.event.pull_request.base.ref': 'main',
      'github.head_ref': fixtureBranch,
      'github.base_ref': 'main',
      'github.event_name': 'pull_request',
      'github.sha': headSha,
      'github.workspace': join(runnerDir, 'workspace'),
      'runner.temp': join(runnerDir, 'runner-temp'),
    },
  });
  return { baseSha: options.eventBaseSha ?? baseSha, headSha, result };
}

function describeJobRun(run: ScriptSourceFixture): string {
  return `base ${run.baseSha}, head ${run.headSha}\njob exit code: ${run.result.exitCode}\n${run.result.output}`;
}

/** The arguments the stub printed, from the line with the given marker. */
function printedArguments(output: string, marker: string): unknown {
  const match = new RegExp(`^${marker} args=(\\[.*\\]) head-reachable=(true|false)$`, 'm').exec(output);
  return match ? { args: JSON.parse(match[1] as string) as unknown, headReachable: match[2] === 'true' } : undefined;
}

describe('boundary check script source (ADR 0008)', () => {
  const slow = { timeout: 120_000 };

  // ADR 0008 item 2: a pull request cannot turn the check off by changing the script
  it.each([
    ['fails', 1, 0],
    ['passes', 0, 1],
  ] as const)(
    'ADR 0008: when the base has the script, the job runs the base version, and the job %s with it, whatever the pull request version does',
    (_outcome, baseExitCode, pullRequestExitCode) => {
      const entry = readBoundaryCheckJob();
      const run = runJobAgainstFixture(entry, {
        baseScriptExitCode: baseExitCode,
        pullRequestScriptExitCode: pullRequestExitCode,
      });
      const output = describeJobRun(run);
      expect(run.result.output, `the base version of the script must run:\n${output}`).toContain(baseScriptMarker);
      expect(run.result.output, `the pull request version must not run:\n${output}`).not.toContain(
        pullRequestScriptMarker,
      );
      expect(run.result.exitCode === 0, `the job must exit as the base script does:\n${output}`).toBe(
        baseExitCode === 0,
      );
      expect(
        printedArguments(run.result.output, baseScriptMarker),
        `the base script must get the pull request range and branch, in a folder that has the head commit:\n${output}`,
      ).toEqual({
        args: ['--base', run.baseSha, '--head', run.headSha, '--branch', fixtureBranch],
        headReachable: true,
      });
    },
    slow.timeout,
  );

  // ADR 0008 item 2: the pull request that adds the script runs its own version, visibly
  it.each([
    ['fails', 1],
    ['passes', 0],
  ] as const)(
    'ADR 0008: when the base has no script, the job runs the pull request version with a ::notice or ::warning, and %s with it',
    (_outcome, pullRequestExitCode) => {
      const entry = readBoundaryCheckJob();
      const run = runJobAgainstFixture(entry, { pullRequestScriptExitCode: pullRequestExitCode });
      const output = describeJobRun(run);
      expect(run.result.output, `the pull request version must run:\n${output}`).toContain(pullRequestScriptMarker);
      expect(
        run.result.output,
        `the fallback must log a GitHub annotation such as "::notice title=boundary-check::..."; it must not be silent:\n${output}`,
      ).toMatch(fallbackNoticePattern);
      expect(run.result.exitCode === 0, `the job must exit as the pull request script does:\n${output}`).toBe(
        pullRequestExitCode === 0,
      );
      expect(printedArguments(run.result.output, pullRequestScriptMarker), output).toEqual({
        args: ['--base', run.baseSha, '--head', run.headSha, '--branch', fixtureBranch],
        headReachable: true,
      });
    },
    slow.timeout,
  );

  // ADR 0008 item 2: the fallback is only for a base without the script
  it('ADR 0008: when the base has the script, the job logs no fallback notice', slow, () => {
    const entry = readBoundaryCheckJob();
    const run = runJobAgainstFixture(entry, { baseScriptExitCode: 0, pullRequestScriptExitCode: 0 });
    const notices = run.result.output.split(/\r?\n/).filter((line) => fallbackNoticePattern.test(line));
    expect(
      notices.filter((line) => /pull request|fallback|no .*script|not .*base/i.test(line)),
      `a fallback notice appeared although the base has the script:\n${describeJobRun(run)}`,
    ).toEqual([]);
  });
});

describe('unreadable base commit (ADR 0009 item 3)', () => {
  const slow = { timeout: 120_000 };
  const missingSha = '0123456789abcdef0123456789abcdef01234567';

  // ADR 0009 item 3: a base commit that cannot be read is not "a base without the script"
  it.each([0, 1])(
    'ADR 0009: when the base commit is not in the repository, the job fails and runs no copy of the script (pull request script exit %i)',
    (pullRequestExitCode) => {
      const entry = readBoundaryCheckJob();
      const run = runJobAgainstFixture(entry, {
        baseScriptExitCode: 0,
        pullRequestScriptExitCode: pullRequestExitCode,
        eventBaseSha: missingSha,
      });
      const output = describeJobRun(run);
      expect(run.result.exitCode, `an unreadable base commit must fail the job:\n${output}`).not.toBe(0);
      expect(run.result.output, `the pull request version must not run as a fallback:\n${output}`).not.toContain(
        pullRequestScriptMarker,
      );
      expect(run.result.output, `no base version can run:\n${output}`).not.toContain(baseScriptMarker);
    },
    slow.timeout,
  );

  // ADR 0009 item 3: the fallback stays for a readable base without the script
  it(
    'ADR 0009: a readable base commit without the script still uses the pull request version with a notice',
    slow,
    () => {
      const entry = readBoundaryCheckJob();
      const run = runJobAgainstFixture(entry, { pullRequestScriptExitCode: 0 });
      const output = describeJobRun(run);
      expect(run.result.exitCode, output).toBe(0);
      expect(run.result.output, output).toContain(pullRequestScriptMarker);
      expect(run.result.output, output).toMatch(fallbackNoticePattern);
    },
  );
});
