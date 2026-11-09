# Design Token Profile Spec

Nov 6, 2026 · @Chris Lloyd

## Purpose and scope

The profile is a set of rules layered on DTCG 2025.10 and Terrazzo so that every token has one exact name that appears verbatim in its source file, its generated CSS and every usage. Token files stay valid DTCG; nothing here requires a custom parser.

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

Every token's leaf key in JSON is its full name, and its CSS variable is that name with `--` in front. One string, searched without the leading dashes, finds the source, the generated CSS and every usage.

### The three shapes

| Tier | Pattern | Example leaf key | CSS variable |
| --- | --- | --- | --- |
| Primitive | `ui-ref-{category}-{scale}-{step}` | `ui-ref-color-blue-600` | `--ui-ref-color-blue-600` |
| Semantic | `ui-{category}-{role}[-{variant}]-{leaf}` | `ui-color-bg-accent-hover` | `--ui-color-bg-accent-hover` |
| Component | `ui-{block}[__{part}]__{category}-{role}[-{variant}]-{leaf}` | `ui-button__color-bg-primary-default` | `--ui-button__color-bg-primary-default` |
| Component part | (same) | `ui-dialog__trigger__color-fg-default` | `--ui-dialog__trigger__color-fg-default` |

### Separators

- **Hyphen** joins words inside one segment of meaning.
- **Double underscore** separates scopes: block, part, then the token. It never appears inside a semantic or primitive name.
- Names are lowercase ASCII letters, digits, single hyphens and `__` only. DTCG forbids only a leading `$` and the characters `{`, `}` and `.`, so every name here is valid DTCG.

The `__` rule exists for whole-word search. In ripgrep, `_` counts as a word character and `-` does not. So `rg -w ui-button` matches the class `.ui-button` but not the token `ui-button__color-bg-primary-default`, and `rg -w ui-dialog__trigger` matches the part class but not that part's tokens. A hyphen there would make every class search return its tokens too.

### Reserved words

- **Prefixes:** `ui-` belongs to the foundation and cannot be renamed by apps. Each app declares its own prefix in its app config (see App configuration) for tokens and classes it adds.
- **Tier markers:** `ref` after the prefix marks a primitive; `runtime` marks a variable set by code at runtime, not generated from tokens. Neither may be used as a category or block name.
- **Categories** (closed list): `color`, `space`, `size`, `radius`, `border-width`, `font-family`, `font-size`, `font-weight`, `line-height`, `letter-spacing`, `shadow`, `duration`, `easing`, `z-index`, `opacity`. A component block MUST NOT share a name with a category.
- **Leaf words** (closed list, extendable by review): interactive states `default`, `hover`, `active`, `selected`, `disabled`, `focus`; scale steps `xs`, `sm`, `md`, `lg`, `xl`, `2xl`. Every semantic and component name ends in exactly one leaf word. `default` is only ever a leaf, never a variant: `ui-color-fg-default`, not `ui-color-fg-default-default`.

### Collision rules

1. **Unique leaf keys.** No two tokens anywhere in a resolver's sources share a leaf key. Groups no longer disambiguate, so this is enforced by lint.
2. **No segment prefixes.** No token name may equal the leading hyphen-segments of another. `ui-color-bg` alongside `ui-color-bg-accent-default` is an error; `ui-ref-space-4` alongside `ui-ref-space-40` is fine because `4` and `40` are different segments.
3. **No case variants.** Names that differ only by case are an error, closing a gap DTCG explicitly allows.
4. **Group path matches the name.** A token's group path MUST equal the start of its leaf key after the prefix, with groups joined by hyphens, or by a double underscore for a component's block and part groups. A token in group `color` MUST start `ui-color-`; a component token MUST live in a group named after its block. This keeps the JSON tree and the flat names from drifting apart.

## Tiers and reference rules

Values flow one way: literals into primitives, primitives into semantics, semantics into components. Only semantic tokens change between themes and densities.

| Tier | `$value` may be | Varies by theme or density | May be used in component CSS |
| --- | --- | --- | --- |
| Primitive | A literal value only | No | No |
| Semantic | A primitive or another semantic token | Yes | Yes |
| Component | A semantic token only | No | Only by its own block |

Rules that follow from the table:

