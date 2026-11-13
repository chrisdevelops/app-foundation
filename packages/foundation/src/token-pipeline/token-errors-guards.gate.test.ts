// Gate tests for #20: strict error format, sRGB gamut and the resolver `$ref`
// guard (TOK-047, TOK-133, TOK-135, TOK-155, TOK-176, TOK-177; token profile
// spec "Units", "Lint and CI rules" > "Token files: built-in Terrazzo rules",
// "Gate tests" Output line and Security rows 21 and 22; ADR 0004 decisions 6
// and 7; spike #7 results 6, 9 and 14 and "Gamut facts").
//
// Contract (input and output):
// - Input: a package with a resolver plus `*.tokens.json` files, built with
//   the package's own token build script, `pnpm run tokens:build`
//   (test-support/token-package-build.ts). Two package shapes: the foundation
//   (its package.json and terrazzo.config.ts unchanged) and an app that uses
//   the profile through the @foundation/config exports.
// - Output on success: exit 0, generated/tokens.css, and no error line.
// - Output on failure: a non-zero exit, no generated files, and each error as
//   exactly one line on stderr: `file#token.path: rule-id: message`
//   (test-support/token-error-lines.ts). `file` is relative to the package
//   root with `/`, as in the tokens.css source comments (TOK-117). Core
//   Terrazzo rules give no location (spike #7 result 14), so the wrapper adds
//   it; core rules run twice per build, and the wrapper prints each error once.
// - `core/max-gamut` runs with `gamut: "srgb"` (TOK-135); `core/valid-dimension`
//   allows only `px` and `rem` (TOK-047, TOK-133).
// - A resolver `$ref` to a remote URL is refused before any request (gate 21,
//   proved with a local server that counts connections); a resolver `$ref`
//   that escapes the repo root, or is absolute, is refused before the file is
//   read (gate 22, proved with a read trace preloaded into every Node process
//   of the build). Each probe has a control build (Terrazzo without the
//   profile) that shows the probe sees Terrazzo's request or read.
// - The guard fails closed (orchestrator decision after #20 review 1):
//   Terrazzo 2.10.0 reads token files as JSONC (comments allowed, the FIRST of
//   duplicate keys wins) and as YAML, so every file the guard visits (resolver,
//   `config.tokens` entries, every `$ref` target) must be strict JSON named
//   `*.json`, an object may hold only one `$ref`, and a `config.tokens` entry
//   that is remote or outside the repo root is refused. Each refusal is a
//   `ui/ref-guard` line in the strict shape that names the file at fault, and
//   comes before any request or read of the target. Each case has a control
//   build (Terrazzo without the profile) that makes the request or the read.
// - All builds run in scratch folders below packages/foundation/node_modules/.cache/;
//   no gate removes, moves or writes a tracked file.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { isOklchInsideSrgb } from './test-support/oklch-gamut';
import { startRecordingHttpServer, type RecordingHttpServer } from './test-support/recording-http-server';
import { fixtureSystemDir } from './test-support/token-build';
import { linesContaining, parseTokenErrorLines, type TokenErrorLine } from './test-support/token-error-lines';
import {
  absoluteRefOf,
  createAppShapedPackage,
  createFoundationShapedPackage,
  createFsReadTrace,
  createOutsideRepoDir,
  describePackageBuild,
  editPackageJson,
  editPackageText,
  isInsideRepo,
  relativeRefFrom,
  removeTokenPackageDirs,
  runTerrazzoWithoutProfile,
  runTerrazzoWithoutProfileOnTokens,
  runTokensBuildScript,
  setAppConfigTokens,
  writePackageFile,
  type TokenPackageBuildResult,
} from './test-support/token-package-build';

const buildTimeoutMs = 240_000;

// ---------- fixture tokens the cases edit (all in the default permutation, so core lint sees them)

const grayFile = 'tokens/ref/color.tokens.json';
const grayPath = 'ref.color.ui-ref-color-gray-50';
const spaceFile = 'tokens/ref/space.tokens.json';
const space4Path = 'ref.space.ui-ref-space-4';
const space6Path = 'ref.space.ui-ref-space-6';
const buttonFile = 'src/components/button/button.tokens.json';
const buttonPath = 'button.ui-button__color-bg-primary-default';
const foundationResolverFile = 'tokens/ui.resolver.json';
const appResolverFile = 'tokens/app.resolver.json';

