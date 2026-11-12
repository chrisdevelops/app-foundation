// Gate tests for #13: the CI workflow that runs install, typecheck, lint and
// tests on Windows, macOS and Linux for every pull request to main and every
// push to main. They read `.github/workflows/` and work out what GitHub would
// run. What only a real run can prove (a failing step fails the job on each
// runner, the three check names in `gh pr checks`) is collected from `gh run`
// by the orchestrator. Requirements: TST-015 (partial), TOK-128 (partial).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ciWorkflowRelativePath,
  isExpressionValue,
  isWorkflowMapping,
  listActionReferences,
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
} from './test-support/github-workflow';
import { describeRepoCommand, repoGateRootDir, runRepoCommand } from './test-support/run-repo-command';
import type { WorkflowYamlValue } from './test-support/workflow-yaml-reader';

const root = repoGateRootDir;

/** The three GitHub-hosted runners, and the word a check name must contain for each. */
const requiredRunners: Readonly<Record<string, RegExp>> = {
  'windows-latest': /windows/i,
  'macos-latest': /mac/i,
  'ubuntu-latest': /ubuntu|linux/i,
};

/** The only actions CI may use (#13). Any other action is a new dependency and needs an ADR. */
const allowedActionRepositories = ['actions/checkout', 'actions/setup-node', 'pnpm/action-setup'] as const;

const turboTasks = ['typecheck', 'lint', 'test'] as const;

/** Turborepo flags that would run less than a developer's `pnpm turbo run typecheck lint test`. */
const narrowingTurboFlags = /^(--filter|-F|--affected|--dry|--dry-run|--graph|--only)(=|$)/;

function readCiWorkflow(): WorkflowMapping {
  expect(
    existsSync(join(root, ciWorkflowRelativePath)),
    `${ciWorkflowRelativePath} must exist (TST-015: CI on Windows, macOS and Linux)`,
  ).toBe(true);
  return readWorkflow(root, ciWorkflowRelativePath);
}

function readRootManifest(): { packageManager?: string; engines?: { node?: string } } {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    packageManager?: string;
    engines?: { node?: string };
  };
}

function isTurboCheckCommand(line: string): boolean {
  return /^pnpm\s+turbo\s+run\s/.test(line);
}

function isInstallCommand(line: string): boolean {
  return /^pnpm\s+(install|i)(\s|$)/.test(line);
}

/** Jobs that run the local check command. These are the jobs the contract applies to. */
function listCheckJobs(workflow: WorkflowMapping): WorkflowJob[] {
  const jobs = listWorkflowJobs(workflow).filter((job) =>
    listJobSteps(job).some((step) => listRunCommandLines(step).some(isTurboCheckCommand)),
  );
  expect(
    jobs.map((job) => job.id),
    `${ciWorkflowRelativePath} must have a job with a step that runs \`pnpm turbo run ${turboTasks.join(' ')}\``,
  ).not.toEqual([]);
  return jobs;
}

function stepLabel(job: WorkflowJob, index: number, step: WorkflowMapping): string {
  const name = typeof step.name === 'string' ? ` "${step.name}"` : '';
  return `jobs.${job.id}.steps[${index}]${name}`;
}

function usesRepository(step: WorkflowMapping): string | undefined {
  return typeof step.uses === 'string' ? splitActionReference(step.uses)?.repository : undefined;
}

function stepInputs(step: WorkflowMapping): WorkflowMapping {
  return isWorkflowMapping(step.with) ? step.with : {};
}

function defaultRunShell(scope: WorkflowMapping): WorkflowYamlValue | undefined {
  const defaults = scope.defaults;
  if (!isWorkflowMapping(defaults)) return undefined;
  const run = defaults.run;
  return isWorkflowMapping(run) ? run.shell : undefined;
}

/** The trigger settings for one event, or undefined when the event is not a trigger. */
function readTrigger(workflow: WorkflowMapping, event: string): WorkflowMapping | undefined {
  const on = workflow.on;
  if (typeof on === 'string') return on === event ? {} : undefined;
  if (Array.isArray(on)) return on.includes(event) ? {} : undefined;
  if (!isWorkflowMapping(on) || !(event in on)) return undefined;
  const settings = on[event];
  return isWorkflowMapping(settings) ? settings : {};
}