- **Components never vary by theme.** If a component needs a different value in dark mode, the fix is a new or adjusted semantic token. This keeps every theme change in one place and keeps the resolver orthogonal.
- **Component CSS uses only** semantic tokens and its own block's component tokens. `button.css` MUST NOT reference `--ui-ref-*` or `--ui-dialog__*`.
- **Apps** override primitives (brand ramp, font stack) and may add tokens under their own prefix. They MUST NOT redefine semantic or component tokens; a need for that means the foundation is missing a semantic token.
- **Aliases use curly-brace references** (`{ref.color.ui-ref-color-blue-600}`). JSON Pointer `$ref` is reserved for the resolver file.

### Units

DTCG dimensions accept only `px` and `rem`. The profile uses `rem` for spacing, sizes and type, so they scale with the user's font setting and Electron zoom, and `px` for border widths and hairlines. Percentages and `fr` belong in layout CSS, not tokens.

## File layout

Shared tokens live in the foundation's `tokens/` folder; component tokens live beside the component that owns them, so a component's tokens, CSS and React code sit in one folder.

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

- File names use the DTCG-recommended `.tokens.json` extension; the resolver uses `.resolver.json`.
- Every `*.tokens.json` file under `src/components/` MUST be listed in the resolver's `components` set. A CI check fails if one is missing, since resolver `$ref`s name files individually.
- `generated/` holds the only files that contain resolved values. Nothing outside it may be generated.

## Themes, contrast and density

The resolver has two modifiers, one per token type, following Terrazzo's guidance that one modifier per `$type` keeps a resolver orthogonal: `theme` for colours and `density` for dimensions. No token appears in both.

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

Components come last because they only alias semantic tokens, so they resolve against whichever theme and density is active.

### How each context reaches the page

| Context | OS signal | Override | CSS selector it maps to |
| --- | --- | --- | --- |
| Light (default) | None | `nativeTheme.themeSource = "light"` | `:root` |
| Dark | `prefers-color-scheme: dark` | `nativeTheme.themeSource = "dark"` | `@media (prefers-color-scheme: dark)` |
| Light high contrast | `prefers-contrast: more` | `data-contrast="more"` on the root | Contrast media query or attribute, light scheme |
| Dark high contrast | Both of the above | Both of the above | Contrast media query or attribute, dark scheme |
| Comfortable density | None | `data-density="comfortable"` on the root | `[data-density="comfortable"]` |

- **Theme override goes through Electron, not an attribute.** Setting `nativeTheme.themeSource` in the main process changes what `prefers-color-scheme` reports in every renderer, so all windows, including torn-off child windows, native menus and dialogs, switch together. CSS needs only the media query.
- **`data-theme` exists for tooling only:** previews, screenshot tests and the design tool, where there is no Electron main process. It mirrors the media-query blocks.
- **Contrast has no Electron equivalent**, so the override is a `data-contrast` attribute (`more` or `standard`) set on each window's root, including child windows.
- **Windows high contrast mode is not a token theme.** It turns on `forced-colors`, where the OS replaces colours. Component CSS MUST handle `@media (forced-colors: active)` with system colour keywords; tokens do not try to imitate it.
- **Layering:** each permutation's `prepare` function wraps its output in `@layer tokens`, so token values always sit below foundation and app styles.

## Per-app branding, fonts and OS accent

An app rebrands by overriding a small, fixed set of primitives; every semantic and component token then follows automatically in all four themes.

### Brand primitives

The foundation defines a brand ramp and a UI font stack that semantic tokens point at:

- `ui-ref-color-brand-50` through `ui-ref-color-brand-950`: the accent ramp. Light themes use the darker steps, dark themes the lighter ones.
- `ui-ref-font-family-ui`: the UI font stack, defaulting to the system font (`system-ui` and platform fallbacks).
- `ui-ref-font-family-mono`: the monospace stack.

An app's `brand.tokens.json` overrides only these. Its resolver lists the foundation's sets, then a `brand` set, then the modifiers:

```json
"resolutionOrder": [
  { "$ref": "#/sets/ref" }, { "$ref": "#/sets/brand" }, { "$ref": "#/sets/sys" },
  { "$ref": "#/modifiers/theme" }, { "$ref": "#/modifiers/density" },
  { "$ref": "#/sets/components" }
]
```

Because the app changes primitives, Terrazzo redeclares every semantic token that depends on them, so each app generates its own complete `tokens.css` rather than layering a patch on the foundation's file.

