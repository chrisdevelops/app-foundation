# Design Token Profile Spec

Nov 6, 2026 · @Chris Lloyd

## Purpose and scope

The profile is a set of rules layered on DTCG 2025.10 and Terrazzo so that every token has one exact name that appears verbatim in its source file, its generated CSS and every usage. [TOK-011] Token files stay valid DTCG; nothing here requires a custom parser.

The profile adds four things the standard leaves open:

- **A naming grammar** that makes every token name unique, greppable and impossible to confuse with a CSS class or another token.
- **Tier and reference rules** that keep components away from raw palette values.
- **Generated outputs for agents**: CSS with source pointers, TypeScript names and a single token reference file.
- **Lint, CI checks and gate tests** that enforce all of the above automatically.

In scope: the foundation package, every app in the monorepo, and the planned in-house design tool. Out of scope: runtime theming logic beyond the CSS output, and component styling rules other than how components consume tokens.

Key words MUST, MUST NOT, SHOULD and MAY are used as in DTCG: requirements, not suggestions.

## Decisions this spec builds on

These were settled in the foundation planning conversation and are not reopened here.

| Area | Decision |
| --- | --- |
| Format | DTCG 2025.10 JSON, including the Resolver module |
| Generator | Terrazzo with `@terrazzo/plugin-css` |
| Master copy | Token files in the repo; the in-house design tool reads and writes them |
| Tiers | Three: primitive, semantic, component |
| Themes | Light, dark, high contrast |
| OS behaviour | Follow OS dark mode and contrast by default, with a user override; OS accent colour opt-in per app |
| Density | Compact (default) and comfortable |
| Fonts | System font by default; apps may specify a bundled font stack |
| Generated CSS | Committed to git, with a CI check against the source |
| CSS conventions | Plain CSS, `@layer` order `reset, tokens, foundation, app, overrides`, `ui-` prefix, parts joined by `__`, variants and states as data attributes |

## Naming grammar

[TOK-012] Every token's leaf key in JSON is its full name, and its CSS variable is that name with `--` in front. One string, searched without the leading dashes, finds the source, the generated CSS and every usage.

### The three shapes

| Tier | Pattern | Example leaf key | CSS variable |
| --- | --- | --- | --- |
| [TOK-013] Primitive | `ui-ref-{category}[-{scale}]-{step}` | `ui-ref-color-blue-600` | `--ui-ref-color-blue-600` |
| [TOK-014] Semantic | `ui-{category}-{role}[-{variant}]-{leaf}` | `ui-color-bg-accent-hover` | `--ui-color-bg-accent-hover` |
| [TOK-015] Component | `ui-{block}[__{part}]__{category}-{role}[-{variant}]-{leaf}` | `ui-button__color-bg-primary-default` | `--ui-button__color-bg-primary-default` |
| [TOK-016] Component part | (same) | `ui-dialog__trigger__color-fg-default` | `--ui-dialog__trigger__color-fg-default` |

### Separators

- [TOK-017] **Hyphen** joins words inside one segment of meaning.
- [TOK-018] **Double underscore** separates scopes: block, part, then the token. [TOK-019] It never appears inside a semantic or primitive name.
- [TOK-020] Names are lowercase ASCII letters, digits, single hyphens and `__` only. DTCG forbids only a leading `$` and the characters `{`, `}` and `.`, so every name here is valid DTCG.

The `__` rule exists for whole-word search. In ripgrep, `_` counts as a word character and `-` does not. So `rg -w ui-button` matches the class `.ui-button` but not the token `ui-button__color-bg-primary-default`, and `rg -w ui-dialog__trigger` matches the part class but not that part's tokens. A hyphen there would make every class search return its tokens too.

### Reserved words

