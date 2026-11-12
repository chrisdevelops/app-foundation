// Test-only helper for the boundary check CI gates (#14, ADR 0008 item 2).
// Runs the steps of one GitHub Actions job on the local machine, against a
// fixture repository, so a gate can prove which script version the job runs.
//
// Supported, and nothing else (anything else throws, so a gate never passes
// on a job it cannot emulate):
// - `actions/checkout`: a full clone of the fixture repository into the
//   workspace or into `with.path`, checked out at `with.ref` (default: the
//   pull request head). `with.repository` is not supported.
// - `actions/setup-node` and `pnpm/action-setup`: no-ops; the Node that runs
//   the tests is first on PATH.
// - `run` steps with the default shell (`bash -e`) or `shell: bash`
//   (`bash --noprofile --norc -eo pipefail`), `env` at workflow, job and step
//   level, `working-directory`, and `KEY=value` or heredoc lines written to
//   `$GITHUB_ENV`.
// - `${{ <expression> }}` in `env` and `with` values, from a fixed table.
// Step `if:` conditions are not supported.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  isWorkflowMapping,
  listJobSteps,
  splitActionReference,
  workflowValueText,
  type WorkflowJob,
  type WorkflowMapping,
} from '../../repo/test-support/github-workflow';
import { describeRepoCommand, runRepoCommand } from '../../repo/test-support/run-repo-command';

export interface WorkflowJobEmulation {
  /** The repository that `actions/checkout` clones. */
  readonly originDir: string;
  /** An empty folder; the workspace and runner temp folder are made inside it. */
  readonly runnerDir: string;
  /** The commit `actions/checkout` checks out when it has no `ref` input. */
  readonly defaultRef: string;
  /** Values for `${{ <expression> }}`, keyed by the trimmed expression. */
  readonly expressions: Readonly<Record<string, string>>;
  /** Extra environment for every step and git command (for example an isolated git config). */
  readonly env: Readonly<Record<string, string>>;
}

export interface EmulatedStepResult {
  readonly index: number;
  readonly exitCode: number;
  readonly output: string;
}

export interface EmulatedJobResult {
  /** 0 when every step passed, otherwise the exit code of the first failing step. */
  readonly exitCode: number;
  readonly steps: EmulatedStepResult[];
  /** The output of every step that ran, in order. */
  readonly output: string;
}

export class WorkflowJobEmulationUnsupportedError extends Error {
  constructor(location: string, reason: string) {
    super(`${location}: ${reason}`);
    this.name = 'WorkflowJobEmulationUnsupportedError';
  }
}

/** Forward slashes, so paths read the same in Git Bash on Windows. */
function toShellPath(path: string): string {
  return process.platform === 'win32' ? path.replace(/\\/g, '/') : path;
}

/**
 * The bash that GitHub's `shell: bash` uses. On Windows that is Git Bash, not
 * the WSL launcher that may come first on PATH.
 */
export function resolveBashCommand(env: Readonly<Record<string, string>> = {}): string {
  if (process.platform !== 'win32') return 'bash';
  const execPath = runRepoCommand('git', ['--exec-path'], { cwd: process.cwd(), env: { ...env } }).stdout.trim();
  // <Git>/mingw64/libexec/git-core -> <Git>/bin/bash.exe
  const candidate = resolve(execPath, '..', '..', '..', 'bin', 'bash.exe');
  if (!existsSync(candidate)) throw new Error(`Git Bash not found at ${candidate} (from git --exec-path ${execPath})`);
  return candidate;
}

function substituteExpressions(text: string, emulation: WorkflowJobEmulation, location: string): string {
  return text.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_match, expression: string) => {
    const value = emulation.expressions[expression.trim()];
    if (value === undefined) {
      throw new WorkflowJobEmulationUnsupportedError(location, `no fixture value for \${{ ${expression.trim()} }}`);
    }
    return value;
  });
}

function scopeEnv(scope: WorkflowMapping, emulation: WorkflowJobEmulation, location: string): Record<string, string> {
  const env = scope.env;
  if (env === undefined || env === null) return {};
  if (!isWorkflowMapping(env)) throw new WorkflowJobEmulationUnsupportedError(location, 'env must be a mapping');
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      substituteExpressions(workflowValueText(value), emulation, location),
    ]),
  );
}

/** Reads `KEY=value` and `KEY<<DELIMITER` blocks from a `$GITHUB_ENV` file. */
function readGithubEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const values: Record<string, string> = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const heredoc = /^([A-Za-z_][A-Za-z0-9_]*)<<(.+)$/.exec(line);
    if (heredoc) {
      const body: string[] = [];
      for (index += 1; index < lines.length && lines[index] !== heredoc[2]; index += 1) body.push(lines[index] ?? '');
      values[heredoc[1] as string] = body.join('\n');
      continue;
    }
    const pair = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (pair) values[pair[1] as string] = pair[2] ?? '';
  }
  return values;
}

function pathVariableName(): string {
  return Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
}

