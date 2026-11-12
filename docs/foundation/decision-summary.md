# Electron App Foundation: Decision Summary

Nov 6, 2026 · @Chris Lloyd

This summarises every decision from the foundation planning conversation. Once you confirm it reflects our shared understanding, it becomes the basis for the implementation plan.

## Problem and desired outcome

**Problem.** You plan to build 12 or more Electron desktop apps, many related to each other, mostly with AI agents doing the coding. Without a shared foundation, each app would reinvent components, theming, state handling and testing, and agents would waste effort searching inconsistent codebases and editing the wrong places.

**Desired outcome.** One foundation package in a monorepo that every app imports and keeps receiving updates from. It provides accessible, themeable, desktop-grade components; a token-based theme system; commands, menus and shortcuts; state and IPC conventions; testing infrastructure; and a reference app that doubles as the template for new apps and the foundation's end-to-end test target. Every name in it is designed so a single search finds exactly one definition.

## Audience and non-audience

| Audience | What they need from the foundation |
| --- | --- |
| You, as architect and developer | Consistent building blocks and decisions you don't revisit per app |
| AI coding agents | Greppable names, one definition site per thing, type errors as fast feedback, agent docs |
| End users of the apps | Native-feeling desktop UI, keyboard access, screen-reader support, themes that follow the OS |
| Your in-house design tool | Token files and component examples it can read and write |

**Not the audience:** web or mobile users (Electron desktop only); third-party developers consuming the foundation outside your monorepo; designers working in Figma or Penpot.

## Scope and non-goals

**In scope:**

- Monorepo structure, build, packaging configuration and the Electron security baseline
- Foundation package: wrapped React Aria components, styling conventions, design tokens, icons, messages
- Commands, menus, shortcuts, context menus and the custom title bar
- Multi-window support, including tearing tabs off into child windows
- State, IPC and form conventions
- Testing infrastructure: component gate tests, workbench, end-to-end harness
- Reference app and `create-app` script
- [PLT-001] Agent documentation

**Non-goals for the first version (parked until an app needs them):**

- Full IDE-style docking (tabs between groups, edge drop zones, floating panels)
- Rich text editor
- Spreadsheet-grade grid features: cell range selection, frozen columns, copy and paste, column reordering
- Dev-only hover overlay showing component names
- App Store packaging details
- Named themes beyond light, dark and high contrast
- User interface for rebinding shortcuts (the data model supports it)
- Languages other than English (the catalogue supports them)

## Decisions and rationale

### Platform and repository

| Decision | Rationale |
| --- | --- |
| [PLT-002] React | Highest AI familiarity; richest headless and desktop-grade libraries |
| [PLT-003] pnpm monorepo; foundation as a workspace package | Apps keep receiving updates; agents can read foundation source in the same repo. Isolated layout with a narrow `public-hoist-pattern` for Forge (ADR 0004) |
| [PLT-004] Turborepo task runner | Low configuration, caching, affected builds; our own scripts cover what Nx would add |
| [PLT-005] Electron Forge with its Vite plugin, version pinned | Official tooling; one bundler shared with Vitest, Paraglide and the workbench |
| [PLT-006] ESLint and Prettier | Needed for the TanStack Query plugin and our custom rules |
| [PLT-007] Packaging per app; App Store-unfriendly features optional | Lets some apps ship to the Mac App Store without fighting the foundation |
| [PLT-008] Security baseline enforced by gate tests | Context isolation, sandbox, no Node in renderers, strict CSP (inline styles allowed), validated IPC, fuses locked in packaged builds, renderers loaded through a custom `app://` protocol (ADR 0004) |
| [PLT-013] Native Node add-ons packaged per app (for example SQLite drivers, image processing, terminals) | Apps need them; the packaging method comes from spike #9 (ADR 0004) |

### Components and styling