- [TOK-021] **Prefixes:** `ui-` belongs to the foundation and cannot be renamed by apps. [TOK-022] Each app declares its own prefix in its app config (see App configuration) for tokens and classes it adds.
- [TOK-023] **Tier markers:** `ref` after the prefix marks a primitive; `runtime` marks a variable set by code at runtime, not generated from tokens. [TOK-024] Neither may be used as a category or block name.
- [TOK-025] **Categories** (closed list): `color`, `space`, `size`, `radius`, `border-width`, `font-family`, `font-size`, `font-weight`, `line-height`, `letter-spacing`, `shadow`, `duration`, `easing`, `z-index`, `opacity`. [TOK-026] A component block MUST NOT share a name with a category.
- [TOK-027] **Leaf words** (closed list, extendable by review): interactive states `default`, `hover`, `active`, `selected`, `disabled`, `focus`; scale steps `xs`, `sm`, `md`, `lg`, `xl`, `2xl`. [TOK-028] Every semantic and component name ends in exactly one leaf word. [TOK-029] `default` is only ever a leaf, never a variant: `ui-color-fg-default`, not `ui-color-fg-default-default`.

### Collision rules

1. [TOK-030] **Unique leaf keys.** No two tokens anywhere in a resolver's sources share a leaf key, except across the alternative contexts of one modifier (for example, the four theme files) and in an app's `brand` set, which overrides brand primitives. Groups no longer disambiguate, so this is enforced by lint.
2. [TOK-031] **No segment prefixes.** No token name may equal the leading hyphen-segments of another. `ui-color-bg` alongside `ui-color-bg-accent-default` is an error; `ui-ref-space-4` alongside `ui-ref-space-40` is fine because `4` and `40` are different segments.
3. [TOK-032] **No case variants.** Names that differ only by case are an error, closing a gap DTCG explicitly allows.
4. [TOK-033] **Group path matches the name.** A token's group path MUST equal the start of its leaf key after the prefix, with groups joined by hyphens, or by a double underscore for a component's block and part groups. [TOK-034] A token in group `color` MUST start `ui-color-`; a component token MUST live in a group named after its block. This keeps the JSON tree and the flat names from drifting apart.

## Tiers and reference rules

[TOK-035] Values flow one way: literals into primitives, primitives into semantics, semantics into components. [TOK-036] Only semantic tokens change between themes and densities.

| Tier | `$value` may be | Varies by theme or density | May be used in component CSS |
| --- | --- | --- | --- |
| [TOK-037] Primitive | A literal value only | No | No |
| [TOK-038] Semantic | A primitive or another semantic token | Yes | Yes |
| [TOK-039] Component | A semantic token only | No | Only by its own block |

Rules that follow from the table:

- [TOK-040] **Components never vary by theme.** If a component needs a different value in dark mode, the fix is a new or adjusted semantic token. This keeps every theme change in one place and keeps the resolver orthogonal.
- [TOK-041] **Component CSS uses only** semantic tokens and its own block's component tokens. [TOK-042] `button.css` MUST NOT reference `--ui-ref-*` or `--ui-dialog__*`.
- [TOK-043] **Apps** override primitives (brand ramp, font stack) and may add tokens under their own prefix. [TOK-044] They MUST NOT redefine semantic or component tokens; a need for that means the foundation is missing a semantic token.
- [TOK-045] **Aliases use curly-brace references** (`{ref.color.ui-ref-color-blue-600}`). [TOK-046] JSON Pointer `$ref` is reserved for the resolver file.

### Units

[TOK-047] DTCG dimensions accept only `px` and `rem`. [TOK-048] The profile uses `rem` for spacing, sizes and type, so they scale with the user's font setting and Electron zoom, and `px` for border widths and hairlines. [TOK-049] Percentages and `fr` belong in layout CSS, not tokens.

## File layout

[TOK-050] Shared tokens live in the foundation's `tokens/` folder; component tokens live beside the component that owns them, so a component's tokens, CSS and React code sit in one folder.

