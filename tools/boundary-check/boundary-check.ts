// Boundary check (#14): rejects commits that break the agent role boundaries
// (implementation/ORCHESTRATOR.md sections 3 and 6) and AI co-author trailers
// (PLT-010). Test code is the closed list in `boundaryTestPathGlobs` (#14,
// ADR 0008).
//
// Run: node tools/boundary-check/boundary-check.ts --base <ref> --head <ref> --branch <name>
// in the git repository to check. The range is `git rev-list <base>..<head>`;
// HEAD and the working tree are never read.
// Output: exit 0 and no output, or exit 1 and one line per violation,
// `<short-sha>: <rule-id>: <message>`. A usage error exits 2.
//
// Task branches are never updated by merging main into them; when a branch
// must move to a newer main, a new branch is built from main and the commits
// are cherry-picked (ADR 0009 item 2). The check fails closed: every merge
// commit in the range is rejected with `merge-commit`.
//
// Valid `Agent:` values are the closed list in `boundaryAgentRoles` (ADR 0009
// item 1). The path rules apply only to a commit with exactly one valid role.
//
// The script uses only Node built-ins, so CI runs it with Node's type
// stripping and no `pnpm install`. It is one file on purpose: CI runs the copy
// on the base commit (ADR 0008 item 2).
// DEFERRED: XC-006, TOK-151, TOK-170 (reject hand edits of generated files; phase 2)
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

/**
 * Test code (#14, ADR 0008): the only paths the test author may change, and
 * the paths whose existing files need `Test-Change: approved #<issue>`.
 */
const boundaryTestPathGlobs = [
  '**/*.gate.test.ts',
  '**/*.gate.test.tsx',
  'e2e/smoke/**',
  '**/__fixtures__/**',
  '**/__snapshots__/**',
  '**/test-support/**',
] as const;

/** The part of the test code the developer never changes (ORCHESTRATOR section 6, ADR 0008 item 1). */
const developerProtectedPathGlobs = [
  '**/*.gate.test.ts',
  '**/*.gate.test.tsx',
  'e2e/smoke/**',
  '**/test-support/**',
] as const satisfies readonly (typeof boundaryTestPathGlobs)[number][];

/** Rule ids, used verbatim in the output. */
const boundaryRule = {
  missingTaskTrailer: 'missing-task-trailer',
  missingAgentTrailer: 'missing-agent-trailer',
  reviewerOrVerifierCommit: 'reviewer-or-verifier-commit',
  developerTouchesGateTest: 'developer-touches-gate-test',
  testAuthorTouchesSource: 'test-author-touches-source',
  testChangeNotApproved: 'test-change-not-approved',
  coAuthorTrailer: 'co-author-trailer',
  invalidRange: 'invalid-range',
  invalidAgentTrailer: 'invalid-agent-trailer',
  mergeCommit: 'merge-commit',
} as const;

type BoundaryRuleId = (typeof boundaryRule)[keyof typeof boundaryRule];

/** Valid `Agent:` values (ADR 0009 item 1): the six sub-agents and the orchestrator. */
const boundaryAgentRoles = [
  'planner',
  'researcher',
  'test-author',
  'developer',
  'reviewer',
  'verifier',
  'orchestrator',
] as const;

type BoundaryAgentRole = (typeof boundaryAgentRoles)[number];

function isBoundaryAgentRole(value: string): value is BoundaryAgentRole {
  return (boundaryAgentRoles as readonly string[]).includes(value);
}

const taskBranchPrefix = 'task/';
const approvedTestChangeValue = /^approved #\d+$/;

const exitPass = 0;
const exitViolations = 1;
const exitUsage = 2;

const usageText = 'usage: node tools/boundary-check/boundary-check.ts --base <ref> --head <ref> --branch <name>';

/** Thrown when the range cannot be read; reported as an `invalid-range` line. */
class BoundaryRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoundaryRangeError';
  }
}

/** Thrown for a missing or malformed option; reported as a usage message. */
class BoundaryUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoundaryUsageError';
  }
}

interface BoundaryCheckInput {
  readonly base: string;
  readonly head: string;
  readonly branch: string;
}

interface CommitTrailer {
  /** Lower case, because git trailer keys are case-insensitive. */
  readonly key: string;
  readonly value: string;
}

