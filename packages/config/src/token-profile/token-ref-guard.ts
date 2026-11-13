// The `$ref` guard of the token profile (TOK-176, TOK-177; token profile spec
// "Gate tests" > "Security", rows 21 and 22; spike #7 result 9). Terrazzo
// fetches remote `$ref`s and reads files anywhere on disk, so the profile
// checks every `$ref` before Terrazzo loads one.
//
// Input: the token files in `config.tokens` (the resolver), the package root
// and the repo root.
// Output: one error per refusal, at the file and JSON path at fault.
// - A `config.tokens` entry must be a `file:` URL inside the repo root.
// - A `$ref` may be a fragment (`#/sets/ref`) or a relative path that stays
//   inside the repo root, also through symlinks. Refused: any URL (`https:`,
//   `file:`, ...), an absolute path (`/...`, `\...`, `C:/...`) and a relative
//   path that leaves the repo root.
// - The guard fails closed (orchestrator decision on #20 review 1): Terrazzo
//   reads token files as JSONC (comments; of duplicate keys, the FIRST wins)
//   and as YAML, and this guard has no parser for those. So every file it
//   visits (each entry and each `$ref` target) must be named `*.json` and be
//   strict JSON with an object at the top (`JSON.parse` on the whole text),
//   and an object may hold only one `$ref` member. The guard lists the
//   `$ref`s from the raw text, so a member that `JSON.parse` drops (a
//   duplicate key) is checked too. A file that does not exist stays
//   Terrazzo's to report: Terrazzo cannot load it either.
// The guard reads a file only after it allows the entry or `$ref` to it, and
// follows the `$ref`s inside it as Terrazzo does.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TokenBuildError } from './token-build-errors';

/** Rule id of the guard's errors. */
export const tokenRefGuardRuleId = 'ui/ref-guard';

/** File that marks the monorepo root. */
const repoRootMarker = 'pnpm-workspace.yaml';

/** File named in errors about a `config.tokens` entry: the config file the profile documents. */
const terrazzoConfigFile = 'terrazzo.config.ts';

/** Token path of an error about a whole file (JSONPath root). */
const wholeFileTokenPath = '$';

/** The only file extension the guard reads (TOK-011, TOK-051: token files are plain DTCG JSON). */
const tokenFileExtension = '.json';

/**
 * The repo root: the nearest folder at or above `packageRoot` that holds
 * pnpm-workspace.yaml. A package outside a pnpm workspace gets its own folder,
 * so its `$ref`s must stay inside the package.
 */
export function findRepoRoot(packageRoot: URL): string {
  const start = fileURLToPath(packageRoot);
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, repoRootMarker))) return dir;
    if (dirname(dir) === dir) return start;
  }
}

/** A URL scheme, or a Windows drive letter, at the start of a `$ref`. */
const schemePattern = /^([a-z][a-z0-9+.-]*):/i;

const isInside = (root: string, path: string): boolean => {
  const fromRoot = relative(root, path);
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
};

/**
 * `path` with symlinks resolved. For a path that does not exist, the nearest
 * folder above it that exists is resolved and the rest is kept, so a missing
 * file below a symlinked folder (macOS `/var`) stays inside its real folder.
 */
const realPathOf = (path: string): string => {
  const missing: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    try {
      return join(realpathSync(current), ...missing);
    } catch {
      if (dirname(current) === current) return path;
      missing.unshift(basename(current));
    }
  }
};

/** Inside the repo root as written and after symlinks are resolved. */
const isInsideRepo = (repoRoot: string, path: string): boolean =>
  isInside(repoRoot, path) && isInside(realPathOf(repoRoot), realPathOf(path));

const isTokenFileName = (path: string): boolean => path.endsWith(tokenFileExtension);