```
packages/foundation/
  terrazzo.config.ts
  tokens/
    ui.resolver.json              # resolver: sets, modifiers, resolution order
    ref/                          # primitives
      color.tokens.json
      space.tokens.json
      font.tokens.json
      motion.tokens.json
    sys/                          # semantic tokens that never vary
      base.tokens.json
    theme/                        # semantic colour tokens per theme context
      light.tokens.json
      dark.tokens.json
      light-high-contrast.tokens.json
      dark-high-contrast.tokens.json
    density/                      # semantic spacing tokens per density
      compact.tokens.json
      comfortable.tokens.json
  src/components/button/
    button.tokens.json            # component tokens for ui-button
    button.css
    Button.tsx
  generated/                      # committed, never edited by hand
    tokens.css
    token-names.ts
    TOKENS.md

apps/<app>/
  foundation.config.ts            # prefix and brand file (see App configuration)
  terrazzo.config.ts              # one call to defineAppTerrazzoConfig
  tokens/
    app.resolver.json             # foundation sets + this app's brand set
    brand.tokens.json             # primitive overrides and app-prefixed tokens
  generated/
    tokens.css
    token-names.ts
    TOKENS.md
```

- [TOK-051] File names use the DTCG-recommended `.tokens.json` extension; the resolver uses `.resolver.json`.
- [TOK-052] Every `*.tokens.json` file under `src/components/` MUST be listed in the resolver's `components` set. [TOK-053] A CI check fails if one is missing, since resolver `$ref`s name files individually.
- [TOK-054] `generated/` holds the only files that contain resolved values. [TOK-055] Nothing outside it may be generated.

## Themes, contrast and density

[TOK-056] The resolver has two modifiers, one per token type, following Terrazzo's guidance that one modifier per `$type` keeps a resolver orthogonal: `theme` for colours and `density` for dimensions. [TOK-057] No token appears in both.

```json
{
  "name": "UI Foundation",
  "version": "2025.10",
  "sets": {
    "ref": { "sources": [{ "$ref": "ref/color.tokens.json" }, { "$ref": "ref/space.tokens.json" }, { "$ref": "ref/font.tokens.json" }, { "$ref": "ref/motion.tokens.json" }] },
    "sys": { "sources": [{ "$ref": "sys/base.tokens.json" }] },
    "components": { "sources": [{ "$ref": "../src/components/button/button.tokens.json" }] }
  },
  "modifiers": {
    "theme": {
      "contexts": {
        "light": [{ "$ref": "theme/light.tokens.json" }],
        "dark": [{ "$ref": "theme/dark.tokens.json" }],
        "light-high-contrast": [{ "$ref": "theme/light-high-contrast.tokens.json" }],
        "dark-high-contrast": [{ "$ref": "theme/dark-high-contrast.tokens.json" }]
      },
      "default": "light"
    },
    "density": {
      "contexts": {
        "compact": [{ "$ref": "density/compact.tokens.json" }],
        "comfortable": [{ "$ref": "density/comfortable.tokens.json" }]
      },
      "default": "compact"
    }
  },
  "resolutionOrder": [
    { "$ref": "#/sets/ref" }, { "$ref": "#/sets/sys" },
    { "$ref": "#/modifiers/theme" }, { "$ref": "#/modifiers/density" },
    { "$ref": "#/sets/components" }
  ]
}
```

[TOK-058] Components come last because they only alias semantic tokens, so they resolve against whichever theme and density is active.

### How each context reaches the page

| Context | OS signal | Override | CSS selector it maps to |
| --- | --- | --- | --- |
| [TOK-059] Light (default) | None | `nativeTheme.themeSource = "light"` | `:root` |
| [TOK-060] Dark | `prefers-color-scheme: dark` | `nativeTheme.themeSource = "dark"` | `@media (prefers-color-scheme: dark)` |
| [TOK-061] Light high contrast | `prefers-contrast: more` | `data-contrast="more"` on the root | Contrast media query or attribute, light scheme |
| [TOK-062] Dark high contrast | Both of the above | Both of the above | Contrast media query or attribute, dark scheme |
| [TOK-063] Comfortable density | None | `data-density="comfortable"` on the root | `[data-density="comfortable"]` |

