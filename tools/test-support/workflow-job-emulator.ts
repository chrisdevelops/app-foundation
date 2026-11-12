// Test-only helper for the CI gate tests (#14, ADR 0008 item 2; #17). Runs
// the steps of one GitHub Actions job on the local machine, so a gate can
// prove what the job does: which script version it runs (#14), or which
// commands it runs, in which order, with which environment (#17).
// Shared by tools/boundary-check and tools/repo (ADR 0008: shared helpers
// live in tools/test-support).
//
// Supported, and nothing else (anything else throws, so a gate never passes
// on a job it cannot emulate):
// - `actions/checkout`: a full clone of `originDir` into the workspace or
//   into `with.path`, checked out at `with.ref` (default: `defaultRef`).
//   `with.repository` is not supported.
// - `actions/setup-node` and `pnpm/action-setup`: no-ops; the Node that runs
//   the tests is first on PATH (after `pathPrepend`).
// - `run` steps with the runner's default shell on Linux and macOS
//   (`bash -e`) or `shell: bash` (`bash --noprofile --norc -eo pipefail`),
//   also through `defaults.run.shell`; `env` at workflow, job and step level;
//   `working-directory` (also through `defaults.run`); `KEY=value` or heredoc
//   lines written to `$GITHUB_ENV`; folders written to `$GITHUB_PATH`.
//   The Windows default shell (pwsh) is not supported.
// - `${{ <expression> }}` in `env`, `with` and `working-directory` values:
//   `runner.os`, `runner.temp`, `github.workspace`, `matrix.<key>`, and a
//   fixed table from the caller.
// - Step and job `if:` conditions built from `==`, `!=`, `&&`, `||`, `!`,
//   parentheses, string literals, `true`, `false`, the context values above,
//   `contains`, `startsWith`, `endsWith`, and the status functions
//   `success()`, `failure()`, `always()`, `cancelled()`. As on GitHub, a
//   condition without a status function also needs `success()`.
// `continue-on-error` is not supported. Once a step fails, later steps run
// only when their condition asks for it (`failure()` or `always()`), and the
// job fails with the exit code of the first failing step.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import {
  isWorkflowMapping,
  listJobSteps,
  splitActionReference,
  substituteMatrixExpressions,
  workflowValueText,
  type MatrixCombination,
  type WorkflowJob,
  type WorkflowMapping,
} from './github-workflow';
import { describeRepoCommand, runRepoCommand } from './run-repo-command';

/** The value GitHub gives `runner.os` on each hosted runner. */
export type EmulatedRunnerOs = 'Linux' | 'macOS' | 'Windows';

export interface WorkflowJobEmulation {
  /** The repository that `actions/checkout` clones. */
  readonly originDir: string;
  /** An empty folder; the workspace and runner temp folder are made inside it. */
  readonly runnerDir: string;
  /** The commit `actions/checkout` checks out when it has no `ref` input. */
  readonly defaultRef: string;
  /** Values for `${{ <expression> }}`, keyed by the trimmed expression. They win over the built-in values. */
  readonly expressions: Readonly<Record<string, string>>;
  /** Extra environment for every step and git command (for example an isolated git config). */
  readonly env: Readonly<Record<string, string>>;
  /** The matrix combination to run, for a job with a matrix. */
  readonly matrix?: MatrixCombination;
  /** Folders put first on PATH for every step (for example fake commands). */
  readonly pathPrepend?: readonly string[];
  /** Time limit for each run step. Default 120 s. */
  readonly stepTimeoutMs?: number;
}

export interface EmulatedStepResult {
  readonly index: number;
  readonly exitCode: number;
  readonly output: string;
}

