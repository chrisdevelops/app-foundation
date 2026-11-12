# ADR 0011: Windows smoke-harness deferral

- **Status:** accepted (trigger occurred)
- **Weight:** major
- **Date:** 2026-11-12
- **Raised by:** orchestrator, #16
- **Decided by:** human
- **Affects:** TST-010, TST-015, phase 1 exit gate; #16, #17

## Context

The smoke harness (#16) passed on Windows in attempt 1, regressed in attempt 2, and attempt 3 fixes the reviewer's Windows findings. Each Windows diagnosis needs a CI round, because no Windows machine is available locally. The human set a limit: no more time on the Windows build after attempt 3.

## Trigger

CI for #16 attempt 3 (run 43205077115, head ceaaa5f) fails on `check (windows-latest)` only in the e2e smoke harness gates.

## Options

1. **Defer Windows e2e only:** Windows keeps every other CI check; only the smoke harness gates skip on Windows.
2. **Drop Windows from CI:** CI and the phase 1 exit gate cover macOS and Linux only.
3. **macOS only for now.**

## Decision

Option 1. If the trigger occurs:

- The smoke harness gates (`e2e/harness/*.gate.test.ts`) and `e2e/smoke/` skip on Windows with a visible skip reason, a `DEFERRED: TST-010` marker and a `test.todo`; the test author makes this change with `Test-Change`.
- All other Windows CI checks stay required, including the clean-clone gate (with the e2e tasks skipped on Windows), the reference app build gates and the boundary check.
- Linux and macOS stay required for everything.
- A new issue records the Windows harness work for a later phase. No further time goes into it during phase 1.
- The phase 1 exit gate reads: packaged-app smoke tests pass on macOS and Linux; on Windows, the packaged app builds, starts and passes its build gates.

If the trigger does not occur, this ADR has no effect.

## Follow-up

- [x] Trigger occurred: run 43205077115 (ceaaa5f) failed on Windows only in `TST-007: each launch uses a fresh temporary user data folder` (1 of 22 e2e gates) and its clean-clone knock-ons. Follow-up issue: 39
