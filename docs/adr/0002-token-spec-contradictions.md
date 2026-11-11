# ADR 0002: Resolve eight contradictions in the specs

- **Status:** accepted
- **Weight:** major
- **Date:** 2026-11-09
- **Raised by:** planner, #1
- **Decided by:** human (major)
- **Affects:** TOK-002, TOK-013, TOK-030, TOK-033, TOK-065, TOK-067, TOK-070, TOK-079, TOK-084, TOK-116, TOK-118, TOK-134, TOK-138, TOK-141, TOK-148, TOK-150, TOK-163, TOK-169

## Context

Adding requirement IDs in #1 showed places where the specs contradict themselves. IDs refer to `task/1-requirement-ids`. Items 1, 3 and 4 fail the spec's own lint or gate tests on the spec's own examples. Each decision below is independent.

## Options and recommendations

### 1. Unique leaf keys and theme files

TOK-030, TOK-138 and TOK-163 forbid one leaf key in two files. TOK-134 requires each semantic colour in all four theme files, and brand files redeclare `ui-ref-color-brand-*`. A valid token system fails lint as written.

- **A (recommended):** a leaf key may repeat only across alternative contexts of one modifier, and in an app's `brand` set for brand primitives. Every other repeat is an error. Gate 8 uses two files that are not alternatives.
- **B:** keep one definition per key and encode the theme in the name. This breaks one name for all themes and removes the resolver's purpose.

### 2. Which tier themes and apps change

The TOK-002 rationale says "Themes and apps change only the semantic layer". TOK-043 and TOK-044 say apps override primitives and MUST NOT redefine semantic tokens.

- **A (recommended):** the token spec is correct. Amend the rationale to "Themes change only the semantic layer; apps change only brand primitives".
- **B:** allow apps to redefine semantic tokens. This removes the TOK-044 guard and gate 20.

### 3. Primitive grammar

TOK-013 requires `ui-ref-{category}-{scale}-{step}`. `ui-ref-space-4` has no scale, and `ui-ref-font-family-ui` has no step.

- **A (recommended):** change the pattern to `ui-ref-{category}[-{scale}]-{step}`, where a step is a number or a single word. All names in the spec then fit.
- **B:** keep the pattern and rename the examples, for example `ui-ref-space-base-4` and `ui-ref-font-family-stack-ui`. The names get longer and the extra words carry no meaning.

### 4. Runtime variable and token lint

TOK-148 requires every `var(--ui-…)` to exist in `token-names.ts`. `--ui-runtime-os-accent` is not generated. The TOK-084 derivation also falls outside the permitted `$value` forms.

- **A (recommended):** exempt the reserved `--ui-runtime-*` namespace from TOK-148, through a closed list in the Stylelint rule. The OS accent derivation is hand-written CSS outside the token files. It stays opt-in per app.
- **B:** add a runtime token type to the token files. This needs a custom format, which conflicts with the rule that nothing requires a custom parser.

### 5. App resolver order

The TOK-079 prose says foundation sets, then `brand`, then modifiers. The code block has `ref`, `brand`, `sys`, `theme`, `density`, `components`.

- **A (recommended):** the code block is correct, because `brand` must sit directly after `ref` and components must resolve last. Amend the prose.
- **B:** follow the prose. Component tokens then resolve before the modifiers, which conflicts with the foundation resolver.

### 6. Group path wording

TOK-033 uses hyphens, or `__` for component block and part groups, after the prefix. TOK-141 says hyphens only.

- **A (recommended):** TOK-033 is correct. Amend TOK-141 to refer to it.
- **B:** hyphens only. This breaks the component token shape in TOK-015.

### 7. Forced-colours scope

TOK-070 says component CSS MUST handle `forced-colors`. TOK-150 lints only interactive component files.

- **A (recommended):** keep both and state the relation: TOK-070 is the rule for all components; TOK-150 is the minimum that lint can enforce.
- **B:** narrow TOK-070 to interactive components. This weakens the accessibility bar in XC-005.

### 8. `data-theme` output and generated header

TOK-067 says `data-theme` mirrors the media-query blocks. TOK-116 generates one selector per context in a table with no `data-theme` selectors, and TOK-065 says CSS needs only the media query. Separately, the TOK-118 header names `tokens/**/*.tokens.json`, but component tokens live in `src/components/`.

- **A (recommended):** generate `[data-theme]` blocks as well, for tooling only. Scope TOK-065 to application behaviour. Change the header to `Edit the source *.tokens.json files, never this file.`
- **B:** remove `data-theme` and run tooling through emulated media queries. This changes the screenshot and design tool plan.

## Decision

The human chose option A for all eight items on 2026-11-11.

## Follow-up

- [x] Spec updated (`docs/foundation/token-profile-spec.md` and `docs/foundation/decision-summary.md`), keeping existing IDs
- [x] Ledger updated: affected rows note ADR 0002
- [x] Issues created or changed: #3
