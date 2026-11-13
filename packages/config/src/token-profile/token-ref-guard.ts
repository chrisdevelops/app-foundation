// The `$ref` guard of the token profile (TOK-176, TOK-177; token profile spec
// "Gate tests" > "Security", rows 21 and 22; spike #7 result 9). Terrazzo
// fetches remote `$ref`s and reads files anywhere on disk, so the profile
// checks every `$ref` before Terrazzo loads one.
//
// Input: the token files in `config.tokens` (the resolver), the package root
// and the repo root.
// Output: one error per refused `$ref`, at the file and JSON path that holds
// it. Allowed: a fragment (`#/sets/ref`) and a relative path that stays inside
// the repo root, also through symlinks. Refused: any URL (`https:`, `file:`,
// ...), an absolute path (`/...`, `\...`, `C:/...`) and a relative path that
// leaves the repo root. The guard reads a file only after it allows the
// `$ref` to it, and follows the `$ref`s inside it as Terrazzo does.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TokenBuildError } from './token-build-errors';

/** Rule id of the guard's errors. */
export const tokenRefGuardRuleId = 'ui/ref-guard';

/** File that marks the monorepo root. */
const repoRootMarker = 'pnpm-workspace.yaml';

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

/** A JSON object or array. */
const isJsonContainer = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** A URL scheme, or a Windows drive letter, at the start of a `$ref`. */
const schemePattern = /^([a-z][a-z0-9+.-]*):/i;

const isInside = (root: string, path: string): boolean => {
  const fromRoot = relative(root, path);
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
};

const realPathOrSelf = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

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
  if (!isInside(repoRoot, target) || !isInside(realPathOrSelf(repoRoot), realPathOrSelf(target))) {
    return { refused: `$ref "${ref}" leaves the repo root; only relative paths inside the repo are allowed (TOK-177)` };
  }
  return { target };
}

/** Every `{ "$ref": "<string>" }` in a JSON value, with the JSON path of its object. */
function listRefs(node: unknown, path: readonly string[], found: { ref: string; path: readonly string[] }[]): void {
  if (!isJsonContainer(node)) return;
  if (!Array.isArray(node) && typeof node.$ref === 'string') found.push({ ref: node.$ref, path });
  for (const [key, child] of Object.entries(node)) listRefs(child, [...path, key], found);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Missing or invalid files are Terrazzo's to report.
    return undefined;
  }
}

/**
 * Checks every `$ref` reachable from `entryFiles` and returns one error per
 * refused `$ref`. File paths in the errors are relative to `packageRoot`.
 */
export function findRefGuardErrors(
  entryFiles: readonly URL[],
  options: { readonly packageRoot: URL; readonly repoRoot: string },
): TokenBuildError[] {
  const packageRootPath = fileURLToPath(options.packageRoot);
  const errors: TokenBuildError[] = [];
  const visited = new Set<string>();
  const queue = entryFiles.filter((url) => url.protocol === 'file:').map((url) => fileURLToPath(url));
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (visited.has(file)) continue;
    visited.add(file);
    const refs: { ref: string; path: readonly string[] }[] = [];
    listRefs(readJson(file), [], refs);
    for (const { ref, path } of refs) {
      const result = checkRef(ref, file, options.repoRoot);
      if ('refused' in result) {
        errors.push({
          file: relative(packageRootPath, file).split(sep).join('/'),
          tokenPath: [...path, '$ref'].join('.'),
          ruleId: tokenRefGuardRuleId,
          message: result.refused,
        });
      } else if (result.target !== undefined) {
        queue.push(result.target);
      }
    }
  }
  return errors;
}