| Decision | Rationale |
| --- | --- |
| [CMP-001] React Aria Components, wrapped in foundation components | Strongest accessibility and widest coverage (dates, table, tree, drag and drop); wrappers hide its API from apps |
| [CMP-002] High accessibility bar | Raising it later would mean replacing the library under every app |
| [CMP-003] Plain CSS with `@layer` order `reset, tokens, foundation, app, overrides` | Most vanilla option; modern CSS works because Electron targets one Chromium |
| [CMP-004] Prefix `ui-`; flat React names (`DialogTrigger`); parts as `.ui-dialog__trigger` | Whole-word search on a parent never matches its parts |
| [CMP-005] Variants and state as data attributes; one identity class per element | Matches React Aria's own state attributes; cleaner searches |
| [CMP-006] CSS animation by default, JavaScript animation allowed per app | Lean foundation; apps needing drag physics aren't blocked |
| [CMP-007] React Aria Table only, extended later with our own features | Avoid combining table systems; built-in virtualisation, async loading, sorting, resizing |
| [CMP-008] react-resizable-panels for split panes, wrapped | Accessible window-splitter pattern with persistence |
| [CMP-009] Tear-off tabs as child windows sharing one React tree | Shared state and theme for free; the approach VS Code uses |
| [CMP-010] Docking staged: tabs, split panes and move-to-window now; full docking later | Ships the must-have sooner; defers the largest build |
| [CMP-011] Menubar built in React Aria style (unparked by the custom title bar) | React Aria has no Menubar component |
| [CMP-012] Phosphor icons through a curated `Icon{Name}` module | Filled weights show state through shape, not only colour; one greppable name per icon |
| [CMP-013] Icons decorative by default; icon-only buttons require a label prop | Unlabelled icon buttons fail to compile |

### Tokens and theming

| Decision | Rationale |
| --- | --- |
| [TOK-001] DTCG 2025.10 with Terrazzo, plus our own profile | Standard format with a greppable naming grammar layered on top; see the Design Token Profile Spec |
| [TOK-002] Three tiers: primitive, semantic, component | Themes change only the semantic layer; apps change only brand primitives |
| [TOK-003] Repo token files are the master copy; the in-house design tool reads and writes them | One source of truth |
| [TOK-004] Light, dark and high contrast themes; compact (default) and comfortable density | Accessibility and desktop density needs |
| [TOK-005] Follow the OS for dark mode and contrast; theme override through `nativeTheme.themeSource` | All windows and native UI switch together |
| [TOK-006] OS accent colour opt-in per app; system font by default, bundled stack per app | Brand by default, native feel available |
| [TOK-007] Apps declare `prefix` and brand file in `foundation.config.ts`; factories build their tool configs | Prefix rules can't drift between tools |
| [TOK-008] Generated CSS, TypeScript names and `TOKENS.md` committed, with a CI drift check | Greppable without a build; nobody edits generated files |

### Commands, menus and windows

| Decision | Rationale |
| --- | --- |
| [CMD-001] Shared command definitions; handlers where the work happens | Main builds the native menu from the same definitions the palette uses |
| [CMD-002] IDs as prefixed dotted literals (`ap.document.save`) with a generated type | One search finds definition, handlers and call sites |
| [CMD-003] Availability as TypeScript functions | Type-checked, greppable, no expression language |
| [CMD-004] Electron accelerator syntax; app-wide and panel scopes; system-wide opt-in per app | Native menu takes it directly; system-wide shortcuts steal keys from other apps |
| [CMD-005] User overrides designed in; rebinding UI later; build-time conflict check | No restructuring when rebinding arrives |
| [CMD-006] Typed command arguments; a picker or hidden from the palette | Palette never runs a command without its input |
| [CMD-007] macOS native menu; custom title bar with native window buttons and in-app menu bar elsewhere | Consistent, themeable; keeps Windows 11 snap layouts |
| [CMD-008] Alt and access keys supported | Standard Windows behaviour; accessibility bar |
| [CMD-009] Context menus rendered with React Aria from the registry | Themeable, accessible, identical in child windows |
| [CMD-010] `*.commands.ts` beside features; explicit registration list; one menu layout file per app with Electron roles | Commands sit beside their code; macOS Edit menu needs roles for text editing |