function gitOrThrow(args: readonly string[], cwd: string, env: Readonly<Record<string, string>>): void {
  const result = runRepoCommand('git', args, { cwd, env: { ...env } });
  if (result.exitCode !== 0) throw new Error(`emulated checkout failed:\n${describeRepoCommand(result)}`);
}

/** Runs the job's steps in order and stops at the first failing step, as GitHub does. */
export function emulateWorkflowJob(
  workflow: WorkflowMapping,
  job: WorkflowJob,
  emulation: WorkflowJobEmulation,
): EmulatedJobResult {
  const workspace = join(emulation.runnerDir, 'workspace');
  const runnerTemp = join(emulation.runnerDir, 'runner-temp');
  mkdirSync(runnerTemp, { recursive: true });
  const bash = resolveBashCommand(emulation.env);
  const workflowEnv = scopeEnv(workflow, emulation, 'workflow');
  const jobEnv = scopeEnv(job.definition, emulation, `jobs.${job.id}`);
  const exportedEnv: Record<string, string> = {};
  const steps: EmulatedStepResult[] = [];

  listJobSteps(job).forEach((step, index) => {
    if (steps.some((entry) => entry.exitCode !== 0)) return;
    const location = `jobs.${job.id}.steps[${index}]`;
    if (step.if !== undefined) {
      throw new WorkflowJobEmulationUnsupportedError(location, 'step if: conditions are not supported');
    }
    const inputs = isWorkflowMapping(step.with) ? step.with : {};
    const input = (name: string): string | undefined =>
      inputs[name] === undefined || inputs[name] === null
        ? undefined
        : substituteExpressions(workflowValueText(inputs[name]), emulation, location);

    if (typeof step.uses === 'string') {
      const repository = splitActionReference(step.uses)?.repository;
      if (repository === 'actions/setup-node' || repository === 'pnpm/action-setup') {
        steps.push({ index, exitCode: 0, output: '' });
        return;
      }
      if (repository !== 'actions/checkout') {
        throw new WorkflowJobEmulationUnsupportedError(location, `action ${step.uses} is not supported`);
      }
      if (input('repository') !== undefined) {
        throw new WorkflowJobEmulationUnsupportedError(location, 'actions/checkout with.repository is not supported');
      }
      const target = resolve(workspace, input('path') ?? '.');
      mkdirSync(dirname(target), { recursive: true });
      gitOrThrow(
        ['clone', '--quiet', '--no-checkout', emulation.originDir, target],
        emulation.runnerDir,
        emulation.env,
      );
      gitOrThrow(['checkout', '--quiet', '--detach', input('ref') ?? emulation.defaultRef], target, emulation.env);
      steps.push({ index, exitCode: 0, output: '' });
      return;
    }

    if (typeof step.run !== 'string') {
      throw new WorkflowJobEmulationUnsupportedError(location, 'a step must have uses or run');
    }
    const shellArgs =
      step.shell === undefined
        ? ['-e']
        : step.shell === 'bash'
          ? ['--noprofile', '--norc', '-eo', 'pipefail']
          : undefined;
    if (!shellArgs) {
      throw new WorkflowJobEmulationUnsupportedError(
        location,
        `shell ${workflowValueText(step.shell ?? null)} is not supported`,
      );
    }
    const scriptPath = join(runnerTemp, `step-${index}.sh`);
    writeFileSync(scriptPath, step.run);
    const githubEnvPath = join(runnerTemp, `github-env-${index}`);
    writeFileSync(githubEnvPath, '');
    const workingDirectory = resolve(
      workspace,
      substituteExpressions(workflowValueText(step['working-directory'] ?? '.'), emulation, location),
    );
    const pathKey = pathVariableName();
    const env: Record<string, string> = {
      ...emulation.env,
      [pathKey]: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env[pathKey] ?? ''}`,
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_WORKSPACE: toShellPath(workspace),
      RUNNER_TEMP: toShellPath(runnerTemp),
      GITHUB_ENV: toShellPath(githubEnvPath),
      GITHUB_OUTPUT: toShellPath(join(runnerTemp, `github-output-${index}`)),
      GITHUB_STEP_SUMMARY: toShellPath(join(runnerTemp, `step-summary-${index}`)),
      ...workflowEnv,
      ...jobEnv,
      ...exportedEnv,
      ...scopeEnv(step, emulation, location),
    };
    const result = runRepoCommand(bash, [...shellArgs, toShellPath(scriptPath)], {
      cwd: workingDirectory,
      env,
      timeoutMs: 120_000,
    });
    Object.assign(exportedEnv, readGithubEnvFile(githubEnvPath));
    steps.push({ index, exitCode: result.exitCode, output: result.output });
  });

  const failed = steps.find((entry) => entry.exitCode !== 0);
  return {
    exitCode: failed?.exitCode ?? 0,
    steps,
    output: steps.map((entry) => `--- step ${entry.index} (exit ${entry.exitCode})\n${entry.output.trim()}`).join('\n'),
  };
}