/** Spike #7 "Gamut facts": outside sRGB, inside P3. */
const outsideSrgb = [0.6, 0.2, 255] as const;
/** Spike #7 "Gamut facts": inside sRGB. */
const insideSrgb = [0.55, 0.2, 260] as const;

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The token object at a dotted path in parsed JSON; throws a fixture error when it is missing. */
function tokenAt(json: unknown, dottedPath: string): JsonRecord {
  let node: unknown = json;
  for (const segment of dottedPath.split('.')) {
    if (!isRecord(node) || !(segment in node)) throw new Error(`fixture precondition: ${dottedPath} exists`);
    node = node[segment];
  }
  if (!isRecord(node) || !('$value' in node)) throw new Error(`fixture precondition: ${dottedPath} is a token`);
  return node;
}

function setOklch(packageDir: string, file: string, dottedPath: string, components: readonly number[]): void {
  editPackageJson(packageDir, file, (json) => {
    const token = tokenAt(json, dottedPath);
    token.$type = 'color';
    token.$value = { colorSpace: 'oklch', components: [...components] };
  });
}

function setDimensionUnit(packageDir: string, file: string, dottedPath: string, unit: string): void {
  editPackageJson(packageDir, file, (json) => {
    const token = tokenAt(json, dottedPath);
    if (token.$type !== 'dimension' || !isRecord(token.$value)) {
      throw new Error(`fixture precondition: ${dottedPath} is a literal dimension`);
    }
    token.$value = { value: token.$value.value, unit };
  });
}

/** Resolver `$ref` edits: append a source to a set, or replace a modifier context's sources. */
function addSetSource(packageDir: string, resolverFile: string, set: string, ref: string): void {
  editPackageJson(packageDir, resolverFile, (json) => {
    const sources = (json as { sets?: Record<string, { sources?: unknown[] }> }).sets?.[set]?.sources;
    if (!Array.isArray(sources)) throw new Error(`fixture precondition: the resolver has the set ${set}`);
    sources.push({ $ref: ref });
  });
}

function replaceContextSources(
  packageDir: string,
  resolverFile: string,
  modifier: string,
  context: string,
  ref: string,
): void {
  editPackageJson(packageDir, resolverFile, (json) => {
    const contexts = (json as { modifiers?: Record<string, { contexts?: Record<string, unknown[]> }> }).modifiers?.[
      modifier
    ]?.contexts;
    if (!contexts || !Array.isArray(contexts[context])) {
      throw new Error(`fixture precondition: the resolver has the context ${modifier}.${context}`);
    }
    contexts[context] = [{ $ref: ref }];
  });
}

// ---------- assertions on the build output

function allOutput(build: TokenPackageBuildResult): string {
  return `${build.run.stdout}\n${build.run.stderr}`;
}

/** Exit non-zero (not a timeout) and write no generated file. */
function expectFailedBuild(build: TokenPackageBuildResult): void {
  expect(build.run.exitCode, `the build must exit, not time out. ${describePackageBuild(build)}`).not.toBe(-1);
  expect(build.run.exitCode, `the build must exit non-zero. ${describePackageBuild(build)}`).not.toBe(0);
  expect(build.generatedFiles, `a failed build must write no generated file. ${describePackageBuild(build)}`).toEqual(
    [],
  );
}

/** Exit 0, write tokens.css, and print no error line (TOK-155). */
function expectCleanBuild(build: TokenPackageBuildResult): void {
  expect(build.run.exitCode, describePackageBuild(build)).toBe(0);
  expect(build.tokensCss, `the build must write generated/tokens.css. ${describePackageBuild(build)}`).toBeDefined();
  expect(
    parseTokenErrorLines(allOutput(build)).map((error) => error.line),
    `a clean build prints no line in the error shape. ${describePackageBuild(build)}`,
  ).toEqual([]);
  expect(
    linesContaining(allOutput(build), '✗'),
    `a clean build prints no Terrazzo error marker. ${describePackageBuild(build)}`,
  ).toEqual([]);
}

/**
 * The one error line for `ruleId` at `file#tokenPath`: every output line that
 * names the rule and the token is that single line, it is on stderr, not on
 * stdout, and it matches the strict shape exactly (TOK-155).
 */
function expectOneErrorLine(
  build: TokenPackageBuildResult,
  expected: { readonly file: string; readonly tokenPath: string; readonly ruleId: string },
): TokenErrorLine {
  const location = `${expected.file}#${expected.tokenPath}`;
  const where = `${location}: ${expected.ruleId}`;
  const leaf = expected.tokenPath.split('.').at(-1) ?? expected.tokenPath;
  // The leaf as a whole name: `ui-ref-space-4` must not match `ui-ref-space-40`.
  const leafPattern = new RegExp(`(^|[^a-z0-9_-])${leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9_-])`);
  const mentioning = linesContaining(allOutput(build), expected.ruleId).filter((line) => leafPattern.test(line));
  expect(
    mentioning,
    `exactly one output line names ${expected.ruleId} and the token (no duplicates, no second format). ${describePackageBuild(build)}`,
  ).toHaveLength(1);
  const [line = ''] = mentioning;
  expect(line.startsWith(`${where}: `), `the line must start with "${where}: ". Got: ${line}`).toBe(true);
  const [parsed] = parseTokenErrorLines(line);
  expect(parsed, `the line must match file#token.path: rule-id: message. Got: ${line}`).toBeDefined();
  expect(parsed?.message.trim().length ?? 0, 'the message must not be empty').toBeGreaterThan(0);
  expect(linesContaining(build.run.stderr, line), `the error line must be on stderr: ${line}`).toHaveLength(1);
  expect(linesContaining(build.run.stdout, line), `the error line must not be on stdout: ${line}`).toEqual([]);
  return parsed as TokenErrorLine;
}

