# ADR 0005: Native add-on packaging method

- **Status:** accepted
- **Weight:** minor
- **Date:** 2026-11-11
- **Raised by:** researcher, #9
- **Decided by:** orchestrator (minor); spike go given by the human
- **Affects:** PLT-007, PLT-013

## Context

ADR 0004 decision 4 B requires native add-ons. Spike #9 (`spike/9-native-addons`, `docs/spikes/9-native-addons.md`) packaged `better-sqlite3` 13.1.1, `sharp` 0.35.5 and `node-pty` 1.1.0 with Forge 8.0.1 and the Vite plugin on macOS arm64. The Vite plugin packs only `.vite/`.

## Options

1. **Externals plus a copy hook:** proven in spike #9 with the isolated pnpm layout and locked fuses.
2. **Bundle add-ons with Vite:** not possible for `.node` binaries.

## Recommendation

Option 1.

## Decision

Each app that uses native add-ons follows this method, provided by the foundation as one helper:

1. Mark each add-on as external in the app's Vite main config.
2. A Forge `afterCopy` hook (async, no callback) copies each add-on and its dependency closure into the build path, resolving real paths through pnpm symlinks.
3. `packagerConfig.asar.unpack` covers `**/{*.node,*.dylib,spawn-helper}`.
4. The hook sets mode 755 on `node-pty` prebuilt `spawn-helper` files, because the published 1.1.0 package ships them as 0644.
5. The hook removes binaries for other platforms and architectures. Spike #9 measured 358 MB without trimming.
6. pnpm `allowBuilds` lists each add-on.
7. Add-ons run only in the main process or a utility process, never in a renderer.

A gate test runs each add-on in the packaged app from outside the repository. Any test of a packaged app must fail on a modal error dialog instead of hanging: a top-level `require()` of a missing module shows one and the app never exits.

## Follow-up

- [ ] Phase 1: verify on Windows, Linux and x64; verify with the `app://` loader and `GrantFileProtocolExtraPrivileges` off (ADR 0004 decision 1)
- [ ] Ledger updated: PLT-013 note
- [x] Issues created or changed: #9 closed
