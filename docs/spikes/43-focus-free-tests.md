# Spike #43: focus-free Electron test runs on macOS

Branch `spike/43-focus-free-tests` (never merged). Scratch code: `spikes/43/` (`main.js`, `index.html`, `measure.mjs`). Electron 45.3.0, macOS 26 (Darwin 25.6) arm64, one machine. Measured: frontmost app sampled every 150 ms from launch to 1.5 s after the DevTools port opened (`lsappinfo front`); window state from `CGWindowListCopyWindowInfo`; Dock presence from `lsappinfo` `ApplicationType` (`Foreground` = Dock icon, `UIElement` = none). The known front app was TextEdit. 3 runs per row unless noted.

## Answer

Yes on macOS, with two methods that each keep focus with the frontmost app in every clean run. Nothing needs the packaged fuses changed.

1. **Launch-only, no app change: `open -j -n -W -a <app> --stdout F --stderr F --env K=V --args <switches>`.** Works for the packaged app (3/3 clean). The window is on screen but behind the front app's windows and Chromium still paints it. This is the fidelity-best option.
2. **App-side, behind a switch: `show:false` or `showInactive()`, plus `app.setActivationPolicy('accessory')`.** 3/3 clean; accessory also removes the Dock icon. Needed for the dev build, because `pnpm run dev` (Forge) starts Electron itself and `open` cannot wrap it (dev-through-`open` not verified).

## Results (focus kept = front app unchanged for the whole sample window)

| Method | Focus kept | Window | Dock icon | `hasFocus()` | visibility / rAF | Screenshot | CDP keys |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline direct spawn | no (3/3 stolen) | on screen, front | yes | true | visible / 60 | ok | ok |
| `dock.hide()` or `accessory` only | no (steals, 5 of 5 clean runs; 1 run contaminated) | front | no | true | visible / 60 | ok | ok |
| `offscreen` x/y -5000 | no (3/3 stolen) | macOS clamped it back on screen (at 0,30) and the app activated | yes | true/false | visible / 60 | ok | ok |
| `open -g` | no (3/3 stolen) | front | yes | true | visible / 60 | ok | ok |
| `showInactive()` | yes | on screen, above front app | yes | false | visible / 60 | ok | ok |
| `show:false` (never shown) | yes | none | yes | false | "visible" / 60 | ok | ok |
| `accessory` + `showInactive()` | yes | above front app | no | false | visible / 60 | ok | ok |
| `accessory` + `show:false` | yes | none | no | false | visible / 60 | ok | ok |
| `open -j` (dev scratch app) | yes | on screen, below front app (2 of 3; third had no front window) | yes | false | visible / 60 | ok | ok |
| `open -g -j` | yes | on screen | yes | false | visible / 60 | ok | ok |
| Packaged `Reference.app`, direct spawn | no (3/3 stolen) | front | yes | true | visible | ok (PNG) | not tested (no input) |
| Packaged `Reference.app`, `open -j` | yes (3/3) | below front app | yes | false | visible | ok (PNG) | not tested (no input) |

Notes on the table:
- `open -g` alone does not help: Electron activates itself on show. `-j` (launch hidden) is what keeps focus.
- `show:false` leaves visibility "visible" and paints at 60 fps (Electron docs say so). So hidden windows do not throttle.
- `document.hasFocus()` is false in every focus-free mode. `Emulation.setFocusEmulationEnabled` makes it true (verified in all modes). `Input.dispatchKeyEvent` typed "abc" into the focused input in every mode, including hidden. So CDP keyboard input does not need OS focus; native menus, dialogs, real OS focus order, and `win.focus()` still do.
- Occlusion: one early `open -j` run (while another process fronted over it) showed `visibility: hidden`, rAF 0. I could not reproduce it with the window covered by a maximized TextEdit (3/3 visible, 55-60 fps, also with `backgroundThrottling:false`). Treat occlusion throttling as possible but not reproduced; `backgroundThrottling:false` (documented to keep state visible) is the cheap guard.
- Contamination: the other agent's `reference` app and flowspec took the front several times (the `foreignFront` count in `measure.mjs`). That is the problem in the issue seen live. A run counts as stolen only when the front became one of my own pids; foreign fronts are reported separately and excluded.
- The packaged app refuses the DevTools port unless `FOUNDATION_ALLOW_PACKAGED_CDP=1` is in its environment (existing guard on `main`). With `open`, pass it with `--env`; without it the app exits and `open` still returns 0.