### Bundled fonts

An app that bundles a font sets `ui-ref-font-family-ui` to a stack that starts with that font and ends with the system fallbacks. The `@font-face` rules and font files live in the app, not in tokens.

### OS accent colour (opt-in)

When an app opts in, the main process reads `systemPreferences.getAccentColor()` and the renderer sets one runtime variable, `--ui-runtime-os-accent`, on each window's root. The accent semantic tokens then derive their steps from it with CSS relative colour syntax. This is runtime behaviour outside the token pipeline; its exact derivation is an open item below.

### App-specific tokens

Tokens an app adds use the app's own prefix and follow the same grammar, tiers and lint rules. They MUST NOT reuse foundation names.

## App configuration

Each app declares its prefix and brand file in one config file; the foundation exports factories that build the app's Terrazzo and Stylelint configs from it, so the prefix rules cannot drift between tools.

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
| `prefix` | Yes | 2–4 lowercase letters; not `ui`, `ref` or `runtime`; unique across the monorepo |
| `brandTokens` | No | Path to the app's brand file; it may only override brand primitives and add tokens under `prefix` |

### Factories the foundation exports

| Factory | Builds |
| --- | --- |
| `defineAppTerrazzoConfig(appConfig)` | The app resolver (foundation sets plus the brand set), CSS plugin with the profile's `variableName`, and lint rules that allow `ui-` only for brand-primitive overrides and `{prefix}-` for new tokens |
| `defineAppStylelintConfig(appConfig)` | Naming rules for the app's `{prefix}-` classes and tokens, plus the foundation's rules for consuming `ui-` tokens |
| Token outputs | `token-names.ts` exporting both `UiTokenName` and the app's own type, for example `ApTokenName` |

### What apps cannot configure

- **The `ui-` prefix.** Every app, the shared `TOKENS.md`, the design tool and an agent's knowledge use identical foundation names.
- **The extension namespace.** It belongs to the foundation; apps reuse it for the profile's fields and add their own key only for fields they invent.

### Validation

- `defineAppConfig` throws when the config loads if `prefix` breaks the rules above.
- A CI script reads every `apps/*/foundation.config.ts` and fails on duplicate prefixes.

## Token metadata

Every token carries an explicit `$type` and a `$description`; extra guidance for people and agents goes in one reserved `$extensions` key.

### Required on every token

- **`$type`** on the token itself, even where a group could supply it. Inherited types are valid DTCG but force a reader to walk up the tree.
- **`$description`**: one plain sentence saying what the token is for, not what it looks like. "Background for the primary action in a group", not "Blue background".

### Profile extension

DTCG asks that extension keys use reverse domain notation and that tools preserve extension data they don't understand. The profile reserves one key, written below as `<namespace>.ui` until the real namespace is chosen.

The namespace belongs to the foundation and is set once. Apps use the same key on their own tokens because they use the same fields; an app adds its own key only for metadata fields it invents.

```json
"ui-color-fg-default": {
  "$type": "color",
  "$value": "{ref.color.ui-ref-color-gray-900}",
  "$description": "Body text on default surfaces.",
  "$extensions": {
    "<namespace>.ui": {
      "usage": "Paragraphs, labels and table cells.",
      "avoid": "Text on accent backgrounds; use ui-color-fg-on-accent-default.",
      "contrastWith": ["ui-color-bg-default", "ui-color-bg-subtle-default"]
    }
  }
}
```

| Field | Required | Purpose |
| --- | --- | --- |
| `usage` | Semantic and component tokens | Where to use the token, in one line |
| `avoid` | No | Common misuse and the token to use instead |
| `contrastWith` | Foreground colour tokens | Background tokens this foreground must pass contrast against; feeds the contrast lint |

Extension data is optional metadata, as DTCG recommends: removing it never changes a token's value.

### Deprecation

- Mark with DTCG's own `$deprecated`, using the string form that names the replacement: `"$deprecated": "Use {color.ui-color-bg-accent-default} instead."`
- A deprecated token stays for at least one minor release of the foundation.
- Using a deprecated token in CSS produces a lint warning; removing it while still in use fails CI.

## Generated outputs

One `tz build` per package writes three committed files into `generated/`; each starts with a header naming its source and saying it must not be edited.