- [TOK-064] **Theme override goes through Electron, not an attribute.** Setting `nativeTheme.themeSource` in the main process changes what `prefers-color-scheme` reports in every renderer, so all windows, including torn-off child windows, native menus and dialogs, switch together. [TOK-065] App CSS needs only the media query.
- [TOK-066] **`data-theme` exists for tooling only:** previews, screenshot tests and the design tool, where there is no Electron main process. [TOK-067] It mirrors the media-query blocks.
- [TOK-068] **Contrast has no Electron equivalent**, so the override is a `data-contrast` attribute (`more` or `standard`) set on each window's root, including child windows.
- [TOK-069] **Windows high contrast mode is not a token theme.** It turns on `forced-colors`, where the OS replaces colours. [TOK-070] Component CSS MUST handle `@media (forced-colors: active)` with system colour keywords; tokens do not try to imitate it.
- [TOK-071] **Layering:** each permutation's `prepare` function wraps its output in `@layer tokens`, so token values always sit below foundation and app styles.

## Per-app branding, fonts and OS accent

[TOK-072] An app rebrands by overriding a small, fixed set of primitives; every semantic and component token then follows automatically in all four themes.

### Brand primitives

[TOK-073] The foundation defines a brand ramp and a UI font stack that semantic tokens point at:

- [TOK-074] `ui-ref-color-brand-50` through `ui-ref-color-brand-950`: the accent ramp. [TOK-075] Light themes use the darker steps, dark themes the lighter ones.
- [TOK-076] `ui-ref-font-family-ui`: the UI font stack, defaulting to the system font (`system-ui` and platform fallbacks).
- [TOK-077] `ui-ref-font-family-mono`: the monospace stack.

[TOK-078] An app's `brand.tokens.json` overrides only these. [TOK-079] Its resolver lists the foundation's `ref` set, then a `brand` set, then the `sys` set, then the modifiers, then the `components` set:

```json
"resolutionOrder": [
  { "$ref": "#/sets/ref" }, { "$ref": "#/sets/brand" }, { "$ref": "#/sets/sys" },
  { "$ref": "#/modifiers/theme" }, { "$ref": "#/modifiers/density" },
  { "$ref": "#/sets/components" }
]
```

[TOK-080] Because the app changes primitives, Terrazzo redeclares every semantic token that depends on them, so each app generates its own complete `tokens.css` rather than layering a patch on the foundation's file.

### Bundled fonts

[TOK-081] An app that bundles a font sets `ui-ref-font-family-ui` to a stack that starts with that font and ends with the system fallbacks. [TOK-082] The `@font-face` rules and font files live in the app, not in tokens.

### OS accent colour (opt-in)

[TOK-083] When an app opts in, the main process reads `systemPreferences.getAccentColor()` and the renderer sets one runtime variable, `--ui-runtime-os-accent`, on each window's root. [TOK-084] The accent semantic tokens then derive their steps from it with CSS relative colour syntax. This is runtime behaviour outside the token pipeline: the derivation is hand-written foundation CSS, not a token `$value`, and its exact recipe is an open item below.

### App-specific tokens

[TOK-085] Tokens an app adds use the app's own prefix and follow the same grammar, tiers and lint rules. [TOK-086] They MUST NOT reuse foundation names.

## App configuration

[TOK-087] Each app declares its prefix and brand file in one config file; the foundation exports factories that build the app's Terrazzo and Stylelint configs from it, so the prefix rules cannot drift between tools.

```ts
// apps/<app>/foundation.config.ts
import { defineAppConfig } from "@foundation/config";

export default defineAppConfig({
  prefix: "ap",
  brandTokens: "./tokens/brand.tokens.json",
});
```

