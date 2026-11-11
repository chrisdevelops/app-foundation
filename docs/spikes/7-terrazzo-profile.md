# Spike #7: Terrazzo support for the token profile

Branch `spike/7-terrazzo-profile` (never merged). Date 2026-11-11. Code: `spikes/7-terrazzo-profile/`; logs: `spikes/7-terrazzo-profile/evidence/`.

## Question

Which "To verify during build" items hold in current Terrazzo, and do ADR 0002 items 1, 3 and 8 work?

## Answer: go-with-changes

Terrazzo loads the resolver and aliases, and exposes enough data to our own plugin. Four built-in pieces do not work as the spec describes, and the profile plugin takes over (see the table). No no-go condition was hit. Confidence: high for every row, because each was run. The inputs were the spec layout, four themes, two densities and one component file. Wide-gamut and P3 results use single test colours.

Tested: `@terrazzo/cli`, `@terrazzo/plugin-css`, `@terrazzo/parser` 2.10.0 (npm latest, published 2026-10-21); Node v24.18.0; pnpm 11.13.1. Extension key `io.github.chrisdevelops.ui`.

## Results

| # | Item | Result | Evidence and profile rule that takes over |
| --- | --- | --- | --- |
| 1 | `core/consistent-naming` custom validator | Works with change | Validator gets one string: the dotted id, for example `ref.color.ui-ref-color-blue-600`. Leaf = last segment. A truthy return means error (the inverse of a "valid" check). `evidence/baseline.logs/validator-input.log` |
| 2 | ADR 0002 item 3 grammar | Works | Accepts `ui-ref-color-blue-600`, `ui-ref-space-4`, `ui-ref-font-family-ui`; rejects `ui-ref-colour-blue-600` (`evidence/validator-check.txt`). With the closed category list anchored at the start, no name parses two ways. A single-word-category regex would split `font-family-ui` into font/family/ui, so the validator must use the list. Gap: `ui-ref-space-4-2` passes (scale `4`). |
| 3 | `core/required-modes` | Does not work | Reads only legacy `token.mode`; a resolver token has only mode `.`. Asking for `dark` flags every colour (false positive). Asking for `.` passes while `dark.tokens.json` lacks `ui-color-fg-default`. `ui/required-theme-colors` catches it (`evidence/required-modes-*.txt`). |
| 4 | `a11y/min-contrast` | Does not work | Lint sees only the default context (light, compact). Pairs are static token ids in config, not `contrastWith`. A failing dark pair passes (1.15:1). `ui/min-contrast-per-context` reads `contrastWith` and checks every context; it builds its own resolver with `parse()` because the lint context has none (`evidence/contrast-dark-fails.txt`). |
| 5 | ADR 0002 item 1 | Works with change | Terrazzo merges silently, later wins: `density/compact` overrides `sys/base`, `brand` overrides `ref` (`evidence/merge-probe.txt`). Lint `tokens` is already merged. A rule recovers set, modifier, context and file from `sources[0]` (original `src` plus bundled `$defs`). `ui/unique-leaf-names` accepts the valid system and the app brand override and rejects a duplicate in two non-alternative files (`evidence/dup-leaf-ours.txt`). `$defs` keys for files outside the resolver folder are wrong in 2.10.0, so pair them with the raw `$ref` strings. |
| 6 | `core/max-gamut` | Works with change | Option is `gamut` (`srgb`, `p3`, `rec2020`; default `rec2020`), source `parser/dist/lint/plugin-core/rules/max-gamut.js`. The docs example `format` is ignored: with `format: srgb` a P3-only colour passes (exit 0). |
| 7 | `core/colorspace` accepts `oklch` | Works | Option `colorSpace`. `oklch` passes; `srgb` as a negative control errors. |
| 8 | `$ref` outside `tokens/` | Works | `../src/components/button/button.tokens.json` from the foundation resolver, and `../../../foundation/...` from the app resolver, both build (`evidence/baseline.txt`, `app-brand.txt`). |
| 9 | `$ref` security (TOK-176/177) | Our factory must refuse | Terrazzo fetched a remote URL (server hit) and read a file outside the root; both built, exit 0. A `config` hook that scans `$ref`s refuses both before any load, exit 1 (`ref-guard.mjs`, `evidence/ref-*.txt`). |
| 10 | `plugin-css` | Works with change | `variableName` must return `--` plus leaf; the spec's `token.id.split(".").at(-1)` gives `var(ui-...)`. For leaves with `__` the build path runs `makeCSSVar`, which drops `_`, so every block also gets a wrong `--ui-button-color-bg-primary-default` (`evidence/builtin-css.generated/`). Fix: `skipBuild: true` and write `tokens.css` from `getTransforms` in our plugin. One selector per context works. `[data-theme]` blocks in `@layer tokens` work with extra permutations on the same inputs. Gotcha: permutations that share an input share transforms, and `only.sets` must list `brand` in an app. |
| 11 | Plugin API outputs | Works | `build` hook plus `outputFile` wrote `token-names.ts` and `TOKENS.md` (`profile-plugin.mjs`; `evidence/baseline.generated/`). |
| 12 | Custom lint rule data | Works with change | Rule gets leaf key, `group.id`, `$type`, `aliasOf` and `aliasChain` (direct target is `aliasChain[0]`), `$extensions`. It does not get the source file: `token.source.filename` is the resolver and `node` points into re-serialized JSON. File comes from item 5. `ui/tier-references` works (`evidence/tier-bad.txt`). |
| 13 | Source comment (TOK-117) | Works | `--ui-color-fg-default: var(--ui-ref-color-gray-900); /* tokens/theme/light.tokens.json#color.ui-color-fg-default */` |
| 14 | Failure format vs TOK-155 | Does not match | Output is `✗  lint:<rule-id>: <message>` on stderr, then `lint:lint: N errors`, exit 1. Core messages carry no file or path, and the code frame points at an unrelated line of the resolver. Custom rules can put `file#path` in the message, giving `lint:ui/x: file#path: ui/x: msg`. Core rules also run twice per build (duplicate errors). TOK-155 needs a wrapper or a relaxed gate-test pattern. |