### State, data and content

| Decision | Rationale |
| --- | --- |
| [STA-001] Four homes chosen by owner, lifetime and sharing | Places any state, including state no one anticipated |
| [STA-002] Component state in React or React Aria | The library already manages it |
| [STA-003] One Zustand store per system (`use<Name>Store`) | Matches the black-box rule; greppable; shared by child windows |
| [STA-004] TanStack Query for main-owned and persisted data (`<name>Keys`) | Caching, loading and errors without hand-written plumbing |
| [STA-005] One typed IPC contract, Zod-validated in main | The only bridge between processes; main never trusts renderer input |
| [STA-006] Derived values computed, not stored; escape hatch via a decision note | No drifting copies; visible deviations |
| [STA-007] Component props follow React Aria names (`value`, `defaultValue`, `onChange`) | One naming scheme end to end |
| [STA-008] Message catalogue from day one, English only; Paraglide | Typed, greppable messages usable in the main process for native menus |
| [STA-009] Locale from OS preferred languages with a user override | One locale for React Aria, Paraglide and native menus |
| [STA-010] Foundation messages under `ui_`; keys `{prefix}_{area}_{name}` | Matches the rest of the naming system |
| [STA-011] Logical CSS properties enforced by Stylelint | Right-to-left layouts work without per-language CSS |
| [STA-012] Forms: React Aria `Form` by default; React Hook Form with Zod for complex forms | No dependency for simple forms; types come from the schema |
| [STA-013] One Zod schema per payload, used in renderer and main | Same rules on both sides of the boundary |
| [STA-014] Validation on commit, never while typing | Settings commit on leaving an input; full forms commit on submit; one handler |
| [STA-015] Preferences apply immediately; dialogs use explicit submit | Desktop convention |

### Testing and quality

| Decision | Rationale |
| --- | --- |
| [TST-001] Integration and end-to-end tests over unit tests | Your preference; pure-logic edge cases tested at their input/output boundary |
| [TST-002] Component tests in real Chromium via Vitest Browser Mode | Same engine as Electron; real focus, keyboard and layout |
| [TST-003] Component gate tests: roles and names, keyboard, naming conventions, axe scan, screenshots per theme and density, failure modes | The component contract, tested as a black box |
| [TST-004] Visual tests on one CI platform with a fixed font | System fonts differ per OS |
| [TST-005] One example file per component, used by the workbench, visual tests and agents | Single source; your design tool can import them later |
| [TST-006] Simple workbench now; in-house design tool later; no Storybook | Avoids another system with its own conventions |
| [TST-007] Playwright for end-to-end, connecting over CDP | Same API as component tests; avoids launch-flag fragility; WebdriverIO as fallback |
| [TST-008] Test-only main-process bridge, absent from packaged builds | Stub dialogs, set theme, run commands, read menus; no backdoor in production |
| [TST-009] CDP port on localhost in development builds for AI agents; packaged builds refuse it unless an environment variable enables it | Agents can inspect and drive the running app; testers can drive early packaged builds (ADR 0004) |
| [TST-010] Small cross-process smoke suite per app on Windows, macOS and Linux | Launch, menus, palette, tear-off, theme, IPC; fake servers for network apps |
| [TST-011] Reference app as end-to-end target and template; `create-app` script | Proves integration in foundation CI; new apps start from a clean shell |

## Cross-cutting requirements

These apply to every part of the foundation and every app built on it.