| Field | Required | Rules |
| --- | --- | --- |
| [TOK-088] `prefix` | Yes | 2–4 lowercase letters; not `ui`, `ref` or `runtime`; unique across the monorepo |
| [TOK-089] `brandTokens` | No | Path to the app's brand file; it may only override brand primitives and add tokens under `prefix` |

### Factories the foundation exports

| Factory | Builds |
| --- | --- |
| [TOK-090] `defineAppTerrazzoConfig(appConfig)` | The app resolver (foundation sets plus the brand set), CSS plugin with the profile's `variableName`, and lint rules that allow `ui-` only for brand-primitive overrides and `{prefix}-` for new tokens |
| [TOK-091] `defineAppStylelintConfig(appConfig)` | Naming rules for the app's `{prefix}-` classes and tokens, plus the foundation's rules for consuming `ui-` tokens |
| [TOK-092] Token outputs | `token-names.ts` exporting both `UiTokenName` and the app's own type, for example `ApTokenName` |

### What apps cannot configure

- [TOK-093] **The `ui-` prefix.** Every app, the shared `TOKENS.md`, the design tool and an agent's knowledge use identical foundation names.
- [TOK-094] **The extension namespace.** It belongs to the foundation; apps reuse it for the profile's fields and add their own key only for fields they invent.

### Validation

- [TOK-095] `defineAppConfig` throws when the config loads if `prefix` breaks the rules above.
- [TOK-096] A CI script reads every `apps/*/foundation.config.ts` and fails on duplicate prefixes.

## Token metadata

[TOK-097] Every token carries an explicit `$type` and a `$description`; extra guidance for people and agents goes in one reserved `$extensions` key.

### Required on every token

- [TOK-098] **`$type`** on the token itself, even where a group could supply it. Inherited types are valid DTCG but force a reader to walk up the tree.
- [TOK-099] **`$description`**: one plain sentence saying what the token is for, not what it looks like. "Background for the primary action in a group", not "Blue background".

### Profile extension

[TOK-100] DTCG asks that extension keys use reverse domain notation and that tools preserve extension data they don't understand. [TOK-101] The profile reserves one key: `io.github.chrisdevelops.ui`.

[TOK-102] The namespace belongs to the foundation and is set once. [TOK-103] Apps use the same key on their own tokens because they use the same fields; an app adds its own key only for metadata fields it invents.

```json
"ui-color-fg-default": {
  "$type": "color",
  "$value": "{ref.color.ui-ref-color-gray-900}",
  "$description": "Body text on default surfaces.",
  "$extensions": {
    "io.github.chrisdevelops.ui": {
      "usage": "Paragraphs, labels and table cells.",
      "avoid": "Text on accent backgrounds; use ui-color-fg-on-accent-default.",
      "contrastWith": ["ui-color-bg-default", "ui-color-bg-subtle-default"]
    }
  }
}
```

| Field | Required | Purpose |
| --- | --- | --- |
| [TOK-104] `usage` | Semantic and component tokens | Where to use the token, in one line |
| [TOK-105] `avoid` | No | Common misuse and the token to use instead |
| [TOK-106] `contrastWith` | Foreground colour tokens | Background tokens this foreground must pass contrast against; feeds the contrast lint |

[TOK-107] Extension data is optional metadata, as DTCG recommends: removing it never changes a token's value.

### Deprecation

- [TOK-108] Mark with DTCG's own `$deprecated`, using the string form that names the replacement: `"$deprecated": "Use {color.ui-color-bg-accent-default} instead."`
- [TOK-109] A deprecated token stays for at least one minor release of the foundation.
- [TOK-110] Using a deprecated token in CSS produces a lint warning; removing it while still in use fails CI.

## Generated outputs

[TOK-111] One `tz build` per package writes three committed files into `generated/`; each starts with a header naming its source and saying it must not be edited.

