# ADR 0016: Linux background test launches without the GPU process

- **Status:** accepted
- **Weight:** minor
- **Date:** 2026-11-12
- **Raised by:** developer, #46 attempt 3
- **Decided by:** orchestrator (minor)
- **Affects:** TST-018; ADR 0013 rule 2

## Context

On the GPU-less Ubuntu runners, the Chromium GPU process sometimes fails again and again at startup. Chromium then reports "GPU access is disabled due to frequent crashes" and falls back to software compositing. Until the fallback is complete (4.5 to 13.4 s), no frame is drawn: timers run on time, but `requestAnimationFrame` does not. This failed the dev paint gate in 2 to 3 of 8 runs (probe runs 43360499928, 43362648562). Showing the window later (`ready-to-show`, after `did-finish-load`) did not help (run 43362141480). With the GPU process disabled, the first paint came within 300 ms in 8 of 8 runs.

The failing runs already used software compositing (`gl=none`), so a disabled GPU process changes no rendering result on these runners.

## Options

1. **App switch disables hardware acceleration on Linux.** Adds a rendering change to the app-side switch; needs an ADR 0013 amendment (major).
2. **Test launches pass `--disable-gpu` on Linux in background mode.** The harness and the gate-test launch helpers add the switch. The app does not change.
3. **The gate waits for the first frame before it counts.** Hides a stall of up to 13 s that also affects Playwright actionability checks. Rejected by the reviewer ("no looser threshold").

## Decision

Option 2:

1. On Linux, every launch in background mode by the harness (`e2e/harness/smoke-app-harness.ts`) and by the gate-test launch helpers passes `--disable-gpu` to Electron.
2. A launch with `FOUNDATION_TEST_FOREGROUND=1` does not get the switch: it launches normally (ADR 0013 rule 2).
3. macOS and Windows launches do not change.
4. The paint gate threshold and verdict do not change. The proof is at least 5 green Ubuntu check runs in a row.

Trade-off: background tests on a Linux machine with a working GPU render in software. Rendering on the GPU is still exercised by the foreground group and by manual runs.

The developer's dev-reload fix (commit 3339578, `apps/reference/vite.renderer.config.ts`: drop Forge's `full-reload` after the first preload build) is kept. It removes a double page load on every dev launch, but it does not fix this stall.

## Follow-up

- [x] Spec updated: not needed (implementation within ADR 0013)
- [ ] Gates and launch helpers: test author, #46 attempt 6
- [ ] Harness: developer, #46 attempt 4