/** Why `ref` is refused; or, when it is allowed, the file it names (undefined for a fragment). */
function checkRef(
  ref: string,
  fromFile: string,
  repoRoot: string,
): { readonly refused: string } | { readonly target: string | undefined } {
  // Same split as Terrazzo's parseRef: the part before `#` names the file.
  const filePart = ref.split('#')[0] ?? '';
  if (filePart === '') return { target: undefined };
  const scheme = schemePattern.exec(filePart)?.[1];
  const isRemote =
    (scheme !== undefined && scheme.length > 1 && scheme.toLowerCase() !== 'file') || /^[/\\]{2}/.test(filePart);
  if (isRemote) {
    return { refused: `$ref "${ref}" is a remote URL; only relative paths inside the repo are allowed (TOK-176)` };
  }
  if (scheme !== undefined || filePart.startsWith('/') || filePart.startsWith('\\')) {
    return {
      refused: `$ref "${ref}" is an absolute path or file: URL; only relative paths inside the repo are allowed (TOK-177)`,
    };
  }
  let target: string;
  try {
    // Same resolution as Terrazzo: a URL relative to the file that holds the `$ref`.
    const url = new URL(filePart, pathToFileURL(fromFile));
    if (url.protocol !== 'file:') throw new Error('not a file URL');
    target = fileURLToPath(url);
  } catch {
    return { refused: `$ref "${ref}" is not a relative file path; only relative paths inside the repo are allowed` };
  }
  if (!isInsideRepo(repoRoot, target)) {
    return { refused: `$ref "${ref}" leaves the repo root; only relative paths inside the repo are allowed (TOK-177)` };
  }
  if (!isTokenFileName(target)) {
    return {
      refused: `$ref "${ref}" names a file that is not *.json; token files must be strict JSON named *.json (TOK-011, TOK-051)`,
    };
  }
  return { target };
}

/** Why a `config.tokens` entry is refused; or, when it is allowed, the file it names. */
function checkEntry(entry: URL, repoRoot: string): { readonly refused: string } | { readonly target: string } {
  if (entry.protocol !== 'file:') {
    return {
      refused: `config.tokens entry "${entry.href}" is not a local file; only files inside the repo are allowed (TOK-176)`,
    };
  }
  let target: string;
  try {
    target = fileURLToPath(entry);
  } catch {
    return {
      refused: `config.tokens entry "${entry.href}" is not a local file path; only files inside the repo are allowed`,
    };
  }
  if (!isInsideRepo(repoRoot, target)) {
    return {
      refused: `config.tokens entry "${entry.href}" is outside the repo root; only files inside the repo are allowed (TOK-177)`,
    };
  }
  if (!isTokenFileName(target)) {
    return {
      refused: `config.tokens entry "${entry.href}" is not *.json; token files must be strict JSON named *.json (TOK-011, TOK-051)`,
    };
  }
  return { target };
}

/** One `"$ref"` member in a JSON text, with the JSON path of its object. */
interface RefMember {
  readonly path: readonly string[];
  /** The member's value when it is a string; Terrazzo follows only string `$ref`s. */
  readonly ref: string | undefined;
}

interface ScannedJson {
  readonly refs: readonly RefMember[];
  /** JSON paths of the objects with more than one `"$ref"` member. */
  readonly multiRefObjects: readonly (readonly string[])[];
}

class StrictJsonScanError extends Error {
  override name = 'StrictJsonScanError';
}

/**
 * Lists every `"$ref"` member of a strict JSON text from the raw text, so
 * that duplicate keys (which `JSON.parse` drops) are listed too. The text must
 * already have passed `JSON.parse`; anything unexpected throws.
 */
