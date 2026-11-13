// Failure modes of the token profile plugin that the foundation gates
// (packages/foundation/src/token-pipeline/) do not reach through `tz build`:
// a config without a resolver, a resolver the profile does not accept, and
// CSS transforms that plugin-css did not produce with
// `tokenProfileCssPluginOptions`. The plugin is driven through its Terrazzo
// hooks (`config`, then `build`), which are its only inputs.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, test, vi, type MockInstance } from 'vitest';
import { generatedTokensCssHeader, tokenProfilePlugin } from './token-profile-plugin';

type Plugin = ReturnType<typeof tokenProfilePlugin>;
type ConfigHook = NonNullable<Plugin['config']>;
type BuildHook = NonNullable<Plugin['build']>;

interface FakeTransform {
  readonly id: string;
  readonly localID: string;
  readonly value: string | Record<string, string>;
}

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A package folder with the given files (path → JSON). */
function writePackage(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'token-profile-plugin-'));
  createdDirs.push(dir);
  for (const [file, json] of Object.entries(files)) {
    const path = join(dir, ...file.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(json));
  }
  return dir;
}

const token = (value: unknown) => ({ $type: 'color', $value: value, $description: 'Test token.' });

/** The smallest resolver the profile accepts: one set and the theme and density modifiers. */
function validPackage(): string {
  return writePackage({
    'tokens/ui.resolver.json': {
      version: '2025.10',
      sets: { ref: { sources: [{ $ref: 'ref/color.tokens.json' }] } },
      modifiers: {
        theme: { contexts: { light: [{ $ref: 'theme/light.tokens.json' }] }, default: 'light' },
        density: { contexts: { compact: [{ $ref: 'density/compact.tokens.json' }] }, default: 'compact' },
      },
      resolutionOrder: [{ $ref: '#/sets/ref' }, { $ref: '#/modifiers/theme' }, { $ref: '#/modifiers/density' }],
    },
    'tokens/ref/color.tokens.json': { ref: { color: { 'ui-ref-color-gray-50': token('#fafafa') } } },
    'tokens/theme/light.tokens.json': { color: { 'ui-color-bg-default': token('{ref.color.ui-ref-color-gray-50}') } },
    'tokens/density/compact.tokens.json': {},
  });
}

const validTransforms: readonly FakeTransform[] = [
  { id: 'ref.color.ui-ref-color-gray-50', localID: '--ui-ref-color-gray-50', value: 'oklch(98% 0 0)' },
  { id: 'color.ui-color-bg-default', localID: '--ui-color-bg-default', value: 'var(--ui-ref-color-gray-50)' },
];

interface BuildRun {
  readonly outputs: Map<string, string>;
  readonly errors: string[];
  readonly thrown: unknown;
}

function runPlugin(options: {
  readonly packageDir: string;
  readonly tokens?: readonly string[];
  readonly transforms: readonly FakeTransform[];
}): BuildRun {
  const plugin = tokenProfilePlugin({ packageRoot: pathToFileURL(`${options.packageDir}/`) });
  const tokens = (options.tokens ?? ['tokens/ui.resolver.json']).map((file) =>
    pathToFileURL(join(options.packageDir, file)),
  );
  const outputs = new Map<string, string>();
  const errors: string[] = [];
  const logger = { error: (...entries: { message: string }[]) => errors.push(...entries.map((e) => e.message)) };
  (plugin.config as ConfigHook)(
    { tokens, lint: { rules: {} }, plugins: [] } as unknown as Parameters<ConfigHook>[0],
    {
      logger,
    } as never,
  );
  let thrown: unknown;
  try {
    void (plugin.build as BuildHook)({
      context: { logger },
      getTransforms: () =>
        options.transforms.map((t) => ({ id: t.id, localID: t.localID, value: t.value, token: { id: t.id } })),
      outputFile: (name: string, contents: string | Buffer) => outputs.set(name, contents.toString()),
    } as unknown as Parameters<BuildHook>[0]);
  } catch (error) {
    thrown = error;
  }
  return { outputs, errors, thrown };
}

