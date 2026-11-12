# Spike #9: native Node add-ons with Forge and Vite

Branch `spike/9-native-addons`. Code: `spikes/9-native-addons/`. Raw logs: `spikes/9-native-addons/evidence/`. Run date 2026-11-11. Requirements: PLT-007, native add-on requirement (ADR 0004 decision 4), context PLT-003, PLT-005, PLT-008.

## Question

How does a Forge 8 and Vite app package and run `better-sqlite3`, `sharp` and `node-pty` (Electron ABI, fuses locked, ADR 0004 isolated pnpm layout)?

## Answer: GO-WITH-CHANGES (macOS arm64 only)

All three add-ons load and work in `electron-forge start`, in `package` output and in the `make` zip output (all calls run in the main process). The method needs four changes the specs do not state. Fuses stay as in spike #6; `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` stay on.

## Versions (macOS 26.6.2, arm64; Windows and Linux not verified)

Electron 45.3.0 (Node 24.22.2 inside), Forge `cli`, `plugin-vite`, `plugin-fuses`, `maker-zip` 8.0.1, `@electron/rebuild` 4.2.1 (pulled in by Forge), `@electron/packager` 20.3.0, `@electron/fuses` 2.1.3, Vite 8.3.8, `better-sqlite3` 13.1.1, `sharp` 0.35.5 (libvips 8.18.7), `node-pty` 1.1.0, host Node 24.18.0, pnpm 11.13.1.

## The method (all four items are needed)

1. **Layout:** isolated pnpm layout, `publicHoistPattern: ['*types*']` only (no `nodeLinker: hoisted`). The three packages are `dependencies` of the app. pnpm 11 needs `allowBuilds` entries (`better-sqlite3`, `node-pty`, `electron`: true) or install stops with `ERR_PNPM_IGNORED_BUILDS`.
2. **Vite:** `build.rollupOptions.external: ['better-sqlite3','sharp','node-pty']` in `vite.main.config.ts`. They stay as runtime `require()` calls.
3. **Copy into the package** (the Vite plugin keeps only `/.vite`): `packagerConfig.afterCopy` runs `copyNativeModules` (`apps/demo/copy-native-modules.ts`). It copies each module and its runtime dependency closure (including optional deps present on this OS) to `<buildPath>/node_modules`, resolving real paths through pnpm symlinks. Copied: `@img/colour`, `@img/sharp-darwin-arm64`, `@img/sharp-libvips-darwin-arm64`, `better-sqlite3`, `detect-libc`, `node-addon-api`, `node-pty`, `semver`, `sharp`. Hooks in `@electron/packager` 20 are `async ({ buildPath }) => {}`; the old `(buildPath, ver, platform, arch, done)` form fails with `TypeError: done is not a function`.
4. **Unpack the binaries:** `packagerConfig.asar = { unpack: '**/{*.node,*.dylib,spawn-helper}' }`. Also `chmod 755` the prebuilt `node-pty/prebuilds/*/spawn-helper` in the same hook (see failure 3).

## Evidence