/**
 * The guard's refusal of `ref` in `resolverFile`: one error line on stderr in
 * the strict shape, with the resolver file as its location, that quotes the
 * refused `$ref` (TOK-155, TOK-176, TOK-177).
 */
function expectRefRefused(build: TokenPackageBuildResult, resolverFile: string, ref: string): void {
  expectFailedBuild(build);
  const mentioning = linesContaining(allOutput(build), ref);
  expect(
    mentioning,
    `exactly one output line quotes the refused $ref ${ref} (no duplicates). ${describePackageBuild(build)}`,
  ).toHaveLength(1);
  const [line = ''] = mentioning;
  const [parsed] = parseTokenErrorLines(line);
  expect(parsed, `the refusal must match file#token.path: rule-id: message. Got: ${line}`).toBeDefined();
  expect(parsed?.file, `the refusal names the resolver file. Got: ${line}`).toBe(resolverFile);
  expect(linesContaining(build.run.stderr, line), `the refusal must be on stderr: ${line}`).toHaveLength(1);
}

afterAll(() => {
  removeTokenPackageDirs();
});

// ---------- TOK-155: error format, and a clean build

describe('token build errors: one line per error on stderr (TOK-155)', { timeout: buildTimeoutMs }, () => {
  // TOK-155: a clean build is the control for every failure below.
  it('TOK-155: a clean build of the fixture exits 0, writes tokens.css and prints no error line', () => {
    const packageDir = createFoundationShapedPackage(fixtureSystemDir);
    expectCleanBuild(runTokensBuildScript(packageDir));
  });

  // TOK-135, ADR 0004 decision 7, spike #7 result 6 and "Gamut facts"
  it('TOK-135: a primitive at oklch(0.6 0.2 255), outside sRGB, fails with one core/max-gamut line at its file and path', () => {
    expect(isOklchInsideSrgb(...outsideSrgb), 'test precondition: oklch(0.6 0.2 255) is outside sRGB').toBe(false);
    const packageDir = createFoundationShapedPackage(fixtureSystemDir);
    setOklch(packageDir, grayFile, grayPath, outsideSrgb);
    const build = runTokensBuildScript(packageDir);
    expectFailedBuild(build);
    expectOneErrorLine(build, { file: grayFile, tokenPath: grayPath, ruleId: 'core/max-gamut' });
  });

  // TOK-135
  it('TOK-135: a primitive at oklch(0.55 0.2 260), inside sRGB, builds with no error line', () => {
    expect(isOklchInsideSrgb(...insideSrgb), 'test precondition: oklch(0.55 0.2 260) is inside sRGB').toBe(true);
    const packageDir = createFoundationShapedPackage(fixtureSystemDir);
    setOklch(packageDir, grayFile, grayPath, insideSrgb);
    expectCleanBuild(runTokensBuildScript(packageDir));
  });

  // TOK-047, TOK-133, TOK-049
  it('TOK-133: a dimension in % fails with one core/valid-dimension line at its file and path', () => {
    const packageDir = createFoundationShapedPackage(fixtureSystemDir);
    setDimensionUnit(packageDir, spaceFile, space4Path, '%');
    const build = runTokensBuildScript(packageDir);
    expectFailedBuild(build);
    expectOneErrorLine(build, { file: spaceFile, tokenPath: space4Path, ruleId: 'core/valid-dimension' });
  });

  // TOK-047, TOK-133: Terrazzo allows em by default, so this proves the px/rem option
  it('TOK-133: a dimension in em fails with one core/valid-dimension line at its file and path', () => {
    const packageDir = createFoundationShapedPackage(fixtureSystemDir);
    setDimensionUnit(packageDir, spaceFile, space4Path, 'em');
    const build = runTokensBuildScript(packageDir);
    expectFailedBuild(build);
    expectOneErrorLine(build, { file: spaceFile, tokenPath: space4Path, ruleId: 'core/valid-dimension' });
  });

  // TOK-047, TOK-048: px and rem stay allowed
  it('TOK-047: dimensions in px and rem build with no error line', () => {
    const packageDir = createFoundationShapedPackage(fixtureSystemDir);
    setDimensionUnit(packageDir, spaceFile, space4Path, 'px');
    setDimensionUnit(packageDir, spaceFile, space6Path, 'rem');
    expectCleanBuild(runTokensBuildScript(packageDir));
  });

  // TOK-155, ADR 0004 decision 6, spike #7 result 14: core rules run twice
  // and give no location; component files sit outside tokens/ (spike #7 result 5).
  it('TOK-155: four errors in three files print exactly four lines, each once, each with its own file and path', () => {
    const packageDir = createFoundationShapedPackage(fixtureSystemDir);
    setOklch(packageDir, grayFile, grayPath, outsideSrgb);
    setDimensionUnit(packageDir, spaceFile, space4Path, '%');
    setDimensionUnit(packageDir, spaceFile, space6Path, 'em');
    setOklch(packageDir, buttonFile, buttonPath, outsideSrgb);
    const build = runTokensBuildScript(packageDir);
    expectFailedBuild(build);
    const expected = [
      { file: grayFile, tokenPath: grayPath, ruleId: 'core/max-gamut' },
      { file: spaceFile, tokenPath: space4Path, ruleId: 'core/valid-dimension' },
      { file: spaceFile, tokenPath: space6Path, ruleId: 'core/valid-dimension' },
      { file: buttonFile, tokenPath: buttonPath, ruleId: 'core/max-gamut' },
    ];
    for (const error of expected) expectOneErrorLine(build, error);
    const errorLines = parseTokenErrorLines(build.run.stderr).filter(
      (error) => error.ruleId === 'core/max-gamut' || error.ruleId === 'core/valid-dimension',
    );
    expect(
      errorLines.map((error) => `${error.file}#${error.tokenPath}: ${error.ruleId}`).sort(),
      `stderr holds exactly these four error lines. ${describePackageBuild(build)}`,
    ).toEqual(expected.map((error) => `${error.file}#${error.tokenPath}: ${error.ruleId}`).sort());
  });
});

