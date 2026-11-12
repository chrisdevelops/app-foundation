// Gate tests for #12, failure mode: a workspace package.json with a version
// range makes the exact-version gate fail and names the file and package.
// ADR 0004 decision 10 (pinned exactly); PLT-003.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertExactDependencyVersions } from './support/exact-dependency-versions';

let fixtureDir: string | undefined;

afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

function writeFixtureFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A two-package pnpm workspace; `leafDependencies` go into packages/leaf/package.json. */
function createWorkspaceFixture(leafDependencies: Record<string, Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'repo-gate-exact-'));
  writeFixtureFile(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'packages/*'\n");
  writeFixtureFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true, devDependencies: { typescript: '5.9.3' } }),
  );
  writeFixtureFile(
    join(dir, 'packages', 'leaf', 'package.json'),
    JSON.stringify({ name: '@fixture/leaf', version: '0.0.0', private: true, ...leafDependencies }),
  );
  writeFixtureFile(
    join(dir, 'apps', 'demo', 'package.json'),
    JSON.stringify({
      name: '@fixture/demo',
      version: '0.0.0',
      private: true,
      dependencies: { '@fixture/leaf': 'workspace:*', 'left-pad': 'npm:left-pad@1.3.0' },
    }),
  );
  fixtureDir = dir;
  return dir;
}

describe('exact dependency version gate', () => {
  // Positive control: exact versions, workspace:* and exact npm: aliases pass.
  it('ADR-0004-10: passes when every dependency is an exact version', () => {
    const dir = createWorkspaceFixture({
      dependencies: { zod: '4.1.12' },
      devDependencies: { vitest: '5.1.0', 'some-tool': '1.0.0-beta.3' },
      optionalDependencies: { fsevents: '2.3.3' },
    });
    expect(() => assertExactDependencyVersions(dir)).not.toThrow();
  });

  it.each([
    ['caret range', '^4.1.12'],
    ['tilde range', '~4.1.12'],
    ['star', '*'],
    ['latest tag', 'latest'],
    ['partial version', '4.1'],
    ['comparator range', '>=4.0.0'],
    ['x range', '4.x'],
  ])('ADR-0004-10: fails on a %s and names the file and package', (_label, spec) => {
    const dir = createWorkspaceFixture({ dependencies: { zod: spec } });
    let message = '';
    try {
      assertExactDependencyVersions(dir);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message, `"${spec}" must be rejected`).not.toBe('');
    expect(message).toContain('packages/leaf/package.json');
    expect(message).toContain('"zod"');
    expect(message).toContain(spec);
  });

  it('ADR-0004-10: checks devDependencies and optionalDependencies and the root package.json too', () => {
    const dir = createWorkspaceFixture({
      devDependencies: { vitest: '^5.1.0' },
      optionalDependencies: { fsevents: '~2.3.3' },
    });
    writeFixtureFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'fixture-root', private: true, devDependencies: { turbo: 'latest' } }),
    );
    let message = '';
    try {
      assertExactDependencyVersions(dir);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/packages\/leaf\/package\.json: devDependencies "vitest"/);
    expect(message).toMatch(/packages\/leaf\/package\.json: optionalDependencies "fsevents"/);
    expect(message).toMatch(/(^|\n)package\.json: devDependencies "turbo"/);
  });
});
