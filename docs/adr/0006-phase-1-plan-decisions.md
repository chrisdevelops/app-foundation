# ADR 0006: Phase 1 plan decisions

- **Status:** accepted
- **Weight:** major (items 1 to 3); minor (item 4)
- **Date:** 2026-11-11
- **Raised by:** planner, phase 1 plan (#12 to #29)
- **Decided by:** human (items 1 to 3); orchestrator (item 4)
- **Affects:** STA-008, STA-010, XC-007, PLT-013, TST-008, TST-010, phase 1 exit gate; issues #25, #26, #29, #30

## Context

The phase 1 plan deferred the message catalogue, needed a new dependency for the native add-on check, and could not smoke-test native menus in a packaged build.

## Decision

1. **Message catalogue in phase 1.** STA-008 says "from day one", so issue #30 sets up Paraglide before the commands task. Menu and palette labels come from the catalogue (#25, #26).
2. **Native add-on for #29:** `better-sqlite3`, pinned exactly. This adds a dependency the specs did not list.
3. **Menu tests and the exit gate.** CDP cannot reach native menus, and TST-008 keeps the test bridge out of packaged builds. Menu smoke tests run on a non-packaged build on all three platforms (#24, #25). The human's walkthrough checks the menu in the packaged app. The phase 1 exit gate counts this as "packaged app passes smoke tests" for menus.
4. **Names chosen by the planner:** reference app prefix `rf` (`ref` is reserved), folder `apps/reference`, first command `rf.theme.toggle`, and the profile plugin in the `@foundation/config` package.

## Follow-up

- [x] Issues created or changed: #30 created; #25, #26 updated; #29 `adr-needed` removed
- [ ] Spec updated: not needed
- [ ] Ledger updated: not needed