function expectTriggerOnMainOnly(event: 'pull_request' | 'push'): WorkflowMapping {
  const workflow = readCiWorkflow();
  const trigger = readTrigger(workflow, event);
  expect(trigger, `${ciWorkflowRelativePath} must trigger on ${event}`).toBeDefined();
  expect(
    trigger?.branches,
    `on.${event}.branches must be [main]: CI runs for ${event === 'push' ? 'pushes to' : 'pull requests to'} main`,
  ).toEqual(['main']);
  for (const filter of ['branches-ignore', 'paths', 'paths-ignore']) {
    expect(
      trigger?.[filter],
      `on.${event}.${filter} would skip CI for some changes, and a skipped required check never reports`,
    ).toBeUndefined();
  }
  return trigger ?? {};
}

describe('CI workflow file', () => {
  // TST-015
  it('TST-015: .github/workflows/ci.yml exists and declares triggers and jobs', () => {
    const workflow = readCiWorkflow();
    expect(workflow.on, `${ciWorkflowRelativePath} must declare "on"`).toBeDefined();
    expect(
      listWorkflowJobs(workflow).length,
      `${ciWorkflowRelativePath} must declare at least one job`,
    ).toBeGreaterThan(0);
  });
});

describe('CI triggers', () => {
  // TST-015: every pull request to main runs CI
  it('TST-015: the workflow runs on pull_request to main, with no path filter and no narrowed event types', () => {
    const trigger = expectTriggerOnMainOnly('pull_request');
    if (trigger.types !== undefined) {
      expect(
        trigger.types,
        'on.pull_request.types must include opened, synchronize and reopened, or new commits would not run CI',
      ).toEqual(expect.arrayContaining(['opened', 'synchronize', 'reopened']));
    }
  });

  // TST-015: every push to main runs CI
  it('TST-015: the workflow runs on push to main, with no path filter', () => {
    expectTriggerOnMainOnly('push');
  });
});

describe('CI platforms', () => {
  // TST-015: Windows, macOS and Linux
  it('TST-015: each check job runs exactly once on windows-latest, macos-latest and ubuntu-latest', () => {
    for (const job of listCheckJobs(readCiWorkflow())) {
      const runners = resolveMatrixJobs(job).map((resolved) => resolved.runsOn);
      expect(
        [...runners].sort(),
        `jobs.${job.id} must run once on each of ${Object.keys(requiredRunners).join(', ')}; it runs on ${runners.join(', ')}`,
      ).toEqual(Object.keys(requiredRunners).sort());
    }
  });

  // TST-015 (failure mode): one failing platform must not cancel the others
  it('TST-015: each check job sets strategy.fail-fast to false so every platform reports', () => {
    for (const job of listCheckJobs(readCiWorkflow())) {
      const strategy = job.definition.strategy;
      const failFast = isWorkflowMapping(strategy) ? strategy['fail-fast'] : undefined;
      expect(
        failFast,
        `jobs.${job.id}.strategy.fail-fast must be false (GitHub's default is true, which cancels the other platforms)`,
      ).toBe(false);
    }
  });

  // TST-015: `gh pr checks` shows three named results
  it('TST-015: the check names are distinct and each contains the OS it runs on', () => {
    for (const job of listCheckJobs(readCiWorkflow())) {
      const resolved = resolveMatrixJobs(job);
      const names = resolved.map((entry) => entry.checkName);
      expect(new Set(names).size, `jobs.${job.id} check names must be distinct: ${names.join(' | ')}`).toBe(
        names.length,
      );
      for (const entry of resolved) {
        const ownWord = requiredRunners[entry.runsOn];
        expect(ownWord, `jobs.${job.id} runs on unexpected runner ${entry.runsOn}`).toBeDefined();
        expect(entry.checkName, `the check name for ${entry.runsOn} must contain its OS`).toMatch(ownWord as RegExp);
        for (const [runner, word] of Object.entries(requiredRunners)) {
          if (runner === entry.runsOn) continue;
          expect(entry.checkName, `the check name for ${entry.runsOn} must not name another OS`).not.toMatch(word);
        }
      }
    }
  });

  // TST-015: matrix and runner values are literal, so the gate can check them
  it('TST-015: the check jobs use a literal matrix, not an expression GitHub resolves at run time', () => {
    for (const job of listCheckJobs(readCiWorkflow())) {
      const strategy = job.definition.strategy;
      expect(isWorkflowMapping(strategy), `jobs.${job.id}.strategy must be a mapping with a matrix`).toBe(true);
      expect(isExpressionValue((strategy as WorkflowMapping).matrix), `jobs.${job.id}.strategy.matrix`).toBe(false);
      expect(() => resolveMatrixJobs(job)).not.toThrow();
    }
  });
});

