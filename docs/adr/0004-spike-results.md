# ADR 0004: Decisions from the phase 0 spikes

- **Status:** accepted
- **Weight:** major
- **Date:** 2026-11-11
- **Raised by:** researchers, #5, #6, #7, #8
- **Decided by:** human (major)
- **Affects:** PLT-003, PLT-007, PLT-008, TST-009, TST-010, TOK-112, TOK-114, TOK-115, TOK-131, TOK-135, TOK-155, CMP-009, CMD-009, CMD-011; Decision Summary "Verified facts" and "Risks and mitigations"

## Context

All four spikes returned go-with-changes on macOS arm64. Evidence is on each spike branch in `docs/spikes/` and in the envelope on each issue. Windows and Linux are not verified. Each decision below is independent.

## Decisions

### 1. Packaged renderer loading (#5, #6; PLT-008)

`loadFile` from the asar fails when the `GrantFileProtocolExtraPrivileges` fuse is off.

- **A (recommended):** fuse off; load the renderer and child windows through a custom `app://` protocol with `protocol.handle`. This is the stronger baseline. Child-window overlays must be re-checked on this origin in phase 1.
- **B:** keep the fuse on and use `loadFile`. Simpler, weaker baseline.

### 2. CDP in packaged builds (#5; TST-009, TST-010)

No fuse blocks `--remote-debugging-port`, so a packaged app accepts it.

- **A (recommended):** an in-code guard refuses the switch unless a build-time constant marks a test build. CI builds a test variant of the packaged app for smoke tests; release builds refuse the switch.
- **B:** guard on an environment variable. Anyone who can set the variable can open the port.

### 3. pnpm layout for Forge (#6; PLT-003)

- **A (recommended):** keep the isolated layout with a narrow `public-hoist-pattern`. Packaging passed with it, and pnpm's strictness against undeclared dependencies stays.
- **B:** `node-linker=hoisted` for the whole monorepo. Simplest, but undeclared dependencies can resolve by accident.

Both need a check of Turborepo and Vitest in the first phase 1 task.

### 4. Native and unbundled dependencies (#6; PLT-007)

The Vite plugin packs only `.vite/`.

- **A (recommended):** everything is bundled by Vite. Native modules are not supported until an app needs one; that app raises an ADR.
- **B:** design native-module packaging now. Cost without a current need.

### 5. Token CSS output (#7; TOK-112, TOK-114, TOK-115, TOK-131, TOK-135)

`plugin-css` drops `_` from `__` leaf keys.

- **A (recommended):** our profile plugin writes `tokens.css` from Terrazzo's transforms (`skipBuild: true`) and adds source comments. Correct the spec wording for `variableName`, the validator input and the `gamut` option name.
- **B:** wait for an upstream fix. Blocks phase 1.

### 6. Lint error format (#7; TOK-155)

Core Terrazzo rules carry no file or token path.

- **A (recommended):** keep the strict `file#token.path: rule-id: message` format through a wrapper. Agents then always see where an error is.
- **B:** relax the gate pattern to Terrazzo's own format.

### 7. Colour gamut (#7; TOK-135)

`display-p3` authoring outside sRGB crashes `plugin-css` 2.10.0; `oklch` works.

- **A (recommended):** sRGB only for now, through `core/max-gamut` with `gamut: srgb`; author in `oklch`. Contrast checks stay exact.
- **B:** allow Display P3 with sRGB fallbacks. More colour range, less predictable contrast.

### 8. Child-window overlay workarounds (#8; CMP-009, CMD-009)

- **A (recommended):** a foundation overlay wrapper with the tested workarounds, react-aria pinned exactly, and smoke tests in child windows that fail when an upgrade breaks them. Report the defects upstream when you approve it. No `top` placements in child windows until fixed.
- **B:** carry a `pnpm patch` of react-aria. Fixes the root cause, but every upgrade needs the patch rebased.

### 9. Inline style and the strict CSP (#8; security baseline)

react-aria `usePress` injects an inline `<style>`, which `style-src 'self'` blocks.

- **A (recommended):** a per-load nonce added to the CSP by the `app://` protocol handler (decision 1 A) and passed to react-aria.
- **B:** allow `'unsafe-inline'` for styles only. Simpler, weaker baseline.

### 10. Stale facts (#6, #8)

The Vite plugin is stable since Forge 8.0.0. Current majors are Vitest 5 and Paraglide 3. `window.open` without a user gesture works in Electron on macOS.

- **A (recommended):** update the "Verified facts" and Risks rows and the CMD-011 constraint wording; use the current majors, pinned exactly.
- **B:** stay on Vitest 4 and Paraglide 2.

## Decision

The human decided on 2026-11-11 and gave the phase 0 spikes a go:

| # | Choice | Notes |
| --- | --- | --- |
| 1 | A | Custom `app://` protocol; `GrantFileProtocolExtraPrivileges` off |
| 2 | B | Packaged builds open the CDP port only when an environment variable is set; the human accepts the risk for early testing |
| 3 | A | Isolated layout with a narrow `public-hoist-pattern` |
| 4 | B | Native add-ons supported; new requirement PLT-013; method from spike #9 |
| 5 | A | Keep `__`; the profile plugin writes `tokens.css` |
| 6 | A | Strict error format through a wrapper |
| 7 | A | sRGB only; colours authored in `oklch`; Display P3 later |
| 8 | A | The human reviews and posts the upstream report draft in `docs/upstream/react-aria-second-window-overlays.md` |
| 9 | B | `style-src` allows `'unsafe-inline'`; `script-src` stays strict |
| 10 | A | Current majors, pinned exactly |

## Follow-up

- [x] Spec updated
- [x] Ledger updated: PLT-013 added; affected rows note ADR 0004
- [x] Issues created or changed: #9 (native add-on spike), #10
