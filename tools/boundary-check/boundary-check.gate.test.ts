// Gate tests for #14: the boundary check that rejects commits which break the
// agent role boundaries (implementation/ORCHESTRATOR.md section 6, the
// `Test-Change` trailer from section 3, and PLT-010: no AI co-author trailers).
// Test code is the closed list in #14 plus `**/test-support/**` (ADR 0008).
//
// Contract (black box):
// - Input: `node tools/boundary-check/boundary-check.ts --base <ref> --head <ref> --branch <name>`,
//   started in the git repository to check. The range is the commits that
//   `git rev-list <base>..<head>` lists. The check never reads HEAD or the
//   working tree: every run here starts with HEAD detached at `main`.
// - Output: exit 0 and no output, or a non-zero exit and one line per
//   violation, `<short-sha>: <rule-id>: <message>`. Path rules name the path.
//
// Every fixture is a temporary git repository with its own empty git config,
// so the developer's or runner's git settings never change the result.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  describeRepoCommand,
  repoGateRootDir,
  runRepoCommand,
  type RepoCommandResult,
} from '../repo/test-support/run-repo-command';

/** The script the contract is about, relative to the repository root. */
const boundaryCheckEntryRelativePath = 'tools/boundary-check/boundary-check.ts';
const boundaryCheckEntry = join(repoGateRootDir, boundaryCheckEntryRelativePath);

/**
 * Rule ids, one per rule. The issue fixes only `invalid-range`; these names
 * are the rest of the contract and are used verbatim in the output.
 */
const boundaryRule = {
  missingTaskTrailer: 'missing-task-trailer',
  missingAgentTrailer: 'missing-agent-trailer',
  reviewerOrVerifierCommit: 'reviewer-or-verifier-commit',
  developerTouchesGateTest: 'developer-touches-gate-test',
  testAuthorTouchesSource: 'test-author-touches-source',
  testChangeNotApproved: 'test-change-not-approved',
  coAuthorTrailer: 'co-author-trailer',
  invalidRange: 'invalid-range',
  // ADR 0009 item 1
  invalidAgentTrailer: 'invalid-agent-trailer',
  // ADR 0009 item 2: fail closed on merge commits; the id is chosen here
  mergeCommit: 'merge-commit',
} as const;

type BoundaryRuleId = (typeof boundaryRule)[keyof typeof boundaryRule];

const taskBranch = 'task/14-fixture';
const approvedTestChange = 'Test-Change: approved #14';
const slow = { timeout: 120_000 };

/** The trailers every task-branch commit carries (CLAUDE.md, "Conventions every agent follows"). */
function taskTrailers(agent: string): string[] {
  return ['Task: #14', `Agent: ${agent}`, 'Attempt: 1'];
}

/** Distinct text, long enough that git detects an unchanged moved file as a rename. */
function fileText(label: string): string {
  return Array.from({ length: 24 }, (_unused, index) => `// ${label}: line ${index + 1} of the fixture file`).join(
    '\n',
  );
}

/** Files on `main` in every fixture. */
const baseFiles = {
  readme: 'README.md',
  source: 'src/app.ts',
  helper: 'src/helper.ts',
  gateTest: 'src/app.gate.test.ts',
  smokeTest: 'e2e/smoke/launch.ts',
  fixture: 'packages/ui/src/__fixtures__/tokens.json',
  snapshot: 'packages/ui/src/__snapshots__/button.gate.test.tsx.snap',
  testSupport: 'tools/repo/test-support/run-fixture.ts',
} as const;

const fixtureRoots: string[] = [];

