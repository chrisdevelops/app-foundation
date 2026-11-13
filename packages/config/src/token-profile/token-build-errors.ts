// Token build errors in the strict shape (TOK-155, ADR 0004 decision 6;
// token profile spec "Gate tests", Output line; spike #7 result 14).
//
// Input: errors from the profile (the `$ref` guard) and lint errors that
// Terrazzo passes to its logger.
// Output: each error once, as one line on stderr, `file#token.path: rule-id: message`,
// where `file` is relative to the package root with `/`. Terrazzo's own lint
// output (`✗  lint:<rule-id>: <message>` with a code frame, and each core rule
// twice) is replaced; the build still fails, so Terrazzo writes no file.
import type { TerrazzoPlugin } from './token-profile-plugin';

type TerrazzoLogger = Parameters<NonNullable<TerrazzoPlugin['config']>>[1]['logger'];
type TerrazzoLogEntry = Parameters<TerrazzoLogger['error']>[number];
type TerrazzoLintRule = ReturnType<NonNullable<TerrazzoPlugin['lint']>>[string];
type TerrazzoLintTokens = Parameters<TerrazzoLintRule['create']>[0]['tokens'];

/** One token build error. */
export interface TokenBuildError {
  /** File relative to the package root, with `/`. */
  readonly file: string;
  /** Dotted path inside the file: a token id, or the JSON path of a resolver entry. */
  readonly tokenPath: string;
  /** `namespace/name`, for example `core/max-gamut`. */
  readonly ruleId: string;
  readonly message: string;
}

/** Thrown after the error lines are written, so that Terrazzo stops and exits non-zero. */
export class TokenBuildFailure extends Error {
  override name = 'TokenBuildFailure';
}

/** The one error line: `file#token.path: rule-id: message`, with line breaks in the message folded. */
export function formatTokenBuildError(error: TokenBuildError): string {
  const message = error.message.replace(/\s*\r?\n\s*/g, ' ').trim();
  return `${error.file}#${error.tokenPath}: ${error.ruleId}: ${message}`;
}

/** Writes each error line to stderr once per build; `written` holds the lines already written. */
export function writeTokenBuildErrors(errors: readonly TokenBuildError[], written: Set<string>): void {
  for (const error of errors) {
    const line = formatTokenBuildError(error);
    if (written.has(line)) continue;
    written.add(line);
    process.stderr.write(`${line}\n`);
  }
}

export function tokenBuildFailure(written: ReadonlySet<string>): TokenBuildFailure {
  const count = written.size;
  return new TokenBuildFailure(`token build failed with ${count} error${count === 1 ? '' : 's'} (TOK-155)`);
}

/** A Momoa node, or a list or record of them. */
const isNodeContainer = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Is `target` the node `node` or one of its descendants? (Momoa nodes have no parent links.) */
function containsNode(node: unknown, target: object): boolean {
  if (node === target) return true;
  if (!isNodeContainer(node)) return false;
  for (const [key, child] of Object.entries(node)) {
    if (key === 'loc' || key === 'range') continue;
    if (Array.isArray(child) ? child.some((item) => containsNode(item, target)) : containsNode(child, target)) {
      return true;
    }
  }
  return false;
}

/** The id of the token whose source node holds `node`. */
function tokenIdOfNode(tokens: TerrazzoLintTokens, node: object): string | undefined {
  for (const token of Object.values(tokens)) {
    if (containsNode(token.source.node, node)) return token.id;
  }
  return undefined;
}

export interface StrictTokenErrorOutputOptions {
  /** The file (relative to the package root, with `/`) that declares the token Terrazzo linted. */
  readonly fileOfToken: (tokenId: string) => string | undefined;
  /** Lines written so far in this build, shared with the `$ref` guard. */
  readonly written: Set<string>;
}

/**
 * Per-build state of the strict output. `install` is called from the profile
 * plugin's `config` hook, which Terrazzo calls once per `defineConfig` (twice
 * per `tz build`), so it wraps each plugin and logger only once.
 */
export function createStrictTokenErrorOutput(options: StrictTokenErrorOutputOptions): {
  install(logger: TerrazzoLogger, plugins: readonly TerrazzoPlugin[]): void;
} {
  const wrapped = new WeakSet<object>();
  let lintedTokens: TerrazzoLintTokens | undefined;

  /** Core lint rules give no file or token path (spike #7 result 14): keep the tokens they lint to find it. */
  const keepLintedTokens = (plugin: TerrazzoPlugin): void => {
    const lint = plugin.lint?.bind(plugin);
    if (!lint || wrapped.has(plugin)) return;
    wrapped.add(plugin);
    plugin.lint = () =>
      Object.fromEntries(
        Object.entries(lint()).map(([id, rule]): [string, TerrazzoLintRule] => [
          id,
          {
            ...rule,
            create(context) {
              lintedTokens = context.tokens;
              return rule.create(context);
            },
          },
        ]),
      );
  };

  const locate = (entry: TerrazzoLogEntry): TokenBuildError | undefined => {
    if (entry.group !== 'lint' || !entry.label?.includes('/') || !entry.node || !lintedTokens) return undefined;
    const tokenPath = tokenIdOfNode(lintedTokens, entry.node);
    const file = tokenPath === undefined ? undefined : options.fileOfToken(tokenPath);
    if (tokenPath === undefined || file === undefined) return undefined;
    return { file, tokenPath, ruleId: entry.label, message: entry.message };
  };

  /** Terrazzo's `lint:lint: N errors` line, which follows the rule errors. */
  const isLintSummary = (entry: TerrazzoLogEntry): boolean =>
    entry.group === 'lint' && entry.label === 'lint' && !entry.node;

  const routeErrors = (logger: TerrazzoLogger): void => {
    if (wrapped.has(logger)) return;
    wrapped.add(logger);
    const terrazzoError = logger.error.bind(logger);
    logger.error = (...entries: TerrazzoLogEntry[]): void => {
      const located: TokenBuildError[] = [];
      const others: TerrazzoLogEntry[] = [];
      for (const entry of entries) {
        const error = locate(entry);
        if (error) located.push(error);
        else if (!isLintSummary(entry)) others.push(entry);
      }
      if (located.length === 0) {
        terrazzoError(...entries);
        return;
      }
      writeTokenBuildErrors(located, options.written);
      // Each printed error fails the build (#20 review 1, finding 3): Terrazzo
      // counts it, as its own `error` does, and fails the build when the count
      // is not zero.
      logger.errorCount += located.length;
      // Errors with no token location (A5: parser errors, for example) keep Terrazzo's format.
      if (others.length > 0) {
        terrazzoError(...others);
        return;
      }
      // Terrazzo asked to go on and collect more errors: the count above fails
      // the build later. A logger with no numeric count (NaN) throws instead.
      if (entries.every((entry) => entry.continueOnError) && logger.errorCount > 0) return;
      throw tokenBuildFailure(options.written);
    };
  };

  return {
    install(logger, plugins) {
      for (const plugin of plugins) keepLintedTokens(plugin);
      routeErrors(logger);
    },
  };
}