interface RangeCommit {
  readonly sha: string;
  readonly shortSha: string;
  readonly parents: readonly string[];
  readonly trailers: readonly CommitTrailer[];
}

interface CommitPathChange {
  /** Every path the change touches: both paths for a rename or copy. */
  readonly touched: readonly string[];
  /** The path whose existing content the change modifies or removes, if any. */
  readonly changedExisting: string | undefined;
}

interface BoundaryViolation {
  readonly shortSha: string;
  readonly rule: BoundaryRuleId;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Path globs

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compiles the glob forms the path lists use: `**\/` prefix or segment, `/**` suffix, and `*` inside a segment. */
function compilePathGlob(glob: string): RegExp {
  let pattern = '';
  let index = 0;
  while (index < glob.length) {
    if (glob.startsWith('**/', index)) {
      pattern += '(?:[^/]+/)*';
      index += 3;
    } else if (glob.startsWith('/**', index) && index + 3 === glob.length) {
      pattern += '/.+';
      index += 3;
    } else if (glob[index] === '*') {
      pattern += '[^/]*';
      index += 1;
    } else {
      pattern += escapeRegExp(glob[index] ?? '');
      index += 1;
    }
  }
  return new RegExp(`^${pattern}$`);
}

const testPathPatterns = boundaryTestPathGlobs.map(compilePathGlob);
const developerProtectedPathPatterns = developerProtectedPathGlobs.map(compilePathGlob);

function isTestPath(path: string): boolean {
  return testPathPatterns.some((pattern) => pattern.test(path));
}

function isDeveloperProtectedPath(path: string): boolean {
  return developerProtectedPathPatterns.some((pattern) => pattern.test(path));
}

// ---------------------------------------------------------------------------
// Git

interface GitResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runGit(args: readonly string[]): GitResult {
  const result = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw new BoundaryRangeError(`git could not be started: ${result.error.message}`);
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function gitOrRangeError(args: readonly string[], what: string): string {
  const result = runGit(args);
  if (result.status !== 0) {
    const detail = result.stderr.trim().split(/\r?\n/)[0] ?? '';
    throw new BoundaryRangeError(`${what} failed${detail === '' ? '' : `: ${detail}`}`);
  }
  return result.stdout;
}

function resolveCommit(ref: string, option: string): string {
  if (ref.startsWith('-')) throw new BoundaryRangeError(`${option} ${ref} is not a ref`);
  const result = runGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  const sha = result.stdout.trim();
  if (result.status !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
    throw new BoundaryRangeError(`${option} ${ref} does not name a commit in this repository`);
  }
  return sha;
}

/** Reads and validates the range. Never returns an empty range for refs it cannot fully read. */
function readRangeCommits(input: BoundaryCheckInput): { baseSha: string; commits: RangeCommit[] } {
  const inside = runGit(['rev-parse', '--git-dir']);
  if (inside.status !== 0) throw new BoundaryRangeError(`${process.cwd()} is not inside a git repository`);

  const baseSha = resolveCommit(input.base, '--base');
  const headSha = resolveCommit(input.head, '--head');
  const range = `${input.base}..${input.head}`;

  const shallow = gitOrRangeError(['rev-parse', '--is-shallow-repository'], 'git rev-parse').trim();
  if (shallow === 'true') {
    throw new BoundaryRangeError(
      `the repository is a shallow clone, so ${range} may be incomplete; fetch full history`,
    );
  }
  if (runGit(['merge-base', baseSha, headSha]).status !== 0) {
    throw new BoundaryRangeError(`${input.base} and ${input.head} have no common ancestor`);
  }

  // `rev-list --parents` prints only hex object names, so no commit text can
  // change the list. Each commit's trailers are then read on their own.
  const list = gitOrRangeError(
    ['rev-list', '--reverse', '--parents', `${baseSha}..${headSha}`, '--'],
    `git rev-list ${range}`,
  );
  const commits = list
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line): RangeCommit => {
      const [sha = '', ...parents] = line.trim().split(' ');
      if (!isObjectName(sha) || !parents.every(isObjectName)) {
        throw new BoundaryRangeError(`git rev-list ${range} printed an unexpected line`);
      }
      return { sha, parents, ...readCommitTrailers(sha) };
    });
  return { baseSha, commits };
}