1. [XC-001] **One name, one definition site.** Every component, part, token, command, store, query key, icon and message has one exact name that appears verbatim wherever it is defined and used.
2. [XC-002] **No barrel files or `export *`.** Re-export by name or import from the source module.
3. [XC-003] **Black-box systems.** Each system has defined inputs and outputs; systems never import another system's internals; gate tests are written before implementation.
4. [XC-004] **Failure modes are part of every contract** and are tested like any other output.
5. [XC-005] **Accessibility at the high bar:** keyboard access, screen-reader support on macOS and Windows, forced-colours support, right-to-left readiness.
6. [XC-006] **Generated files are committed and never hand-edited;** CI fails on drift.
7. [XC-007] **Type errors are the first line of feedback** for agents: token names, command IDs, message keys, icon names and IPC payloads are all typed.
8. [XC-008] **Main never trusts the renderer:** every IPC payload is validated in main.
9. [XC-009] **Agent documentation ships with the foundation:** conventions file, `TOKENS.md`, example files and the CDP setup for agents.

## Verified facts

Checked against official docs or primary sources during planning (November 2026).

| Fact | Source |
| --- | --- |
| Base UI has no date primitives and none on its near roadmap; React Aria has DatePicker, Table, Tree, Virtualizer and drag and drop | Tailor date-picker proposal; React Aria docs |
| React Aria has no Menubar component | React Aria component list |
| React Aria Table supports tab-mode keyboard navigation for cells containing inputs | React Aria Table docs |
| React Aria added context-menu triggers, a simpler keyboard-shortcut API and inputs inside table rows in July 2026 | React Aria v1.20.0 release |
| React Aria's `UNSAFE_PortalProvider` sets where overlays render | React Aria PortalProvider docs |
| React Aria ships built-in string translations for over 30 locales | React Aria internationalisation docs |
| DTCG reached its first stable version, 2025.10; names may not start with `$` or contain `{`, `}` or `.` | DTCG Format Module 2025.10 |
| Terrazzo's CSS plugin supports custom `variableName` and resolver-driven `permutations`; built-in lint includes descriptions, required type and WCAG contrast | Terrazzo docs |
| Setting `nativeTheme.themeSource` changes `prefers-color-scheme` in renderers | Electron nativeTheme tests |
| Vitest 4.0 made Browser Mode stable and added visual regression testing; the current major is 5 | Vitest 4.0 announcement; npm registry (2026-11-11) |
| Playwright's Electron support is experimental but conservative in practice; native dialogs are not intercepted | Playwright docs and maintainer reply |
| Electron Forge's Vite plugin was experimental from v7.5.0 and is stable since Forge 8.0.0 (2026-09-29) | Electron Forge release notes |
| Paraglide v2 compiles messages to typed functions and needs no React provider; the current major is 3, not yet checked for the same properties | Paraglide repository; npm registry (2026-11-11) |

## Assumptions, unknowns and open decisions

### Open decisions (yours)

- [x] **Extension namespace** for token metadata: settled as `io.github.chrisdevelops.ui` (ADR 0003).
- [ ] **Re-validation after a failed submit:** I proposed that a corrected field re-validates when the user leaves it. You haven't confirmed or rejected this yet.

### Assumptions

- Apps live in one monorepo and are not consumed from outside it.
- Initial apps are English only; other languages arrive later through the catalogue.
- Apps run on current Windows, macOS and Linux; no older Electron versions need support.
- Each app handles its own packaging; the foundation provides defaults only.

### Unknowns to resolve during implementation

- [x] Terrazzo lint behaviour with resolvers (naming validator input, required modes, contrast) — see the token spec. Answered by spike #7.
- [x] Playwright Electron package status and API after its April 2026 restructuring. Spike #5: the move was reverted; `_electron` stays in playwright-core.
- [ ] Exact Stylelint plugins for the raw-value and logical-property rules
- [ ] OS accent colour recipe that keeps contrast in all four themes
- [ ] Performance budgets: token build time, component render time, app startup time
- [ ] Final App Store packaging details (parked)

## Constraints