export interface EmulatedJobResult {
  /** 0 when every step that ran passed, otherwise the exit code of the first failing step. */
  readonly exitCode: number;
  /** The steps that ran, in order. */
  readonly steps: EmulatedStepResult[];
  /** Indexes of the steps whose `if:` condition was false. */
  readonly skippedStepIndexes: number[];
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

/** `runner.os` for a hosted runner label such as `ubuntu-latest`; undefined for a label it cannot tell. */
export function runnerOsOfLabel(label: string): EmulatedRunnerOs | undefined {
  if (/^ubuntu-/i.test(label)) return 'Linux';
  if (/^macos-/i.test(label)) return 'macOS';
  if (/^windows-/i.test(label)) return 'Windows';
  return undefined;
}

/** The hosted runner label for the machine the tests run on. */
export function hostRunnerLabel(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return 'macos-latest';
  if (platform === 'win32') return 'windows-latest';
  return 'ubuntu-latest';
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

// ---------------------------------------------------------------------------
// Expressions and conditions
// ---------------------------------------------------------------------------

/** Values an `if:` condition or `${{ }}` expression can read, keyed by the dotted name. */
export type WorkflowExpressionContext = Readonly<Record<string, string>>;

/** Job status the status functions read. */
export interface WorkflowJobStatus {
  readonly failed: boolean;
}

type ConditionValue = string | boolean;

type Token =
  | { kind: 'string'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'paren'; value: '(' | ')' }
  | { kind: 'comma' };

function tokenizeCondition(text: string, location: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "'") {
      let value = '';
      index += 1;
      for (;;) {
        if (index >= text.length)
          throw new WorkflowJobEmulationUnsupportedError(location, `unclosed string in ${text}`);
        if (text[index] === "'") {
          if (text[index + 1] === "'") {
            value += "'";
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        value += text[index];
        index += 1;
      }
      tokens.push({ kind: 'string', value });
      continue;
    }
    const two = text.slice(index, index + 2);
    if (two === '==' || two === '!=' || two === '&&' || two === '||') {
      tokens.push({ kind: 'op', value: two });
      index += 2;
      continue;
    }
    if (char === '!') {
      tokens.push({ kind: 'op', value: '!' });
      index += 1;
      continue;
    }
    if (char === '(' || char === ')') {
      tokens.push({ kind: 'paren', value: char });
      index += 1;
      continue;
    }
    if (char === ',') {
      tokens.push({ kind: 'comma' });
      index += 1;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(text.slice(index));
    if (name) {
      tokens.push({ kind: 'name', value: name[0] });
      index += name[0].length;
      continue;
    }
    throw new WorkflowJobEmulationUnsupportedError(location, `unsupported character "${char}" in condition ${text}`);
  }
  return tokens;
}

const statusFunctions = new Set(['success', 'failure', 'always', 'cancelled']);
const stringFunctions = new Set(['contains', 'startsWith', 'endsWith']);

function truthy(value: ConditionValue): boolean {
  return typeof value === 'boolean' ? value : value !== '';
}

/** GitHub compares strings without case. */
function looselyEqual(left: ConditionValue, right: ConditionValue): boolean {
  if (typeof left === 'boolean' || typeof right === 'boolean') return truthy(left) === truthy(right);
  return left.toLowerCase() === right.toLowerCase();
}

/** Strips one `${{ ... }}` wrapper from a whole condition. */
function unwrapCondition(condition: string): string {
  const match = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(condition);
  return match ? (match[1] as string) : condition;
}

/** True when the condition calls a status function, so GitHub does not add `success() &&`. */
export function conditionUsesStatusFunction(condition: string): boolean {
  return tokenizeCondition(unwrapCondition(condition), 'condition').some(
    (token, index, all) =>
      token.kind === 'name' &&
      statusFunctions.has(token.value) &&
      all[index + 1]?.kind === 'paren' &&
      (all[index + 1] as { value: string }).value === '(',
  );
}

/**
 * Evaluates an `if:` condition the way GitHub does for the supported subset.
 * Throws `WorkflowJobEmulationUnsupportedError` for anything outside it.
 */
export function evaluateWorkflowCondition(
  condition: string | undefined,
  context: WorkflowExpressionContext,
  status: WorkflowJobStatus,
  location = 'condition',
): boolean {
  if (condition === undefined) return !status.failed;
  const text = unwrapCondition(condition);
  const tokens = tokenizeCondition(text, location);
  let position = 0;
  const peek = (): Token | undefined => tokens[position];
  const fail = (reason: string): never => {
    throw new WorkflowJobEmulationUnsupportedError(location, `${reason} in condition ${JSON.stringify(condition)}`);
  };

  const parsePrimary = (): ConditionValue => {
    const token = tokens[position];
    if (!token) return fail('unexpected end');
    position += 1;
    if (token.kind === 'string') return token.value;
    if (token.kind === 'paren' && token.value === '(') {
      const value = parseOr();
      const close = tokens[position];
      if (close?.kind !== 'paren' || close.value !== ')') fail('missing )');
      position += 1;
      return value;
    }
    if (token.kind === 'op' && token.value === '!') return !truthy(parsePrimary());
    if (token.kind !== 'name') return fail(`unexpected token ${JSON.stringify(token)}`);
    const next = peek();
    if (next?.kind === 'paren' && next.value === '(') {
      position += 1;
      const args: ConditionValue[] = [];
      while (!(peek()?.kind === 'paren' && (peek() as { value: string }).value === ')')) {
        args.push(parseOr());
        if (peek()?.kind === 'comma') position += 1;
      }
      position += 1;
      if (statusFunctions.has(token.value)) {
        if (args.length > 0) fail(`${token.value}() takes no arguments`);
        if (token.value === 'success') return !status.failed;
        if (token.value === 'failure') return status.failed;
        if (token.value === 'always') return true;
        return false; // cancelled(): the emulated job is never cancelled
      }
      if (stringFunctions.has(token.value)) {
        if (args.length !== 2) fail(`${token.value}() takes two arguments`);
        const [haystack, needle] = args.map((arg) => String(arg).toLowerCase()) as [string, string];
        if (token.value === 'contains') return haystack.includes(needle);
        if (token.value === 'startsWith') return haystack.startsWith(needle);
        return haystack.endsWith(needle);
      }
      return fail(`unsupported function ${token.value}()`);
    }
    if (token.value === 'true') return true;
    if (token.value === 'false') return false;
    const value = context[token.value];
    if (value === undefined) return fail(`no value for ${token.value}`);
    return value;
  };

  const parseComparison = (): ConditionValue => {
    const left = parsePrimary();
    const op = peek();
    if (op?.kind === 'op' && (op.value === '==' || op.value === '!=')) {
      position += 1;
      const right = parsePrimary();
      return op.value === '==' ? looselyEqual(left, right) : !looselyEqual(left, right);
    }
    return left;
  };

  const parseAnd = (): ConditionValue => {
    let value = parseComparison();
    while (peek()?.kind === 'op' && (peek() as { value: string }).value === '&&') {
      position += 1;
      const right = parseComparison();
      value = truthy(value) && truthy(right);
    }
    return value;
  };

  function parseOr(): ConditionValue {
    let value = parseAnd();
    while (peek()?.kind === 'op' && (peek() as { value: string }).value === '||') {
      position += 1;
      const right = parseAnd();
      value = truthy(value) || truthy(right);
    }
    return value;
  }

  const result = truthy(parseOr());
  if (position !== tokens.length) fail('unexpected trailing tokens');
  return conditionUsesStatusFunction(condition) ? result : result && !status.failed;
}

function substituteExpressions(text: string, context: WorkflowExpressionContext, location: string): string {
  return text.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_match, expression: string) => {
    const value = context[expression.trim()];
    if (value === undefined) {
      throw new WorkflowJobEmulationUnsupportedError(location, `no fixture value for \${{ ${expression.trim()} }}`);
    }
    return value;
  });
}

/** The runner label a job (in one matrix combination) runs on. */
export function resolveJobRunnerLabel(job: WorkflowJob, matrix: MatrixCombination = {}): string {
  const runsOn = job.definition['runs-on'];
  if (typeof runsOn !== 'string') {
    throw new WorkflowJobEmulationUnsupportedError(`jobs.${job.id}`, 'runs-on must be one runner label');
  }
  return substituteMatrixExpressions(runsOn, matrix);
}

/**
 * The values the emulated job's expressions and conditions read. `runner.temp`
 * and `github.workspace` point into `runnerDir`.
 */
export function buildExpressionContext(
  job: WorkflowJob,
  emulation: Pick<WorkflowJobEmulation, 'runnerDir' | 'expressions' | 'matrix'>,
): Record<string, string> {
  const matrix = emulation.matrix ?? {};
  const context: Record<string, string> = {
    'runner.temp': join(emulation.runnerDir, 'runner-temp'),
    'github.workspace': join(emulation.runnerDir, 'workspace'),
  };
  const runnerOs = runnerOsOfLabel(resolveJobRunnerLabel(job, matrix));
  if (runnerOs) context['runner.os'] = runnerOs;
  for (const [key, value] of Object.entries(matrix)) {
    if (value !== null && typeof value !== 'object') context[`matrix.${key}`] = String(value);
  }
  return { ...context, ...emulation.expressions };
}

// ---------------------------------------------------------------------------
// Running a job
// ---------------------------------------------------------------------------

function scopeEnv(
  scope: WorkflowMapping,
  context: WorkflowExpressionContext,
  location: string,
): Record<string, string> {
  const env = scope.env;
  if (env === undefined || env === null) return {};
  if (!isWorkflowMapping(env)) throw new WorkflowJobEmulationUnsupportedError(location, 'env must be a mapping');
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      substituteExpressions(workflowValueText(value), context, location),
    ]),
  );
}