function isObjectName(text: string): boolean {
  return /^[0-9a-f]{40,64}$/.test(text);
}

/** The short SHA and trailers of one commit, read with one git call for that commit only. */
function readCommitTrailers(sha: string): { shortSha: string; trailers: CommitTrailer[] } {
  const text = gitOrRangeError(
    ['log', '-1', '--format=%h%n%(trailers:only,unfold)', sha, '--'],
    `git log ${sha.slice(0, 12)}`,
  );
  const [shortSha = '', ...trailerLines] = text.split(/\r?\n/);
  if (!/^[0-9a-f]{4,64}$/.test(shortSha) || !sha.startsWith(shortSha)) {
    throw new BoundaryRangeError(`git log ${sha.slice(0, 12)} printed an unexpected short SHA`);
  }
  return { shortSha, trailers: parseTrailers(trailerLines.join('\n')) };
}

function parseTrailers(text: string): CommitTrailer[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = /^([A-Za-z0-9][A-Za-z0-9-]*)\s*:\s*(.*)$/.exec(line);
    return match ? [{ key: (match[1] ?? '').toLowerCase(), value: (match[2] ?? '').trim() }] : [];
  });
}

function readBasePaths(baseSha: string): Set<string> {
  const text = gitOrRangeError(['ls-tree', '-r', '-z', '--name-only', baseSha], 'git ls-tree of the base commit');
  return new Set(text.split('\0').filter((path) => path !== ''));
}

/**
 * The paths a commit changes, against its first parent. A rename touches the
 * old and the new path (#14).
 */