describe('CI toolchain versions', () => {
  // TOK-128, PLT-003: CI uses the Node version pinned in #12
  it('TOK-128: each check job sets up the exact Node version from package.json engines.node', () => {
    const pinnedNode = readRootManifest().engines?.node;
    expect(pinnedNode, 'package.json engines.node must pin an exact Node version').toMatch(/^\d+\.\d+\.\d+$/);
    for (const job of listCheckJobs(readCiWorkflow())) {
      const steps = listJobSteps(job).filter((step) => usesRepository(step) === 'actions/setup-node');
      expect(steps.length, `jobs.${job.id} must have exactly one actions/setup-node step`).toBe(1);
      const inputs = stepInputs(steps[0] as WorkflowMapping);
      const versionFile = inputs['node-version-file'];
      if (inputs['node-version'] === undefined && typeof versionFile === 'string') {
        if (versionFile !== 'package.json') {
          expect(existsSync(join(root, versionFile)), `node-version-file ${versionFile} must exist`).toBe(true);
          expect(readFileSync(join(root, versionFile), 'utf8').trim().replace(/^v/, '')).toBe(pinnedNode);
        }
        continue;
      }
      expect(
        workflowValueText(inputs['node-version'] ?? null),
        `jobs.${job.id}: actions/setup-node with.node-version must be exactly ${pinnedNode}`,
      ).toBe(pinnedNode);
    }
  });

  // TOK-128, PLT-010: CI uses the pnpm version pinned in #12
  it('TOK-128: each check job sets up pnpm from package.json packageManager, through pnpm/action-setup or corepack', () => {
    const packageManager = readRootManifest().packageManager ?? '';
    const pinnedPnpm = /^pnpm@(\d+\.\d+\.\d+)/.exec(packageManager)?.[1];
    expect(pinnedPnpm, 'package.json packageManager must pin an exact pnpm version').toBeDefined();
    for (const job of listCheckJobs(readCiWorkflow())) {
      const steps = listJobSteps(job);
      const actionSetup = steps.filter((step) => usesRepository(step) === 'pnpm/action-setup');
      const corepack = steps.filter((step) =>
        listRunCommandLines(step).some((line) => /^corepack\s+enable(\s|$)/.test(line)),
      );
      expect(
        actionSetup.length + corepack.length,
        `jobs.${job.id} must set up pnpm once, with pnpm/action-setup or \`corepack enable\``,
      ).toBe(1);
      for (const step of actionSetup) {
        const version = stepInputs(step).version;
        if (version !== undefined) {
          expect(
            workflowValueText(version),
            `jobs.${job.id}: pnpm/action-setup with.version must match packageManager`,
          ).toBe(pinnedPnpm);
        }
      }
    }
  });
});