| File | Produced by | For |
| --- | --- | --- |
| [TOK-112] `tokens.css` | The profile plugin, from `@terrazzo/plugin-css` transforms (`skipBuild: true`), with source comments | The app at runtime; grep |
| [TOK-113] `token-names.ts` | Custom Terrazzo plugin | Type-checked token names in TypeScript |
| [TOK-114] `TOKENS.md` | Custom Terrazzo plugin plus a usage scan | Agents and people: one file describing every token |

### tokens.css

- [TOK-115] **Variable names** come from `variableName: (token) => "--" + token.id.split(".").at(-1)`, so the CSS name is `--` plus the leaf key exactly. The plugin documents `variableName` as the hook for renaming variables.
- [TOK-116] **Selectors** come from `permutations`, one per context in the themes table, plus one `[data-theme]` block per theme context for tooling, each wrapped in `@layer tokens`.
- [TOK-117] **Source comments.** Each declaration gets a trailing comment with its file and token path, for example `/* tokens/theme/dark.tokens.json#color.ui-color-bg-default */`. `plugin-css` has no option for this, and its own build drops `_` from `__` leaf keys, so the profile plugin writes the file and adds them from Terrazzo's resolved token list.
- [TOK-118] **Header:** `/* GENERATED by tz build. Edit the source *.tokens.json files, never this file. */`

### token-names.ts

```ts
// GENERATED by tz build. Edit the source *.tokens.json files, never this file.
export const uiTokenNames = [
  "ui-color-bg-default",
  "ui-color-fg-default",
  // ...
] as const;
export type UiTokenName = (typeof uiTokenNames)[number];
export const uiTokenVar = (name: UiTokenName) => `var(--${name})` as const;
```

[TOK-119] Any token referenced from TypeScript (inline styles, canvas drawing, the design tool) goes through `UiTokenName`, so a misspelled name fails the type check.

### TOKENS.md

[TOK-120] One section per tier, then one row per token. It is the file an agent reads instead of walking the JSON.

| Column | Content |
| --- | --- |
| [TOK-121] Name | The leaf key |
| [TOK-122] Type | `$type` |
| [TOK-123] Description | `$description`, plus `usage` and `avoid` from the extension |
| [TOK-124] Values | Resolved value in each theme and density context |
| [TOK-125] Source | File and token path |
| [TOK-126] Used by | CSS files that reference it, from a scan of `var(--name)` |
| [TOK-127] Status | Deprecated and its replacement, when set |

## Lint and CI rules

Three layers enforce the profile: Terrazzo lint on token files, Stylelint on CSS, and CI checks on the generated files. [TOK-128] All run locally and in CI; all are errors unless marked.

### Token files: built-in Terrazzo rules

| Rule | Setting | Why |
| --- | --- | --- |
| [TOK-129] `core/required-type` | error | Every token states its type |
| [TOK-130] `core/descriptions` | error | Every token explains its purpose |
| [TOK-131] `core/consistent-naming` | error, custom validator (receives the dotted id; the leaf is its last segment; a truthy return is an error) | Checks the naming grammar on every leaf key |
| [TOK-132] `core/valid-*` (all) | error | Values follow the DTCG format |
| [TOK-133] `core/valid-dimension` | error, units `px` and `rem` | Matches the units rule |
| [TOK-134] `core/required-modes` | error | Every semantic colour token exists in all four theme contexts |
| [TOK-135] `core/max-gamut` | error, option `gamut: "srgb"`; colours authored in `oklch` | Predictable colour across displays |
| [TOK-136] `a11y/min-contrast` | error, AA; pairs built from `contrastWith` | Contrast is checked, not hoped for |
| [TOK-137] `core/duplicate-values` | warn, primitives ignored | Flags semantic tokens that should alias |

### Token files: profile rules (custom Terrazzo lint plugin)