function scanStrictJson(text: string): ScannedJson {
  const refs: RefMember[] = [];
  const multiRefObjects: (readonly string[])[] = [];
  let at = 0;

  const fail = (): never => {
    throw new StrictJsonScanError(`unexpected text at offset ${at}`);
  };
  const skipSpace = (): void => {
    while (at < text.length && ' \t\n\r'.includes(text.charAt(at))) at += 1;
  };
  const expect = (char: string): void => {
    skipSpace();
    if (text.charAt(at) !== char) fail();
    at += 1;
  };
  const readString = (): string => {
    skipSpace();
    const start = at;
    if (text.charAt(at) !== '"') fail();
    at += 1;
    while (at < text.length && text.charAt(at) !== '"') at += text.charAt(at) === '\\' ? 2 : 1;
    if (at >= text.length) fail();
    at += 1;
    const decoded: unknown = JSON.parse(text.slice(start, at));
    return typeof decoded === 'string' ? decoded : fail();
  };
  const readValue = (path: readonly string[]): unknown => {
    skipSpace();
    const char = text.charAt(at);
    if (char === '{') {
      at += 1;
      let refCount = 0;
      skipSpace();
      if (text.charAt(at) === '}') {
        at += 1;
        return undefined;
      }
      for (;;) {
        const key = readString();
        expect(':');
        const value = readValue([...path, key]);
        if (key === '$ref') {
          refCount += 1;
          refs.push({ path, ref: typeof value === 'string' ? value : undefined });
        }
        skipSpace();
        if (text.charAt(at) === ',') {
          at += 1;
          continue;
        }
        expect('}');
        break;
      }
      if (refCount > 1) multiRefObjects.push(path);
      return undefined;
    }
    if (char === '[') {
      at += 1;
      skipSpace();
      if (text.charAt(at) === ']') {
        at += 1;
        return undefined;
      }
      for (let index = 0; ; index += 1) {
        readValue([...path, String(index)]);
        skipSpace();
        if (text.charAt(at) === ',') {
          at += 1;
          continue;
        }
        expect(']');
        break;
      }
      return undefined;
    }
    if (char === '"') return readString();
    // A number, true, false or null: no `$ref` inside.
    const start = at;
    while (at < text.length && !',}] \t\n\r'.includes(text.charAt(at))) at += 1;
    if (at === start) fail();
    return undefined;
  };

  skipSpace();
  // Terrazzo parses a text that does not start with `{`, `"` or `[` as YAML: accept only an object.
  if (text.charAt(at) !== '{') fail();
  readValue([]);
  skipSpace();
  if (at !== text.length) fail();
  return { refs, multiRefObjects };
}

/** The `$ref`s of a token file; or why the file is refused; or `missing` when it does not exist. */
function readTokenFile(path: string): ScannedJson | { readonly refused: string } | 'missing' {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return { refused: `cannot be read (${(error as Error).message}); the guard refuses what it cannot check` };
  }
  try {
    JSON.parse(text);
    return scanStrictJson(text);
  } catch (error) {
    return {
      refused: `is not strict JSON with an object at the top (${(error as Error).message}); token files must be plain JSON, with no comments (TOK-011, TOK-051)`,
    };
  }
}

/**
 * Checks every `config.tokens` entry and every `$ref` reachable from them,
 * and returns one error per refusal. File paths in the errors are relative to
 * `packageRoot`.
 */
export function findRefGuardErrors(
  entryFiles: readonly URL[],
  options: { readonly packageRoot: URL; readonly repoRoot: string },
): TokenBuildError[] {
  const packageRootPath = fileURLToPath(options.packageRoot);
  const fileOf = (path: string): string => relative(packageRootPath, path).split(sep).join('/');
  const errors: TokenBuildError[] = [];
  const refuse = (file: string, tokenPath: string, message: string): void => {
    errors.push({ file, tokenPath, ruleId: tokenRefGuardRuleId, message });
  };

  const queue: string[] = [];
  entryFiles.forEach((entry, index) => {
    const result = checkEntry(entry, options.repoRoot);
    if ('refused' in result) refuse(terrazzoConfigFile, `tokens.${index}`, result.refused);
    else queue.push(result.target);
  });

  const visited = new Set<string>();
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (visited.has(file)) continue;
    visited.add(file);
    const scanned = readTokenFile(file);
    if (scanned === 'missing') continue;
    if ('refused' in scanned) {
      refuse(fileOf(file), wholeFileTokenPath, `${fileOf(file)} ${scanned.refused}`);
      continue;
    }
    for (const path of scanned.multiRefObjects) {
      refuse(
        fileOf(file),
        [...path, '$ref'].join('.'),
        'an object holds more than one "$ref" member; Terrazzo and JSON.parse would follow different ones',
      );
    }
    for (const { ref, path } of scanned.refs) {
      if (ref === undefined) continue;
      const result = checkRef(ref, file, options.repoRoot);
      if ('refused' in result) refuse(fileOf(file), [...path, '$ref'].join('.'), result.refused);
      else if (result.target !== undefined) queue.push(result.target);
    }
  }
  return errors;
}
