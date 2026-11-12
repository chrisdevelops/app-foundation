// Gate tests for #18: the packaged CDP variable has one name and one
// definition site (TST-009; ADR 0004 decision 2 B; CLAUDE.md "one name, one
// definition site").
// Contract: the string FOUNDATION_ALLOW_PACKAGED_CDP appears as a string
// literal in exactly one source file of the apps, the foundation package and
// the e2e harness, and that file is in packages/foundation/src/ (the
// foundation's main-process security system). The reference app and any other
// code that needs the name import it from there. Test files and test-support
// folders keep their own copy of the expected name (the gate contract,
// tools/test-support/packaged-cdp-variable.ts). The CI side (set only in the
// packaged smoke step) is gated in packaged-smoke-ci.gate.test.ts; what the
// packaged app does with it is gated in
// tools/reference-app/reference-app-build.gate.test.ts.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packagedCdpVariableName } from '../test-support/packaged-cdp-variable';
import { repoGateRootDir } from '../test-support/run-repo-command';

const root = repoGateRootDir;
const sourceRoots = ['apps', 'packages', 'e2e'] as const;
const skippedDirNames = new Set(['node_modules', 'out', 'dist', '.vite', '.turbo', 'test-support']);
const sourceFile = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
const testFile = /\.test\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;

/** Non-test source files under `dir`, as paths relative to the repository root with `/` separators. */
function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skippedDirNames.has(entry.name)) continue;
      const fromRoot = relative(root, path).split('\\').join('/');
      if (fromRoot === 'e2e/smoke') continue;
      files.push(...listSourceFiles(path));
    } else if (entry.isFile() && sourceFile.test(entry.name) && !testFile.test(entry.name)) {
      files.push(relative(root, path).split('\\').join('/'));
    }
  }
  return files;
}

/** Files that hold the variable name as a string literal ('…', "…" or `…`). */
function filesWithNameLiteral(): string[] {
  const literal = new RegExp(`(['"\`])${packagedCdpVariableName}\\1`);
  return sourceRoots
    .flatMap((sourceRoot) => listSourceFiles(join(root, sourceRoot)))
    .filter((file) => literal.test(readFileSync(join(root, file), 'utf8')));
}

describe(`${packagedCdpVariableName}: one name, one definition site`, () => {
  // TST-009; issue #18 acceptance criterion 8
  it(`TST-009: exactly one source file defines the string "${packagedCdpVariableName}", in packages/foundation/src/`, () => {
    const files = filesWithNameLiteral();
    expect(
      files,
      `the name must be defined once, in the foundation's main-process security system; found it in ${JSON.stringify(files)}`,
    ).toHaveLength(1);
    expect(files[0], 'the definition site').toMatch(/^packages\/foundation\/src\//);
  });
});
