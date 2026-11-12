// Test-only helper for the CI workflow gate tests (#13). Reads GitHub Actions
// workflow files and works out what GitHub would run: matrix combinations,
// job names as `gh pr checks` shows them, and the commands of each step.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkflowYaml, type WorkflowYamlValue } from './workflow-yaml-reader';

export type WorkflowMapping = { [key: string]: WorkflowYamlValue };

export const workflowsDirRelative = '.github/workflows';
export const ciWorkflowRelativePath = '.github/workflows/ci.yml';

export function isWorkflowMapping(value: WorkflowYamlValue | undefined): value is WorkflowMapping {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

/** Relative paths of every workflow file in `.github/workflows`. */
export function listWorkflowFiles(repoRootDir: string): string[] {
  const dir = join(repoRootDir, workflowsDirRelative);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => /\.ya?ml$/.test(entry))
    .sort()
    .map((entry) => `${workflowsDirRelative}/${entry}`);
}

export function readWorkflowText(repoRootDir: string, relativePath: string): string {
  return readFileSync(join(repoRootDir, relativePath), 'utf8');
}

export function readWorkflow(repoRootDir: string, relativePath: string): WorkflowMapping {
  const parsed = parseWorkflowYaml(readWorkflowText(repoRootDir, relativePath));
  if (!isWorkflowMapping(parsed)) throw new Error(`${relativePath} is not a YAML mapping`);
  return parsed;
}

export interface WorkflowJob {
  readonly id: string;
  readonly definition: WorkflowMapping;
}

export function listWorkflowJobs(workflow: WorkflowMapping): WorkflowJob[] {
  const jobs = workflow.jobs;
  if (!isWorkflowMapping(jobs)) return [];
  return Object.entries(jobs).flatMap(([id, definition]) =>
    isWorkflowMapping(definition) ? [{ id, definition }] : [],
  );
}

export function listJobSteps(job: WorkflowJob): WorkflowMapping[] {
  const steps = job.definition.steps;
  return Array.isArray(steps) ? steps.filter(isWorkflowMapping) : [];
}

export type MatrixCombination = Record<string, WorkflowYamlValue>;

/**
 * The matrix combinations GitHub creates for a job, following the documented
 * rules for `include` and `exclude`. A job without a matrix has one empty
 * combination. Throws when the matrix is built from an expression.
 */
export function expandJobMatrix(job: WorkflowJob): MatrixCombination[] {
  const strategy = job.definition.strategy;
  if (strategy === undefined || strategy === null) return [{}];
  if (!isWorkflowMapping(strategy)) throw new Error(`job "${job.id}": strategy must be a mapping`);
  const matrix = strategy.matrix;
  if (matrix === undefined || matrix === null) return [{}];
  if (!isWorkflowMapping(matrix)) {
    throw new Error(`job "${job.id}": strategy.matrix must be a literal mapping, not ${JSON.stringify(matrix)}`);
  }
  let combinations: MatrixCombination[] = [{}];
  const originalKeys: string[] = [];
  for (const [key, values] of Object.entries(matrix)) {
    if (key === 'include' || key === 'exclude') continue;
    if (!Array.isArray(values)) {
      throw new Error(`job "${job.id}": matrix.${key} must be a literal list, not ${JSON.stringify(values)}`);
    }
    originalKeys.push(key);
    combinations = combinations.flatMap((combination) => values.map((value) => ({ ...combination, [key]: value })));
  }
  if (originalKeys.length === 0) combinations = [];
  const exclude = matrix.exclude;
  if (exclude !== undefined && exclude !== null) {
    if (!Array.isArray(exclude)) throw new Error(`job "${job.id}": matrix.exclude must be a literal list`);
    combinations = combinations.filter(
      (combination) =>
        !exclude.some(
          (entry) =>
            isWorkflowMapping(entry) &&
            Object.entries(entry).every(([key, value]) => JSON.stringify(combination[key]) === JSON.stringify(value)),
        ),
    );
  }
  const include = matrix.include;
  if (include !== undefined && include !== null) {
    if (!Array.isArray(include)) throw new Error(`job "${job.id}": matrix.include must be a literal list`);
    const originals = combinations.map((combination) => ({ ...combination }));
    for (const entry of include) {
      if (!isWorkflowMapping(entry)) throw new Error(`job "${job.id}": matrix.include entries must be mappings`);
      let added = false;
      originals.forEach((original, index) => {
        const overwritesOriginal = Object.entries(entry).some(
          ([key, value]) => originalKeys.includes(key) && JSON.stringify(original[key]) !== JSON.stringify(value),
        );
        if (!overwritesOriginal) {
          combinations[index] = { ...combinations[index], ...entry };
          added = true;
        }
      });
      if (!added) combinations.push({ ...entry });
    }
  }
  return combinations;
}

