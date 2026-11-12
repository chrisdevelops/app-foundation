// Test-only helper for the repo gate tests (#12). Reads a tsconfig file and
// follows its `extends` chain, so the tests can see the effective options.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';

/** Parses JSON with comments and trailing commas, as tsconfig files allow. */
export function parseJsonWithComments(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (char === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
    } else {
      out += char;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

interface TsconfigFile {
  extends?: string | string[];
  compilerOptions?: Record<string, unknown>;
}

export function readTsconfigFile(path: string): TsconfigFile {
  return parseJsonWithComments(readFileSync(path, 'utf8')) as TsconfigFile;
}

/** Returns the `extends` entries of a tsconfig file as absolute paths. */
export function resolveTsconfigExtends(tsconfigPath: string): string[] {
  const config = readTsconfigFile(tsconfigPath);
  const entries = config.extends === undefined ? [] : [config.extends].flat();
  const baseDir = dirname(tsconfigPath);
  return entries.map((entry) => {
    if (entry.startsWith('.') || isAbsolute(entry)) {
      const direct = resolve(baseDir, entry);
      if (existsSync(direct)) return direct;
      if (existsSync(`${direct}.json`)) return `${direct}.json`;
      throw new Error(`${tsconfigPath} extends "${entry}", which does not exist`);
    }
    // A package specifier, for example "@scope/tsconfig/base.json".
    return createRequire(tsconfigPath).resolve(entry);
  });
}

/** Merges compilerOptions along the extends chain (later files win), like tsc does. */
export function resolveEffectiveCompilerOptions(tsconfigPath: string): Record<string, unknown> {
  const config = readTsconfigFile(tsconfigPath);
  let merged: Record<string, unknown> = {};
  for (const parent of resolveTsconfigExtends(tsconfigPath)) {
    merged = { ...merged, ...resolveEffectiveCompilerOptions(parent) };
  }
  return { ...merged, ...(config.compilerOptions ?? {}) };
}