describe('token profile plugin', () => {
  // Positive control for the failure modes below.
  it('TOK-112: writes tokens.css from the transforms, with the header and a source comment per declaration', () => {
    const run = runPlugin({ packageDir: validPackage(), transforms: validTransforms });
    expect(run.thrown).toBeUndefined();
    const css = run.outputs.get('tokens.css') ?? '';
    expect(css.split('\n')[0]).toBe(generatedTokensCssHeader);
    expect(css).toContain(
      '--ui-color-bg-default: var(--ui-ref-color-gray-50); /* tokens/theme/light.tokens.json#color.ui-color-bg-default */',
    );
  });

  it.each([
    {
      label: 'config.tokens names no resolver',
      tokens: ['tokens/ref/color.tokens.json'],
      transforms: validTransforms,
      message: '*.resolver.json',
    },
    {
      label: 'plugin-css produced no value for a token',
      transforms: validTransforms.slice(0, 1),
      message: 'color.ui-color-bg-default has no CSS value',
    },
    {
      label: 'plugin-css ran without the profile variableName',
      transforms: [validTransforms[0], { ...validTransforms[1], localID: '--color-ui-color-bg-default' }],
      message: 'expected --ui-color-bg-default',
    },
    {
      label: 'a token has one value per gamut',
      transforms: [validTransforms[0], { ...validTransforms[1], value: { '.': 'a', srgb: 'b' } }],
      message: 'color.ui-color-bg-default has a CSS value per gamut',
    },
  ] as const)('fails and writes nothing when $label', (testCase) => {
    const run = runPlugin({
      packageDir: validPackage(),
      tokens: 'tokens' in testCase ? testCase.tokens : undefined,
      transforms: testCase.transforms as readonly FakeTransform[],
    });
    expect(run.thrown).toBeInstanceOf(Error);
    expect(run.errors.join('\n')).toContain(testCase.message);
    expect([...run.outputs.keys()]).toEqual([]);
  });

  it('fails and writes nothing when the resolver uses an inline source instead of a $ref', () => {
    const packageDir = writePackage({
      'tokens/ui.resolver.json': {
        version: '2025.10',
        sets: { ref: { sources: [{ ref: { color: {} } }] } },
        resolutionOrder: [{ $ref: '#/sets/ref' }],
      },
    });
    const run = runPlugin({ packageDir, transforms: validTransforms });
    expect(run.thrown).toBeInstanceOf(Error);
    expect(run.errors.join('\n')).toContain('sets.ref.sources[0] must be a { "$ref" }');
    expect([...run.outputs.keys()]).toEqual([]);
  });

  test.todo('tokens.css applies high contrast through [data-contrast="more"] on the root as well (TOK-068)');
  test.todo(
    'tz build writes generated/token-names.ts with UiTokenName and uiTokenVar (TOK-092, TOK-113, TOK-119, TOK-160)',
  );
  test.todo('tz build writes generated/TOKENS.md for every token (TOK-114, TOK-120 to TOK-127)');
  test.todo(
    'the other built-in lint rules run with the profile settings (TOK-129, TOK-130, TOK-131, TOK-132, TOK-134, TOK-136, TOK-137)',
  );
});