// ---------- gate 21: remote $ref

/** A valid token file with names the fixture does not use, for `$ref` targets the gates add. */
const extraTokenFile = JSON.stringify({
  ref: {
    extra: {
      'ui-ref-color-extra-1': {
        $type: 'color',
        $value: { colorSpace: 'oklch', components: [0.5, 0.01, 250] },
        $description: 'Added by the #20 gates as a $ref target.',
      },
    },
  },
});

async function withServer(run: (server: RecordingHttpServer) => void): Promise<void> {
  const server = await startRecordingHttpServer(extraTokenFile);
  try {
    run(server);
  } finally {
    await server.close();
  }
}

describe('resolver $ref guard: remote URLs (gate 21, TOK-176)', { timeout: buildTimeoutMs }, () => {
  // Control: without the profile, Terrazzo requests the remote $ref (spike #7
  // result 9), and the server sees it. So zero connections below means refused.
  it('control: Terrazzo without the profile requests a remote $ref, and the local server records it', async () => {
    await withServer((server) => {
      const packageDir = createFoundationShapedPackage(fixtureSystemDir);
      addSetSource(packageDir, foundationResolverFile, 'ref', `${server.origin}/remote.tokens.json`);
      const run = runTerrazzoWithoutProfile(packageDir, foundationResolverFile);
      expect(server.requests(), `the control build must request the URL:\n${run.output.slice(-3000)}`).toBeGreaterThan(
        0,
      );
    });
  });

  // TOK-176 (gate 21)
  it('TOK-176: a remote $ref in a set is refused with one error line, and the server gets no connection', async () => {
    await withServer((server) => {
      const ref = `${server.origin}/set-source.tokens.json`;
      const packageDir = createFoundationShapedPackage(fixtureSystemDir);
      addSetSource(packageDir, foundationResolverFile, 'ref', ref);
      const build = runTokensBuildScript(packageDir);
      expect(server.connections(), `no connection may reach the server. ${describePackageBuild(build)}`).toBe(0);
      expectRefRefused(build, foundationResolverFile, ref);
    });
  });

  // TOK-176 (gate 21)
  it('TOK-176: a remote $ref in a theme context is refused with one error line, and the server gets no connection', async () => {
    await withServer((server) => {
      const ref = `${server.origin}/dark.tokens.json`;
      const packageDir = createFoundationShapedPackage(fixtureSystemDir);
      replaceContextSources(packageDir, foundationResolverFile, 'theme', 'dark', ref);
      const build = runTokensBuildScript(packageDir);
      expect(server.connections(), `no connection may reach the server. ${describePackageBuild(build)}`).toBe(0);
      expectRefRefused(build, foundationResolverFile, ref);
    });
  });
});