| File | Produced by | For |
| --- | --- | --- |
| `tokens.css` | `@terrazzo/plugin-css` plus a source-comment step | The app at runtime; grep |
| `token-names.ts` | Custom Terrazzo plugin | Type-checked token names in TypeScript |
| `TOKENS.md` | Custom Terrazzo plugin plus a usage scan | Agents and people: one file describing every token |

### tokens.css

- **Variable names** come from `variableName: (token) => token.id.split(".").at(-1)`, so the CSS name is the leaf key exactly. The plugin documents `variableName` as the hook for renaming variables.
- **Selectors** come from `permutations`, one per context in the themes table, each wrapped in `@layer tokens`.
- **Source comments.** Each declaration gets a trailing comment with its file and token path, for example `/* tokens/theme/dark.tokens.json#color.ui-color-bg-default */`. `plugin-css` has no option for this, so a small step after the build adds them from Terrazzo's resolved token list.
- **Header:** `/* GENERATED by tz build. Edit tokens/**/*.tokens.json, never this file. */`

### token-names.ts

```ts
// GENERATED by tz build. Edit tokens/**/*.tokens.json, never this file.
export const uiTokenNames = [
  "ui-color-bg-default",
  "ui-color-fg-default",
  // ...
] as const;
export type UiTokenName = (typeof uiTokenNames)[number];
export const uiTokenVar = (name: UiTokenName) => `var(--${name})` as const;
```

Any token referenced from TypeScript (inline styles, canvas drawing, the design tool) goes through `UiTokenName`, so a misspelled name fails the type check.

### TOKENS.md

One section per tier, then one row per token. It is the file an agent reads instead of walking the JSON.

| Column | Content |
| --- | --- |
| Name | The leaf key |
| Type | `$type` |
| Description | `$description`, plus `usage` and `avoid` from the extension |
| Values | Resolved value in each theme and density context |
| Source | File and token path |
| Used by | CSS files that reference it, from a scan of `var(--name)` |
| Status | Deprecated and its replacement, when set |

## Lint and CI rules

Three layers enforce the profile: Terrazzo lint on token files, Stylelint on CSS, and CI checks on the generated files. All run locally and in CI; all are errors unless marked.

### Token files: built-in Terrazzo rules

| Rule | Setting | Why |
| --- | --- | --- |
| `core/required-type` | error | Every token states its type |
| `core/descriptions` | error | Every token explains its purpose |
| `core/consistent-naming` | error, custom validator | Checks the naming grammar on every leaf key |
| `core/valid-*` (all) | error | Values follow the DTCG format |
| `core/valid-dimension` | error, units `px` and `rem` | Matches the units rule |
| `core/required-modes` | error | Every semantic colour token exists in all four theme contexts |
| `core/max-gamut` | error, `srgb` (see open items) | Predictable colour across displays |
| `a11y/min-contrast` | error, AA; pairs built from `contrastWith` | Contrast is checked, not hoped for |
| `core/duplicate-values` | warn, primitives ignored | Flags semantic tokens that should alias |

### Token files: profile rules (custom Terrazzo lint plugin)

- **`ui/unique-leaf-names`**: no two tokens share a leaf key.
- **`ui/no-segment-prefix`**: no name equals the leading segments of another.
- **`ui/no-case-variants`**: no names that differ only by case.
- **`ui/group-matches-name`**: group path joined by hyphens equals the start of the name.
- **`ui/tier-references`**: primitives hold literals; semantics alias primitives or semantics; components alias semantics only.
- **`ui/components-theme-invariant`**: no component token appears in a theme or density context file.
- **`ui/extension-fields`**: `usage` present on semantic and component tokens; `contrastWith` on foreground colours.

### CSS: Stylelint

- **No raw values** for colour, spacing, radius, font, shadow, duration or easing properties in foundation and app CSS; only `var(--…)`. Candidate plugin: `stylelint-declaration-strict-value`, to verify.
- **No primitives** (`--ui-ref-*`) in any component CSS.
- **Own block only:** a component file may reference component tokens of its own block, matched by file and block name.
- **Known tokens only:** every `var(--ui-…)` must exist in `token-names.ts`.
- **Deprecated tokens** produce a warning.
- **Forced colours:** each interactive component file includes a `@media (forced-colors: active)` block.

### CI checks