- [TOK-138] **`ui/unique-leaf-names`**: no two tokens share a leaf key, except as collision rule 1 allows.
- [TOK-139] **`ui/no-segment-prefix`**: no name equals the leading segments of another.
- [TOK-140] **`ui/no-case-variants`**: no names that differ only by case.
- [TOK-141] **`ui/group-matches-name`**: group path matches the name, as collision rule 4 defines.
- [TOK-142] **`ui/tier-references`**: primitives hold literals; semantics alias primitives or semantics; components alias semantics only.
- [TOK-143] **`ui/components-theme-invariant`**: no component token appears in a theme or density context file.
- [TOK-144] **`ui/extension-fields`**: `usage` present on semantic and component tokens; `contrastWith` on foreground colours.

### CSS: Stylelint

- [TOK-145] **No raw values** for colour, spacing, radius, font, shadow, duration or easing properties in foundation and app CSS; only `var(--…)`. Candidate plugin: `stylelint-declaration-strict-value`, to verify.
- [TOK-146] **No primitives** (`--ui-ref-*`) in any component CSS.
- [TOK-147] **Own block only:** a component file may reference component tokens of its own block, matched by file and block name.
- [TOK-148] **Known tokens only:** every `var(--ui-…)` must exist in `token-names.ts`, except a closed list of reserved `--ui-runtime-*` variables.
- [TOK-149] **Deprecated tokens** produce a warning.
- [TOK-150] **Forced colours:** each interactive component file includes a `@media (forced-colors: active)` block. This is the minimum that lint enforces; the forced-colours rule under Themes, contrast and density applies to all component CSS.

### CI checks

1. [TOK-151] Run `tz build`; fail if any file in `generated/` differs from what is committed.
2. [TOK-152] Fail if a component `*.tokens.json` is missing from the resolver's `components` set.
3. [TOK-153] Fail if a removed token is still referenced in CSS or TypeScript.
4. [TOK-154] Run the gate tests below.

## Gate tests

The token pipeline is one black box: token files and a resolver go in; `tokens.css`, `token-names.ts` and `TOKENS.md` come out, or a build error naming the file and token. These tests are written before the pipeline and guard its contract; its internals may change freely while they pass.

**Input:** a resolver plus `*.tokens.json` fixtures. [TOK-155] **Output:** the three generated files, or a non-zero exit with errors in the shape `file#token.path: rule-id: message`.

### Correct output

| # | Input | Expected |
| --- | --- | --- |
| [TOK-156] 1 | Valid fixture system | Builds; outputs match committed snapshots |
| [TOK-157] 2 | Valid fixture system | Every CSS variable equals `--` plus a leaf key, and every leaf key appears verbatim in a source file |
| [TOK-158] 3 | Valid fixture system | Each theme and density context has its selector block inside `@layer tokens` |
| [TOK-159] 4 | Valid fixture system | Every declaration carries a source comment that points at a real file and path |
| [TOK-160] 5 | Valid fixture system | `token-names.ts` type-checks and lists every token exactly once |
| [TOK-161] 6 | App fixture overriding the brand ramp | App `tokens.css` redeclares affected semantic tokens; component tokens unchanged |

### Failure modes

| # | Input | Expected error rule |
| --- | --- | --- |
| [TOK-162] 7 | Name breaking the grammar | `core/consistent-naming` |
| [TOK-163] 8 | Same leaf key in two files that are not alternative contexts | `ui/unique-leaf-names` |
| [TOK-164] 9 | `ui-color-bg` beside `ui-color-bg-subtle-default` | `ui/no-segment-prefix` |
| [TOK-165] 10 | Component token aliasing a primitive | `ui/tier-references` |
| [TOK-166] 11 | Component token inside `theme/dark.tokens.json` | `ui/components-theme-invariant` |
| [TOK-167] 12 | Token without `$description` | `core/descriptions` |
| [TOK-168] 13 | Foreground failing AA against a `contrastWith` background | `a11y/min-contrast` |
| [TOK-169] 14 | Semantic colour missing from one theme context | `core/required-modes` |
| [TOK-170] 15 | Hand-edited `generated/tokens.css` | CI drift check fails |
| [TOK-171] 16 | Component CSS using `--ui-ref-color-blue-600` | Stylelint primitive rule |
| [TOK-172] 17 | Component CSS with a hex colour | Stylelint raw-value rule |
| [TOK-173] 18 | App config with prefix "ui" or "UI1" | defineAppConfig throws at config load |
| [TOK-174] 19 | Two apps declaring the same prefix | CI prefix-uniqueness check fails |
| [TOK-175] 20 | App brand file redefining a semantic token | App lint rejects the override |