| Item | Result (log in `evidence/`) |
| --- | --- |
| `electron-forge start` | exit 0; sqlite, sharp, pty OK (`start-report.json`) |
| `package` | exit 0, `.app` 358 MB (`package-final.log`); app copied outside the repo and run: all three OK (`packaged-final-report.json`) |
| `make` (zip) | exit 0 (`make.log`); zip unpacked outside the repo and run: all three OK (`packaged-make-report.json`) |
| Results | sqlite `select` returns 2 rows, SQLite 3.54.1; sharp 64x64 to 16x16 PNG; pty output `pty-hello-42\r\n`, exit 0 |
| Where binaries are | `Contents/Resources/app.asar.unpacked/node_modules/...`; JS stays in `app.asar` (`asar-list-final.txt`). `process.report` shared-object list shows each loaded file under `app.asar.unpacked` |
| Fuses, read after `make` finished (`fuses-final-out-app.txt`, `fuses-final-make-zip.txt`) | RunAsNode off; CookieEncryption on; NodeOptionsEnv off; NodeCliInspect off; **EmbeddedAsarIntegrityValidation on; OnlyLoadAppFromAsar on**; GrantFileProtocolExtraPrivileges on (spike #6 setting); V8 snapshot off; WasmTrapHandlers on |

The packaged app must be run outside the repo. Inside it, Node's upward `node_modules` lookup finds the workspace copy and gives a false pass (seen with the no-copy build).

## Electron ABI rebuild

- All three are **N-API** (`nm` shows `napi_register_module_v1` or `Napi::` symbols; `better-sqlite3` 13 `binding.gyp` sets `NAPI_VERSION=10`). N-API is ABI stable across Node and Electron versions (Node N-API docs), so the shipped prebuilds (`better-sqlite3` `prebuilds/darwin-arm64.node`, `sharp` `@img/sharp-darwin-arm64`, `node-pty` `prebuilds/darwin-arm64/pty.node`) load in Electron without a rebuild. Proved by the `SPIKE_STRIP_BUILD` build, which removed all rebuilt output and still passed (`packaged-prebuilds-only-report.json`).
- **Forge already rebuilds.** `electron-forge start` and `package` run `@electron/rebuild` ("Preparing native dependencies") in place on the app's `node_modules`, which writes into the pnpm store directory. Result here: `node-pty` was compiled from source for Electron (`build/Release/pty.node`, `bin/darwin-arm64-150/`, `.forge-meta` = `darwin--arm64--150`) and loads first (`node-pty` checks `build/Release` before `prebuilds`). `better-sqlite3` produced only `.stamp` files (prebuilt used). `sharp` is untouched. Compiling needs Xcode command line tools (present here; not tested without).
- Net: no extra rebuild step is needed for these versions. A non-N-API add-on would still be rebuilt by Forge's `@electron/rebuild` step.

## Cause of the spike #6 hang (found)

A top-level `require()` of a module missing from the package throws during main-process load. Electron then shows its modal "JavaScript error in main process" dialog and never exits, with nothing on stderr. `sample` of the hung process shows the main thread in `-[NSAlert runModal]` under `node::StartExecution` (`hang-static-require-sample.txt`). The dialog text was not captured. Rolldown hoists externals to top-level `require()` calls, so a handler imported first in `main.ts` does not run in time. Loading add-ons with `await import()` inside functions (as the spike does) turns a missing module into a catchable `ERR_MODULE_NOT_FOUND`.

## Failure modes (exact text)

1. Add-ons external, not copied: `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'better-sqlite3' imported from .../app.asar/.vite/build/main.cjs` (same for sharp, node-pty); asar holds only `/.vite` and `/package.json` (`asar-list-nocopy.txt`). With a static `require()` this is the hang above. Fix: item 3.
2. Copied but not unpacked (`asar: true`): `Error: Could not load the "sharp" module using the darwin-arm64 runtime` / `ERR_DLOPEN_FAILED: dlopen(.../sharp-darwin-arm64-0.35.5.node): Library not loaded: @rpath/libvips-cpp.8.18.7.dylib` (Forge's auto-unpack default catches `.node` only, not the `.dylib`); `node-pty`: `Error: posix_spawnp failed.` Fix: item 4 glob. See `packaged-f-no-unpack-report.json`.
3. `node-pty` 1.1.0 prebuilt only: `Error: posix_spawnp failed.` The published tarball ships `prebuilds/darwin-*/spawn-helper` as mode 0644 (`node-pty-1.1.0-tarball-modes.txt`). Forge's source build makes an executable `build/Release/spawn-helper`, which hides the problem. Fix: `chmod 755` in the hook (the hook does it; the prebuilds-only build passed with it).
4. `TypeError: done is not a function` from a callback-style `afterCopy` (`package-failure-afterCopy-callback.log`).

## Side effects and open points

- Package size: 358 MB. The whole module trees are copied, including all platform prebuilds (for example `better-sqlite3` has eight `.node` files, `node-pty` has win32 files). Trim by platform and arch in the hook before shipping.
- Forge's rebuild mutates the pnpm store directory of the add-on (build output appears in `node_modules/.pnpm/...`). Not a problem for a single Electron version; two apps on different Electron ABIs could collide for non-N-API add-ons (not tested).
- Asar integrity covers the asar archive. Unpacked binaries sit outside it; whether Electron validates them is not stated in the official integrity page (checked 2026-11-11). Not verified. Code signing is out of scope.
- The copy hook walks `dependencies` and `optionalDependencies` only. A hand-written helper is the cost; no Forge or Vite plugin option for it was found. Not exhaustively searched for third-party plugins.
- The spike keeps `GrantFileProtocolExtraPrivileges` on (spike #6). The add-ons do not depend on it; not tested with it off and an `app://` loader.
- Not tested: Windows, Linux, universal or x64 macOS builds, utility processes (main process only), dmg or pkg makers, signing and notarisation, Turborepo and Vitest on this layout, `make` for non-zip makers.

## Recommendation

Go-with-changes. Changes for the human, each named with what it affects:

1. Extra Forge config: Vite `external` list, an `afterCopy` copy step, and `asar.unpack` with `.dylib` and `spawn-helper` (PLT-005, PLT-007; native add-on requirement).
2. `allowBuilds` for `better-sqlite3`, `node-pty`, `electron` in `pnpm-workspace.yaml` (PLT-003; pnpm 11).
3. A `chmod` guard for `node-pty` `spawn-helper` (native add-on requirement).
4. A gate test that runs each add-on in the packaged app outside the repo, and a rule to load add-ons lazily so a missing module is an error, not a hang (PLT-008, TST).
5. Size trimming by platform before release (PLT-007).

Decision change: ADR 0004 decision 4 option B (design native packaging now) is supported by this spike; a note that the hoisted layout is not needed (decision 3 A holds) is supported too.

## Sources

- Installed source and logs in `evidence/`: `@electron-forge/plugin-vite` 8.0.1 `resolveForgeConfig`; `@electron/packager` 20.3.0 `types.d.ts` (`HookFunction`); `node-pty` 1.1.0 `lib/utils.js`, `lib/unixTerminal.js`; npm tarball modes.
- Node-API ABI stability: https://nodejs.org/api/n-api.html
- Electron ASAR integrity: https://www.electronjs.org/docs/latest/tutorial/asar-integrity
- Spike #6 findings: branch `spike/6-forge-vite`, `docs/spikes/6-forge-vite.md`