// ---------- gate 22: $ref outside the repo root, or absolute

/** A valid token file outside the checkout, as a `$ref` target. */
function createOutsideTokenFile(fileName = 'outside.tokens.json'): string {
  const outsideDir = createOutsideRepoDir();
  const target = join(outsideDir, fileName);
  writeFileSync(target, extraTokenFile);
  return target;
}

describe(
  'resolver $ref guard: outside the repo root or absolute (gate 22, TOK-177)',
  { timeout: buildTimeoutMs },
  () => {
    // Control: without the profile, Terrazzo reads a file outside the root
    // (spike #7 result 9), and the trace records the read. So an empty trace
    // below means the build did not read the file.
    it('control: Terrazzo without the profile reads a $ref outside the repo root, and the read trace records it', () => {
      const target = createOutsideTokenFile();
      const packageDir = createFoundationShapedPackage(fixtureSystemDir);
      addSetSource(packageDir, foundationResolverFile, 'ref', relativeRefFrom(join(packageDir, 'tokens'), target));
      const trace = createFsReadTrace([target]);
      const run = runTerrazzoWithoutProfile(packageDir, foundationResolverFile, trace.env);
      expect(
        trace.lines().length,
        `the control build must read ${target}:\n${run.output.slice(-3000)}`,
      ).toBeGreaterThan(0);
    });

    // TOK-177 (gate 22)
    it('TOK-177: a relative $ref that escapes the repo root is refused with one error line before the file is read', () => {
      const target = createOutsideTokenFile();
      const packageDir = createFoundationShapedPackage(fixtureSystemDir);
      const ref = relativeRefFrom(join(packageDir, 'tokens'), target);
      expect(ref.startsWith('../'), 'test precondition: the $ref is relative and goes up').toBe(true);
      addSetSource(packageDir, foundationResolverFile, 'ref', ref);
      const trace = createFsReadTrace([target]);
      const build = runTokensBuildScript(packageDir, trace.env);
      expect(trace.lines(), `the build must not read ${target}. ${describePackageBuild(build)}`).toEqual([]);
      expectRefRefused(build, foundationResolverFile, ref);
    });

    // TOK-177 (gate 22)
    it('TOK-177: an absolute $ref outside the repo root, in a theme context, is refused before the file is read', () => {
      const target = createOutsideTokenFile();
      const packageDir = createFoundationShapedPackage(fixtureSystemDir);
      const ref = absoluteRefOf(target);
      replaceContextSources(packageDir, foundationResolverFile, 'theme', 'dark', ref);
      const trace = createFsReadTrace([target]);
      const build = runTokensBuildScript(packageDir, trace.env);
      expect(trace.lines(), `the build must not read ${target}. ${describePackageBuild(build)}`).toEqual([]);
      expectRefRefused(build, foundationResolverFile, ref);
    });

    // TOK-177 (gate 22): absolute is refused even when the file is inside the repo
    it('TOK-177: an absolute $ref to a file inside the package is refused before the file is read', () => {
      const packageDir = createFoundationShapedPackage(fixtureSystemDir);
      const target = realpathSync(join(packageDir, 'tokens'));
      const insideFile = join(target, 'inside.tokens.json');
      writeFileSync(insideFile, extraTokenFile);
      expect(isInsideRepo(insideFile), 'test precondition: the scratch package is inside the checkout').toBe(true);
      const ref = absoluteRefOf(insideFile);
      addSetSource(packageDir, foundationResolverFile, 'ref', ref);
      const trace = createFsReadTrace([insideFile]);
      const build = runTokensBuildScript(packageDir, trace.env);
      expect(trace.lines(), `the build must not read ${insideFile}. ${describePackageBuild(build)}`).toEqual([]);
      expectRefRefused(build, foundationResolverFile, ref);
    });

    // TOK-177 (gate 22): a file: URL is an absolute reference too
    it('TOK-177: a file: URL $ref outside the repo root is refused before the file is read', () => {
      const target = createOutsideTokenFile();
      const packageDir = createFoundationShapedPackage(fixtureSystemDir);
      const ref = pathToFileURL(target).href;
      addSetSource(packageDir, foundationResolverFile, 'ref', ref);
      const trace = createFsReadTrace([target]);
      const build = runTokensBuildScript(packageDir, trace.env);
      expect(trace.lines(), `the build must not read ${target}. ${describePackageBuild(build)}`).toEqual([]);
      expectRefRefused(build, foundationResolverFile, ref);
    });
  },
);

// ---------- every build that uses the profile: an app package