### Security

| # | Input | Expected |
| --- | --- | --- |
| [TOK-176] 21 | Resolver `$ref` to a remote URL | Build refuses; only relative paths inside the monorepo are allowed |
| [TOK-177] 22 | Resolver `$ref` that escapes the repo root | Build refuses |

### Performance

| # | Input | Expected |
| --- | --- | --- |
| [TOK-178] 23 | Generated system of 2,000 tokens, 4 themes, 2 densities | Full build within a budget set after the first measured run |
| [TOK-179] 24 | Running app, theme switched via `nativeTheme.themeSource` | Computed token values update in every open window, child windows included |

## Open items

One item needs your decision; the rest are facts to confirm while building the pipeline, each settled by a gate test or a short spike.

### Decisions

- [x] **Extension namespace:** settled as `io.github.chrisdevelops.ui` (ADR 0003).
- [x] **App prefix scheme:** settled. Each app sets `prefix` in `foundation.config.ts`; see App configuration.

### To verify during build

- [x] `core/consistent-naming` with a custom validator receives the leaf key, not only the dotted path; if not, the grammar check moves into the profile plugin. Spike #7: it receives the dotted id; the leaf is its last segment.
- [x] `core/required-modes` and `a11y/min-contrast` evaluate resolver contexts, not only legacy `$extensions.mode`; if not, profile rules replace them. Spike #7: they do not; profile rules replace them.
- [x] `core/max-gamut` option name: `gamut` (spike #7; `format` is ignored). sRGB only for now; Display P3 later (ADR 0004).
- [x] Authoring colour space: `core/colorspace` accepts `oklch` (spike #7).
- [x] Resolver `$ref`s to paths outside `tokens/` (component files, and the foundation from an app) resolve correctly (spike #7).
- [x] Terrazzo's plugin and lint APIs support the custom outputs and rules as described (spike #7), except that the profile plugin writes `tokens.css`.
- [x] Source-comment step: read file and path per token from Terrazzo's resolved output (spike #7).
- [ ] Stylelint plugin for the raw-value rule.
- [ ] OS accent: CSS relative-colour recipe that derives the accent steps from `--ui-runtime-os-accent` with acceptable contrast in all four themes.
- [ ] Performance budget for gate test 23, set after the first measured build.
- [ ] In-house design tool preserves unknown `$extensions` data on save, which DTCG requires of any tool.

## Sources

- [DTCG Format Module 2025.10](https://www.w3.org/community/reports/design-tokens/CG-FINAL-format-20251028/): name restrictions, `$description`, `$type`, `$extensions`, `$deprecated`, dimension units
- [Terrazzo: Resolvers and theming](https://terrazzo.app/docs/guides/resolvers/): sets, modifiers, contexts, orthogonality, one modifier per type
- [Terrazzo: CSS plugin](https://terrazzo.app/docs/integrations/css/): `variableName`, `permutations`, alias redeclaration
- [Terrazzo: Lint](https://terrazzo.app/docs/linting/): built-in rules and options
- [Electron nativeTheme tests](https://github.com/electron/electron/blob/c8d924b08e420d03594f658ef1abe14a4fe8b1de/spec-main/api-native-theme-spec.ts): `themeSource` changes `prefers-color-scheme` in renderers