## Harness impact of `open`

`open -j -n -W --stdout F --stderr F --env ... -a App --args ...` is close to a drop-in for `spawn`: `-W` keeps `open` alive until the app exits (verified: alive while running, exits when the app is killed), stdout and stderr land in files (verified: DevTools line and the refusal message were captured). Lost: the app's pid and exit code, the process group. The harness already finds and kills by `--user-data-dir`, so ownership and teardown still work; it must read the pid from that match. Not verified: the existing `smoke-app-harness.ts` changes themselves.

## Other platforms (not measured; sources only)

- **Linux:** the harness already uses `xvfb-run` when there is no display; a virtual X server cannot take focus from a Mac. Running the local suite in a Linux container with Xvfb is fully focus-free but is a different platform (no macOS menus, title bar, Dock, fonts; Electron `showInactive` is unsupported on Wayland). Docker not checked on this machine. Not verified.
- **Windows:** `windowsHide` in the harness is the Node `child_process` option; it only hides a console window, not Electron windows. `showInactive()` is documented to show without focus. Windows' own foreground-lock rules limit stealing, but I did not test it. Not verified.

## Security cost of an app-side switch

- A window and activation-policy switch exposes no code execution, no extra IPC and no data. It does not touch fuses, sandbox, context isolation, CSP or the `app://` loader (PLT-008). The existing packaged guard for the CDP port (ADR 0004 decision 2B, TST-009) already reads an environment variable the same way, so a second variable adds no new class of risk.
- TST-008 (no test bridge in packaged builds) is not affected: this is not a main-process bridge. Still, keep it out of release builds if the team wants zero test switches there; a build-time constant is the strict option, and ADR 0004 already accepted the env-var approach for the CDP port.
- Because `open -j` needs no app change, the packaged build needs no new switch at all. That is the main reason to prefer it.

## Recommendation

1. Packaged smoke tests on macOS: launch with `open -j -n -W` (no app change). Add `backgroundThrottling:false` only if throttling shows up.
2. Dev build (Forge `pnpm run dev`) and gate-test fixture apps: add a switch (for example `FOUNDATION_TEST_BACKGROUND=1`) read in `packages/foundation/src/main/app-window.ts` and `e2e/test-support/smoke-fixture-app.ts` that calls `setActivationPolicy('accessory')` and uses `showInactive()` (or `show:false`). Allow it in dev and test builds; leave it out of release builds or accept the env-var form as ADR 0004 did for CDP.
3. Tests that really need OS focus (native menus, dialogs, `win.focus()`, real tab order) stay in a small, named, foreground group. Use `Emulation.setFocusEmulationEnabled` for the rest.
4. Use Linux container plus Xvfb only as an additional local option, not a replacement.

Cost in fidelity: `open -j` and `showInactive` keep the real window, GPU paint and the same code path as the user; only `hasFocus()` and OS-level focus differ. `show:false` skips real window compositing on screen but screenshots via CDP still render. `accessory` changes the Dock and menu bar behaviour (no menu bar), so macOS app-menu tests need the foreground group.

## Does it change a recorded decision?

No. It adds a test-only option next to ADR 0004 decision 2. It touches TST-007/TST-010 harness behaviour (launch path) but contradicts nothing.

## Sources

- Electron `app` API (`setActivationPolicy`, `app.focus`): https://www.electronjs.org/docs/latest/api/app
- Electron `BrowserWindow` (`showInactive`, `show:false` visibility, `backgroundThrottling`, `focusable`): https://www.electronjs.org/docs/latest/api/browser-window
- Local measurements: `spikes/43/measure.mjs` (re-runnable; needs the Electron binary from the main checkout and a TextEdit window).