function readCommitChanges(commit: RangeCommit): CommitPathChange[] {
  const firstParent = commit.parents[0];
  const args =
    firstParent === undefined
      ? ['diff-tree', '-r', '-z', '-M', '--name-status', '--no-commit-id', '--root', commit.sha]
      : ['diff-tree', '-r', '-z', '-M', '--name-status', '--no-commit-id', firstParent, commit.sha];
  const fields = gitOrRangeError(args, `git diff-tree ${commit.shortSha}`).split('\0');
  const changes: CommitPathChange[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index] ?? '';
    index += 1;
    if (status === '') continue;
    const kind = status[0];
    if (kind === 'R' || kind === 'C') {
      const from = fields[index] ?? '';
      const to = fields[index + 1] ?? '';
      index += 2;
      changes.push({ touched: [from, to], changedExisting: kind === 'R' ? from : undefined });
      continue;
    }
    const path = fields[index] ?? '';
    index += 1;
    changes.push({ touched: [path], changedExisting: kind === 'A' ? undefined : path });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Rules

/** A trailer value in the output, quoted so control bytes and spaces stay visible. */
function quoteValue(value: string): string {
  return JSON.stringify(value);
}

function trailerValues(commit: RangeCommit, key: string): string[] {
  return commit.trailers.filter((trailer) => trailer.key === key).map((trailer) => trailer.value);
}

function checkCommit(
  commit: RangeCommit,
  input: BoundaryCheckInput,
  basePaths: ReadonlySet<string>,
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const report = (rule: BoundaryRuleId, message: string): void => {
    violations.push({ shortSha: commit.shortSha, rule, message });
  };
  const agents = trailerValues(commit, 'agent');

  if (input.branch.startsWith(taskBranchPrefix)) {
    if (!trailerValues(commit, 'task').some((value) => value !== '')) {
      report(boundaryRule.missingTaskTrailer, `a commit on ${input.branch} must have a Task: #<issue> trailer`);
    }
    if (agents.length === 0) {
      report(boundaryRule.missingAgentTrailer, `a commit on ${input.branch} must have an Agent: <role> trailer`);
    }
  }

  // ADR 0009 item 1: exactly one Agent: trailer, from the closed list.
  if (agents.length > 1) {
    report(
      boundaryRule.invalidAgentTrailer,
      `a commit must have exactly one Agent: trailer; found ${agents.length}: ${agents.map(quoteValue).join(', ')}`,
    );
  }
  for (const agent of agents.filter((value) => !isBoundaryAgentRole(value))) {
    report(
      boundaryRule.invalidAgentTrailer,
      `Agent: ${quoteValue(agent)} is not a role; valid roles are ${boundaryAgentRoles.join(', ')}`,
    );
  }
  const role: BoundaryAgentRole | undefined =
    agents.length === 1 && isBoundaryAgentRole(agents[0] ?? '') ? (agents[0] as BoundaryAgentRole) : undefined;

  for (const agent of new Set(agents.filter((value) => value === 'reviewer' || value === 'verifier'))) {
    report(
      boundaryRule.reviewerOrVerifierCommit,
      `Agent: ${agent} commits are not allowed; the ${agent} never commits`,
    );
  }

  if (commit.trailers.some((trailer) => trailer.key === 'co-authored-by')) {
    report(boundaryRule.coAuthorTrailer, 'Co-Authored-By: trailers are not allowed (PLT-010)');
  }

  // ADR 0009 item 2: fail closed; a merge would attribute main's changes to this commit's agent.
  if (commit.parents.length > 1) {
    report(
      boundaryRule.mergeCommit,
      'merge commits are not allowed in the range; rebuild the task branch from main and cherry-pick the commits',
    );
    return violations;
  }

  const changes = readCommitChanges(commit);
  const touched = [...new Set(changes.flatMap((change) => change.touched))];

  if (role === 'developer') {
    for (const path of touched.filter(isDeveloperProtectedPath)) {
      report(
        boundaryRule.developerTouchesGateTest,
        `Agent: developer commit touches ${path}; only the test author changes gate tests, e2e/smoke/ and test-support/`,
      );
    }
  }

  if (role === 'test-author') {
    for (const path of touched.filter((entry) => !isTestPath(entry))) {
      report(
        boundaryRule.testAuthorTouchesSource,
        `Agent: test-author commit touches ${path}, which is not a test path; the test author never changes source`,
      );
    }
  }

  const approved = trailerValues(commit, 'test-change').some((value) => approvedTestChangeValue.test(value));
  if (!approved) {
    const changedTests = new Set(
      changes
        .map((change) => change.changedExisting)
        .filter((path): path is string => path !== undefined && isTestPath(path) && basePaths.has(path)),
    );
    for (const path of changedTests) {
      report(
        boundaryRule.testChangeNotApproved,
        `${path} exists on ${input.base} and is modified, deleted or renamed without a Test-Change: approved #<issue> trailer`,
      );
    }
  }

  return violations;
}

function runBoundaryCheck(input: BoundaryCheckInput): BoundaryViolation[] {
  const { baseSha, commits } = readRangeCommits(input);
  if (commits.length === 0) return [];
  const basePaths = readBasePaths(baseSha);
  return commits.flatMap((commit) => checkCommit(commit, input, basePaths));
}

// ---------------------------------------------------------------------------
// Command line

function readInput(argv: readonly string[]): BoundaryCheckInput {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args: [...argv],
      options: { base: { type: 'string' }, head: { type: 'string' }, branch: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    throw new BoundaryUsageError(error instanceof Error ? error.message : String(error));
  }
  const read = (name: 'base' | 'head' | 'branch'): string => {
    const value = values[name];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new BoundaryUsageError(`missing required option --${name}`);
    }
    return value.trim();
  };
  return { base: read('base'), head: read('head'), branch: read('branch') };
}

function formatViolation(violation: BoundaryViolation): string {
  return `${violation.shortSha}: ${violation.rule}: ${violation.message}`;
}

function main(argv: readonly string[]): number {
  let input: BoundaryCheckInput;
  try {
    input = readInput(argv);
  } catch (error) {
    if (!(error instanceof BoundaryUsageError)) throw error;
    process.stderr.write(`boundary-check: ${error.message}\n${usageText}\n`);
    return exitUsage;
  }
  try {
    const violations = runBoundaryCheck(input);
    if (violations.length === 0) return exitPass;
    process.stdout.write(`${violations.map(formatViolation).join('\n')}\n`);
    return exitViolations;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${boundaryRule.invalidRange}: ${input.base}..${input.head}: ${message}\n`);
    return exitViolations;
  }
}

process.exitCode = main(process.argv.slice(2));