describe('CI commands', () => {
  // TOK-128: the same commands developers run locally, in order
  it('TOK-128: each check job checks out, sets up pnpm and Node, runs `pnpm install --frozen-lockfile`, then `pnpm turbo run typecheck lint test`', () => {
    for (const job of listCheckJobs(readCiWorkflow())) {
      const steps = listJobSteps(job);
      const firstIndex = (predicate: (step: WorkflowMapping) => boolean): number => steps.findIndex(predicate);
      const checkout = firstIndex((step) => usesRepository(step) === 'actions/checkout');
      const setupNode = firstIndex((step) => usesRepository(step) === 'actions/setup-node');
      const setupPnpm = firstIndex(
        (step) =>
          usesRepository(step) === 'pnpm/action-setup' ||
          listRunCommandLines(step).some((line) => /^corepack\s+enable(\s|$)/.test(line)),
      );
      const install = firstIndex((step) => listRunCommandLines(step).some(isInstallCommand));
      const turbo = firstIndex((step) => listRunCommandLines(step).some(isTurboCheckCommand));

      expect(checkout, `jobs.${job.id}: the first step must be actions/checkout`).toBe(0);
      expect(install, `jobs.${job.id} must run pnpm install`).toBeGreaterThan(-1);
      expect(setupNode, `jobs.${job.id}: actions/setup-node must run before pnpm install`).toBeGreaterThan(checkout);
      expect(setupNode).toBeLessThan(install);
      expect(setupPnpm, `jobs.${job.id}: pnpm must be set up before pnpm install`).toBeGreaterThan(checkout);
      expect(setupPnpm).toBeLessThan(install);
      expect(turbo, `jobs.${job.id}: pnpm turbo run must come after pnpm install`).toBeGreaterThan(install);

      const installLines = steps.flatMap(listRunCommandLines).filter(isInstallCommand);
      for (const line of installLines) {
        const words = splitCommandWords(line);
        expect(words.slice(0, 2), `"${line}" must be \`pnpm install\``).toEqual(['pnpm', 'install']);
        expect(words, `"${line}" must use --frozen-lockfile`).toContain('--frozen-lockfile');
        expect(
          words.filter((word) =>
            /^--(no-frozen-lockfile|fix-lockfile|lockfile-only|frozen-lockfile=false)$/.test(word),
          ),
          `"${line}" must not loosen the lockfile`,
        ).toEqual([]);
      }

      const turboLines = steps.flatMap(listRunCommandLines).filter(isTurboCheckCommand);
      for (const line of turboLines) {
        const words = splitCommandWords(line).slice(3);
        const tasks = words.filter((word) => !word.startsWith('-'));
        expect([...tasks].sort(), `"${line}" must run exactly the tasks ${turboTasks.join(', ')}`).toEqual(
          [...turboTasks].sort(),
        );
        expect(
          words.filter((word) => narrowingTurboFlags.test(word)),
          `"${line}" must not narrow what Turborepo runs`,
        ).toEqual([]);
      }
    }
  });

  // TOK-128: CI runs tasks that the local Turborepo config defines
  it('TOK-128: every task CI asks Turborepo to run is defined in turbo.json', () => {
    const turbo = JSON.parse(readFileSync(join(root, 'turbo.json'), 'utf8')) as { tasks?: Record<string, unknown> };
    const defined = new Set(Object.keys(turbo.tasks ?? {}).map((name) => name.replace(/^.*#/, '')));
    for (const job of listCheckJobs(readCiWorkflow())) {
      for (const line of listJobSteps(job).flatMap(listRunCommandLines).filter(isTurboCheckCommand)) {
        const tasks = splitCommandWords(line)
          .slice(3)
          .filter((word) => !word.startsWith('-'));
        expect(
          tasks.filter((task) => !defined.has(task)),
          `"${line}" runs tasks that turbo.json does not define`,
        ).toEqual([]);
      }
    }
  });
});

describe('CI failure behaviour', () => {
  // TST-015 (failure mode): a failing step fails the job
  it('TST-015: no check job or step sets continue-on-error', () => {
    for (const job of listCheckJobs(readCiWorkflow())) {
      expect(
        job.definition['continue-on-error'] ?? false,
        `jobs.${job.id}.continue-on-error would hide a failing platform`,
      ).toBe(false);
      listJobSteps(job).forEach((step, index) => {
        expect(
          step['continue-on-error'] ?? false,
          `${stepLabel(job, index, step)} continue-on-error would hide a failing step`,
        ).toBe(false);
      });
    }
  });

  // TST-015 (failure mode): a check job is never skipped by a condition
  it('TST-015: check jobs and their install and check steps have no if: condition', () => {
    for (const job of listCheckJobs(readCiWorkflow())) {
      expect(job.definition.if, `jobs.${job.id}.if could skip a required check`).toBeUndefined();
      listJobSteps(job).forEach((step, index) => {
        const lines = listRunCommandLines(step);
        if (!lines.some((line) => isInstallCommand(line) || isTurboCheckCommand(line))) return;
        expect(step.if, `${stepLabel(job, index, step)}.if could skip the check`).toBeUndefined();
      });
    }
  });

  // TST-015 (failure mode): shell code must not swallow a failing exit code
  it('TST-015: no run step swallows a failing exit code', () => {
    const masks: ReadonlyArray<readonly [RegExp, string]> = [
      [/\|\|/, '`||` runs a fallback when the command fails'],
      [/(^|[;&]\s*)exit\s+0\b/, '`exit 0` ends the step as passed'],
      [/\bset\s+\+e\b/, '`set +e` ignores failing commands'],
      [/\$ErrorActionPreference\s*=\s*['"]?(Continue|SilentlyContinue|Ignore)/i, 'PowerShell keeps going after errors'],
      [/\$PSNativeCommandUseErrorActionPreference\s*=\s*\$false/i, 'PowerShell ignores native exit codes'],
    ];
    for (const job of listCheckJobs(readCiWorkflow())) {
      listJobSteps(job).forEach((step, index) => {
        for (const line of listRunCommandLines(step)) {
          for (const [pattern, reason] of masks) {
            expect(line, `${stepLabel(job, index, step)}: ${reason}`).not.toMatch(pattern);
          }
          if (isInstallCommand(line) || isTurboCheckCommand(line)) {
            expect(
              line,
              `${stepLabel(job, index, step)}: "${line}" must not be piped, chained or run in the background`,
            ).not.toMatch(/[|;&]/);
          }
        }
      });
    }
  });

  // TST-015 (failure mode): on Windows the default shell is PowerShell, which
  // fails a step only on the exit code of its last command
  it('TST-015: every run step with more than one command uses bash, so an earlier failing command fails the step on Windows', () => {
    const workflow = readCiWorkflow();
    for (const job of listCheckJobs(workflow)) {
      listJobSteps(job).forEach((step, index) => {
        const lines = listRunCommandLines(step);
        if (lines.length <= 1) return;
        const shell = step.shell ?? defaultRunShell(job.definition) ?? defaultRunShell(workflow);
        const exitsOnError =
          shell === 'bash' ||
          (typeof shell === 'string' && /^bash\b/.test(shell) && /\s-\w*e/.test(shell) && /pipefail/.test(shell));
        expect(
          exitsOnError,
          `${stepLabel(job, index, step)} runs ${lines.length} commands with shell ${JSON.stringify(shell ?? 'default (pwsh on Windows)')}; use one command per step or shell: bash`,
        ).toBe(true);
      });
    }
  });
});

describe('CI actions', () => {
  function listAllActionReferences() {
    readCiWorkflow();
    return listWorkflowFiles(root).flatMap((file) => listActionReferences(file, readWorkflow(root, file)));
  }

  // TST-015; CLAUDE.md: a new dependency needs an ADR
  it('TST-015: workflows use only actions/checkout, actions/setup-node and pnpm/action-setup', () => {
    const references = listAllActionReferences();
    expect(references.length, 'the CI workflow must use actions/checkout and actions/setup-node').toBeGreaterThan(0);
    const outside = references.filter((reference) => {
      const parts = splitActionReference(reference.uses);
      return (
        !parts || parts.path !== '' || !(allowedActionRepositories as readonly string[]).includes(parts.repository)
      );
    });
    expect(
      outside.map((reference) => `${reference.workflow} ${reference.location}: ${reference.uses}`),
      `only ${allowedActionRepositories.join(', ')} are allowed; any other action needs an ADR`,
    ).toEqual([]);
  });

  // TST-015: supply chain: actions are pinned to a commit
  it('TST-015: every action is pinned to a full 40-character commit SHA', () => {
    const references = listAllActionReferences();
    expect(references.length).toBeGreaterThan(0);
    const unpinned = references.filter(
      (reference) => !/^[0-9a-f]{40}$/.test(splitActionReference(reference.uses)?.ref ?? ''),
    );
    expect(
      unpinned.map((reference) => `${reference.workflow} ${reference.location}: ${reference.uses}`),
      'pin each action to a commit SHA, for example actions/checkout@<40 hex characters> # v5.0.0',
    ).toEqual([]);
  });

  // TST-015: a pinned SHA must be a released version of that action, not a
  // typo or a commit from a fork. Reads tags from GitHub with git ls-remote.
  it('TST-015: every pinned SHA is the commit of a release tag in the action repository', () => {
    const references = listAllActionReferences();
    expect(references.length).toBeGreaterThan(0);
    const tagCommitsByRepository = new Map<string, Set<string>>();
    for (const reference of references) {
      const parts = splitActionReference(reference.uses);
      if (!parts || !/^[0-9a-f]{40}$/.test(parts.ref)) continue;
      let tagCommits = tagCommitsByRepository.get(parts.repository);
      if (!tagCommits) {
        const result = runRepoCommand('git', ['ls-remote', '--tags', `https://github.com/${parts.repository}.git`], {
          cwd: root,
          timeoutMs: 60_000,
        });
        expect(result.exitCode, `git ls-remote could not read tags:\n${describeRepoCommand(result)}`).toBe(0);
        tagCommits = new Set(
          result.stdout
            .split('\n')
            .map((line) => line.split('\t'))
            .filter(([sha, ref]) => sha && ref?.startsWith('refs/tags/'))
            .map(([sha]) => sha as string),
        );
        tagCommitsByRepository.set(parts.repository, tagCommits);
      }
      expect(
        tagCommits.has(parts.ref),
        `${reference.workflow} ${reference.location}: ${parts.ref} is not the commit of any tag in ${parts.repository}`,
      ).toBe(true);
    }
  }, 120_000);
});

function isSetupStep(step: WorkflowMapping): boolean {
  const repository = usesRepository(step);
  return (
    repository === 'actions/checkout' ||
    repository === 'actions/setup-node' ||
    repository === 'pnpm/action-setup' ||
    listRunCommandLines(step).some((line) => /^corepack\s+enable(\s|$)/.test(line))
  );
}

function defaultRunWorkingDirectory(scope: WorkflowMapping): WorkflowYamlValue | undefined {
  const defaults = scope.defaults;
  if (!isWorkflowMapping(defaults)) return undefined;
  const run = defaults.run;
  return isWorkflowMapping(run) ? run['working-directory'] : undefined;
}

/** True for a working directory that is the repository root. */
function isRepositoryRoot(directory: WorkflowYamlValue | undefined): boolean {
  return directory === undefined || directory === '.' || directory === './';
}

function listAllWorkflows(): Array<{ file: string; workflow: WorkflowMapping }> {
  readCiWorkflow();
  return listWorkflowFiles(root).map((file) => ({ file, workflow: readWorkflow(root, file) }));
}

/** The only token permissions CI may have (#13 review, finding 4). */
const allowedTokenPermissions: Readonly<Record<string, readonly string[]>> = { contents: ['read', 'none'] };

describe('CI working directory and setup steps', () => {
  // TOK-128 (failure mode): Turborepo 2 started in a package folder checks only that package
  it('TOK-128: install and check commands run at the repository root, with no working-directory other than .', () => {
    const workflow = readCiWorkflow();
    expect(
      defaultRunWorkingDirectory(workflow),
      'defaults.run.working-directory at workflow level would run install and turbo outside the repository root',
    ).toSatisfy(isRepositoryRoot);
    for (const job of listCheckJobs(workflow)) {
      expect(
        defaultRunWorkingDirectory(job.definition),
        `jobs.${job.id}.defaults.run.working-directory would run install and turbo outside the repository root`,
      ).toSatisfy(isRepositoryRoot);
      listJobSteps(job).forEach((step, index) => {
        const lines = listRunCommandLines(step);
        if (!lines.some((line) => isInstallCommand(line) || isTurboCheckCommand(line))) return;
        expect(
          step['working-directory'],
          `${stepLabel(job, index, step)}.working-directory: Turborepo started in a package folder checks only that package`,
        ).toSatisfy(isRepositoryRoot);
      });
    }
  });

  // TST-015 (failure mode): a skipped setup step makes the job run on the runner's defaults
  it('TST-015: the checkout, setup-node and pnpm setup steps have no if: condition', () => {
    for (const job of listCheckJobs(readCiWorkflow())) {
      listJobSteps(job).forEach((step, index) => {
        if (!isSetupStep(step)) return;
        expect(
          step.if,
          `${stepLabel(job, index, step)}.if could skip a setup step, so the job would run on the runner's default checkout, Node or pnpm`,
        ).toBeUndefined();
      });
    }
  });

  // TST-015: CI checks the commit that triggered it
  it('TST-015: actions/checkout has no ref or repository input, so CI checks the triggering commit', () => {
    for (const job of listCheckJobs(readCiWorkflow())) {
      listJobSteps(job).forEach((step, index) => {
        if (usesRepository(step) !== 'actions/checkout') return;
        const inputs = stepInputs(step);
        for (const input of ['ref', 'repository']) {
          expect(
            inputs[input],
            `${stepLabel(job, index, step)} with.${input} would check out something other than the triggering commit`,
          ).toBeUndefined();
        }
      });
    }
  });
});

describe('CI security', () => {
  // TST-015 (#13 review, finding 5a): the token is not left in .git/config for later steps
  it('TST-015: every actions/checkout step sets persist-credentials: false', () => {
    const checkouts = listAllWorkflows().flatMap(({ file, workflow }) =>
      listWorkflowJobs(workflow).flatMap((job) =>
        listJobSteps(job).flatMap((step, index) =>
          usesRepository(step) === 'actions/checkout'
            ? [{ label: `${file} ${stepLabel(job, index, step)}`, step }]
            : [],
        ),
      ),
    );
    expect(checkouts.length, 'the CI workflow must use actions/checkout').toBeGreaterThan(0);
    for (const { label, step } of checkouts) {
      const persist = stepInputs(step)['persist-credentials'];
      expect(
        persist === false || persist === 'false',
        `${label} must set with.persist-credentials: false (found ${JSON.stringify(persist ?? 'not set, which defaults to true')})`,
      ).toBe(true);
    }
  });

  // TST-015 (#13 review, finding 4): least-privilege token
  it('TST-015: the workflow token is limited to contents: read, at workflow and job level', () => {
    const workflow = readCiWorkflow();
    expect(
      workflow.permissions,
      `${ciWorkflowRelativePath} must set top-level permissions to exactly { contents: read }; without it the token gets the repository default`,
    ).toEqual({ contents: 'read' });
    for (const job of listWorkflowJobs(workflow)) {
      const permissions = job.definition.permissions;
      if (permissions === undefined) continue;
      expect(
        isWorkflowMapping(permissions),
        `jobs.${job.id}.permissions must be a mapping, not ${JSON.stringify(permissions)} (read-all and write-all are too wide)`,
      ).toBe(true);
      const wider = Object.entries(permissions as WorkflowMapping).filter(
        ([scope, level]) => !(allowedTokenPermissions[scope] ?? ['none']).includes(workflowValueText(level)),
      );
      expect(
        wider.map(([scope, level]) => `${scope}: ${workflowValueText(level)}`),
        `jobs.${job.id}.permissions is wider than { contents: read }`,
      ).toEqual([]);
    }
  });

  // TST-015 (#13 review, finding 4): no trigger that runs with secrets on untrusted code
  it('TST-015: no workflow triggers on pull_request_target or workflow_run', () => {
    const unsafe = listAllWorkflows().flatMap(({ file, workflow }) =>
      ['pull_request_target', 'workflow_run']
        .filter((event) => readTrigger(workflow, event) !== undefined)
        .map((event) => `${file}: on.${event}`),
    );
    expect(
      unsafe,
      `${unsafe.join(', ')}: pull_request_target and workflow_run run with a privileged token on code from a pull request`,
    ).toEqual([]);
  });
});
