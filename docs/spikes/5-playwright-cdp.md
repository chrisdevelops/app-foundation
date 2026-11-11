# Spike #5: Playwright over CDP against an Electron app

Branch `spike/5-playwright-cdp`. Code in `spikes/5-playwright-cdp/` (the issue text says `spikes/playwright-cdp/`; the task brief set the path used). Date: 2026-11-11.

## Question

Can Playwright, connected with `chromium.connectOverCDP`, find and drive every window of an Electron app we start ourselves, including a window opened later, with the security baseline on?

## Answer

Yes. Recommendation: go-with-changes (two spec wording points, below). Confidence: high for macOS arm64; Windows and Linux not verified.

## Versions

Electron 45.3.0 (Chromium 156.0.8078.96), playwright-core 1.65.0, Node 24.18.0, pnpm 11.13.1, macOS 26.6.2, arm64. App: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, CSP meta tag `default-src 'none'; script-src 'self'; ...`. In the renderer `typeof require` and `typeof process` are `undefined`.

## Evidence (outputs in `*.out`)

- `happy.out`: connects; 1 context; lists pages; main title "Spike Main"; click twice gives `#count` = 2. Window opened after connection by `window.open` and by a new `BrowserWindow` (via IPC) both fire `context.on('page')`, load, and accept clicks (3 pages, then 2 after closing one).
- Lifecycle: spawn Electron with `--remote-debugging-port=N --user-data-dir=<tmp>`, poll `/json/version` (ready in under 1 s), connect, `SIGTERM` to the process group. `pgrep -f <user-data-dir>` showed no orphans in every run. `browser.close()` only disconnects; the app keeps running.
- Failure modes (`failures.out`), exact text:
  - Not started or wrong port: `browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:9555` (same for 9334).
  - Port in use: the second app does not quit and does not fail. It logs `bind() failed: Address already in use (48)` and `Cannot start http server for devtools.`, then runs without CDP. A client connecting to that port reaches the first app. Silent wrong-target risk.
  - App quits during a test: `browser` fires `disconnected`; later calls throw `page.title: Target page, context or browser has been closed`.
  - `Browser.close` over a CDP session quits the app (exit 0) and throws the same "has been closed" error. No orphans.
- Packaged build (`@electron/packager` 20.3.0 + `@electron/fuses` 2.1.3, `packaged.out`): with RunAsNode, NodeOptions, NodeCliInspect off, and asar integrity and OnlyLoadAppFromAsar on, `--remote-debugging-port` is still accepted. Playwright drove the app, including a child window. No fuse in the Electron fuse docs mentions Chromium switches. NodeCliInspect off did stop `--inspect` in the packaged build (no "Debugger listening"); the unlocked dev build did start it.
- Side finding: with `GrantFileProtocolExtraPrivileges` off, `loadFile` of `app.asar/index.html` failed with `ERR_FILE_NOT_FOUND`; turning it on fixed it. Unrelated to CDP; matters for Forge spike. Use a custom protocol if it must stay off (Electron fuse docs recommend this).
- `page.evaluate(() => eval('1+1'))` returned 2 despite the CSP (no `unsafe-eval`). Cause not verified (likely CDP evaluation bypasses page CSP). CSP gate tests should not rely on `page.evaluate` to prove the CSP blocks eval.

## Playwright April 2026 restructuring

- PR #40184 (merged 2026-04-17) moved the Electron API into a new `@playwright/electron` package built on `connectToWorker` + `connectOverCDP`, and dropped options such as `recordHar`/`recordVideo`.
- PR #40461 (merged 2026-04-28) reversed it: package marked private, client code moved back into `playwright-core`, `playwright._electron` restored.
- Result: `@playwright/electron` on npm is a 0.0.1 placeholder plus 1.60.0-alpha builds from April; no stable release. `_electron` exists in playwright-core 1.65.0 (checked in the installed package). `connectOverCDP` is not affected.
- Status is still "experimental" (docs, fetched 2026-11-11). Maintainer, 2026-11-02, issue #43834: "We don't have plans to remove Electron support, if anything, we'll make it public", and 99% of it is Node plus CDP, reproducible with public APIs. Issue #43247: `_electron.launch` intermittently lost a packaged app's first window on 1.64.0; maintainer says upstream Chromium fix merged (Electron version carrying it: not verified).

## What CDP cannot reach

- Native menus and dialogs (OS-drawn): not renderer content. Playwright issue #5013 (2021): file chooser not emitted for `dialog.show*Dialog`. Main-process stubs are the TST-008 path.
- The main process: the CDP port exposes renderer and browser targets. Playwright's own launch reaches it via Node `--inspect`, which the NodeCliInspect fuse disables (verified above).
- Tray, notifications, global shortcuts: inferred from the same reason; not verified.

## Fallback

Not needed (result is go). Not researched.

## Affects specs

- TST-009: say the CDP port is opt-in per launch and is not removed by fuses. "Development builds only" needs an in-code guard (decision for the orchestrator). Packaged smoke tests (TST-010) can use the same flag on a locked build.
- TST-007/TST-017 setup: the harness must choose a free port and check the endpoint belongs to its own process (port-in-use is silent).
- "Playwright April 2026" unknown and "Risks" row: update with the facts above; pin `playwright-core` exactly.

## Sources

- https://github.com/microsoft/playwright/pull/40184 and /pull/40461 (April 2026)
- https://github.com/microsoft/playwright/issues/43834 (2026-11-02), /43247 (2026-10), /39477 (2026-03-03), /5013
- https://playwright.dev/docs/api/class-electron (fetched 2026-11-11)
- https://www.electronjs.org/docs/latest/tutorial/fuses and /api/command-line-switches (fetched 2026-11-11)
- https://registry.npmjs.org/@playwright/electron (published times)
