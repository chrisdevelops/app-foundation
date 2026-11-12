# ADR 0014: Stricter rules in the packaged CDP guard

- **Status:** accepted
- **Weight:** minor
- **Date:** 2026-11-12
- **Raised by:** developer, #18
- **Decided by:** orchestrator (minor)
- **Affects:** TST-009, PLT-008; ADR 0004 decision 2 B

## Context

The #18 guard (`packages/foundation/src/main/packaged-cdp-guard.ts`) went further than the brief in two places. Both are stricter than the specs and stay inside ADR 0004 decision 2 B, which accepts the environment-variable risk for the CDP port only. Recorded on #18 as readings 12 and 13; the reviewer judged both correct.

## Options

1. **Keep both rules and gate them.**
2. **Remove them:** the guard refuses only `--remote-debugging-port` without the variable.

## Recommendation

Option 1.

## Decision

Option 1:

1. A packaged build refuses Node inspector switches (`--inspect`, `--inspect-brk`, `--inspect-port`, `--inspect-publish-uid`) even when `FOUNDATION_ALLOW_PACKAGED_CDP=1`. The variable enables only the CDP port. The `EnableNodeCliInspectArguments` fuse already stops the debugger; the guard also makes the app exit non-zero and name the switch on stderr.
2. Every build refuses a `--remote-debugging-address` that is not loopback. This enforces "localhost only" in TST-009.

Gates: `tools/reference-app/reference-app-build.gate.test.ts` (attempt 2 of #18, commit 0e09a70).

## Follow-up

- [x] Spec updated: not needed (stricter reading of TST-009)
- [x] Ledger updated (TST-009, PLT-008)
- [x] Issues created or changed: #18 (readings 12 and 13), #45 (`--remote-debugging-pipe`)