afterEach(() => {
  while (fixtureRoots.length > 0) {
    const dir = fixtureRoots.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function createFixtureRoot(): string {
  // Real path: on Windows this also expands 8.3 short names such as RUNNER~1.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'boundary-check-gate-')));
  fixtureRoots.push(dir);
  writeFileSync(join(dir, 'empty.gitconfig'), '');
  return dir;
}

function isolatedGitEnv(fixtureRoot: string): Record<string, string> {
  return {
    GIT_CONFIG_GLOBAL: join(fixtureRoot, 'empty.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    // Git never looks above the fixture root for a repository.
    GIT_CEILING_DIRECTORIES: fixtureRoot,
    GIT_AUTHOR_NAME: 'boundary-gate',
    GIT_AUTHOR_EMAIL: 'boundary-gate@example.invalid',
    GIT_COMMITTER_NAME: 'boundary-gate',
    GIT_COMMITTER_EMAIL: 'boundary-gate@example.invalid',
  };
}

interface Violation {
  readonly shortSha: string;
  readonly rule: string;
  readonly line: string;
}

interface CheckRun {
  readonly result: RepoCommandResult;
  /** Lines in the `<short-sha>: <rule-id>: <message>` form. */
  readonly violations: Violation[];
  /** Non-empty output lines that are not in that form. */
  readonly strayLines: string[];
}

const violationLinePattern = /^([^\s:]+): ([a-z][a-z0-9-]*): (\S.*)$/;

function parseCheckOutput(result: RepoCommandResult): CheckRun {
  const violations: Violation[] = [];
  const strayLines: string[] = [];
  for (const raw of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.trim() === '') continue;
    const match = violationLinePattern.exec(line);
    if (match) violations.push({ shortSha: match[1] ?? '', rule: match[2] ?? '', line });
    else strayLines.push(line);
  }
  return { result, violations, strayLines };
}

function runBoundaryCheck(cwd: string, env: Record<string, string>, args: readonly string[]): CheckRun {
  expect(
    existsSync(boundaryCheckEntry),
    `${boundaryCheckEntryRelativePath} must exist: the boundary check script (#14)`,
  ).toBe(true);
  const result = runRepoCommand(process.execPath, [boundaryCheckEntry, ...args], { cwd, env, timeoutMs: 60_000 });
  expect(result.exitCode, `the boundary check did not finish:\n${describeRepoCommand(result)}`).not.toBe(-1);
  return parseCheckOutput(result);
}

class FixtureRepo {
  readonly root: string;
  readonly dir: string;
  readonly env: Record<string, string>;
  /** Full SHA of every commit made through `commit`, newest last. */
  readonly commits: string[] = [];
  private messageCount = 0;

  constructor() {
    this.root = createFixtureRoot();
    this.dir = join(this.root, 'repo');
    mkdirSync(this.dir);
    this.env = isolatedGitEnv(this.root);
    this.git(['init', '--quiet', '--initial-branch=main']);
  }

  git(args: readonly string[]): string {
    const result = runRepoCommand('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
      cwd: this.dir,
      env: this.env,
    });
    if (result.exitCode !== 0) throw new Error(`fixture git command failed:\n${describeRepoCommand(result)}`);
    return result.stdout.trim();
  }

  write(path: string, text: string = fileText(path)): this {
    const target = join(this.dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${text}\n`);
    return this;
  }

  /** Changes an existing file. */
  edit(path: string): this {
    return this.write(path, `${fileText(path)}\n// edited ${this.commits.length}`);
  }

  remove(path: string): this {
    unlinkSync(join(this.dir, path));
    return this;
  }

  move(from: string, to: string): this {
    mkdirSync(dirname(join(this.dir, to)), { recursive: true });
    this.git(['mv', from, to]);
    return this;
  }

  /** Commits everything in the working tree. The message ends with the trailer block. */
  commit(subject: string, trailers: readonly string[], body?: string): string {
    this.git(['add', '--all']);
    const parts = [
      subject,
      ...(body === undefined ? [] : [body]),
      ...(trailers.length > 0 ? [trailers.join('\n')] : []),
    ];
    this.messageCount += 1;
    const messageFile = join(this.root, `message-${this.messageCount}.txt`);
    writeFileSync(messageFile, `${parts.join('\n\n')}\n`);
    this.git(['commit', '--quiet', '--no-verify', '--allow-empty', '--cleanup=strip', '-F', messageFile]);
    const sha = this.git(['rev-parse', 'HEAD']);
    this.commits.push(sha);
    return sha;
  }

  /** Merges a ref into the current branch with a merge commit (never a fast-forward). */
  merge(ref: string, subject: string, trailers: readonly string[]): string {
    this.messageCount += 1;
    const messageFile = join(this.root, `message-${this.messageCount}.txt`);
    writeFileSync(messageFile, `${[subject, trailers.join('\n')].join('\n\n')}\n`);
    this.git(['merge', '--quiet', '--no-ff', '--no-verify', '-F', messageFile, ref]);
    const sha = this.git(['rev-parse', 'HEAD']);
    this.commits.push(sha);
    return sha;
  }

  /** Writes the files every fixture has on main, commits them, and starts a branch. */
  seed(branch: string = taskBranch): this {
    for (const path of Object.values(baseFiles)) this.write(path);
    this.commit('base', []);
    this.git(['checkout', '--quiet', '-b', branch]);
    return this;
  }

  checkout(ref: string): this {
    this.git(['checkout', '--quiet', ref]);
    return this;
  }

  /** Runs the check with HEAD detached at main, so it must read the range from its arguments. */
  check(options: { base?: string; head?: string; branch?: string } = {}): CheckRun {
    this.git(['checkout', '--quiet', '--detach', 'main']);
    return runBoundaryCheck(this.dir, this.env, [
      '--base',
      options.base ?? 'main',
      '--head',
      options.head ?? taskBranch,
      '--branch',
      options.branch ?? taskBranch,
    ]);
  }

  /** The full SHA of a known commit that starts with the printed short SHA, or the short SHA itself. */
  resolveShortSha(shortSha: string): string {
    if (!/^[0-9a-f]{7,40}$/.test(shortSha)) return shortSha;
    const matches = this.commits.filter((sha) => sha.startsWith(shortSha));
    return matches.length === 1 ? (matches[0] as string) : shortSha;
  }

  /** Fails the test unless git itself records the move as a rename, so the rename tests mean something. */
  expectGitSeesRename(from: string, to: string): void {
    const status = this.git(['diff', '--name-status', '-M', 'HEAD~1', 'HEAD']);
    expect(status, `the fixture commit must be a rename ${from} -> ${to}`).toMatch(
      new RegExp(`^R\\d+\\t${escapeRegExp(from)}\\t${escapeRegExp(to)}$`, 'm'),
    );
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function describeCheckRun(run: CheckRun): string {
  return describeRepoCommand(run.result);
}

function expectPass(run: CheckRun): void {
  expect(run.result.exitCode, `a valid range must pass with exit 0:\n${describeCheckRun(run)}`).toBe(0);
  expect(run.result.stdout.trim(), `a passing check prints nothing:\n${describeCheckRun(run)}`).toBe('');
  expect(run.result.stderr.trim(), `a passing check prints nothing:\n${describeCheckRun(run)}`).toBe('');
}

interface ExpectedViolation {
  readonly sha: string;
  readonly rule: BoundaryRuleId;
  /** A path the line for this commit and rule must name. */
  readonly path?: string;
}

function expectViolations(repo: FixtureRepo, run: CheckRun, expected: readonly ExpectedViolation[]): void {
  const output = describeCheckRun(run);
  expect(run.result.exitCode, `a range with violations must exit non-zero:\n${output}`).not.toBe(0);
  expect(run.strayLines, `every output line must be \`<short-sha>: <rule-id>: <message>\`:\n${output}`).toEqual([]);
  for (const violation of run.violations) {
    expect(violation.shortSha, `"${violation.line}" must start with a short commit SHA`).toMatch(/^[0-9a-f]{7,40}$/);
  }
  const actual = [
    ...new Set(run.violations.map((violation) => `${repo.resolveShortSha(violation.shortSha)} ${violation.rule}`)),
  ].sort();
  const wanted = [...new Set(expected.map((violation) => `${violation.sha} ${violation.rule}`))].sort();
  expect(actual, `violations (full SHA and rule) must be exactly these:\n${output}`).toEqual(wanted);
  for (const violation of expected) {
    if (violation.path === undefined) continue;
    const lines = run.violations.filter(
      (entry) => entry.rule === violation.rule && repo.resolveShortSha(entry.shortSha) === violation.sha,
    );
    expect(
      lines.some((entry) => entry.line.includes(violation.path as string)),
      `a ${violation.rule} line for ${violation.sha.slice(0, 7)} must name ${violation.path}:\n${output}`,
    ).toBe(true);
  }
}

/**
 * An `invalid-range` line has no commit to name, so the `<short-sha>` part is
 * optional or may hold the ref: `invalid-range: <message>` or
 * `<ref>: invalid-range: <message>`.
 */
const invalidRangeLinePattern = /^(?:\S+: )?invalid-range: \S/;

function expectInvalidRange(run: CheckRun, mustName?: string): void {
  const output = describeCheckRun(run);
  expect(run.result.exitCode, `an invalid range must exit non-zero, never pass:\n${output}`).not.toBe(0);
  const lines = `${run.result.stdout}\n${run.result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '');
  expect(
    lines.filter((line) => !invalidRangeLinePattern.test(line) && !violationLinePattern.test(line)),
    `every output line must be \`[<short-sha>: ]<rule-id>: <message>\`:\n${output}`,
  ).toEqual([]);
  const rangeLines = lines.filter((line) => invalidRangeLinePattern.test(line));
  expect(rangeLines.length, `the output must have an ${boundaryRule.invalidRange} line:\n${output}`).toBeGreaterThan(0);
  if (mustName !== undefined) {
    expect(
      rangeLines.some((line) => line.includes(mustName)),
      `the ${boundaryRule.invalidRange} line must name ${mustName}:\n${output}`,
    ).toBe(true);
  }
}

describe('task-branch trailers', () => {
  // ORCHESTRATOR section 6: task-branch commits need Task: and Agent:
  it('section 6: a task-branch commit without a Task: trailer is rejected with missing-task-trailer', slow, () => {
    const repo = new FixtureRepo().seed();
    repo.edit(baseFiles.source).commit('Valid commit', taskTrailers('developer'));
    const bad = repo.edit(baseFiles.source).commit('No task', ['Agent: developer', 'Attempt: 1']);
    expectViolations(repo, repo.check(), [{ sha: bad, rule: boundaryRule.missingTaskTrailer }]);
  });

  // ORCHESTRATOR section 6
  it('section 6: a task-branch commit without an Agent: trailer is rejected with missing-agent-trailer', slow, () => {
    const repo = new FixtureRepo().seed();
    const bad = repo.edit(baseFiles.source).commit('No agent', ['Task: #14', 'Attempt: 1']);
    repo.edit(baseFiles.source).commit('Valid commit', taskTrailers('developer'));
    expectViolations(repo, repo.check(), [{ sha: bad, rule: boundaryRule.missingAgentTrailer }]);
  });

  // ORCHESTRATOR section 6: one line per violation
  it('section 6: a task-branch commit with no trailers is rejected by both trailer rules', slow, () => {
    const repo = new FixtureRepo().seed();
    const bad = repo.edit(baseFiles.readme).commit('No trailers at all', []);
    expectViolations(repo, repo.check(), [
      { sha: bad, rule: boundaryRule.missingTaskTrailer },
      { sha: bad, rule: boundaryRule.missingAgentTrailer },
    ]);
  });

  // ORCHESTRATOR section 6 (failure mode): only the trailer block counts, as git reads trailers
  it('section 6: Task: and Agent: lines in the message body, outside the trailer block, do not count', slow, () => {
    const repo = new FixtureRepo().seed();
    const bad = repo
      .edit(baseFiles.source)
      .commit(
        'Trailers in the body',
        [],
        'Task: #14\nAgent: developer\n\nThis closing paragraph is not a trailer block.',
      );
    expectViolations(repo, repo.check(), [
      { sha: bad, rule: boundaryRule.missingTaskTrailer },
      { sha: bad, rule: boundaryRule.missingAgentTrailer },
    ]);
  });

  // ORCHESTRATOR section 6: the trailer rule applies to task/* branches only
  it.each(['spike/7-cdp', 'feature/task-14', 'tasks/14-fixture'])(
    'section 6: commits without Task: or Agent: pass on the non-task branch %s',
    (branch) => {
      const repo = new FixtureRepo().seed(branch);
      repo.edit(baseFiles.source).commit('Spike work', []);
      repo.write('spike/notes.md').commit('More spike work', []);
      expectPass(repo.check({ head: branch, branch }));
    },
    slow.timeout,
  );
});

describe('reviewer and verifier commits', () => {
  // ORCHESTRATOR section 6: reviewer and verifier never commit
  it.each(['reviewer', 'verifier'])(
    'section 6: an Agent: %s commit on a task branch is rejected with reviewer-or-verifier-commit',
    (agent) => {
      const repo = new FixtureRepo().seed();
      repo.edit(baseFiles.source).commit('Developer work', taskTrailers('developer'));
      const bad = repo.edit(baseFiles.readme).commit('Review notes', taskTrailers(agent));
      expectViolations(repo, repo.check(), [{ sha: bad, rule: boundaryRule.reviewerOrVerifierCommit }]);
    },
    slow.timeout,
  );

  // ORCHESTRATOR section 6: "on any branch", even for an empty commit
  it.each(['reviewer', 'verifier'])(
    'section 6: an empty Agent: %s commit on a non-task branch is rejected with reviewer-or-verifier-commit',
    (agent) => {
      const branch = 'spike/9-overlays';
      const repo = new FixtureRepo().seed(branch);
      const bad = repo.commit('Empty marker commit', [`Agent: ${agent}`]);
      expectViolations(repo, repo.check({ head: branch, branch }), [
        { sha: bad, rule: boundaryRule.reviewerOrVerifierCommit },
      ]);
    },
    slow.timeout,
  );
});

describe('developer paths', () => {
  // ORCHESTRATOR section 6: the developer never changes gate tests or e2e/smoke/
  it.each([
    'src/button.gate.test.ts',
    'packages/ui/src/menu/menu.gate.test.tsx',
    'root.gate.test.ts',
    'e2e/smoke/windows/tear-off.ts',
    'src/my folder/ünïcode.gate.test.ts',
  ])(
    'section 6: an Agent: developer commit that adds %s is rejected with developer-touches-gate-test naming the path',
    (path) => {
      const repo = new FixtureRepo().seed();
      repo.edit(baseFiles.source).commit('Valid developer work', taskTrailers('developer'));
      const bad = repo.write(path).commit('Developer adds a test', taskTrailers('developer'));
      expectViolations(repo, repo.check(), [{ sha: bad, rule: boundaryRule.developerTouchesGateTest, path }]);
    },
    slow.timeout,
  );

  // ORCHESTRATOR sections 3 and 6: a changed existing gate test breaks two rules
  it.each([
    ['modifies', (repo: FixtureRepo, path: string) => repo.edit(path)],
    ['deletes', (repo: FixtureRepo, path: string) => repo.remove(path)],
  ] as const)(
    'sections 3 and 6: an Agent: developer commit that %s an existing gate test is rejected by both rules',
    (_verb, change) => {
      const repo = new FixtureRepo().seed();
      const bad = change(repo, baseFiles.gateTest).commit('Developer changes a test', taskTrailers('developer'));
      expectViolations(repo, repo.check(), [
        { sha: bad, rule: boundaryRule.developerTouchesGateTest, path: baseFiles.gateTest },
        { sha: bad, rule: boundaryRule.testChangeNotApproved, path: baseFiles.gateTest },
      ]);
    },
    slow.timeout,
  );

  // ORCHESTRATOR section 6: Test-Change approves a test change, not a developer editing tests
  it(
    'section 6: an Agent: developer commit that edits e2e/smoke/** is rejected even with Test-Change: approved',
    slow,
    () => {
      const repo = new FixtureRepo().seed();
      const bad = repo
        .edit(baseFiles.smokeTest)
        .commit('Developer edits a smoke test', [...taskTrailers('developer'), approvedTestChange]);
      expectViolations(repo, repo.check(), [
        { sha: bad, rule: boundaryRule.developerTouchesGateTest, path: baseFiles.smokeTest },
      ]);
    },
  );

  // ORCHESTRATOR section 6: everything else is the developer's to change
  it(
    'section 6: an Agent: developer commit may change source, plain tests, new fixtures and look-alike paths',
    slow,
    () => {
      const repo = new FixtureRepo().seed();
      repo.edit(baseFiles.source).write('src/feature.ts').commit('Source', taskTrailers('developer'));
      repo.write('src/app.test.ts').commit('A plain unit test', taskTrailers('developer'));
      repo.write('packages/ui/src/__fixtures__/new-input.json').commit('New fixture', taskTrailers('developer'));
      repo
        .write('e2e/smoke-helpers/launch.ts')
        .write('src/gate-test-utils.ts')
        .write('docs/notes.md')
        .write('test-supports/helper.ts')
        .write('src/my-test-support/helper.ts')
        .write('src/test-support.ts')
        .commit('Look-alike paths', taskTrailers('developer'));
      expectPass(repo.check());
    },
  );
});

describe('test-author paths', () => {
  // ORCHESTRATOR section 6: the test author never changes non-test source files.
  // The test paths are the closed list in #14.
  it.each([
    ['modifies', baseFiles.source],
    ['adds', 'src/new-module.ts'],
    ['adds', 'src/app.test.ts'],
    ['adds', 'e2e/smoke-helpers/launch.ts'],
    ['adds', 'src/__fixtures__.ts'],
    ['adds', 'packages/ui/src/menu.gate.test.ts.orig'],
    ['adds', '.github/workflows/boundary.yml'],
    ['adds', 'test-supports/helper.ts'],
    ['adds', 'src/my-test-support/helper.ts'],
    ['adds', 'src/test-support.ts'],
  ] as const)(
    'section 6: an Agent: test-author commit that %s %s is rejected with test-author-touches-source naming the path',
    (verb, path) => {
      const repo = new FixtureRepo().seed();
      repo.write('src/feature.gate.test.ts').commit('Valid test-author work', taskTrailers('test-author'));
      if (verb === 'modifies') repo.edit(path);
      else repo.write(path);
      const bad = repo.commit('Test author touches source', taskTrailers('test-author'));
      expectViolations(repo, repo.check(), [{ sha: bad, rule: boundaryRule.testAuthorTouchesSource, path }]);
    },
    slow.timeout,
  );

  // #14 test paths: **/*.gate.test.ts, **/*.gate.test.tsx, e2e/smoke/**, **/__fixtures__/**, **/__snapshots__/**
  // (test-support/ is covered in its own describe block, ADR 0008)
  it(
    '#14: an Agent: test-author commit may add files under every test path, at any depth, with no Test-Change trailer',
    slow,
    () => {
      const repo = new FixtureRepo().seed();
      repo
        .write('root.gate.test.ts')
        .write('src/feature.gate.test.ts')
        .commit('Gate tests', taskTrailers('test-author'));
      repo.write('packages/ui/src/menu/menu.gate.test.tsx').commit('Component gate test', taskTrailers('test-author'));
      repo.write('e2e/smoke/windows/deep/tear-off.ts').commit('Smoke test', taskTrailers('test-author'));
      repo
        .write('__fixtures__/top.json')
        .write('packages/ui/src/__fixtures__/deep/input.json')
        .commit('Fixtures', taskTrailers('test-author'));
      repo
        .write('packages/ui/src/__snapshots__/menu.gate.test.tsx.snap')
        .commit('Snapshot', taskTrailers('test-author'));
      expectPass(repo.check());
    },
  );

  // ORCHESTRATOR section 6: one source path in a commit is enough
  it(
    'section 6: an Agent: test-author commit with a test path and a source path is rejected and names the source path',
    slow,
    () => {
      const repo = new FixtureRepo().seed();
      const bad = repo
        .write('src/feature.gate.test.ts')
        .write('src/feature.ts')
        .commit('Test and stub', taskTrailers('test-author'));
      expectViolations(repo, repo.check(), [
        { sha: bad, rule: boundaryRule.testAuthorTouchesSource, path: 'src/feature.ts' },
      ]);
    },
  );
});

describe('test-support folders (ADR 0008)', () => {
  // ADR 0008 item 1: `**/test-support/**` is test code; the developer never changes it
  it.each([
    ['adds', 'test-support/root-helper.ts'],
    ['adds', 'packages/ui/src/test-support/deep/render-helper.tsx'],
    ['modifies', baseFiles.testSupport],
    ['deletes', baseFiles.testSupport],
  ] as const)(
    'ADR 0008: an Agent: developer commit that %s %s is rejected with developer-touches-gate-test naming the path',
    (verb, path) => {
      const repo = new FixtureRepo().seed();
      repo.edit(baseFiles.source).commit('Valid developer work', taskTrailers('developer'));
      if (verb === 'adds') repo.write(path);
      else if (verb === 'modifies') repo.edit(path);
      else repo.remove(path);
      // Approved, so only the developer rule applies to the existing file.
      const bad = repo.commit('Developer touches test support', [...taskTrailers('developer'), approvedTestChange]);
      expectViolations(repo, repo.check(), [{ sha: bad, rule: boundaryRule.developerTouchesGateTest, path }]);
    },
    slow.timeout,
  );

  // ADR 0008 item 1: the test author changes test-support/ at any depth
  it('ADR 0008: an Agent: test-author commit may add, change and delete test-support/ files at any depth', slow, () => {
    const repo = new FixtureRepo().seed();
    repo
      .write('test-support/root-helper.ts')
      .write('tools/repo/test-support/new-helper.ts')
      .write('packages/ui/src/test-support/deep/nested/render-helper.tsx')
      .commit('Add test support', taskTrailers('test-author'));
    repo.edit('tools/repo/test-support/new-helper.ts').commit('Change test support', taskTrailers('test-author'));
    repo.remove('test-support/root-helper.ts').commit('Drop test support', taskTrailers('test-author'));
    repo
      .edit(baseFiles.testSupport)
      .commit('Approved change to existing support', [...taskTrailers('test-author'), approvedTestChange]);
    expectPass(repo.check());
  });

  // ADR 0008 item 1: the developer's look-alike paths are not test code
  it(
    'ADR 0008: test-supports/, my-test-support/ and a file named test-support.ts are not test code for the developer',
    slow,
    () => {
      const repo = new FixtureRepo().seed();
      repo
        .write('test-supports/helper.ts')
        .write('src/my-test-support/helper.ts')
        .write('src/test-support.ts')
        .commit('Look-alike source paths', taskTrailers('developer'));
      expectPass(repo.check());
    },
  );
});

describe('existing test files and Test-Change', () => {
  const existingTests = [baseFiles.gateTest, baseFiles.smokeTest, baseFiles.testSupport] as const;

  // ORCHESTRATOR section 3: changing an existing test needs Test-Change: approved #<issue>
  it.each(existingTests)(
    'section 3: a commit that modifies %s, which exists on the base ref, is rejected with test-change-not-approved',
    (path) => {
      const repo = new FixtureRepo().seed();
      const bad = repo.edit(path).commit('Rewrite a test', taskTrailers('test-author'));
      expectViolations(repo, repo.check(), [{ sha: bad, rule: boundaryRule.testChangeNotApproved, path }]);
    },
    slow.timeout,
  );

  // ORCHESTRATOR section 3
  it.each(existingTests)(
    'section 3: a commit that deletes %s, which exists on the base ref, is rejected with test-change-not-approved',
    (path) => {
      const repo = new FixtureRepo().seed();
      const bad = repo.remove(path).commit('Remove a test', taskTrailers('test-author'));
      expectViolations(repo, repo.check(), [{ sha: bad, rule: boundaryRule.testChangeNotApproved, path }]);
    },
    slow.timeout,
  );

  // ORCHESTRATOR section 3: with the trailer it passes
  it.each(existingTests)(
    'section 3: a commit that modifies and one that deletes %s pass with Test-Change: approved #14',
    (path) => {
      const repo = new FixtureRepo().seed();
      repo.edit(path).commit('Approved rewrite', [...taskTrailers('test-author'), approvedTestChange]);
      repo.remove(path).commit('Approved removal', [...taskTrailers('test-author'), approvedTestChange]);
      expectPass(repo.check());
    },
    slow.timeout,
  );

  // #14: adding a new test file needs no trailer
  it('#14: a commit that adds a new gate test and a new smoke test passes with no Test-Change trailer', slow, () => {
    const repo = new FixtureRepo().seed();
    repo
      .write('src/new.gate.test.ts')
      .write('e2e/smoke/new-window.ts')
      .commit('New tests', taskTrailers('test-author'));
    expectPass(repo.check());
  });

  // #14: "exists on the base ref", not "exists in the parent commit"
  it(
    '#14: a test file added earlier in the range may be changed and deleted later in the range with no trailer',
    slow,
    () => {
      const repo = new FixtureRepo().seed();
      repo.write('src/new.gate.test.ts').commit('Add test', taskTrailers('test-author'));
      repo.edit('src/new.gate.test.ts').commit('Fix the new test', taskTrailers('test-author'));
      repo.remove('src/new.gate.test.ts').commit('Drop the new test', taskTrailers('test-author'));
      expectPass(repo.check());
    },
  );

  // ORCHESTRATOR section 3 (failure mode): the trailer must be `approved #<issue>`
  it.each(['Test-Change: approved', 'Test-Change: yes #14', 'Test-Change: approved 14', 'Test-Change: pending #14'])(
    'section 3: a commit that modifies an existing gate test with the malformed trailer "%s" is rejected',
    (trailer) => {
      const repo = new FixtureRepo().seed();
      const bad = repo.edit(baseFiles.gateTest).commit('Rewrite a test', [...taskTrailers('test-author'), trailer]);
      expectViolations(repo, repo.check(), [
        { sha: bad, rule: boundaryRule.testChangeNotApproved, path: baseFiles.gateTest },
      ]);
    },
    slow.timeout,
  );

  // ORCHESTRATOR section 3 (failure mode): only the trailer block counts
  it(
    'section 3: Test-Change: approved #14 in the message body, outside the trailer block, does not count',
    slow,
    () => {
      const repo = new FixtureRepo().seed();
      const bad = repo
        .edit(baseFiles.gateTest)
        .commit(
          'Rewrite a test',
          taskTrailers('test-author'),
          `${approvedTestChange}\n\nThe approval is in this paragraph.`,
        );
      expectViolations(repo, repo.check(), [
        { sha: bad, rule: boundaryRule.testChangeNotApproved, path: baseFiles.gateTest },
      ]);
    },
  );
});

describe('renames', () => {
  // #14: a rename touches the old path; here the old path is a gate test
  it(
    '#14: an Agent: developer commit that renames a gate test to a source path is rejected, naming the old path',
    slow,
    () => {
      const repo = new FixtureRepo().seed();
      const bad = repo
        .move(baseFiles.gateTest, 'src/app-check.ts')
        .commit('Move the test out of the way', taskTrailers('developer'));
      repo.expectGitSeesRename(baseFiles.gateTest, 'src/app-check.ts');
      expectViolations(repo, repo.check(), [
        { sha: bad, rule: boundaryRule.developerTouchesGateTest, path: baseFiles.gateTest },
        { sha: bad, rule: boundaryRule.testChangeNotApproved, path: baseFiles.gateTest },
      ]);
    },
  );

  // #14: a rename touches the new path; here the new path is a gate test
  it(
    '#14: an Agent: developer commit that renames a source file to a gate test path is rejected, naming the new path',
    slow,
    () => {
      const repo = new FixtureRepo().seed();
      const bad = repo
        .move(baseFiles.helper, 'src/helper.gate.test.ts')
        .commit('Turn a helper into a test', taskTrailers('developer'));
      repo.expectGitSeesRename(baseFiles.helper, 'src/helper.gate.test.ts');
      expectViolations(repo, repo.check(), [
        { sha: bad, rule: boundaryRule.developerTouchesGateTest, path: 'src/helper.gate.test.ts' },
      ]);
    },
  );

  // #14: a rename touches the old path; here the old path is source
  it(
    '#14: an Agent: test-author commit that renames a source file to a gate test path is rejected, naming the old path',
    slow,
    () => {
      const repo = new FixtureRepo().seed();
      const bad = repo
        .move(baseFiles.helper, 'src/helper.gate.test.ts')
        .commit('Turn a helper into a test', taskTrailers('test-author'));
      repo.expectGitSeesRename(baseFiles.helper, 'src/helper.gate.test.ts');
      expectViolations(repo, repo.check(), [
        { sha: bad, rule: boundaryRule.testAuthorTouchesSource, path: baseFiles.helper },
      ]);
    },
  );

  // #14 and ORCHESTRATOR section 3: renaming an existing test removes its old path
  it(
    '#14: renaming an existing gate test to another gate test path needs Test-Change, naming the old path',
    slow,
    () => {
      const repo = new FixtureRepo().seed();
      const bad = repo
        .move(baseFiles.gateTest, 'src/app-renamed.gate.test.ts')
        .commit('Rename a test', taskTrailers('test-author'));
      repo.expectGitSeesRename(baseFiles.gateTest, 'src/app-renamed.gate.test.ts');
      expectViolations(repo, repo.check(), [
        { sha: bad, rule: boundaryRule.testChangeNotApproved, path: baseFiles.gateTest },
      ]);
    },
  );

  // #14 and ORCHESTRATOR section 3
  it(
    '#14: renaming an existing gate test to another gate test path passes with Test-Change: approved #14',
    slow,
    () => {
      const repo = new FixtureRepo().seed();
      repo
        .move(baseFiles.gateTest, 'src/app-renamed.gate.test.ts')
        .commit('Rename a test', [...taskTrailers('test-author'), approvedTestChange]);
      repo.expectGitSeesRename(baseFiles.gateTest, 'src/app-renamed.gate.test.ts');
      expectPass(repo.check());
    },
  );
});

describe('co-author trailers', () => {
  // PLT-010: no AI co-author trailers. Git trailer keys are case-insensitive.
  it.each([
    'Co-Authored-By: Assistant <assistant@example.invalid>',
    'Co-authored-by: Assistant <assistant@example.invalid>',
  ])(
    'PLT-010: a task-branch commit with the trailer "%s" is rejected with co-author-trailer',
    (trailer) => {
      const repo = new FixtureRepo().seed();
      repo.edit(baseFiles.source).commit('Valid commit', taskTrailers('developer'));
      const bad = repo.edit(baseFiles.source).commit('Pair work', [...taskTrailers('developer'), trailer]);
      expectViolations(repo, repo.check(), [{ sha: bad, rule: boundaryRule.coAuthorTrailer }]);
    },
    slow.timeout,
  );

  // PLT-010: any commit, on any branch
  it(
    'PLT-010: a commit with a Co-Authored-By: trailer on a non-task branch is rejected with co-author-trailer',
    slow,
    () => {
      const branch = 'spike/8-forge';
      const repo = new FixtureRepo().seed(branch);
      const bad = repo
        .write('spike/result.md')
        .commit('Spike result', ['Co-Authored-By: Assistant <assistant@example.invalid>']);
      expectViolations(repo, repo.check({ head: branch, branch }), [{ sha: bad, rule: boundaryRule.coAuthorTrailer }]);
    },
  );
});

describe('commit range', () => {
  // #14: a valid range passes with exit 0 and no output
  it(
    '#14: a valid range of test-author, developer and approved test-change commits exits 0 and prints nothing',
    slow,
    () => {
      const repo = new FixtureRepo().seed();
      repo
        .write('src/feature.gate.test.ts')
        .write('e2e/smoke/feature.ts')
        .commit('Gate tests', taskTrailers('test-author'));
      repo.write('packages/ui/src/__fixtures__/feature.json').commit('Fixture', taskTrailers('test-author'));
      repo.write('src/feature.ts').edit(baseFiles.source).commit('Implement', taskTrailers('developer'));
      repo
        .edit(baseFiles.gateTest)
        .commit('Approved test change', [...taskTrailers('test-author'), approvedTestChange]);
      repo.write('docs/adr/0099-note.md').commit('Orchestrator note', taskTrailers('orchestrator'));
      expectPass(repo.check());
    },
  );

  // #14: the range is <base>..<head>; head may be given as a full SHA
  it('#14: head given as a full commit SHA checks the same range as the branch name', slow, () => {
    const repo = new FixtureRepo().seed();
    const bad = repo.edit(baseFiles.source).commit('No trailers', []);
    expectViolations(repo, repo.check({ base: repo.commits[0], head: bad }), [
      { sha: bad, rule: boundaryRule.missingTaskTrailer },
      { sha: bad, rule: boundaryRule.missingAgentTrailer },
    ]);
  });

  // #14: commits reachable from base are not in the range
  it('#14: violating commits already on the base ref are not reported', slow, () => {
    const repo = new FixtureRepo();
    for (const path of Object.values(baseFiles)) repo.write(path);
    repo.commit('base', []);
    repo.edit(baseFiles.readme).commit('Old review commit', ['Agent: reviewer']);
    repo.edit(baseFiles.readme).commit('Old pair commit', ['Co-Authored-By: Assistant <assistant@example.invalid>']);
    repo.git(['checkout', '--quiet', '-b', taskBranch]);
    repo.edit(baseFiles.source).commit('Valid work', taskTrailers('developer'));
    expectPass(repo.check());
  });

  // #14: a pull request's base SHA is the tip of main, which may have moved on
  it('#14: a base ref that moved on after the branch started checks only the branch commits', slow, () => {
    const repo = new FixtureRepo().seed();
    repo.edit(baseFiles.source).commit('Valid work', taskTrailers('developer'));
    repo.checkout('main');
    repo.edit(baseFiles.readme).commit('Later commit on main', ['Agent: reviewer']);
    expectPass(repo.check());
  });

  // #14: one line per violation, for every violating commit
  it('#14: every violating commit in the range is reported, each with its own SHA and rule', slow, () => {
    const repo = new FixtureRepo().seed();
    const first = repo.write('src/new.gate.test.ts').commit('Developer test', taskTrailers('developer'));
    repo.edit(baseFiles.source).commit('Valid', taskTrailers('developer'));
    const second = repo.commit('Review', taskTrailers('verifier'));
    const third = repo
      .write('src/stub.ts')
      .commit('Stub', [...taskTrailers('test-author'), 'Co-Authored-By: Assistant <assistant@example.invalid>']);
    expectViolations(repo, repo.check(), [
      { sha: first, rule: boundaryRule.developerTouchesGateTest, path: 'src/new.gate.test.ts' },
      { sha: second, rule: boundaryRule.reviewerOrVerifierCommit },
      { sha: third, rule: boundaryRule.testAuthorTouchesSource, path: 'src/stub.ts' },
      { sha: third, rule: boundaryRule.coAuthorTrailer },
    ]);
  });
});

describe('invalid range (failure mode)', () => {
  const missingSha = '0123456789abcdef0123456789abcdef01234567';

  // #14: an unknown or unreachable ref never passes
  it.each([
    ['base', { base: 'no-such-ref' }, 'no-such-ref'],
    ['head', { head: 'no-such-branch' }, 'no-such-branch'],
    ['base', { base: missingSha }, missingSha.slice(0, 7)],
    ['head', { head: missingSha }, missingSha.slice(0, 7)],
  ] as const)(
    '#14: an unknown %s ref fails with a non-zero exit and an invalid-range line naming it (%j)',
    (_which, refs, named) => {
      const repo = new FixtureRepo().seed();
      repo.edit(baseFiles.source).commit('Valid work', taskTrailers('developer'));
      expectInvalidRange(repo.check(refs), named);
    },
    slow.timeout,
  );

  // #14: a shallow clone (CI's default fetch depth of 1) lacks the base commit
  it(
    '#14: a base commit missing from a shallow clone fails with invalid-range, never an empty passing range',
    slow,
    () => {
      const repo = new FixtureRepo().seed();
      const base = repo.commits[0] as string;
      repo.edit(baseFiles.source).commit('Valid work', taskTrailers('developer'));
      repo.edit(baseFiles.source).commit('More valid work', taskTrailers('developer'));
      const shallowDir = join(repo.root, 'shallow');
      const clone = runRepoCommand(
        'git',
        ['clone', '--quiet', '--depth=1', '--branch', taskBranch, pathToFileURL(repo.dir).href, shallowDir],
        { cwd: repo.root, env: repo.env },
      );
      expect(clone.exitCode, describeRepoCommand(clone)).toBe(0);
      const probe = runRepoCommand('git', ['cat-file', '-e', `${base}^{commit}`], { cwd: shallowDir, env: repo.env });
      expect(probe.exitCode, 'the fixture shallow clone must not contain the base commit').not.toBe(0);
      const run = runBoundaryCheck(shallowDir, repo.env, ['--base', base, '--head', 'HEAD', '--branch', taskBranch]);
      expectInvalidRange(run, base.slice(0, 7));
    },
  );

  // #14: refs cannot resolve outside a git repository
  it('#14: running outside a git repository fails with a non-zero exit and an invalid-range line', slow, () => {
    const root = createFixtureRoot();
    const notARepo = join(root, 'not-a-repo');
    mkdirSync(notARepo);
    const run = runBoundaryCheck(notARepo, isolatedGitEnv(root), [
      '--base',
      'main',
      '--head',
      taskBranch,
      '--branch',
      taskBranch,
    ]);
    expectInvalidRange(run);
  });

  // #14 (failure mode): a missing input never passes
  it.each(['--base', '--head', '--branch'])(
    '#14: leaving out %s fails with a non-zero exit, a message naming the option, and no stack trace',
    (option) => {
      const repo = new FixtureRepo().seed();
      repo.edit(baseFiles.source).commit('Valid work', taskTrailers('developer'));
      repo.git(['checkout', '--quiet', '--detach', 'main']);
      const values: Record<string, string> = { '--base': 'main', '--head': taskBranch, '--branch': taskBranch };
      const args = Object.entries(values)
        .filter(([name]) => name !== option)
        .flat();
      const run = runBoundaryCheck(repo.dir, repo.env, args);
      const output = describeCheckRun(run);
      expect(run.result.exitCode, `a missing ${option} must fail:\n${output}`).not.toBe(0);
      expect(run.result.output, `the message must name ${option}:\n${output}`).toContain(option);
      expect(run.result.output, `a missing option is a usage error, not a crash:\n${output}`).not.toMatch(
        /^\s+at\s.+[:(]/m,
      );
    },
    slow.timeout,
  );
});

// ---------------------------------------------------------------------------
// Review of #14 (attempt 1 of the developer) and ADR 0009.

/**
 * Like `expectViolations`, but only requires the listed violations to be among
 * the output, and requires every line to name a real fixture commit, so a
 * forged record can never appear as a commit.
 */
function expectViolationsInclude(repo: FixtureRepo, run: CheckRun, expected: readonly ExpectedViolation[]): void {
  const output = describeCheckRun(run);
  expect(run.result.exitCode, `the check must fail closed, never exit 0:\n${output}`).not.toBe(0);
  expect(run.result.exitCode, `the check must finish, not crash:\n${output}`).toBe(1);
  expect(run.strayLines, `every output line must be \`<short-sha>: <rule-id>: <message>\`:\n${output}`).toEqual([]);
  for (const violation of run.violations) {
    expect(
      repo.commits,
      `"${violation.line}" must name a commit of the range, not a forged or unknown SHA:\n${output}`,
    ).toContain(repo.resolveShortSha(violation.shortSha));
  }
  const actual = new Set(run.violations.map((entry) => `${repo.resolveShortSha(entry.shortSha)} ${entry.rule}`));
  for (const violation of expected) {
    expect(
      actual.has(`${violation.sha} ${violation.rule}`),
      `the output must have a ${violation.rule} line for ${violation.sha.slice(0, 7)}:\n${output}`,
    ).toBe(true);
    if (violation.path !== undefined) {
      expect(
        run.violations.some(
          (entry) =>
            entry.rule === violation.rule &&
            repo.resolveShortSha(entry.shortSha) === violation.sha &&
            entry.line.includes(violation.path as string),
        ),
        `the ${violation.rule} line for ${violation.sha.slice(0, 7)} must name ${violation.path}:\n${output}`,
      ).toBe(true);
    }
  }
}

const coAuthorTrailerLine = 'Co-Authored-By: Assistant <assistant@example.invalid>';

describe('control bytes in trailers (review finding 1)', () => {
  // Review finding 1: a unit separator (\x1f) after a value must not hide the trailers after it
  it(
    '#14: Agent: developer<0x1f> followed by Agent: reviewer and Co-Authored-By: hides no trailer and never exits 0',
    slow,
    () => {
      const repo = new FixtureRepo().seed();
      repo.edit(baseFiles.source).commit('Valid commit', taskTrailers('developer'));
      const bad = repo
        .edit(baseFiles.source)
        .commit('Control byte', ['Task: #14', 'Agent: developer\u001f', 'Agent: reviewer', coAuthorTrailerLine]);
      expectViolationsInclude(repo, repo.check(), [
        { sha: bad, rule: boundaryRule.reviewerOrVerifierCommit },
        { sha: bad, rule: boundaryRule.coAuthorTrailer },
        { sha: bad, rule: boundaryRule.invalidAgentTrailer },
      ]);
    },
  );

  // Review finding 1: a record separator (\x1e) must not end the commit's record early
  it('#14: Agent: test-author<0x1e> followed by Co-Authored-By: hides no trailer and never exits 0', slow, () => {
    const repo = new FixtureRepo().seed();
    const bad = repo
      .write('src/new.gate.test.ts')
      .commit('Record separator', ['Task: #14', 'Agent: test-author\u001e', coAuthorTrailerLine]);
    expectViolationsInclude(repo, repo.check(), [{ sha: bad, rule: boundaryRule.coAuthorTrailer }]);
  });

  // Review finding 1: text after \x1e that looks like a new record must not become a commit
  it('#14: a forged record after <0x1e> neither appears as a commit nor hides the real commit trailers', slow, () => {
    const repo = new FixtureRepo().seed();
    const valid = repo.edit(baseFiles.source).commit('Valid commit', taskTrailers('developer'));
    const forged = `${valid}\u001f${valid.slice(0, 7)}\u001f${repo.commits[0] ?? ''}\u001fAgent: developer`;
    const bad = repo
      .write('src/new.gate.test.ts')
      .commit('Forged record', [
        'Task: #14',
        `Agent: developer\u001e${forged}`,
        'Agent: reviewer',
        coAuthorTrailerLine,
      ]);
    expectViolationsInclude(repo, repo.check(), [
      { sha: bad, rule: boundaryRule.reviewerOrVerifierCommit },
      { sha: bad, rule: boundaryRule.coAuthorTrailer },
    ]);
  });
});

describe('Agent: roles (ADR 0009 item 1)', () => {
  const validRoles = ['planner', 'researcher', 'test-author', 'developer', 'reviewer', 'verifier', 'orchestrator'];

  // ADR 0009 item 1: each valid role passes the trailer rules (reviewer and verifier still never commit)
  it.each(validRoles)(
    'ADR 0009: an empty Agent: %s commit on a task branch passes the Agent: trailer rules',
    (role) => {
      const repo = new FixtureRepo().seed();
      const sha = repo.commit(`Empty ${role} commit`, taskTrailers(role));
      const run = repo.check();
      if (role === 'reviewer' || role === 'verifier') {
        expectViolations(repo, run, [{ sha, rule: boundaryRule.reviewerOrVerifierCommit }]);
      } else {
        expectPass(run);
      }
    },
    slow.timeout,
  );

  // ADR 0009 item 1 (review finding 2): an unknown role must not skip the path rules
  it.each(['dev', 'test author', 'human', 'developer, reviewer', 'claude'])(
    'ADR 0009: an Agent: %s commit that adds a gate test is rejected with invalid-agent-trailer',
    (value) => {
      const repo = new FixtureRepo().seed();
      const bad = repo.write('src/new.gate.test.ts').commit('Unknown role', ['Task: #14', `Agent: ${value}`]);
      expectViolationsInclude(repo, repo.check(), [{ sha: bad, rule: boundaryRule.invalidAgentTrailer }]);
    },
    slow.timeout,
  );

  // ADR 0009 item 1: the role list applies on any branch
  it('ADR 0009: an Agent: dev commit on a non-task branch is rejected with invalid-agent-trailer', slow, () => {
    const branch = 'spike/7-cdp';
    const repo = new FixtureRepo().seed(branch);
    const bad = repo.edit(baseFiles.source).commit('Unknown role', ['Agent: dev']);
    expectViolations(repo, repo.check({ head: branch, branch }), [
      { sha: bad, rule: boundaryRule.invalidAgentTrailer },
    ]);
  });

  // ADR 0009 item 1 (review mutant M10): every Agent: trailer counts, not only the first
  it.each([
    ['test-author', 'developer'],
    ['developer', 'test-author'],
    ['developer', 'developer'],
  ] as const)(
    'ADR 0009: a commit with Agent: %s and Agent: %s is rejected with invalid-agent-trailer',
    (first, second) => {
      const repo = new FixtureRepo().seed();
      const bad = repo
        .write('src/new.gate.test.ts')
        .commit('Two roles', ['Task: #14', `Agent: ${first}`, `Agent: ${second}`, 'Attempt: 1']);
      expectViolationsInclude(repo, repo.check(), [{ sha: bad, rule: boundaryRule.invalidAgentTrailer }]);
    },
    slow.timeout,
  );

  // ADR 0009 item 1: a missing Agent: trailer stays missing-agent-trailer
  it(
    'ADR 0009: a task-branch commit with no Agent: trailer is still missing-agent-trailer, not invalid-agent-trailer',
    slow,
    () => {
      const repo = new FixtureRepo().seed();
      const bad = repo.edit(baseFiles.source).commit('No agent', ['Task: #14', 'Attempt: 1']);
      expectViolations(repo, repo.check(), [{ sha: bad, rule: boundaryRule.missingAgentTrailer }]);
    },
  );
});

describe('merge commits (ADR 0009 item 2)', () => {
  // ADR 0009 item 2: task branches are never updated by merging main; the check fails closed
  it.each([
    ['README.md only', baseFiles.readme],
    ['an existing gate test', baseFiles.gateTest],
  ] as const)(
    'ADR 0009: a merge of main into a task branch, where main changed %s, is rejected with merge-commit naming the merge',
    (_what, mainPath) => {
      const repo = new FixtureRepo().seed();
      repo.edit(baseFiles.source).commit('Developer work', taskTrailers('developer'));
      repo.checkout('main');
      repo.edit(mainPath).commit('main moves on', [...taskTrailers('orchestrator'), approvedTestChange]);
      repo.checkout(taskBranch);
      const merge = repo.merge('main', 'Merge main into the task branch', taskTrailers('developer'));
      expectViolationsInclude(repo, repo.check(), [{ sha: merge, rule: boundaryRule.mergeCommit }]);
    },
    slow.timeout,
  );

  // ADR 0009 item 2: the limit is stated in the script header
  it('ADR 0009: the script header states that task branches are never updated by merging main', () => {
    expect(existsSync(boundaryCheckEntry), `${boundaryCheckEntryRelativePath} must exist`).toBe(true);
    const lines = readFileSync(boundaryCheckEntry, 'utf8').split(/\r?\n/);
    const header: string[] = [];
    for (const line of lines) {
      if (!/^\s*\/\//.test(line)) break;
      header.push(line.replace(/^\s*\/\/\s?/, ''));
    }
    const text = header.join(' ').replace(/\s+/g, ' ');
    expect(
      text,
      'the leading comment block must say that a task branch is never updated by merging main (ADR 0009 item 2)',
    ).toMatch(/task branch(es)?\b[^.]*\bnever\b[^.]*\bmerg\w*[^.]*\bmain\b/i);
  });
});

describe('range completeness (review mutants M6 and M8)', () => {
  // Review mutant M6: a shallow repository fails closed even when base and head are present
  it('#14: a shallow clone that has the base and every range commit still fails with invalid-range', slow, () => {
    const repo = new FixtureRepo();
    for (const path of Object.values(baseFiles)) repo.write(path);
    repo.commit('first', []);
    repo.edit(baseFiles.readme).commit('second', []);
    const base = repo.edit(baseFiles.readme).commit('base', []);
    repo.git(['checkout', '--quiet', '-b', taskBranch]);
    repo.edit(baseFiles.source).commit('Valid work', taskTrailers('developer'));
    const head = repo.edit(baseFiles.source).commit('More valid work', taskTrailers('developer'));
    const shallowDir = join(repo.root, 'shallow');
    const clone = runRepoCommand(
      'git',
      [
        'clone',
        '--quiet',
        '--depth=3',
        '--no-single-branch',
        '--branch',
        taskBranch,
        pathToFileURL(repo.dir).href,
        shallowDir,
      ],
      { cwd: repo.root, env: repo.env },
    );
    expect(clone.exitCode, describeRepoCommand(clone)).toBe(0);
    const probe = (args: readonly string[]): RepoCommandResult =>
      runRepoCommand('git', args, { cwd: shallowDir, env: repo.env });
    expect(probe(['rev-parse', '--is-shallow-repository']).stdout.trim(), 'the fixture clone must be shallow').toBe(
      'true',
    );
    for (const sha of [base, head, repo.commits[3] as string]) {
      expect(probe(['cat-file', '-e', `${sha}^{commit}`]).exitCode, `the shallow clone must contain ${sha}`).toBe(0);
    }
    expect(probe(['merge-base', base, head]).exitCode, 'base and head must have a merge base in the clone').toBe(0);
    const run = runBoundaryCheck(shallowDir, repo.env, ['--base', base, '--head', head, '--branch', taskBranch]);
    expectInvalidRange(run);
  });

  // Review mutant M8: a head with no common ancestor with the base fails closed
  it('#14: a head on an unrelated history (no merge base with the base) fails with invalid-range', slow, () => {
    const repo = new FixtureRepo().seed();
    const orphanBranch = 'task/14-orphan';
    repo.git(['checkout', '--quiet', '--orphan', orphanBranch]);
    repo.git(['rm', '-r', '-q', '-f', '.']);
    repo.write('src/unrelated.ts').commit('Unrelated history', taskTrailers('developer'));
    expect(
      runRepoCommand('git', ['merge-base', 'main', orphanBranch], { cwd: repo.dir, env: repo.env }).exitCode,
      'the fixture branch must share no history with main',
    ).not.toBe(0);
    expectInvalidRange(repo.check({ head: orphanBranch, branch: orphanBranch }));
  });
});

describe('existing fixtures and snapshots (review finding 5, reading (a))', () => {
  const fixtureFiles = [baseFiles.fixture, baseFiles.snapshot] as const;

  // Reading (a): an updated existing fixture or snapshot needs Test-Change
  it.each(fixtureFiles)(
    '#14: an Agent: test-author commit that modifies %s, which exists on the base ref, is rejected with test-change-not-approved',
    (path) => {
      const repo = new FixtureRepo().seed();
      const bad = repo.edit(path).commit('Update test data', taskTrailers('test-author'));
      expectViolations(repo, repo.check(), [{ sha: bad, rule: boundaryRule.testChangeNotApproved, path }]);
    },
    slow.timeout,
  );

  // Reading (a): the developer may touch fixtures, but an existing one still needs Test-Change
  it.each(fixtureFiles)(
    '#14: an Agent: developer commit that modifies %s without Test-Change is rejected with test-change-not-approved only',
    (path) => {
      const repo = new FixtureRepo().seed();
      const bad = repo.edit(path).commit('Update test data', taskTrailers('developer'));
      expectViolations(repo, repo.check(), [{ sha: bad, rule: boundaryRule.testChangeNotApproved, path }]);
    },
    slow.timeout,
  );

  // Reading (a): with the trailer it passes
  it.each(fixtureFiles)(
    '#14: commits that modify and delete %s pass with Test-Change: approved #14',
    (path) => {
      const repo = new FixtureRepo().seed();
      repo.edit(path).commit('Approved update', [...taskTrailers('test-author'), approvedTestChange]);
      repo.remove(path).commit('Approved removal', [...taskTrailers('test-author'), approvedTestChange]);
      expectPass(repo.check());
    },
    slow.timeout,
  );
});