- [PLT-009] **TypeScript and JavaScript** for all tooling and scripts; Python only where no JavaScript option exists.
- [PLT-010] **pnpm** as the package manager; **`gh`** for GitHub work; no AI co-author trailers on commits.
- [CMP-014] **Electron's single Chromium target:** modern CSS is allowed, but there is no browser fallback to rely on.
- [TOK-009] **DTCG dimensions accept only `px` and `rem`**, so percentages and `fr` stay in layout CSS.
- [CMD-011] **Browsers only open windows from a user gesture**, which affects restoring torn-off windows automatically. Spike #8 found that Electron on macOS does not enforce this; Windows and Linux are not verified.
- [CMD-012] **macOS requires Electron's Edit-menu roles** for copy, paste and undo in text fields.
- [PLT-011] **App Store builds run sandboxed:** no built-in auto-update, limited file access.

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Playwright's Electron support is experimental and launch has broken in 2026 | End-to-end suite fails to start | Connect over CDP instead of launching (proven in spike #5); WebdriverIO as fallback |
| Electron Forge's Vite plugin may break in minor releases | Build failures on upgrade | Pin versions; upgrade deliberately. Spike #6: the plugin is stable since Forge 8, so no alternatives evaluation is needed |
| React Aria's API trips up agents (props, hidden context, collections) | Wrong code, wasted turns | Wrappers hide it from apps; TypeScript in the loop; conventions file; example files |
| `UNSAFE_PortalProvider` is an escape hatch | Overlays misbehave in child windows | Foundation overlay wrapper with the spike #8 workarounds; react-aria pinned exactly; child-window overlays in the smoke suite; no `top` placements in child windows until upstream fixes land (ADR 0004) |
| React Aria Table editing support is only months old | Editable grid harder than expected | Ship read-only grid first; extend with our own component when an app needs it |
| Custom title bar and Menubar are ours to build and maintain | Extra effort; platform edge cases | Native window buttons; Menubar follows React Aria's patterns; smoke tests per OS |
| Terrazzo lint may not cover resolver contexts as needed | Profile rules unenforced | Move checks into our own lint plugin. Spike #7: `core/required-modes` and `a11y/min-contrast` are replaced by profile rules |
| Paraglide is not ICU-based | Friction with professional translation platforms later | Decide at the point a second language is added |
| Phosphor has fewer icons than Lucide | Missing icons | Custom-icon pipeline with regular and fill weights |
| A foundation change breaks all apps at once | Broad regressions | Reference app smoke suite in foundation CI; type checks across all apps |

## Dependencies

**Libraries and tools:**

| Area | Dependency |
| --- | --- |
| Runtime and build | Electron, Electron Forge (Vite plugin), Vite, TypeScript |
| Repository | pnpm workspaces, Turborepo |
| UI | React, React Aria Components, react-resizable-panels, Phosphor icons |
| Tokens | Terrazzo CLI, `@terrazzo/plugin-css` |
| State and data | Zustand, TanStack Query, Zod |
| Forms | React Hook Form with its Zod resolver (complex forms only) |
| Messages | Paraglide JS |
| Quality | ESLint, Prettier, Stylelint, Vitest (Browser Mode, Playwright provider), axe-core, Playwright |

**Ordering dependencies between pieces of work:**

- [TOK-010] Tokens and the config factories come before any styled component.
- [TST-012] Test infrastructure and gate tests come before each system's implementation.
- [STA-016] The IPC contract comes before commands, persisted settings and forms that talk to main.
- [CMD-013] The command registry comes before menus, the palette, context menus and the title bar.
- [TST-013] The reference app comes before the smoke suite and the `create-app` script.

## Success criteria

The first version of the foundation is done when all of these hold:

- [ ] [TST-014] `create-app` produces a new app that launches with the custom title bar, menus, command palette, themes and density switching, with no manual wiring.
- [ ] [TST-015] The reference app's smoke suite passes on Windows, macOS and Linux in CI.
- [ ] [TST-016] Every foundation component passes its gate tests, including zero axe violations and screenshots in all four themes and both densities.
- [ ] [XC-010] For any component, part, token, command, store, query key, icon or message, a single whole-word search returns its one definition and its usages, with no false matches.
- [ ] [XC-011] A misspelled token, command ID, message key, icon name or IPC payload fails type-checking or lint.
- [ ] [XC-012] Editing a generated file, or a component token that varies by theme, fails CI.
- [ ] [PLT-012] The security baseline gate tests pass in a packaged build.
- [ ] [TST-017] An AI agent can attach to a running development build over CDP using the documented setup.

