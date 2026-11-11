# Spike #6: Electron Forge with its Vite plugin in a pnpm workspace

Branch `spike/6-forge-vite`. Code: `spikes/6-forge-vite/`. Run date 2026-11-11. Requirements: PLT-005, PLT-003, PLT-007.

## Question

Can pinned Forge plus `@electron-forge/plugin-vite` dev-run, package and make a main/preload/renderer app that is a workspace package in a pnpm monorepo, with locked fuses? Does the plugin's experimental status call for evaluating alternatives now?

## Answer: GO-WITH-CHANGES

It works on macOS arm64. Two things differ from the specs: (1) Forge's own check demands a pnpm setting; (2) Forge 8 took the Vite plugin out of experimental, so the spec's "experimental" fact is out of date. No full evaluation of alternatives is needed now.

## Tested versions (macOS 26.6.2, arm64 only)

Electron 45.3.0 (Chromium 156, Node 24.22.2 inside), `@electron-forge/{cli,plugin-vite,plugin-fuses,maker-zip}` 8.0.1, `@electron/fuses` 2.1.3, Vite 8.3.8, TypeScript 5.9.3, Node 24.18.0, pnpm 11.13.1. Windows and Linux: **not verified**.

## Evidence

| Item | Result |
| --- | --- |
| `electron-forge start` | Window opens. Settings read back from the live window: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. Preload ran in a sandboxed renderer (`process.sandboxed` true) and the `contextBridge` API reached the page. The page has no `require` or `process`. |
| Renderer hot reload | Edits to `index.html` and `src/renderer.ts` showed in the page with the same Electron pid (`[vite] (client) page reload ...`). |
| Main edit in dev | The bundle rebuilt, but the app did not restart (same pid). Matches open issue #4446 (opt-in `hotRestart` is broken in 8.0.1). |
| Edit in the workspace package | Main rebuilt. No renderer reload line appeared. Not investigated. |
| `package` | exit 0. `.app` is 252 MB. Starts and reports `packaged: true`. |
| `make` (zip) | exit 0. Zip was unpacked in a clean folder and started. Other makers (dmg, pkg, signing) not tested. |
| Fuses | `electron-fuses read` confirms: RunAsNode off, EnableNodeOptionsEnvironmentVariable off, EnableNodeCliInspectArguments off, EnableCookieEncryption on, EnableEmbeddedAsarIntegrityValidation on, OnlyLoadAppFromAsar on, GrantFileProtocolExtraPrivileges on. Left at default: LoadBrowserProcessSpecificV8Snapshot off, WasmTrapHandlers on. |

## pnpm settings

- **Needed:** `pnpm config get node-linker` must be `hoisted`, or `hoist-pattern` or `public-hoist-pattern` must be set. Source: `packages/cli/src/util/check-system.ts` in the Forge package. Without it, `package` stops before building. Setting `nodeLinker: hoisted` in `pnpm-workspace.yaml` satisfied the check (pnpm 11 reads it there).
- **The check is a guard, not a functional need for this app.** With the default isolated layout plus `publicHoistPattern: ['*types*']` (a dummy value), package and run also worked. The Vite plugin ignores every file except `/.vite` (`resolveForgeConfig` in `VitePlugin.js`), so the asar holds only `.vite/` and `package.json` under both layouts.
- **Consequence:** a dependency left out of the bundle (a native module, or `rollupOptions.external`) is not copied in either layout. A probe with `is-odd` marked external produced an asar with no `node_modules`; `main.cjs` still calls `require("is-odd")`. The packaged app never wrote its report and hung until killed (probably the Electron main-process error dialog; the dialog text was not captured). Native modules need a separate decision (not tested).
- **Hoisted changes the workspace:** dependencies move to the workspace root `node_modules`; `apps/demo/node_modules` holds only the workspace link. This weakens pnpm's phantom-dependency protection for the whole workspace. PLT-003 stays intact. Whether hoisted breaks Turborepo or Vitest was not tested.
- **pnpm 11 side effects:** dependency build scripts are blocked by default, so the `electron` postinstall did not run; Electron downloaded on first `require('electron')` instead. pnpm 11 also wrote `minimumReleaseAgeExclude: [vite@8.3.8]` into the workspace file (a release-age gate on fresh versions). CI that needs a pre-fetched Electron should approve its build script.