describe('the guard and the wrapper apply to an app build that uses the profile', { timeout: buildTimeoutMs }, () => {
  // Control for the app cases, and the guard's allowed side: a relative $ref
  // outside the app package but inside the monorepo builds (spike #7 result 8).
  it('control: the app package builds clean, including a $ref to a file outside the app package inside the repo', () => {
    const { appDir } = createAppShapedPackage(fixtureSystemDir);
    const build = runTokensBuildScript(appDir);
    expectCleanBuild(build);
    expect(build.tokensCss, 'the app tokens.css declares a token from the shared colour file').toContain(
      '--ui-ref-color-gray-50:',
    );
  });

  // TOK-155 in an app
  it('TOK-155: an app dimension in % fails with one core/valid-dimension line at its file and path', () => {
    const { appDir } = createAppShapedPackage(fixtureSystemDir);
    setDimensionUnit(appDir, spaceFile, space4Path, '%');
    const build = runTokensBuildScript(appDir);
    expectFailedBuild(build);
    expectOneErrorLine(build, { file: spaceFile, tokenPath: space4Path, ruleId: 'core/valid-dimension' });
  });

  // TOK-176 in an app
  it('TOK-176: an app resolver $ref to a remote URL is refused, and the server gets no connection', async () => {
    await withServer((server) => {
      const ref = `${server.origin}/app.tokens.json`;
      const { appDir } = createAppShapedPackage(fixtureSystemDir);
      addSetSource(appDir, appResolverFile, 'ref', ref);
      const build = runTokensBuildScript(appDir);
      expect(server.connections(), `no connection may reach the server. ${describePackageBuild(build)}`).toBe(0);
      expectRefRefused(build, appResolverFile, ref);
    });
  });

  // TOK-177 in an app
  it('TOK-177: an app resolver $ref that escapes the repo root is refused before the file is read', () => {
    const target = createOutsideTokenFile();
    const { appDir } = createAppShapedPackage(fixtureSystemDir);
    const ref = relativeRefFrom(join(appDir, 'tokens'), target);
    addSetSource(appDir, appResolverFile, 'ref', ref);
    const trace = createFsReadTrace([target]);
    const build = runTokensBuildScript(appDir, trace.env);
    expect(trace.lines(), `the build must not read ${target}. ${describePackageBuild(build)}`).toEqual([]);
    expectRefRefused(build, appResolverFile, ref);
  });
});

// ---------- fail-closed guard: files Terrazzo reads that JSON.parse does not (#20 review 1, findings 1 and 2)
//
// Terrazzo 2.10.0 parses token files with Momoa as JSONC (comments allowed;
// of duplicate keys, the FIRST wins, where JSON.parse keeps the last) and
// parses as YAML any source that does not start with `{`, `"` or `[`. The
// orchestrator decision: the guard fails closed. Every file it visits must be
// strict JSON named `*.json`, an object holds at most one `$ref`, and a
// `config.tokens` entry that is remote or outside the repo root is refused.
// Finding 3 (an error printed without failing the build) cannot be reached in
// Terrazzo 2.10.0, so no gate covers it.

/** The resolver source that the raw-text cases insert after. */
const motionSourceText = '{ "$ref": "ref/motion.tokens.json" }';

/** Inserts raw `text` as the next source after the motion source of a resolver's `ref` set. */
function insertAfterMotionSource(packageDir: string, resolverFile: string, text: string): void {
  editPackageText(packageDir, resolverFile, (source) => {
    if (!source.includes(motionSourceText)) {
      throw new Error(`fixture precondition: ${resolverFile} holds ${motionSourceText}`);
    }
    return source.replace(motionSourceText, `${motionSourceText}, ${text}`);
  });
}

/**
 * The guard's fail-closed refusal: the build fails, and stderr holds a
 * `ui/ref-guard` line in the strict shape (TOK-155) that names `names` (the
 * file at fault, as the line's `file` field or in its message). When `file` is
 * given, that line's `file` field is exactly `file`. Each `ui/ref-guard` line
 * is printed once, and only on stderr.
 */
function expectGuardRefusal(
  build: TokenPackageBuildResult,
  expected: { readonly names: string; readonly file?: string },
): void {
  expectFailedBuild(build);
  const guardErrors = parseTokenErrorLines(build.run.stderr).filter((error) => error.ruleId === 'ui/ref-guard');
  const naming = guardErrors.filter(
    (error) => error.line.includes(expected.names) && (expected.file === undefined || error.file === expected.file),
  );
  expect(
    naming.map((error) => error.line),
    `stderr must hold a ui/ref-guard line in the shape file#token.path: rule-id: message that names ${expected.names}${
      expected.file === undefined ? '' : ` with the file ${expected.file}`
    }. ${describePackageBuild(build)}`,
  ).not.toEqual([]);
  for (const error of guardErrors) {
    expect(
      linesContaining(build.run.stderr, error.line),
      `each guard line is printed once: ${error.line}`,
    ).toHaveLength(1);
    expect(linesContaining(build.run.stdout, error.line), `a guard line is not on stdout: ${error.line}`).toEqual([]);
  }
}