## Ordered steps

The foundation is built as a walking skeleton first: the thinnest working path through every layer, proven on all three platforms, then widened screen by screen. How agents carry out these phases is defined in the [Implementation Operating Model](https://claude.ai/artifact/GJzkbXa3ayWvWo4wQgPHcS).

| Phase | What happens | Done when |
| --- | --- | --- |
| 0. Preparation and spikes | Specs moved into the repo with requirement IDs; time-boxed spikes on Playwright over CDP, Forge with Vite, the Terrazzo profile rules and overlays in child windows | Each unknown has a recorded answer; you approve the go/no-go |
| 1. Walking skeleton | One token from JSON to CSS, one wrapped component with gate tests, one command in the native menu and palette, one validated IPC call, one torn-off window, one CDP smoke test; CI on three platforms; security baseline | A packaged app passes its smoke test everywhere, and you've walked through it by hand |
| 2. Guardrails | Lint rules, code generation, drift checks, agent conventions file, `TOKENS.md`, coverage ledger reporting | Breaking a convention fails CI |
| 3. Widen by screens | App shell (title bar, menus, palette) → data screen (table, tree, split panes) → settings screen (forms, persisted state) → multi-window workflow | Each screen passes gate tests and smoke coverage; you approve its first visual version |
| 4. First real app | Built on the foundation alongside phase 3; gaps feed back as tasks or ADRs | The real app ships a meaningful feature without foundation workarounds |
| 5. Template | `create-app` extracted from the reference app and the first real app | A second real app starts from it cleanly |

Two principles run through every phase:

- **Real screens pull components into existence.** No component is built before a screen needs it; everything the skeleton skips is tracked in the coverage ledger, so nothing in the specs is lost.
- **Decisions become checks.** Every rule in these specs is turned into a lint rule, a type, a generated file or a gate test as early as possible, so agents can't drift from them.

## Sources

- [Design Token Profile Spec](https://claude.ai/artifact/8qrpoNZtckJcbuhHSxQezE): full token rules
- [React Aria Table](https://react-aria.adobe.com/Table.html)
- [React Aria v1.20.0 release](https://newreleases.io/project/github/adobe/react-spectrum/release/react-aria-components@1.20.0)
- [React Aria PortalProvider](https://react-aria.adobe.com/PortalProvider)
- [React Aria internationalisation](https://react-spectrum.adobe.com/react-aria/internationalization.html)
- [React Aria forms](https://react-aria.adobe.com/forms)
- [Tailor date-picker proposal (Base UI gap)](https://docs.tailor.tech/app-shell/proposals/date-picker)
- [DTCG Format Module 2025.10](https://www.w3.org/community/reports/design-tokens/CG-FINAL-format-20251028/)
- [Terrazzo CSS plugin](https://terrazzo.app/docs/integrations/css/) and [Terrazzo lint](https://terrazzo.app/docs/linting/)
- [Electron automated testing](https://electronjs.org/docs/latest/tutorial/automated-testing)
- [Playwright Electron API](https://playwright.dev/docs/api/class-electron) and [maintainer reply on experimental status](https://github.com/microsoft/playwright/issues/39477)
- [Vitest 4.0 announcement](https://voidzero.dev/posts/announcing-vitest-4)
- [Electron Forge Vite template](https://www.electronforge.io/templates/vite.md)
- [TanStack Query: server vs client state](https://tanstack.com/query/latest/docs/framework/react/guides/does-this-replace-client-state)
- [Paraglide JS](https://github.com/opral/paraglide-js)
