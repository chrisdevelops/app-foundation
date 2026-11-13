// Failure modes of the token profile plugin that the foundation gates
// (packages/foundation/src/token-pipeline/) do not reach through `tz build`:
// a config without a resolver, a resolver the profile does not accept, and
// CSS transforms that plugin-css did not produce with
// `tokenProfileCssPluginOptions`. The plugin is driven through its Terrazzo
// hooks (`config`, then `build`), which are its only inputs.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, test } from 'vitest';
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
  (plugin.config as ConfigHook)({ tokens } as unknown as Parameters<ConfigHook>[0], { logger } as never);
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
  test.todo('a colour outside sRGB fails the token lint before the build (TOK-135)');
  test.todo('the build refuses remote and out-of-root $ref sources before any load (TOK-176, TOK-177)');
});