/** The fixture's resolver as the `tokens` entry of a control config. */
const foundationControlTokens = [`./${foundationResolverFile}`] as const;

interface FailClosedArrangement {
  /** The package to build with `pnpm run tokens:build`. */
  readonly packageDir: string;
  /** The `tokens` field of the control config (Terrazzo without the profile) in `packageDir`. */
  readonly controlTokens: readonly string[];
  /** What the guard line must name: the file at fault. */
  readonly names: string;
  /** The guard line's exact `file` field, when the file at fault is a token file of the package. */
  readonly file?: string;
}

interface RemoteFailClosedCase {
  readonly title: string;
  arrange(origin: string): FailClosedArrangement;
}

const remoteFailClosedCases: readonly RemoteFailClosedCase[] = [
  {
    title: 'a resolver with a comment before a remote $ref',
    arrange(origin) {
      const packageDir = createFoundationShapedPackage(fixtureSystemDir);
      insertAfterMotionSource(
        packageDir,
        foundationResolverFile,
        `/* a comment before a remote $ref */ { "$ref": "${origin}/after-comment.tokens.json" }`,
      );
      return {
        packageDir,
        controlTokens: foundationControlTokens,
        names: foundationResolverFile,
        file: foundationResolverFile,
      };
    },
  },
  {
    title: 'an object with two $ref keys, the first remote and the second in the repo',
    arrange(origin) {
      const packageDir = createFoundationShapedPackage(fixtureSystemDir);
      insertAfterMotionSource(
        packageDir,
        foundationResolverFile,
        `{ "$ref": "${origin}/duplicate-key.tokens.json", "$ref": "ref/motion.tokens.json" }`,
      );
      // JSON.parse accepts the file and keeps the last (in-repo) $ref; Terrazzo takes the first.
      const resolverText = readFileSync(join(packageDir, ...foundationResolverFile.split('/')), 'utf8');
      expect((): unknown => JSON.parse(resolverText), 'test precondition: the resolver is valid JSON').not.toThrow();
      return {
        packageDir,
        controlTokens: foundationControlTokens,
        names: foundationResolverFile,
        file: foundationResolverFile,
      };
    },
  },
  {
    title: 'an in-repo .yaml token file named by the resolver, holding a remote $ref',
    arrange(origin) {
      const packageDir = createFoundationShapedPackage(fixtureSystemDir);
      writePackageFile(
        packageDir,
        'tokens/ref/remote-ref.tokens.yaml',
        `ref:\n  extra:\n    $ref: "${origin}/from-yaml.tokens.json#/ref/extra"\n`,
      );
      addSetSource(packageDir, foundationResolverFile, 'ref', 'ref/remote-ref.tokens.yaml');
      return { packageDir, controlTokens: foundationControlTokens, names: 'remote-ref.tokens.yaml' };
    },
  },
  {
    title: 'an app config.tokens entry that is a remote URL',
    arrange(origin) {
      const { appDir } = createAppShapedPackage(fixtureSystemDir);
      const entry = `${origin}/remote-entry.tokens.json`;
      setAppConfigTokens(appDir, [entry]);
      return { packageDir: appDir, controlTokens: [entry], names: 'remote-entry.tokens.json' };
    },
  },
];

describe(
  'fail-closed $ref guard: remote URLs Terrazzo would fetch (gate 21, TOK-176)',
  { timeout: buildTimeoutMs },
  () => {
    for (const failClosedCase of remoteFailClosedCases) {
      // Control: Terrazzo without the profile requests the URL, so the server
      // count below proves a refusal and not a fixture Terrazzo ignores.
      it(`control: Terrazzo without the profile requests the URL in ${failClosedCase.title}`, async () => {
        await withServer((server) => {
          const arranged = failClosedCase.arrange(server.origin);
          const run = runTerrazzoWithoutProfileOnTokens(arranged.packageDir, arranged.controlTokens);
          expect(
            server.requests(),
            `the control build must request the URL:\n${run.output.slice(-3000)}`,
          ).toBeGreaterThan(0);
        });
      });

      // TOK-176 (gate 21), fail-closed decision on #20 review 1 findings 1 and 2
      it(`TOK-176: ${failClosedCase.title} is refused with a ui/ref-guard line naming the file, and the server gets no connection`, async () => {
        await withServer((server) => {
          const arranged = failClosedCase.arrange(server.origin);
          const build = runTokensBuildScript(arranged.packageDir);
          expect(server.connections(), `no connection may reach the server. ${describePackageBuild(build)}`).toBe(0);
          expectGuardRefusal(build, arranged);
        });
      });
    }
  },
);

