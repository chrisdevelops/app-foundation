// Test-only reader for DTCG token files and the resolver (#19). It lists the
// tokens each `*.tokens.json` file declares, so the gates can compare the
// generated CSS with its sources without using the pipeline under test.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The profile's reserved extension key (ADR 0003, TOK-101). */
export const profileExtensionKey = 'io.github.chrisdevelops.ui';

export type TokenTier = 'primitive' | 'semantic' | 'component';

export interface SourceToken {
  /** Token file relative to the package root, with `/`, for example `tokens/theme/dark.tokens.json`. */
  readonly file: string;
  /** Dotted JSON path inside the file, for example `color.ui-color-bg-default`. */
  readonly path: string;
  /** The leaf key, which is the token's full name (TOK-012). */
  readonly leaf: string;
  readonly tier: TokenTier;
  readonly token: Readonly<Record<string, unknown>>;
}

/** Tier from the naming grammar: `ui-ref-` is primitive, `__` is component, anything else semantic. */
export function tierOfLeaf(leaf: string): TokenTier {
  if (leaf.startsWith('ui-ref-')) return 'primitive';
  if (leaf.includes('__')) return 'component';
  return 'semantic';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every token in one token file, in document order. */
export function readTokenFile(packageDir: string, file: string): SourceToken[] {
  const parsed: unknown = JSON.parse(readFileSync(join(packageDir, ...file.split('/')), 'utf8'));
  const tokens: SourceToken[] = [];
  const walk = (node: unknown, path: readonly string[]): void => {
    if (!isRecord(node)) return;
    if ('$value' in node) {
      const leaf = path.at(-1) ?? '';
      tokens.push({ file, path: path.join('.'), leaf, tier: tierOfLeaf(leaf), token: node });
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (!key.startsWith('$')) walk(child, [...path, key]);
    }
  };
  walk(parsed, []);
  return tokens;
}

/** Follows a dotted path inside a token file. Returns the node there, or undefined. */
export function lookUpTokenPath(packageDir: string, file: string, dottedPath: string): unknown {
  const fullPath = join(packageDir, ...file.split('/'));
  if (!existsSync(fullPath)) return undefined;
  let node: unknown = JSON.parse(readFileSync(fullPath, 'utf8'));
  for (const segment of dottedPath.split('.')) {
    if (!isRecord(node) || !(segment in node)) return undefined;
    node = node[segment];
  }
  return node;
}

/** The alias target leaf of a curly-brace `$value` (TOK-045), or undefined for a literal. */
export function aliasTargetLeaf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^\{([^{}]+)\}$/.exec(value);
  return match?.[1]?.split('.').at(-1);
}

export interface ResolverSourceRef {
  readonly $ref?: unknown;
}

export interface ResolverDocument {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly sets?: Record<string, { readonly sources?: readonly ResolverSourceRef[] }>;
  readonly modifiers?: Record<
    string,
    { readonly contexts?: Record<string, readonly ResolverSourceRef[]>; readonly default?: unknown }
  >;
  readonly resolutionOrder?: readonly ResolverSourceRef[];
}

export function readResolver(packageDir: string): ResolverDocument {
  return JSON.parse(readFileSync(join(packageDir, 'tokens', 'ui.resolver.json'), 'utf8')) as ResolverDocument;
}

/** A resolver `$ref` (relative to tokens/) as a path relative to the package root, with `/`. */
export function packagePathOfResolverRef(ref: string): string {
  const parts = ['tokens'];
  for (const segment of ref.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.') parts.push(segment);
  }
  return parts.join('/');
}

export interface ResolverFiles {
  /** Set name → files, in source order. */
  readonly sets: ReadonlyMap<string, readonly string[]>;
  /** Modifier name → context name → files. */
  readonly contexts: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
}

/** The files each set and modifier context of the resolver names, relative to the package root. */
export function resolverFiles(resolver: ResolverDocument): ResolverFiles {
  const toFiles = (refs: readonly ResolverSourceRef[] | undefined): string[] =>
    (refs ?? []).map((ref) => (typeof ref.$ref === 'string' ? packagePathOfResolverRef(ref.$ref) : '<not a $ref>'));
  const sets = new Map<string, string[]>();
  for (const [name, set] of Object.entries(resolver.sets ?? {})) sets.set(name, toFiles(set.sources));
  const contexts = new Map<string, Map<string, string[]>>();
  for (const [name, modifier] of Object.entries(resolver.modifiers ?? {})) {
    const byContext = new Map<string, string[]>();
    for (const [context, refs] of Object.entries(modifier.contexts ?? {})) byContext.set(context, toFiles(refs));
    contexts.set(name, byContext);
  }
  return { sets, contexts };
}