1. Run `tz build`; fail if any file in `generated/` differs from what is committed.
2. Fail if a component `*.tokens.json` is missing from the resolver's `components` set.
3. Fail if a removed token is still referenced in CSS or TypeScript.
4. Run the gate tests below.

## Gate tests

The token pipeline is one black box: token files and a resolver go in; `tokens.css`, `token-names.ts` and `TOKENS.md` come out, or a build error naming the file and token. These tests are written before the pipeline and guard its contract; its internals may change freely while they pass.

**Input:** a resolver plus `*.tokens.json` fixtures. **Output:** the three generated files, or a non-zero exit with errors in the shape `file#token.path: rule-id: message`.

### Correct output

| # | Input | Expected |
| --- | --- | --- |
| 1 | Valid fixture system | Builds; outputs match committed snapshots |
| 2 | Valid fixture system | Every CSS variable equals `--` plus a leaf key, and every leaf key appears verbatim in a source file |
| 3 | Valid fixture system | Each theme and density context has its selector block inside `@layer tokens` |
| 4 | Valid fixture system | Every declaration carries a source comment that points at a real file and path |
| 5 | Valid fixture system | `token-names.ts` type-checks and lists every token exactly once |
| 6 | App fixture overriding the brand ramp | App `tokens.css` redeclares affected semantic tokens; component tokens unchanged |

### Failure modes

| # | Input | Expected error rule |
| --- | --- | --- |
| 7 | Name breaking the grammar | `core/consistent-naming` |
| 8 | Same leaf key in two files | `ui/unique-leaf-names` |
| 9 | `ui-color-bg` beside `ui-color-bg-subtle-default` | `ui/no-segment-prefix` |
| 10 | Component token aliasing a primitive | `ui/tier-references` |
| 11 | Component token inside `theme/dark.tokens.json` | `ui/components-theme-invariant` |
| 12 | Token without `$description` | `core/descriptions` |
| 13 | Foreground failing AA against a `contrastWith` background | `a11y/min-contrast` |
| 14 | Semantic colour missing from one theme context | `core/required-modes` |
| 15 | Hand-edited `generated/tokens.css` | CI drift check fails |
| 16 | Component CSS using `--ui-ref-color-blue-600` | Stylelint primitive rule |
| 17 | Component CSS with a hex colour | Stylelint raw-value rule |
| 18 | App config with prefix "ui" or "UI1" | defineAppConfig throws at config load |
| 19 | Two apps declaring the same prefix | CI prefix-uniqueness check fails |
| 20 | App brand file redefining a semantic token | App lint rejects the override |

### Security

| # | Input | Expected |
| --- | --- | --- |
| 21 | Resolver `$ref` to a remote URL | Build refuses; only relative paths inside the monorepo are allowed |
| 22 | Resolver `$ref` that escapes the repo root | Build refuses |

### Performance

| # | Input | Expected |
| --- | --- | --- |
| 23 | Generated system of 2,000 tokens, 4 themes, 2 densities | Full build within a budget set after the first measured run |
| 24 | Running app, theme switched via `nativeTheme.themeSource` | Computed token values update in every open window, child windows included |

## Open items

One item needs your decision; the rest are facts to confirm while building the pipeline, each settled by a gate test or a short spike.

### Decisions

- [ ] **Extension namespace:** the reverse-domain key replacing `<namespace>.ui`, chosen once for the foundation (for example, a domain you own).
- [x] **App prefix scheme:** settled. Each app sets `prefix` in `foundation.config.ts`; see App configuration.

### To verify during build

- [ ] `core/consistent-naming` with a custom validator receives the leaf key, not only the dotted path; if not, the grammar check moves into the profile plugin.
- [ ] `core/required-modes` and `a11y/min-contrast` evaluate resolver contexts, not only legacy `$extensions.mode`; if not, profile rules replace them.
- [ ] `core/max-gamut` option name: the docs show both `gamut` and `format`. Also decide sRGB only or Display P3, since Electron renders P3 and the CSS plugin down-converts automatically.
- [ ] Authoring colour space: confirm `core/colorspace` accepts `oklch`, the planned authoring space.
- [ ] Resolver `$ref`s to paths outside `tokens/` (component files, and the foundation from an app) resolve correctly.
- [ ] Terrazzo's plugin and lint APIs support the custom outputs and rules as described.
- [ ] Source-comment step: read file and path per token from Terrazzo's resolved output.
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
