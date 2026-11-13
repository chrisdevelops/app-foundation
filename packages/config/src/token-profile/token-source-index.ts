// Where each token is declared (TOK-117, ADR 0002 item 1, spike #7 results 5
// and 13). Terrazzo merges the resolver's sources and does not keep the file
// of each token, so this module reads the resolver and the token files it
// names and lists every declaration with its file and JSON path.
import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One token declaration in one token file. */
export interface TokenDeclaration {
  /** Dotted JSON path, which is also Terrazzo's token id, for example `color.ui-color-bg-default`. */
  readonly id: string;
  /** Token file relative to the package root, with `/`. */
  readonly file: string;
  /** The set or modifier context the file belongs to. */
  readonly origin:
    | { readonly kind: 'set'; readonly set: string }
    | { readonly kind: 'modifier'; readonly modifier: string; readonly context: string };
  /** Position in resolution order; a later declaration of the same id wins (ADR 0002 item 1). */
  readonly order: number;
}

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Thrown when the resolver does not have the shape the profile requires. */
export class TokenSourceIndexError extends Error {
  override name = 'TokenSourceIndexError';
}

function readJson(url: URL): unknown {
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
}

function listTokenIds(node: unknown, path: readonly string[], ids: string[]): void {
  if (!isJsonObject(node)) return;
  if ('$value' in node) {
    ids.push(path.join('.'));
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    if (!key.startsWith('$')) listTokenIds(child, [...path, key], ids);
  }
}

// DEFERRED: TOK-176, TOK-177 (refuse remote and out-of-root `$ref`s before any load; #20)
function sourceFileUrls(sources: unknown, resolverUrl: URL, where: string): URL[] {
  if (!Array.isArray(sources)) throw new TokenSourceIndexError(`${where} must be a list of { "$ref" } sources`);
  return sources.map((source, index) => {
    const ref = isJsonObject(source) ? source.$ref : undefined;
    if (typeof ref !== 'string' || ref.startsWith('#')) {
      throw new TokenSourceIndexError(`${where}[${index}] must be a { "$ref" } to a *.tokens.json file`);
    }
    return new URL(ref, resolverUrl);
  });
}

/**
 * Lists every token declaration of the resolver at `resolverUrl`, in
 * resolution order. File paths are relative to `packageRoot`.
 */
export function indexTokenDeclarations(resolverUrl: URL, packageRoot: URL): TokenDeclaration[] {
  const resolver = readJson(resolverUrl);
  if (!isJsonObject(resolver)) throw new TokenSourceIndexError('the resolver must be a JSON object');
  const sets = isJsonObject(resolver.sets) ? resolver.sets : {};
  const modifiers = isJsonObject(resolver.modifiers) ? resolver.modifiers : {};
  const order = Array.isArray(resolver.resolutionOrder) ? (resolver.resolutionOrder as unknown[]) : [];
  const rootPath = fileURLToPath(packageRoot);
  const declarations: TokenDeclaration[] = [];
  let position = 0;

  const addFiles = (urls: readonly URL[], origin: TokenDeclaration['origin']): void => {
    for (const url of urls) {
      const file = relative(rootPath, fileURLToPath(url)).split(sep).join('/');
      const ids: string[] = [];
      listTokenIds(readJson(url), [], ids);
      for (const id of ids) declarations.push({ id, file, origin, order: position });
      position += 1;
    }
  };

  order.forEach((item, index) => {
    const ref = isJsonObject(item) ? item.$ref : undefined;
    const match = typeof ref === 'string' ? /^#\/(sets|modifiers)\/([^/]+)$/.exec(ref) : null;
    const [, kind, name = ''] = match ?? [];
    if (kind === 'sets') {
      const set = sets[name];
      if (!isJsonObject(set))
        throw new TokenSourceIndexError(`resolutionOrder[${index}] names a missing set "${name}"`);
      addFiles(sourceFileUrls(set.sources, resolverUrl, `sets.${name}.sources`), { kind: 'set', set: name });
    } else if (kind === 'modifiers') {
      const modifier = modifiers[name];
      if (!isJsonObject(modifier) || !isJsonObject(modifier.contexts)) {
        throw new TokenSourceIndexError(`resolutionOrder[${index}] names a missing modifier "${name}"`);
      }
      for (const [context, sources] of Object.entries(modifier.contexts)) {
        addFiles(sourceFileUrls(sources, resolverUrl, `modifiers.${name}.contexts.${context}`), {
          kind: 'modifier',
          modifier: name,
          context,
        });
      }
    } else {
      throw new TokenSourceIndexError(
        `resolutionOrder[${index}] must be a { "$ref": "#/sets/<name>" or "#/modifiers/<name>" }`,
      );
    }
  });
  return declarations;
}

/** True when a declaration takes part in the permutation `input`. */
export function isDeclarationActive(declaration: TokenDeclaration, input: Readonly<Record<string, string>>): boolean {
  return declaration.origin.kind === 'set' || input[declaration.origin.modifier] === declaration.origin.context;
}

/** The declaration of `id` that wins in the permutation `input`: the last active one in resolution order. */
export function winningDeclaration(
  declarations: readonly TokenDeclaration[],
  id: string,
  input: Readonly<Record<string, string>>,
): TokenDeclaration | undefined {
  let winner: TokenDeclaration | undefined;
  for (const declaration of declarations) {
    if (declaration.id === id && isDeclarationActive(declaration, input)) {
      if (!winner || declaration.order >= winner.order) winner = declaration;
    }
  }
  return winner;
}