/**
 * Replaces `${{ matrix.<key> }}` with the combination's value. Throws when
 * any other expression remains, because its value is only known on GitHub.
 */
export function substituteMatrixExpressions(text: string, combination: MatrixCombination): string {
  const result = text.replace(/\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g, (match, key: string) => {
    const value = combination[key];
    if (value === undefined || value === null || typeof value === 'object') {
      throw new Error(`${match} has no scalar value in matrix combination ${JSON.stringify(combination)}`);
    }
    return String(value);
  });
  if (result.includes('${{')) {
    throw new Error(`"${text}" uses an expression other than \${{ matrix.<key> }}; its value cannot be checked`);
  }
  return result;
}

export interface ResolvedMatrixJob {
  readonly combination: MatrixCombination;
  readonly runsOn: string;
  /** The name GitHub shows for the job, and the name `gh pr checks` lists. */
  readonly checkName: string;
}

function defaultMatrixJobName(jobId: string, combination: MatrixCombination): string {
  const values = Object.values(combination)
    .filter((value) => value === null || typeof value !== 'object')
    .map(String);
  return values.length === 0 ? jobId : `${jobId} (${values.join(', ')})`;
}

export function resolveMatrixJobs(job: WorkflowJob): ResolvedMatrixJob[] {
  return expandJobMatrix(job).map((combination) => {
    const runsOn = job.definition['runs-on'];
    if (typeof runsOn !== 'string') {
      throw new Error(
        `job "${job.id}": runs-on must be one runner label or a matrix expression, not ${JSON.stringify(runsOn)}`,
      );
    }
    const name = job.definition.name;
    if (name !== undefined && typeof name !== 'string') throw new Error(`job "${job.id}": name must be a string`);
    return {
      combination,
      runsOn: substituteMatrixExpressions(runsOn, combination),
      checkName:
        name === undefined ? defaultMatrixJobName(job.id, combination) : substituteMatrixExpressions(name, combination),
    };
  });
}

export function isExpressionValue(value: WorkflowYamlValue | undefined): boolean {
  return typeof value === 'string' && value.includes('${{');
}

/** The shell command lines of a `run` step: non-empty, non-comment lines, trimmed. */
export function listRunCommandLines(step: WorkflowMapping): string[] {
  const run = step.run;
  if (typeof run !== 'string') return [];
  return run
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** Splits a command line into words. Quoted words keep their content without the quotes. */
export function splitCommandWords(commandLine: string): string[] {
  const words: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let match = pattern.exec(commandLine); match; match = pattern.exec(commandLine)) {
    words.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return words;
}

/** A workflow value as text: scalars as written, collections as JSON. */
export function workflowValueText(value: WorkflowYamlValue): string {
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}

export interface ActionReference {
  readonly workflow: string;
  readonly location: string;
  readonly uses: string;
}

/** Every `uses:` value in a workflow, at job level (reusable workflows) and step level. */
export function listActionReferences(relativePath: string, workflow: WorkflowMapping): ActionReference[] {
  const references: ActionReference[] = [];
  for (const job of listWorkflowJobs(workflow)) {
    const jobUses = job.definition.uses;
    if (jobUses !== undefined) {
      references.push({ workflow: relativePath, location: `jobs.${job.id}.uses`, uses: workflowValueText(jobUses) });
    }
    listJobSteps(job).forEach((step, index) => {
      if (step.uses !== undefined) {
        references.push({
          workflow: relativePath,
          location: `jobs.${job.id}.steps[${index}]`,
          uses: workflowValueText(step.uses),
        });
      }
    });
  }
  return references;
}

/** `owner/repo` and ref of an action reference such as `actions/checkout@<sha>`. */
export function splitActionReference(uses: string): { repository: string; path: string; ref: string } | undefined {
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)((?:\/[^@]+)?)@(.+)$/.exec(uses);
  if (!match) return undefined;
  return { repository: match[1] ?? '', path: match[2] ?? '', ref: match[3] ?? '' };
}
