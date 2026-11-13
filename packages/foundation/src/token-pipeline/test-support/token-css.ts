// Test-only reader for the generated tokens.css (#19). It understands the
// small CSS subset the token pipeline writes: comments, at-rules with a block
// (`@layer`, `@media`), style rules, and custom property declarations. It
// keeps, for every declaration, the at-rules and selector around it and the
// comment that follows it on the same line.

export interface TokenCssDeclaration {
  /** Custom property name, for example `--ui-color-bg-default`. */
  readonly name: string;
  /** Value with surrounding whitespace removed. */
  readonly value: string;
  /** Text inside the comment that follows the `;` on the same line, or undefined. */
  readonly trailingComment: string | undefined;
  /** True when nothing but whitespace follows the trailing comment on its line. */
  readonly commentEndsLine: boolean;
  /** 1-based line of the declaration. */
  readonly line: number;
}

export interface TokenCssBlock {
  /** Enclosing at-rule preludes from outermost to innermost, whitespace collapsed, for example `@media (prefers-color-scheme: dark)`. */
  readonly atRules: readonly string[];
  /** Selector of the style rule, whitespace collapsed. */
  readonly selector: string;
  readonly declarations: readonly TokenCssDeclaration[];
}

export interface ParsedTokenCss {
  readonly blocks: readonly TokenCssBlock[];
  /** Problems the reader found: text it cannot place, unbalanced braces, declarations outside a rule. */
  readonly problems: readonly string[];
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

interface OpenScope {
  readonly prelude: string;
  readonly declarations: TokenCssDeclaration[] | undefined;
}

/** Parses tokens.css text. Never throws; problems are listed in the result. */
export function parseTokenCss(css: string): ParsedTokenCss {
  const blocks: TokenCssBlock[] = [];
  const problems: string[] = [];
  const stack: OpenScope[] = [];
  let pending = '';
  let pendingStart = 0;
  let lastDeclaration: { decl: TokenCssDeclaration; index: number } | undefined;
  let i = 0;

  const lineOf = (index: number): number => css.slice(0, index).split('\n').length;

  const flushDeclaration = (endIndex: number): void => {
    const text = pending.trim();
    const startIndex = pendingStart;
    pending = '';
    if (text === '') return;
    const scope = stack.at(-1);
    if (!scope?.declarations) {
      problems.push(`line ${lineOf(startIndex)}: text outside a style rule: ${collapse(text)}`);
      return;
    }
    const colon = text.indexOf(':');
    if (colon < 0) {
      problems.push(`line ${lineOf(startIndex)}: not a declaration: ${collapse(text)}`);
      return;
    }
    const decl: TokenCssDeclaration = {
      name: text.slice(0, colon).trim(),
      value: text.slice(colon + 1).trim(),
      trailingComment: undefined,
      commentEndsLine: false,
      line: lineOf(startIndex),
    };
    scope.declarations.push(decl);
    lastDeclaration = { decl, index: endIndex };
  };

  while (i < css.length) {
    const char = css.charAt(i);
    if (char === '/' && css.charAt(i + 1) === '*') {
      const end = css.indexOf('*/', i + 2);
      if (end < 0) {
        problems.push(`line ${lineOf(i)}: unterminated comment`);
        break;
      }
      const body = css.slice(i + 2, end);
      if (lastDeclaration && !css.slice(lastDeclaration.index + 1, i).includes('\n') && pending.trim() === '') {
        const lineEnd = css.indexOf('\n', end + 2);
        const rest = css.slice(end + 2, lineEnd < 0 ? css.length : lineEnd);
        const updated: TokenCssDeclaration = {
          ...lastDeclaration.decl,
          trailingComment: body,
          commentEndsLine: rest.trim() === '',
        };
        const declarations = stack.at(-1)?.declarations;
        if (declarations) declarations[declarations.length - 1] = updated;
      }
      lastDeclaration = undefined;
      i = end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = css.indexOf(char, i + 1);
      if (pending.trim() === '') pendingStart = i;
      pending += css.slice(i, end < 0 ? css.length : end + 1);
      i = end < 0 ? css.length : end + 1;
      continue;
    }
    if (char === '{') {
      const prelude = collapse(pending);
      pending = '';
      lastDeclaration = undefined;
      const parentIsRule = stack.at(-1)?.declarations !== undefined;
      if (parentIsRule) problems.push(`line ${lineOf(i)}: nested block inside a style rule: ${prelude}`);
      stack.push({ prelude, declarations: prelude.startsWith('@') ? undefined : [] });
      i += 1;
      continue;
    }
    if (char === '}') {
      flushDeclaration(i);
      lastDeclaration = undefined;
      const scope = stack.pop();
      if (!scope) {
        problems.push(`line ${lineOf(i)}: unbalanced }`);
      } else if (scope.declarations) {
        blocks.push({
          atRules: stack.map((open) => open.prelude),
          selector: scope.prelude,
          declarations: scope.declarations,
        });
      }
      i += 1;
      continue;
    }
    if (char === ';') {
      if (stack.at(-1)?.declarations) {
        flushDeclaration(i);
      } else {
        problems.push(`line ${lineOf(i)}: statement outside a style rule: ${collapse(pending)}`);
        pending = '';
      }
      i += 1;
      continue;
    }
    if (pending.trim() === '' && !/\s/.test(char)) pendingStart = i;
    pending += char;
    i += 1;
  }
  if (pending.trim() !== '') problems.push(`trailing text: ${collapse(pending)}`);
  if (stack.length > 0) problems.push(`${stack.length} block(s) not closed`);
  return { blocks, problems };
}

/** Feature → value of every `(feature: value)` in the block's `@media` at-rules. */
export function mediaFeaturesOf(block: TokenCssBlock): Map<string, string> {
  const features = new Map<string, string>();
  for (const atRule of block.atRules) {
    if (!atRule.startsWith('@media')) continue;
    for (const match of atRule.matchAll(/\(\s*([a-z-]+)\s*:\s*([a-z-]+)\s*\)/g)) {
      features.set(match[1] ?? '', match[2] ?? '');
    }
  }
  return features;
}

/** The `@media` preludes of a block. */
export function mediaQueriesOf(block: TokenCssBlock): string[] {
  return block.atRules.filter((atRule) => atRule.startsWith('@media'));
}