function defaultRunSetting(scope: WorkflowMapping, key: 'shell' | 'working-directory'): string | undefined {
  const defaults = scope.defaults;
  if (!isWorkflowMapping(defaults)) return undefined;
  const run = defaults.run;
  if (!isWorkflowMapping(run)) return undefined;
  const value = run[key];
  return value === undefined || value === null ? undefined : workflowValueText(value);
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

/** Folders listed in a `$GITHUB_PATH` file, one per line. */
function readGithubPathFile(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function pathVariableName(): string {
  return Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
}

function gitOrThrow(args: readonly string[], cwd: string, env: Readonly<Record<string, string>>): void {
  const result = runRepoCommand('git', args, { cwd, env: { ...env } });
  if (result.exitCode !== 0) throw new Error(`emulated checkout failed:\n${describeRepoCommand(result)}`);
}

/** Runs the job's steps in order, following `if:` conditions and the job status, as GitHub does. */
export function emulateWorkflowJob(
  workflow: WorkflowMapping,
  job: WorkflowJob,
  emulation: WorkflowJobEmulation,
): EmulatedJobResult {
  const workspace = join(emulation.runnerDir, 'workspace');
  const runnerTemp = join(emulation.runnerDir, 'runner-temp');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  const context = buildExpressionContext(job, emulation);
  const runnerOs = context['runner.os'];
  const bash = resolveBashCommand(emulation.env);
  const workflowEnv = scopeEnv(workflow, context, 'workflow');
  const jobEnv = scopeEnv(job.definition, context, `jobs.${job.id}`);
  const defaultShell = defaultRunSetting(job.definition, 'shell') ?? defaultRunSetting(workflow, 'shell');
  const defaultWorkingDirectory =
    defaultRunSetting(job.definition, 'working-directory') ?? defaultRunSetting(workflow, 'working-directory');
  const exportedEnv: Record<string, string> = {};
  const exportedPath: string[] = [];
  const steps: EmulatedStepResult[] = [];
  const skippedStepIndexes: number[] = [];

  if (job.definition['continue-on-error'] !== undefined) {
    throw new WorkflowJobEmulationUnsupportedError(`jobs.${job.id}`, 'continue-on-error is not supported');
  }

  listJobSteps(job).forEach((step, index) => {
    const location = `jobs.${job.id}.steps[${index}]`;
    const failed = steps.some((entry) => entry.exitCode !== 0);
    if (step['continue-on-error'] !== undefined) {
      throw new WorkflowJobEmulationUnsupportedError(location, 'continue-on-error is not supported');
    }
    const condition = step.if === undefined || step.if === null ? undefined : workflowValueText(step.if);
    if (!evaluateWorkflowCondition(condition, context, { failed }, `${location}.if`)) {
      skippedStepIndexes.push(index);
      return;
    }
    const inputs = isWorkflowMapping(step.with) ? step.with : {};
    const input = (name: string): string | undefined =>
      inputs[name] === undefined || inputs[name] === null
        ? undefined
        : substituteExpressions(workflowValueText(inputs[name]), context, location);

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
    const shell = step.shell === undefined || step.shell === null ? defaultShell : workflowValueText(step.shell);
    const shellArgs =
      shell === undefined && runnerOs !== 'Windows'
        ? ['-e']
        : shell === 'bash'
          ? ['--noprofile', '--norc', '-eo', 'pipefail']
          : undefined;
    if (!shellArgs) {
      throw new WorkflowJobEmulationUnsupportedError(
        location,
        `shell ${shell ?? `default (pwsh on ${runnerOs ?? 'this runner'})`} is not supported`,
      );
    }
    const scriptPath = join(runnerTemp, `step-${index}.sh`);
    writeFileSync(scriptPath, step.run);
    const githubEnvPath = join(runnerTemp, `github-env-${index}`);
    const githubPathPath = join(runnerTemp, `github-path-${index}`);
    writeFileSync(githubEnvPath, '');
    writeFileSync(githubPathPath, '');
    const stepWorkingDirectory =
      step['working-directory'] === undefined || step['working-directory'] === null
        ? (defaultWorkingDirectory ?? '.')
        : workflowValueText(step['working-directory']);
    const workingDirectory = resolve(workspace, substituteExpressions(stepWorkingDirectory, context, location));
    const pathKey = pathVariableName();
    const pathParts = [
      ...exportedPath,
      ...(emulation.pathPrepend ?? []),
      dirname(process.execPath),
      process.env[pathKey] ?? '',
    ];
    const env: Record<string, string> = {
      ...emulation.env,
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_WORKSPACE: toShellPath(workspace),
      RUNNER_TEMP: toShellPath(runnerTemp),
      ...(runnerOs ? { RUNNER_OS: runnerOs } : {}),
      GITHUB_ENV: toShellPath(githubEnvPath),
      GITHUB_PATH: toShellPath(githubPathPath),
      GITHUB_OUTPUT: toShellPath(join(runnerTemp, `github-output-${index}`)),
      GITHUB_STEP_SUMMARY: toShellPath(join(runnerTemp, `step-summary-${index}`)),
      ...workflowEnv,
      ...jobEnv,
      ...exportedEnv,
      ...scopeEnv(step, context, location),
      [pathKey]: pathParts.join(delimiter),
    };
    const result = runRepoCommand(bash, [...shellArgs, toShellPath(scriptPath)], {
      cwd: workingDirectory,
      env,
      timeoutMs: emulation.stepTimeoutMs ?? 120_000,
    });
    Object.assign(exportedEnv, readGithubEnvFile(githubEnvPath));
    exportedPath.unshift(...readGithubPathFile(githubPathPath).reverse());
    steps.push({ index, exitCode: result.exitCode, output: result.output });
  });

  const failed = steps.find((entry) => entry.exitCode !== 0);
  return {
    exitCode: failed?.exitCode ?? 0,
    steps,
    skippedStepIndexes,
    output: steps.map((entry) => `--- step ${entry.index} (exit ${entry.exitCode})\n${entry.output.trim()}`).join('\n'),
  };
}