// `$ref` forms the #20 gates (packages/foundation/src/token-pipeline/token-errors-guards.gate.test.ts)
// do not build: the guard runs in the plugin's `config` hook, before Terrazzo loads any `$ref`.
describe('token profile plugin: $ref guard (TOK-176, TOK-177)', () => {
  let stderr: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
  });

  /** A repo folder (with pnpm-workspace.yaml) holding a package with a resolver whose `ref` set adds `ref`. */
  function packageWithRef(ref: string): { readonly repoDir: string; readonly packageDir: string } {
    const repoDir = writePackage({ 'shared/extra.tokens.json': {} });
    writeFileSync(join(repoDir, 'pnpm-workspace.yaml'), "packages:\n  - 'pkg'\n");
    const packageDir = join(repoDir, 'pkg');
    const files: Record<string, unknown> = {
      'tokens/ui.resolver.json': {
        version: '2025.10',
        sets: { ref: { sources: [{ $ref: 'ref/color.tokens.json' }, { $ref: ref }] } },
        resolutionOrder: [{ $ref: '#/sets/ref' }],
      },
      'tokens/ref/color.tokens.json': {},
    };
    for (const [file, json] of Object.entries(files)) {
      const path = join(packageDir, ...file.split('/'));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(json));
    }
    return { repoDir, packageDir };
  }

  function runConfigHook(
    packageDir: string,
    tokens: readonly URL[] = [pathToFileURL(join(packageDir, 'tokens', 'ui.resolver.json'))],
  ): { readonly thrown: unknown; readonly lines: string[] } {
    const plugin = tokenProfilePlugin({ packageRoot: pathToFileURL(`${packageDir}/`) });
    const config = {
      tokens,
      lint: { rules: {} },
      plugins: [],
    };
    let thrown: unknown;
    try {
      (plugin.config as ConfigHook)(
        config as unknown as Parameters<ConfigHook>[0],
        { logger: { error: () => undefined } } as never,
      );
    } catch (error) {
      thrown = error;
    }
    const lines = stderr.mock.calls.flatMap(([chunk]) => String(chunk).split('\n')).filter((line) => line !== '');
    return { thrown, lines };
  }

  it('allows a relative $ref outside the package that stays inside the repo root', () => {
    const { packageDir } = packageWithRef('../../shared/extra.tokens.json');
    const run = runConfigHook(packageDir);
    expect(run.thrown).toBeUndefined();
    expect(run.lines).toEqual([]);
  });

  it.each([
    { label: 'a protocol-relative URL', ref: '//example.com/remote.tokens.json', reason: 'remote URL' },
    { label: 'an https URL with a fragment', ref: 'https://example.com/a.json#/ref', reason: 'remote URL' },
    { label: 'a Windows drive path', ref: 'C:/tokens/outside.tokens.json', reason: 'absolute path' },
    { label: 'a backslash root path', ref: '\\tokens\\outside.tokens.json', reason: 'absolute path' },
    {
      label: 'a percent-encoded escape',
      ref: '%2e%2e/%2e%2e/%2e%2e/outside.tokens.json',
      reason: 'leaves the repo root',
    },
    { label: 'a backslash escape', ref: '..\\..\\..\\outside.tokens.json', reason: 'leaves the repo root' },
  ])('refuses $label with one error line at the resolver entry', ({ ref, reason }) => {
    const { packageDir } = packageWithRef(ref);
    const run = runConfigHook(packageDir);
    expect(run.thrown).toBeInstanceOf(Error);
    expect(run.lines).toEqual([
      expect.stringMatching(
        new RegExp(`^tokens/ui\\.resolver\\.json#sets\\.ref\\.sources\\.1\\.\\$ref: ui/ref-guard: .*${reason}`),
      ),
    ]);
    expect(run.lines[0]).toContain(`"${ref}"`);
  });

  it('refuses a relative $ref through a symlink that points outside the repo root', () => {
    const outsideDir = writePackage({ 'outside.tokens.json': {} });
    const { packageDir } = packageWithRef('ref/linked/outside.tokens.json');
    try {
      symlinkSync(outsideDir, join(packageDir, 'tokens', 'ref', 'linked'), 'junction');
    } catch {
      // Symlinks need a privilege on some Windows hosts; the other cases still run.
      return;
    }
    const run = runConfigHook(packageDir);
    expect(run.thrown).toBeInstanceOf(Error);
    expect(run.lines).toHaveLength(1);
    expect(run.lines[0]).toContain('leaves the repo root');
  });

  // Positive control for the fail-closed cases below (#20 review 1): plain JSON still builds.
  it('allows a strict JSON token file that holds an in-repo $ref to another *.json file', () => {
    const { packageDir } = packageWithRef('ref/nested.tokens.json');
    writeFileSync(
      join(packageDir, 'tokens', 'ref', 'nested.tokens.json'),
      JSON.stringify({ ref: { extra: { $ref: '../../../shared/extra.tokens.json#/ref' } } }, null, 2),
    );
    const run = runConfigHook(packageDir);
    expect(run.thrown).toBeUndefined();
    expect(run.lines).toEqual([]);
  });

  it('does not report a missing $ref target: Terrazzo reports it', () => {
    const { packageDir } = packageWithRef('ref/missing.tokens.json');
    const run = runConfigHook(packageDir);
    expect(run.thrown).toBeUndefined();
    expect(run.lines).toEqual([]);
  });

  /** Replaces the resolver of `packageWithRef` with raw text. */
  const writeResolverText = (packageDir: string, text: string): void =>
    writeFileSync(join(packageDir, 'tokens', 'ui.resolver.json'), text);

  it.each([
    {
      label: 'a $ref key written with an escape next to an in-repo $ref',
      text: '{ "version": "2025.10", "sets": { "ref": { "sources": [{ "\\u0024ref": "https://example.com/a.json", "$ref": "ref/color.tokens.json" }] } } }',
      expected: [
        'tokens/ui.resolver.json#sets.ref.sources.0.$ref: ui/ref-guard: an object holds more than one "$ref" member',
        'tokens/ui.resolver.json#sets.ref.sources.0.$ref: ui/ref-guard: $ref "https://example.com/a.json" is a remote URL',
      ],
    },
    {
      label: 'a duplicate "sets" key whose first value (dropped by JSON.parse) holds a remote $ref',
      text: '{ "version": "2025.10", "sets": { "ref": { "sources": [{ "$ref": "https://example.com/a.json" }] } }, "sets": { "ref": { "sources": [{ "$ref": "ref/color.tokens.json" }] } } }',
      expected: [
        'tokens/ui.resolver.json#sets.ref.sources.0.$ref: ui/ref-guard: $ref "https://example.com/a.json" is a remote URL',
      ],
    },
    {
      label: 'a top level that is not an object (Terrazzo reads a bare value as YAML)',
      text: '"ref/color.tokens.json"',
      expected: ['tokens/ui.resolver.json#$: ui/ref-guard: tokens/ui.resolver.json is not strict JSON'],
    },
    {
      label: 'a trailing comma (JSONC, not JSON)',
      text: '{ "version": "2025.10", }',
      expected: ['tokens/ui.resolver.json#$: ui/ref-guard: tokens/ui.resolver.json is not strict JSON'],
    },
  ])('refuses a resolver with $label', ({ text, expected }) => {
    const { packageDir } = packageWithRef('ref/color.tokens.json');
    writeResolverText(packageDir, text);
    const run = runConfigHook(packageDir);
    expect(run.thrown).toBeInstanceOf(Error);
    expect(run.lines).toHaveLength(expected.length);
    for (const [index, start] of expected.entries()) expect(run.lines[index]).toContain(start);
  });

  it('refuses a $ref to an in-repo file that is not *.json, without reading it', () => {
    const { packageDir } = packageWithRef('ref/extra.tokens.yaml');
    const run = runConfigHook(packageDir);
    expect(run.thrown).toBeInstanceOf(Error);
    expect(run.lines).toEqual([
      expect.stringMatching(
        /^tokens\/ui\.resolver\.json#sets\.ref\.sources\.1\.\$ref: ui\/ref-guard: \$ref "ref\/extra\.tokens\.yaml" names a file that is not \*\.json/,
      ),
    ]);
  });

  it.each([
    { label: 'a remote URL', entry: () => new URL('https://example.com/ui.resolver.json'), reason: 'not a local file' },
    {
      label: 'a file outside the repo root',
      entry: () => pathToFileURL(join(writePackage({ 'ui.resolver.json': {} }), 'ui.resolver.json')),
      reason: 'outside the repo root',
    },
    {
      label: 'an in-repo file that is not *.json',
      entry: (packageDir: string) => pathToFileURL(join(packageDir, 'tokens', 'ui.resolver.yaml')),
      reason: 'is not \\*\\.json',
    },
  ])('refuses a config.tokens entry that is $label', ({ entry, reason }) => {
    const { packageDir } = packageWithRef('ref/color.tokens.json');
    const run = runConfigHook(packageDir, [entry(packageDir)]);
    expect(run.thrown).toBeInstanceOf(Error);
    expect(run.lines).toEqual([
      expect.stringMatching(new RegExp(`^terrazzo\\.config\\.ts#tokens\\.0: ui/ref-guard: .*${reason}`)),
    ]);
  });

  it('refuses a remote $ref inside a token file that the resolver names', () => {
    const { packageDir } = packageWithRef('ref/nested.tokens.json');
    writeFileSync(
      join(packageDir, 'tokens', 'ref', 'nested.tokens.json'),
      JSON.stringify({ ref: { extra: { $ref: 'https://example.com/extra.json' } } }),
    );
    const run = runConfigHook(packageDir);
    expect(run.thrown).toBeInstanceOf(Error);
    expect(run.lines).toEqual([
      'tokens/ref/nested.tokens.json#ref.extra.$ref: ui/ref-guard: $ref "https://example.com/extra.json" is a remote URL; only relative paths inside the repo are allowed (TOK-176)',
    ]);
  });
});

