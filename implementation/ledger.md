# Requirement coverage ledger

> One row per requirement ID from the specs. Filled by the planner in phase 0; updated by the orchestrator on every merge. Nothing in the specs is dropped: if it isn't `done`, it's still here.

**Status values:** `not-started` · `stubbed` (marked `DEFERRED:` in code, with a `test.todo`) · `done` (gate tests pass) · `superseded` (replaced by an ADR)

## ID prefixes

| Prefix | Area | Spec |
| --- | --- | --- |
| `PLT` | Platform, repository, build, security | Decision summary |
| `CMP` | Components and styling | Decision summary |
| `TOK` | Tokens and theming | Both |
| `CMD` | Commands, menus, windows | Decision summary |
| `STA` | State, IPC, data, messages, forms | Decision summary |
| `TST` | Testing and quality | Decision summary |
| `XC` | Cross-cutting requirements | Decision summary |

## Ledger

| ID | Requirement (short) | Status | Tests | Issue | Notes |
| --- | --- | --- | --- | --- | --- |
| PLT-001 | Agent documentation is in scope for the foundation | not-started | — | — |  |
| PLT-002 | React is the UI framework | done | tools/reference-app/reference-app-build | #15 |  |
| PLT-003 | pnpm monorepo with the foundation as a workspace package | done | tools/repo/workspace-config, clean-clone | #12 | ADR 0004 |
| PLT-004 | Turborepo is the task runner | done | tools/repo/clean-clone | #12 |  |
| PLT-005 | Electron Forge with its Vite plugin, version pinned | done | tools/reference-app/reference-app-manifest, reference-app-build | #15 |  |
| PLT-006 | ESLint and Prettier are the linter and formatter | not-started | — | #12 | base config in #12; plugin rules later |
| PLT-007 | Packaging is per app; App Store-unfriendly features are optional | not-started | — | #15, #17 | zip maker and ADR 0010 step in #15; signing, dmg and pkg deferred; native add-ons in #29; packaged in CI on three OS in #17 |
| PLT-008 | Electron security baseline is enforced by gate tests | not-started | — | #15 | ADR 0004; app:// protocol, fuses and symlink refusal in #15; isolation, sandbox, CSP and CDP guard in #18 |
| PLT-009 | TypeScript and JavaScript for tooling; Python only with no JavaScript option | done | tools/repo/workspace-config | #12 |  |
| PLT-010 | pnpm for packages; gh for GitHub; no AI co-author trailers | done | tools/repo/workspace-config, tools/boundary-check | #12, #14 | pnpm in #12; co-author trailer rule in #14 |
| PLT-011 | App Store builds run sandboxed: no built-in auto-update, limited file access | not-started | — | — |  |
| PLT-012 | Success: security baseline gate tests pass in a packaged build | not-started | — | — |  |
| PLT-013 | Native Node add-ons packaged per app | not-started | — | — | ADR 0004, ADR 0005 |
| CMP-001 | React Aria Components wrapped in foundation components | not-started | — | — |  |
| CMP-002 | High accessibility bar for components | not-started | — | — |  |
| CMP-003 | Plain CSS with @layer order reset, tokens, foundation, app, overrides | not-started | — | — |  |
| CMP-004 | ui- prefix, flat React names, parts as .ui-block__part | not-started | — | — |  |
| CMP-005 | Variants and state as data attributes; one identity class per element | not-started | — | — |  |
| CMP-006 | CSS animation by default; JavaScript animation allowed per app | not-started | — | — |  |
| CMP-007 | React Aria Table only, extended later with own features | not-started | — | — |  |
| CMP-008 | react-resizable-panels for split panes, wrapped | not-started | — | — |  |
| CMP-009 | Tear-off tabs are child windows sharing one React tree | not-started | — | — |  |
| CMP-010 | Docking staged: tabs, split panes and move-to-window now; full docking later | not-started | — | — |  |
| CMP-011 | Menubar built in React Aria style | not-started | — | — |  |
| CMP-012 | Phosphor icons through a curated Icon{Name} module | not-started | — | — |  |
| CMP-013 | Icons decorative by default; icon-only buttons require a label prop | not-started | — | — |  |
| CMP-014 | Single Chromium target: modern CSS allowed, no browser fallback | not-started | — | — |  |
| TOK-001 | DTCG 2025.10 with Terrazzo plus the profile | not-started | — | — |  |
| TOK-002 | Three token tiers: primitive, semantic, component | not-started | — | — | ADR 0002 |
| TOK-003 | Repo token files are the master copy; design tool reads and writes them | not-started | — | — |  |
| TOK-004 | Light, dark and high contrast themes; compact (default) and comfortable density | not-started | — | — |  |
| TOK-005 | Follow the OS for dark mode and contrast; theme override via nativeTheme.themeSource | not-started | — | — |  |
| TOK-006 | OS accent colour opt-in per app; system font default, bundled stack per app | not-started | — | — |  |
| TOK-007 | Apps declare prefix and brand file in foundation.config.ts; factories build tool configs | not-started | — | — |  |
| TOK-008 | Generated CSS, TypeScript names and TOKENS.md committed, with CI drift check | not-started | — | — |  |
| TOK-009 | DTCG dimensions accept only px and rem; percentages and fr stay in layout CSS | not-started | — | — |  |
| TOK-010 | Tokens and config factories come before any styled component | not-started | — | — |  |
| TOK-011 | Token files stay valid DTCG with no custom parser | not-started | — | — |  |
| TOK-012 | Leaf key is the full name; CSS variable is that name with -- in front | not-started | — | — |  |
| TOK-013 | Primitive name shape: ui-ref-{category}[-{scale}]-{step} | not-started | — | — | ADR 0002 |
| TOK-014 | Semantic name shape: ui-{category}-{role}[-{variant}]-{leaf} | not-started | — | — |  |
| TOK-015 | Component name shape: ui-{block}[__{part}]__{category}-{role}[-{variant}]-{leaf} | not-started | — | — |  |
| TOK-016 | Component part tokens use the component shape with a part scope | not-started | — | — |  |
| TOK-017 | Hyphen joins words inside one segment | not-started | — | — |  |
| TOK-018 | Double underscore separates block, part and token scopes | not-started | — | — |  |
| TOK-019 | Double underscore never appears in semantic or primitive names | not-started | — | — |  |
| TOK-020 | Names use lowercase ASCII letters, digits, single hyphens and __ only | not-started | — | — |  |
| TOK-021 | ui- prefix belongs to the foundation and apps cannot rename it | not-started | — | — |  |
| TOK-022 | Each app declares its own prefix for tokens and classes it adds | not-started | — | — |  |
| TOK-023 | ref marks a primitive; runtime marks a code-set variable | not-started | — | — |  |
| TOK-024 | ref and runtime cannot be category or block names | not-started | — | — |  |
| TOK-025 | Categories are a closed list | not-started | — | — |  |
| TOK-026 | A component block must not share a name with a category | not-started | — | — |  |
| TOK-027 | Leaf words are a closed list, extendable by review | not-started | — | — |  |
| TOK-028 | Every semantic and component name ends in exactly one leaf word | not-started | — | — |  |
| TOK-029 | default is only ever a leaf, never a variant | not-started | — | — |  |
| TOK-030 | Leaf keys are unique across a resolver's sources, except alternative modifier contexts and brand overrides | not-started | — | — | ADR 0002 |
| TOK-031 | No token name equals the leading hyphen-segments of another | not-started | — | — |  |
| TOK-032 | Names differing only by case are an error | not-started | — | — |  |
| TOK-033 | Group path equals the start of the leaf key after the prefix | not-started | — | — |  |
| TOK-034 | Group color tokens start ui-color-; component tokens live in a block-named group | not-started | — | — |  |
| TOK-035 | Values flow one way: literals, primitives, semantics, components | not-started | — | — |  |
| TOK-036 | Only semantic tokens change between themes and densities | not-started | — | — |  |
| TOK-037 | Primitive tier: literal only, invariant, not used in component CSS | not-started | — | — |  |
| TOK-038 | Semantic tier: aliases primitive or semantic, may vary, usable in component CSS | not-started | — | — |  |
| TOK-039 | Component tier: aliases semantic only, invariant, used only by its own block | not-started | — | — |  |
| TOK-040 | Component tokens never vary by theme | not-started | — | — |  |
| TOK-041 | Component CSS uses only semantic tokens and its own block's component tokens | not-started | — | — |  |
| TOK-042 | button.css must not reference --ui-ref-* or --ui-dialog__* | not-started | — | — |  |
| TOK-043 | Apps override primitives and may add tokens under their own prefix | not-started | — | — |  |
| TOK-044 | Apps must not redefine semantic or component tokens | not-started | — | — |  |
| TOK-045 | Aliases use curly-brace references | not-started | — | — |  |
| TOK-046 | JSON Pointer $ref is reserved for the resolver file | not-started | — | — |  |
| TOK-047 | DTCG dimensions accept only px and rem | not-started | — | — |  |
| TOK-048 | rem for spacing, sizes and type; px for border widths and hairlines | not-started | — | — |  |
| TOK-049 | Percentages and fr belong in layout CSS, not tokens | not-started | — | — |  |
| TOK-050 | Shared tokens in tokens/; component tokens beside the owning component | not-started | — | — |  |
| TOK-051 | File names use .tokens.json; the resolver uses .resolver.json | not-started | — | — |  |
| TOK-052 | Every component *.tokens.json is listed in the resolver's components set | not-started | — | — |  |
| TOK-053 | CI fails if a component token file is missing from the resolver | not-started | — | — |  |
| TOK-054 | generated/ holds the only files containing resolved values | not-started | — | — |  |
| TOK-055 | Nothing outside generated/ may be generated | not-started | — | — |  |
| TOK-056 | Resolver has two modifiers: theme for colours and density for dimensions | not-started | — | — |  |
| TOK-057 | No token appears in both modifiers | not-started | — | — |  |
| TOK-058 | Components come last in the resolution order | not-started | — | — |  |
| TOK-059 | Light context: no OS signal, themeSource light, :root | not-started | — | — |  |
| TOK-060 | Dark context: prefers-color-scheme dark, themeSource dark, media query | not-started | — | — |  |
| TOK-061 | Light high contrast context: prefers-contrast more, data-contrast more, light scheme | not-started | — | — |  |
| TOK-062 | Dark high contrast context: both signals, both overrides, dark scheme | not-started | — | — |  |
| TOK-063 | Comfortable density: data-density comfortable on the root | not-started | — | — |  |
| TOK-064 | Theme override goes through Electron nativeTheme.themeSource, not an attribute | not-started | — | — |  |
| TOK-065 | Runtime theme CSS needs only the media query | not-started | — | — | ADR 0002 |
| TOK-066 | data-theme exists for tooling only | not-started | — | — |  |
| TOK-067 | data-theme mirrors the media-query blocks | not-started | — | — |  |
| TOK-068 | Contrast override is a data-contrast attribute on each window's root | not-started | — | — |  |
| TOK-069 | Windows high contrast mode is not a token theme | not-started | — | — |  |
| TOK-070 | Component CSS handles forced-colors with system colour keywords | not-started | — | — |  |
| TOK-071 | Each permutation wraps its output in @layer tokens | not-started | — | — |  |
| TOK-072 | An app rebrands by overriding a fixed set of primitives | not-started | — | — |  |
| TOK-073 | Foundation defines a brand ramp and UI font stack that semantic tokens point at | not-started | — | — |  |
| TOK-074 | Brand ramp is ui-ref-color-brand-50 through 950 | not-started | — | — |  |
| TOK-075 | Light themes use darker brand steps; dark themes use lighter | not-started | — | — |  |
| TOK-076 | ui-ref-font-family-ui defaults to the system font stack | not-started | — | — |  |
| TOK-077 | ui-ref-font-family-mono is the monospace stack | not-started | — | — |  |
| TOK-078 | An app's brand file overrides only the brand primitives | not-started | — | — |  |
| TOK-079 | App resolver order: ref, brand, sys, modifiers, components | not-started | — | — | ADR 0002 |
| TOK-080 | Each app generates its own complete tokens.css | not-started | — | — |  |
| TOK-081 | Bundled font stack starts with the font and ends with system fallbacks | not-started | — | — |  |
| TOK-082 | @font-face rules and font files live in the app, not in tokens | not-started | — | — |  |
| TOK-083 | Opted-in OS accent: main reads the colour; renderer sets --ui-runtime-os-accent on each root | not-started | — | — |  |
| TOK-084 | Accent semantic tokens derive steps in hand-written CSS with relative colour syntax | not-started | — | — | ADR 0002 |
| TOK-085 | App tokens use the app prefix and the same grammar, tiers and lint rules | not-started | — | — |  |
| TOK-086 | App tokens must not reuse foundation names | not-started | — | — |  |
| TOK-087 | One app config file; foundation factories build Terrazzo and Stylelint configs | not-started | — | — |  |
| TOK-088 | prefix is required: 2-4 lowercase letters, not reserved, unique in the monorepo | not-started | — | — |  |
| TOK-089 | brandTokens is optional: only brand overrides and prefixed tokens | not-started | — | — |  |
| TOK-090 | defineAppTerrazzoConfig builds resolver, CSS plugin and prefix lint rules | not-started | — | — |  |
| TOK-091 | defineAppStylelintConfig builds app naming and ui- consumption rules | not-started | — | — |  |
| TOK-092 | token-names.ts exports UiTokenName and the app's own type | not-started | — | — |  |
| TOK-093 | Apps cannot configure the ui- prefix | not-started | — | — |  |
| TOK-094 | Apps cannot configure the extension namespace; own key only for invented fields | not-started | — | — |  |
| TOK-095 | defineAppConfig throws at load on an invalid prefix | not-started | — | — |  |
| TOK-096 | CI script fails on duplicate app prefixes | not-started | — | — |  |
| TOK-097 | Every token has explicit $type and $description; guidance goes in one $extensions key | not-started | — | — |  |
| TOK-098 | $type is on the token itself, not inherited | not-started | — | — |  |
| TOK-099 | $description is one plain sentence on purpose, not appearance | not-started | — | — |  |
| TOK-100 | Extension keys use reverse domain notation; tools preserve unknown extension data | not-started | — | — |  |
| TOK-101 | The profile reserves one extension key | not-started | — | — |  |
| TOK-102 | The extension namespace belongs to the foundation and is set once | not-started | — | — |  |
| TOK-103 | Apps use the same extension key; own key only for invented fields | not-started | — | — |  |
| TOK-104 | usage is required on semantic and component tokens | not-started | — | — |  |
| TOK-105 | avoid is optional and names misuse and the replacement | not-started | — | — |  |
| TOK-106 | contrastWith is required on foreground colours and feeds the contrast lint | not-started | — | — |  |
| TOK-107 | Removing extension data never changes a token's value | not-started | — | — |  |
| TOK-108 | Deprecation uses $deprecated string form naming the replacement | not-started | — | — |  |
| TOK-109 | A deprecated token stays for at least one minor foundation release | not-started | — | — |  |
| TOK-110 | Deprecated token in CSS warns; removing it while in use fails CI | not-started | — | — |  |
| TOK-111 | One tz build per package writes three committed files, each with a do-not-edit header | not-started | — | — |  |
| TOK-112 | tokens.css written by the profile plugin from plugin-css transforms, with source comments | not-started | — | — | ADR 0004 |
| TOK-113 | token-names.ts comes from a custom Terrazzo plugin | not-started | — | — |  |
| TOK-114 | TOKENS.md comes from a custom Terrazzo plugin plus a usage scan | not-started | — | — |  |
| TOK-115 | variableName returns -- plus the leaf key | not-started | — | — | ADR 0004 |
| TOK-116 | Selectors: one per context plus [data-theme] blocks for tooling, each in @layer tokens | not-started | — | — | ADR 0002 |
| TOK-117 | Each CSS declaration has a trailing source comment with file and token path | not-started | — | — | ADR 0004 |
| TOK-118 | tokens.css starts with the specified generated header | not-started | — | — | ADR 0002 |
| TOK-119 | Tokens referenced from TypeScript go through UiTokenName | not-started | — | — |  |
| TOK-120 | TOKENS.md has one section per tier and one row per token | not-started | — | — |  |
| TOK-121 | TOKENS.md Name column is the leaf key | not-started | — | — |  |
| TOK-122 | TOKENS.md Type column is $type | not-started | — | — |  |
| TOK-123 | TOKENS.md Description column is $description plus usage and avoid | not-started | — | — |  |
| TOK-124 | TOKENS.md Values column is the resolved value per context | not-started | — | — |  |
| TOK-125 | TOKENS.md Source column is file and token path | not-started | — | — |  |
| TOK-126 | TOKENS.md Used by column lists CSS files from a var scan | not-started | — | — |  |
| TOK-127 | TOKENS.md Status column shows deprecation and replacement | not-started | — | — |  |
| TOK-128 | All lint layers run locally and in CI; errors unless marked | not-started | — | #13 | CI runs typecheck, lint and test in #13; drift checks in phase 2 |
| TOK-129 | core/required-type is an error | not-started | — | — |  |
| TOK-130 | core/descriptions is an error | not-started | — | — |  |
| TOK-131 | core/consistent-naming is an error with a custom validator | not-started | — | — | ADR 0004 |
| TOK-132 | core/valid-* rules are all errors | not-started | — | — |  |
| TOK-133 | core/valid-dimension is an error with units px and rem | not-started | — | — |  |
| TOK-134 | core/required-modes is an error across all four theme contexts | not-started | — | — |  |
| TOK-135 | core/max-gamut with gamut: srgb; colours authored in oklch | not-started | — | — | ADR 0004 |
| TOK-136 | a11y/min-contrast is an error at AA with pairs from contrastWith | not-started | — | — |  |
| TOK-137 | core/duplicate-values warns with primitives ignored | not-started | — | — |  |
| TOK-138 | Lint ui/unique-leaf-names | not-started | — | — | ADR 0002 |
| TOK-139 | Lint ui/no-segment-prefix | not-started | — | — |  |
| TOK-140 | Lint ui/no-case-variants | not-started | — | — |  |
| TOK-141 | Lint ui/group-matches-name | not-started | — | — | ADR 0002 |
| TOK-142 | Lint ui/tier-references | not-started | — | — |  |
| TOK-143 | Lint ui/components-theme-invariant | not-started | — | — |  |
| TOK-144 | Lint ui/extension-fields | not-started | — | — |  |
| TOK-145 | Stylelint: no raw values, only var(), in foundation and app CSS | not-started | — | — |  |
| TOK-146 | Stylelint: no primitives in component CSS | not-started | — | — |  |
| TOK-147 | Stylelint: component tokens from own block only | not-started | — | — |  |
| TOK-148 | Stylelint: every var(--ui-...) exists in token-names.ts, except reserved --ui-runtime-* variables | not-started | — | — | ADR 0002 |
| TOK-149 | Stylelint: deprecated tokens produce a warning | not-started | — | — |  |
| TOK-150 | Stylelint: each interactive component file has a forced-colors block | not-started | — | — | ADR 0002 |
| TOK-151 | CI: tz build and fail on generated drift | not-started | — | — |  |
| TOK-152 | CI: fail if a component token file is missing from the resolver | not-started | — | — |  |
| TOK-153 | CI: fail if a removed token is still referenced in CSS or TypeScript | not-started | — | — |  |
| TOK-154 | CI: run the token gate tests | not-started | — | — |  |
| TOK-155 | Pipeline output: three files, or non-zero exit with file#token.path: rule-id: message | not-started | — | — |  |
| TOK-156 | Gate 1: valid fixtures build and match snapshots | not-started | — | — |  |
| TOK-157 | Gate 2: CSS variables equal -- plus a leaf key found verbatim in source | not-started | — | — |  |
| TOK-158 | Gate 3: each context has a selector block in @layer tokens | not-started | — | — |  |
| TOK-159 | Gate 4: every declaration's source comment points at a real file and path | not-started | — | — |  |
| TOK-160 | Gate 5: token-names.ts type-checks and lists every token once | not-started | — | — |  |
| TOK-161 | Gate 6: app brand override redeclares semantics; component tokens unchanged | not-started | — | — |  |
| TOK-162 | Gate 7: grammar break fails core/consistent-naming | not-started | — | — |  |
| TOK-163 | Gate 8: duplicate leaf key outside alternative contexts fails ui/unique-leaf-names | not-started | — | — | ADR 0002 |
| TOK-164 | Gate 9: segment prefix fails ui/no-segment-prefix | not-started | — | — |  |
| TOK-165 | Gate 10: component aliasing a primitive fails ui/tier-references | not-started | — | — |  |
| TOK-166 | Gate 11: component token in a theme file fails ui/components-theme-invariant | not-started | — | — |  |
| TOK-167 | Gate 12: missing $description fails core/descriptions | not-started | — | — |  |
| TOK-168 | Gate 13: failing contrast pair fails a11y/min-contrast | not-started | — | — |  |
| TOK-169 | Gate 14: semantic colour missing from a context fails core/required-modes | not-started | — | — |  |
| TOK-170 | Gate 15: hand-edited generated tokens.css fails CI drift check | not-started | — | — |  |
| TOK-171 | Gate 16: primitive in component CSS fails Stylelint | not-started | — | — |  |
| TOK-172 | Gate 17: hex colour in component CSS fails Stylelint | not-started | — | — |  |
| TOK-173 | Gate 18: invalid prefix makes defineAppConfig throw | not-started | — | — |  |
| TOK-174 | Gate 19: duplicate app prefixes fail the CI check | not-started | — | — |  |
| TOK-175 | Gate 20: app brand file redefining a semantic token is rejected | not-started | — | — |  |
| TOK-176 | Gate 21: remote resolver $ref is refused | not-started | — | — |  |
| TOK-177 | Gate 22: resolver $ref escaping the repo root is refused | not-started | — | — |  |
| TOK-178 | Gate 23: 2,000-token full build meets the measured budget | not-started | — | — |  |
| TOK-179 | Gate 24: theme switch updates computed tokens in every open window | not-started | — | — |  |
| CMD-001 | Shared command definitions; handlers where the work happens | not-started | — | — |  |
| CMD-002 | Command IDs are prefixed dotted literals with a generated type | not-started | — | — |  |
| CMD-003 | Command availability expressed as TypeScript functions | not-started | — | — |  |
| CMD-004 | Electron accelerator syntax; app-wide and panel scopes; system-wide opt-in per app | not-started | — | — |  |
| CMD-005 | User shortcut overrides designed in; rebinding UI later; build-time conflict check | not-started | — | — |  |
| CMD-006 | Typed command arguments; a picker or hidden from the palette | not-started | — | — |  |
| CMD-007 | macOS native menu; custom title bar with native window buttons and in-app menu bar elsewhere | not-started | — | — |  |
| CMD-008 | Alt and access keys supported | not-started | — | — |  |
| CMD-009 | Context menus rendered with React Aria from the registry | not-started | — | — |  |
| CMD-010 | *.commands.ts beside features; explicit registration list; one menu layout file per app with roles | not-started | — | — |  |
| CMD-011 | Windows open only from a user gesture, which affects restoring torn-off windows | not-started | — | — | ADR 0004 |
| CMD-012 | macOS requires Electron Edit-menu roles for text-field copy, paste and undo | not-started | — | — |  |
| CMD-013 | Command registry comes before menus, palette, context menus and title bar | not-started | — | — |  |
| STA-001 | Four state homes chosen by owner, lifetime and sharing | not-started | — | — |  |
| STA-002 | Component state lives in React or React Aria | not-started | — | — |  |
| STA-003 | One Zustand store per system, named use<Name>Store | not-started | — | — |  |
| STA-004 | TanStack Query for main-owned and persisted data, keys named <name>Keys | not-started | — | — |  |
| STA-005 | One typed IPC contract, Zod-validated in main | not-started | — | — |  |
| STA-006 | Derived values computed, not stored; escape hatch via a decision note | not-started | — | — |  |
| STA-007 | Component props follow React Aria names | not-started | — | — |  |
| STA-008 | Message catalogue from day one, English only, with Paraglide | not-started | — | — |  |
| STA-009 | Locale from OS preferred languages with a user override | not-started | — | — |  |
| STA-010 | Foundation messages under ui_; keys are {prefix}_{area}_{name} | not-started | — | — |  |
| STA-011 | Logical CSS properties enforced by Stylelint | not-started | — | — |  |
| STA-012 | React Aria Form by default; React Hook Form with Zod for complex forms | not-started | — | — |  |
| STA-013 | One Zod schema per payload, used in renderer and main | not-started | — | — |  |
| STA-014 | Validation on commit, never while typing | not-started | — | — |  |
| STA-015 | Preferences apply immediately; dialogs use explicit submit | not-started | — | — |  |
| STA-016 | IPC contract comes before commands, persisted settings and forms that talk to main | not-started | — | — |  |
| TST-001 | Integration and end-to-end tests over unit tests | not-started | — | — |  |
| TST-002 | Component tests in real Chromium via Vitest Browser Mode | not-started | — | — |  |
| TST-003 | Component gate tests: roles, keyboard, naming, axe, screenshots, failure modes | not-started | — | — |  |
| TST-004 | Visual tests on one CI platform with a fixed font | not-started | — | — |  |
| TST-005 | One example file per component, shared by workbench, visual tests and agents | not-started | — | — |  |
| TST-006 | Simple workbench now; in-house design tool later; no Storybook | not-started | — | — |  |
| TST-007 | Playwright for end-to-end, connecting over CDP | done | e2e/harness/smoke-app-harness.gate | #16 |  |
| TST-008 | Test-only main-process bridge, absent from packaged builds | not-started | — | — |  |
| TST-009 | CDP port in development builds; packaged builds only with an environment variable | not-started | — | #16 | ADR 0004; dev build part in #16; packaged guard in #18 |
| TST-010 | Small cross-process smoke suite per app on Windows, macOS and Linux | not-started | — | #16, #17 | harness and smoke suite on macOS and Linux in #16; packaged smoke in CI in #17; Windows deferred (ADR 0011, #39); CDP variable in #18 |
| TST-011 | Reference app is end-to-end target and template; create-app script | not-started | — | #15 | reference app in #15; create-app in phase 5 |
| TST-012 | Test infrastructure and gate tests come before each system's implementation | not-started | — | — |  |
| TST-013 | Reference app comes before the smoke suite and create-app | done | tools/reference-app/reference-app-build | #15 |  |
| TST-014 | Success: create-app output launches with shell features and no manual wiring | not-started | — | — |  |
| TST-015 | Success: reference app smoke suite passes on three platforms in CI | not-started | — | #13, #17 | CI on three OS in #13; smoke and packaging in #17; packaged smoke job on three OS in #17 (smoke on macOS and Linux, Windows per ADR 0011) |
| TST-016 | Success: every component passes gate tests, zero axe violations, all theme and density screenshots | not-started | — | — |  |
| TST-017 | Success: an AI agent can attach to a development build over CDP with the documented setup | not-started | — | — |  |
| XC-001 | One name, one definition site | not-started | — | — |  |
| XC-002 | No barrel files or export * | not-started | — | — |  |
| XC-003 | Black-box systems with gate tests before implementation | not-started | — | — |  |
| XC-004 | Failure modes are part of every contract and are tested | not-started | — | #12-#16 | applied in every task; closed when phase 1 ends |
| XC-005 | Accessibility: keyboard, screen readers, forced colours, right-to-left readiness | not-started | — | — |  |
| XC-006 | Generated files committed and never hand-edited; CI fails on drift | not-started | — | — |  |
| XC-007 | Token names, command IDs, message keys, icon names and IPC payloads are typed | not-started | — | — |  |
| XC-008 | Main never trusts the renderer; every IPC payload validated in main | not-started | — | — |  |
| XC-009 | Agent documentation ships with the foundation | not-started | — | — |  |
| XC-010 | Success: single whole-word search returns one definition and its usages, no false matches | not-started | — | — |  |
| XC-011 | Success: misspelled token, command ID, message key, icon name or IPC payload fails type-check or lint | not-started | — | — |  |
| XC-012 | Success: editing a generated file or a theme-varying component token fails CI | not-started | — | — |  |