## Failure modes (exact text)

1. `When using pnpm, \`node-linker\` must be set to "hoisted" (or a custom \`hoist-pattern\` or \`public-hoist-pattern\` must be defined).` Fix: the settings above.
2. `The "main" entry point in "package.json" is ".vite/build/main.js", but the Vite plugin now emits the main process bundle as ".vite/build/main.cjs".` Fix: set `main` to `.vite/build/main.cjs` and load `preload.cjs`. Forge 8 emits `.cjs` always.
3. With `GrantFileProtocolExtraPrivileges: false`, the packaged app fails: `ERR_FILE_NOT_FOUND (-6) loading 'file://.../app.asar/.vite/renderer/main_window/index.html'`. The file is in the asar. `loadFile` from the asar needs the fuse **on** with this loader. PLT-008 gate tests must not require this fuse off without a different renderer loader (for example a custom protocol). Not investigated further.
4. Vite 8 warns on every start: `Your Vite config uses features that are unsupported by configLoader: 'native'` for `.ts` configs in a CommonJS package. Fix: `.mjs` configs or `"type": "module"`. Not tested.

## Plugin status (sources below)

- Forge 8.0.0 (2026-09-29) release notes: "The Vite plugin is promoted to stable. `@electron-forge/plugin-vite` is no longer experimental and is covered by semver. It now targets Vite 8." Latest is 8.0.1 (2026-09-29). Previous: 8.0.0-alpha.10 (2026-07-02), 7.11.2 (2026-05-20). Vite plugin dev dependency: `vite ^8.0.0`. The plugin declares no `vite` dependency or peer; the app must install it (issue #4350).
- The Forge docs pages still say "marked as experimental since 7.5.0" (checked 2026-11-11), so they are stale. Issue #4067 (opened 2025-12-03, open) asked for clearer labelling.
- Open issues touching the Vite plugin: #4446 (hotRestart does nothing in start), #4439 (renderer loads twice at start), #4444 (SIGINT forwarding), #3738 (incomplete asar with make; not seen here), #3865. None blocks build, package or make here.
- Forge 8 needs Node 22.17 or newer and is ESM only. Vite 6 and 7 are not supported by Forge 8's plugin.

## Desk check: Vite major

- Vitest 4.1.12 declares `vite ^6 || ^7 || ^8`. Vitest 5.1.0 (current latest, 2026-11-02) declares `^6.4 || ^7 || ^8`. Vite 8 is fine for both.
- Paraglide `@inlang/paraglide-js` 2.29.3 declares `vite >=5`. **Spec drift:** npm `latest` is now 3.2.2 (2.x is a maintenance line). The spec says "stable v2". Not checked whether 3.x changes anything for STA-008.
- Not verified: Vitest Browser Mode and Paraglide running together inside this Forge workspace.

## Recommendation

Go-with-changes. Build on Forge 8.0.1 + plugin-vite 8.0.1 + Vite 8, all pinned exactly. No alternatives evaluation now; revisit only if Forge 8.x breaks packaging. Changes for the human:

1. Record `nodeLinker: hoisted` (or a deliberate `public-hoist-pattern`) as a PLT-003 workaround. It affects the whole workspace and Turborepo (PLT-004).
2. Update the "Verified facts" row: the plugin is stable in Forge 8, not experimental; the matching risk row is much weaker.
3. Decide how the app loads its renderer in a packaged build (fuse choice, PLT-008).
4. Decide native or unbundled dependencies (PLT-007), since the plugin ships `.vite/` only.
5. Note the Paraglide 3.x and Vitest 5 drift.

## Sources

- Forge 8.0.0/8.0.1 release notes (2026-09-29): https://github.com/electron/forge/releases/tag/v8.0.1
- Forge Vite plugin docs (stale experimental wording): https://www.electronforge.io/config/plugins/vite
- Issue #4067: https://github.com/electron/forge/issues/4067 . Issue #4446: https://github.com/electron/forge/issues/4446
- npm registry metadata for the packages above (queried 2026-11-11)
- Installed source: `@electron-forge/cli/src/util/check-system.ts`, `@electron-forge/plugin-vite/dist/VitePlugin.js` (8.0.1)