// #20 review 1, finding 3: a lint error that the profile prints in the strict
// shape must fail the build, also when Terrazzo asks to go on (`continueOnError`).
describe('token profile plugin: a printed lint error fails the build (TOK-155)', () => {
  let stderr: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
  });

  /** Runs the config hook with a lint plugin, lints one token of `validPackage` and logs one rule error at it. */
  function logLintError(logger: { errorCount?: number; error: (...entries: unknown[]) => void }): unknown {
    const packageDir = validPackage();
    const plugin = tokenProfilePlugin({ packageRoot: pathToFileURL(`${packageDir}/`) });
    const tokenNode = { type: 'Object' };
    const lintPlugin = {
      name: 'fake-lint',
      lint: () => ({ 'core/max-gamut': { meta: {}, create: () => ({}) } }),
    } as unknown as Plugin;
    (plugin.config as ConfigHook)(
      {
        tokens: [pathToFileURL(join(packageDir, 'tokens', 'ui.resolver.json'))],
        lint: { rules: {} },
        plugins: [lintPlugin],
      } as unknown as Parameters<ConfigHook>[0],
      { logger } as never,
    );
    const rules = (lintPlugin.lint as () => Record<string, { create: (context: unknown) => unknown }>)();
    rules['core/max-gamut']?.create({
      tokens: { 'color.ui-color-bg-default': { id: 'color.ui-color-bg-default', source: { node: tokenNode } } },
    });
    try {
      logger.error({
        group: 'lint',
        label: 'core/max-gamut',
        node: tokenNode,
        message: 'out of sRGB',
        continueOnError: true,
      });
    } catch (error) {
      return error;
    }
    return undefined;
  }

  const printedLines = (): string[] =>
    stderr.mock.calls.flatMap(([chunk]) => String(chunk).split('\n')).filter((line) => line !== '');

  it('counts the error in the logger when Terrazzo asks to go on', () => {
    const logger = { errorCount: 0, error: () => undefined };
    expect(logLintError(logger)).toBeUndefined();
    expect(logger.errorCount).toBe(1);
    expect(printedLines()).toEqual([
      'tokens/theme/light.tokens.json#color.ui-color-bg-default: core/max-gamut: out of sRGB',
    ]);
  });

  it('throws when the logger has no error count', () => {
    const logger = { error: () => undefined };
    expect(logLintError(logger)).toBeInstanceOf(Error);
    expect(printedLines()).toHaveLength(1);
  });
});
