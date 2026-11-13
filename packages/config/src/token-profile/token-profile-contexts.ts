// The token profile's contexts (token profile spec, "Themes, contrast and
// density"; TOK-056, TOK-059 to TOK-063, TOK-066, TOK-067, TOK-071, TOK-116).
// One entry per selector block of tokens.css, in output order. This table is
// the one definition site for each block's resolver input, its selector and
// which tokens it declares; the plugin-css permutations are built from it.
import type { Permutation } from '@terrazzo/plugin-css';

/** Resolver modifier for colours (TOK-056). */
export const themeModifierName = 'theme';

/** Resolver modifier for dimensions (TOK-056). */
export const densityModifierName = 'density';

const themeContextNames = ['light', 'dark', 'light-high-contrast', 'dark-high-contrast'] as const;

/** The default permutation: light theme, compact density (TOK-059). */
const defaultResolverInput = { [themeModifierName]: 'light', [densityModifierName]: 'compact' } as const;

/** Which tokens a block declares. */
export type TokenProfileBlockScope =
  /** Every token of the block's input (the default permutation). */
  | { readonly kind: 'all' }
  /** Only the tokens declared in the files of one modifier context. */
  | { readonly kind: 'modifier-context'; readonly modifier: string; readonly context: string };

export interface TokenProfileBlock {
  /** Resolver input the block's values come from. */
  readonly input: Readonly<Record<string, string>>;
  /** `@media` prelude around the selector, if any. */
  readonly mediaQuery: string | undefined;
  readonly selector: string;
  readonly scope: TokenProfileBlockScope;
}

const themeScope = (context: string): TokenProfileBlockScope => ({
  kind: 'modifier-context',
  modifier: themeModifierName,
  context,
});

// DEFERRED: TOK-068 (`[data-contrast="more"]` override on the root; phase 3, #23 and #27). The
// high contrast blocks use the contrast media query only (issue #19 reading R4).
export const tokenProfileBlocks: readonly TokenProfileBlock[] = [
  // TOK-059: light (default) and compact density, every tier.
  { input: defaultResolverInput, mediaQuery: undefined, selector: ':root', scope: { kind: 'all' } },
  // TOK-060
  {
    input: { ...defaultResolverInput, [themeModifierName]: 'dark' },
    mediaQuery: '@media (prefers-color-scheme: dark)',
    selector: ':root',
    scope: themeScope('dark'),
  },
  // TOK-061
  {
    input: { ...defaultResolverInput, [themeModifierName]: 'light-high-contrast' },
    mediaQuery: '@media (prefers-color-scheme: light) and (prefers-contrast: more)',
    selector: ':root',
    scope: themeScope('light-high-contrast'),
  },
  // TOK-062
  {
    input: { ...defaultResolverInput, [themeModifierName]: 'dark-high-contrast' },
    mediaQuery: '@media (prefers-color-scheme: dark) and (prefers-contrast: more)',
    selector: ':root',
    scope: themeScope('dark-high-contrast'),
  },
  // TOK-066, TOK-067: one [data-theme] block per theme context, for tooling only.
  ...themeContextNames.map((theme): TokenProfileBlock => ({
    input: { ...defaultResolverInput, [themeModifierName]: theme },
    mediaQuery: undefined,
    selector: `[data-theme="${theme}"]`,
    scope: themeScope(theme),
  })),
  // TOK-063
  {
    input: { ...defaultResolverInput, [densityModifierName]: 'comfortable' },
    mediaQuery: undefined,
    selector: '[data-density="comfortable"]',
    scope: { kind: 'modifier-context', modifier: densityModifierName, context: 'comfortable' },
  },
];

const indentLines = (text: string, depth: number): string =>
  text
    .split('\n')
    .map((line) => (line === '' ? line : `${'  '.repeat(depth)}${line}`))
    .join('\n');

/**
 * Wraps a block's declaration lines (one per line, not indented) in its
 * selector, its media query and `@layer tokens` (TOK-071), with two-space indents.
 */
export function wrapTokenProfileBlock(block: TokenProfileBlock, declarations: string): string {
  let text = `${block.selector} {\n${indentLines(declarations, 1)}\n}`;
  if (block.mediaQuery !== undefined) text = `${block.mediaQuery} {\n${indentLines(text, 1)}\n}`;
  return `@layer tokens {\n${indentLines(text, 1)}\n}`;
}

/** plugin-css permutations, one per block (TOK-116). Blocks with the same input share transforms. */
export function tokenProfilePermutations(): Permutation[] {
  return tokenProfileBlocks.map((block) => ({
    input: { ...block.input },
    prepare: (contents: string) => wrapTokenProfileBlock(block, contents),
  }));
}
