# ADR 0008: Test support folders and the boundary check source

- **Status:** accepted
- **Weight:** major (item 1); minor (item 2)
- **Date:** 2026-11-12
- **Raised by:** test author, #14
- **Decided by:** human (item 1); orchestrator (item 2)
- **Affects:** ORCHESTRATOR.md section 6; CLAUDE.md conventions; #14

## Context

The boundary check (#14) decides from a closed list of paths which files are test code. The list holds gate tests (`*.gate.test.ts`, `*.gate.test.tsx`) and `e2e/smoke/`. Shared gate-test helpers in `tools/repo/support/` were not on it, so the check would reject the test author's changes to them and accept the developer's.

The CI job also ran the check script from the pull request's own code, so a commit could change the script and turn the check off.

## Decision

1. **Any folder named `test-support/` is test code.** The pattern `**/test-support/**` joins the test-path list. Only the test author changes these folders; the developer never does. `tools/repo/support/` is renamed to `tools/repo/test-support/` in #14.
2. **CI runs the boundary check script as it exists on the base commit**, against the pull request's commits. Only when the base has no script (the pull request that adds it) does CI use the pull request's version.

## Follow-up

- [x] CLAUDE.md conventions updated
- [ ] #14 gates cover both items
