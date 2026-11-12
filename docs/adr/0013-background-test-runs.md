# ADR 0013: Background test runs

- **Status:** accepted (amended 2026-11-12: rule 1 on Linux and Windows)
- **Weight:** major
- **Date:** 2026-11-12
- **Raised by:** human; orchestrator, spike #43
- **Decided by:** human
- **Affects:** new TST-018; TST-007, TST-009, TST-010; PLT-008 (packaged build reads one more environment variable); phase 1 order

## Context

Gate and smoke tests start the app dozens of times per run. On macOS each launch takes keyboard focus and puts a window in front of the user's work, so the human cannot use the machine while agents test. Linux already runs under `xvfb-run` and is not affected.

Spike #43 (`origin/spike/43-focus-free-tests`, `docs/spikes/43-focus-free-tests.md`, 3 runs per method on macOS arm64) measured:

- Direct spawn, `open -g`, `app.dock.hide()` or the `accessory` activation policy alone, and an off-screen window position all take focus. macOS moves off-screen windows back onto the screen.
- `app.setActivationPolicy('accessory')` with windows that are never shown keeps focus with the user's app, shows no window and no Dock icon. Pages still paint at 60 fps, `Page.captureScreenshot` works and CDP key input reaches a focused input. `document.hasFocus()` is false; `Emulation.setFocusEmulationEnabled` makes it true.
- `open -j` keeps focus without an app change, but a window and a Dock icon still appear, and the harness loses the app's process ID, exit code and stderr pipe, which the #18 guard gates need.
- The packaged fuses (`RunAsNode`, `NODE_OPTIONS`) stop the harness from injecting this behaviour from outside, so it needs an app-side switch.

Not measured: Windows, a Linux container, native menus and dialogs in background mode.

## Options

1. **One app-side switch in every build:** background activation policy and windows never shown, read by the foundation. Nothing on screen; process ID, exit code and stderr kept. The packaged build reads one more environment variable.
2. **`open -j` for packaged, switch for dev and fixtures:** packaged build unchanged, but a window and Dock icon still appear and the guard gates lose exit code and stderr.
3. **Option 1 with `showInactive()`:** windows visible above the user's app without focus.

## Recommendation

Option 1.

## Decision

Option 1, with these rules (human, 2026-11-12):

1. **Switch.** The foundation's main process reads `FOUNDATION_TEST_BACKGROUND`. Only the value `1` enables it. When enabled, on macOS the app uses the `accessory` activation policy, and every window the foundation creates (including `window.open` children) is never shown and never focused. On Linux and Windows every such window is shown without focus (`showInactive()`) and never focused; under `xvfb-run` nothing is visible (amendment 1). The variable name has one definition site in the foundation. The switch exposes no code or data and does not change fuses, CSP, the `app://` loader or the CDP guard.
2. **Default on.** The harness and the gate-test launch helpers set `FOUNDATION_TEST_BACKGROUND=1` for every launch, locally, for agents and in CI. A run with `FOUNDATION_TEST_FOREGROUND=1` in its environment launches normally, so a person can watch. In background mode the harness enables CDP focus emulation so `document.hasFocus()` is true.
3. **Foreground group.** Tests that need real OS focus, native menus or native dialogs are in a separate foreground group. It does not run by default on a developer machine; it runs in CI, and locally only on request, and prints a clear notice before it starts.
4. **Platforms.** The switch applies on all three platforms. Linux keeps `xvfb-run`. No extra Windows measurement in phase 1 (ADR 0011); CI shows Windows problems.
5. **Order.** The task runs directly after #18, before #19.

## Amendment 1 (human, 2026-11-12)

PR #47 CI (run 43324750319): on Linux (`xvfb-run`) and Windows, a never-shown window paints but `Page.captureScreenshot` never answers, so rule 1 and the screenshot criterion of #46 could not both hold there. Options: A show without focus on Linux and Windows; B spike for another hiding method; C keep never-shown and drop screenshot checks there. Decision: A. macOS is unchanged (accessory policy, never shown). Focus is never taken on any platform.

## Follow-up

- [x] Spec updated (`docs/foundation/decision-summary.md`, section "Testing and quality": TST-018)
- [x] Ledger updated (TST-018)
- [x] Issues created or changed: #46 (task for TST-018); #43 closed
- [ ] `.claude/agents/verifier.md` and `test-author.md`: launch in background mode unless a scenario needs the foreground group (orchestrator, after the task merges)
