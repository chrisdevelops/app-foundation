// Gate tests for #14: CI runs the boundary check as its own job on every pull
// request, on one OS, with a stable check name. They read `.github/workflows/`
// and work out what GitHub would run, like tools/repo/ci-workflow.gate.test.ts.
// The job may live in ci.yml or in its own workflow file. What only a real run
// can prove (the check appears in `gh pr checks` and fails a bad pull request)
// is collected from `gh run` by the orchestrator.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
} from '../repo/support/github-workflow';
import { repoGateRootDir } from '../repo/support/run-repo-command';
import type { WorkflowYamlValue } from '../repo/support/workflow-yaml-reader';

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

function runsBoundaryCheck(line: string): boolean {
  return splitCommandWords(line).some(
    (word) => word.replace(/\\/g, '/').replace(/^\.\//, '') === boundaryCheckEntryRelativePath,
  );
}

function listBoundaryCheckJobs(): BoundaryCheckJob[] {
  return listWorkflowFiles(root).flatMap((file) => {
    const workflow = readWorkflow(root, file);
    return listWorkflowJobs(workflow).flatMap((job) => {
      const steps = listJobSteps(job);
      const checkStepIndex = steps.findIndex((step) => listRunCommandLines(step).some(runsBoundaryCheck));
      return checkStepIndex === -1 ? [] : [{ file, workflow, job, steps, checkStepIndex }];
    });
  });
}

function readBoundaryCheckJob(): BoundaryCheckJob {
  const jobs = listBoundaryCheckJobs();
  expect(
    jobs.map((entry) => `${entry.file} jobs.${entry.job.id}`),
    `exactly one job in .github/workflows must run \`node ${boundaryCheckEntryRelativePath}\` (#14)`,
  ).toHaveLength(1);
  return jobs[0] as BoundaryCheckJob;
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
  it('#14: exactly one workflow job runs tools/boundary-check/boundary-check.ts with node', () => {
    const entry = readBoundaryCheckJob();
    const lines = listRunCommandLines(entry.steps[entry.checkStepIndex] as WorkflowMapping).filter(runsBoundaryCheck);
    for (const line of lines) {
      expect(splitCommandWords(line)[0], `${label(entry, entry.checkStepIndex)}: "${line}" must start with node`).toBe(
        'node',
      );
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
    const step = entry.steps[entry.checkStepIndex] as WorkflowMapping;
    const lines = listRunCommandLines(step);
    for (const line of lines) {
      expect(line, `${label(entry, entry.checkStepIndex)}: pass values through env, not \${{ }} in run`).not.toContain(
        '${{',
      );
    }
    const words = splitCommandWords(lines.find(runsBoundaryCheck) ?? '');
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
  });

  // #14 (failure mode): a failing check fails the job
  it('#14: the job and its check step cannot pass when the check fails', () => {
    const entry = readBoundaryCheckJob();
    expect(entry.job.definition['continue-on-error'] ?? false, `${label(entry)}.continue-on-error`).toBe(false);
    entry.steps.forEach((step, index) => {
      expect(step['continue-on-error'] ?? false, `${label(entry, index)}.continue-on-error`).toBe(false);
    });
    const step = entry.steps[entry.checkStepIndex] as WorkflowMapping;
    expect(step.if, `${label(entry, entry.checkStepIndex)}.if could skip the check`).toBeUndefined();
    const lines = listRunCommandLines(step);
    const shell = step.shell;
    expect(
      lines.length === 1 || shell === 'bash',
      `${label(entry, entry.checkStepIndex)} runs ${lines.length} commands; use one command or shell: bash`,
    ).toBe(true);
    for (const line of lines) {
      expect(line, `${label(entry, entry.checkStepIndex)}: "${line}" must not mask the exit code`).not.toMatch(
        /\|\||(^|[;&]\s*)exit\s+0\b|\bset\s+\+e\b|\btrue\s*$/,
      );
      if (runsBoundaryCheck(line)) {
        expect(line, `"${line}" must not be piped, chained or run in the background`).not.toMatch(/[|;&]/);
      }
    }
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