interface OutsideFailClosedCase {
  readonly title: string;
  arrange(): FailClosedArrangement & { readonly target: string };
}

/** Writes a token file that holds a `$ref` from `fileInPackage` to the `ref.extra` group of `target`. */
function refToOutsideGroup(packageDir: string, fileInPackage: string, target: string): string {
  const fromDir = join(packageDir, ...fileInPackage.split('/').slice(0, -1));
  const ref = `${relativeRefFrom(fromDir, target)}#/ref/extra`;
  expect(ref.startsWith('../'), 'test precondition: the $ref is relative and goes up').toBe(true);
  return ref;
}

const outsideFailClosedCases: readonly OutsideFailClosedCase[] = [
  {
    title: 'a token file with a comment, named by the resolver, holding a $ref outside the repo root',
    arrange() {
      const target = createOutsideTokenFile('outside-target.tokens.json');
      const packageDir = createFoundationShapedPackage(fixtureSystemDir);
      const file = 'tokens/ref/commented.tokens.json';
      const ref = refToOutsideGroup(packageDir, file, target);
      writePackageFile(
        packageDir,
        file,
        `{\n  /* a comment: JSONC, not JSON */\n  "ref": { "outside": { "$ref": ${JSON.stringify(ref)} } }\n}\n`,
      );
      addSetSource(packageDir, foundationResolverFile, 'ref', 'ref/commented.tokens.json');
      return { packageDir, target, controlTokens: foundationControlTokens, names: 'commented.tokens.json' };
    },
  },
  {
    title: 'an in-repo .yaml token file named by the resolver, holding a $ref outside the repo root',
    arrange() {
      const target = createOutsideTokenFile('outside-target.tokens.json');
      const packageDir = createFoundationShapedPackage(fixtureSystemDir);
      const file = 'tokens/ref/outside-ref.tokens.yaml';
      const ref = refToOutsideGroup(packageDir, file, target);
      writePackageFile(packageDir, file, `ref:\n  outside:\n    $ref: ${JSON.stringify(ref)}\n`);
      addSetSource(packageDir, foundationResolverFile, 'ref', 'ref/outside-ref.tokens.yaml');
      return { packageDir, target, controlTokens: foundationControlTokens, names: 'outside-ref.tokens.yaml' };
    },
  },
  {
    title: 'an app config.tokens entry outside the repo root',
    arrange() {
      const target = createOutsideTokenFile('outside-entry.tokens.json');
      const { appDir } = createAppShapedPackage(fixtureSystemDir);
      // Terrazzo resolves a config.tokens entry against the build's working folder, the app package.
      const entry = relativeRefFrom(appDir, target);
      expect(entry.startsWith('../'), 'test precondition: the entry is relative and goes up').toBe(true);
      setAppConfigTokens(appDir, [entry]);
      return { packageDir: appDir, target, controlTokens: [entry], names: 'outside-entry.tokens.json' };
    },
  },
];

describe(
  'fail-closed $ref guard: files outside the repo root Terrazzo would read (gate 22, TOK-177)',
  { timeout: buildTimeoutMs },
  () => {
    for (const failClosedCase of outsideFailClosedCases) {
      // Control: Terrazzo without the profile reads the target, so an empty
      // trace below proves a refusal and not a fixture Terrazzo ignores.
      it(`control: Terrazzo without the profile reads the target of ${failClosedCase.title}`, () => {
        const arranged = failClosedCase.arrange();
        const trace = createFsReadTrace([arranged.target]);
        const run = runTerrazzoWithoutProfileOnTokens(arranged.packageDir, arranged.controlTokens, trace.env);
        expect(
          trace.lines().length,
          `the control build must read ${arranged.target}:\n${run.output.slice(-3000)}`,
        ).toBeGreaterThan(0);
      });

      // TOK-177 (gate 22), fail-closed decision on #20 review 1 findings 1 and 2
      it(`TOK-177: ${failClosedCase.title} is refused with a ui/ref-guard line naming the file, before the target is read`, () => {
        const arranged = failClosedCase.arrange();
        const trace = createFsReadTrace([arranged.target]);
        const build = runTokensBuildScript(arranged.packageDir, trace.env);
        expect(trace.lines(), `the build must not read ${arranged.target}. ${describePackageBuild(build)}`).toEqual([]);
        expectGuardRefusal(build, arranged);
      });
    }
  },
);