## Gamut facts (no choice made)

- For a colour outside sRGB, `plugin-css` writes a sRGB-clamped value in the base block, plus `@media (color-gamut: p3)` and `rec2020` blocks with the authored value (`evidence/wide-gamut-builtin-css.generated/builtin-tokens.css`). The lint option does not change this.
- A colour authored as `display-p3` and outside sRGB crashes `plugin-css` 2.10.0: `No color space found with id = "display-p3"` (`evidence/display-p3-authored.txt`). `token-tools` `css/color.js` passes the DTCG name to Color.js, which expects `p3`. `oklch` authoring works.
- `oklch(0.6 0.2 255)` is outside sRGB and inside P3; `oklch(0.55 0.2 260)` is inside sRGB (`evidence/gamut-probe.txt`).

## Spec items that read differently now

TOK-115 expression (needs `--`); TOK-112 and TOK-114 (our plugin writes `tokens.css`, not `plugin-css` build); TOK-131 (validator gets the dotted id); TOK-134 and TOK-136 (replaced by profile rules, which the spec allows); TOK-135 (`gamut`); TOK-155 (not native). No ADR is contradicted; ADR 0002 items 1, 3 and 8 work. The human may want to decide whether TOK-155 stays strict.

## Sources

- Terrazzo lint docs, https://terrazzo.app/docs/linting/ (read 2026-11-11). It lists both `gamut` and `format` for max-gamut and does not document the validator signature.
- Terrazzo CSS plugin docs, https://terrazzo.app/docs/integrations/css/ (read 2026-11-11). Its `variableName` examples omit `--`; 2.10.0 behaves otherwise for aliases.
- Installed package source (primary): `@terrazzo/parser`, `plugin-css`, `token-tools`, `json-schema-tools` 2.10.0.
