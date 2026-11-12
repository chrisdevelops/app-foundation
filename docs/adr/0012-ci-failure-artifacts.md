# ADR 0012: CI failure artifacts

- **Status:** accepted
- **Weight:** major
- **Date:** 2026-11-12
- **Raised by:** test author, #17
- **Decided by:** human
- **Affects:** TST-010, TST-015; `tools/repo/ci-workflow.gate.test.ts` action allowlist; #17

## Context

Issue #17 asks CI to keep the smoke harness logs and screenshots when a packaged smoke run fails. The CI action allowlist (#13) permits only `actions/checkout`, `actions/setup-node` and `pnpm/action-setup`. In #16, two Windows and Linux failures were hard to diagnose because the nested output was cut off.

## Options

1. **Add `actions/upload-artifact`:** full evidence for failed runs.
2. **Job log only:** no new action; output can be cut off.
3. **Defer.**

## Decision

Option 1, with these limits:

1. `actions/upload-artifact` joins the allowlist, pinned to the full commit SHA of a release tag, like the other three actions.
2. It runs only when an earlier step failed (`if: failure()`), only in the packaged smoke job, and uploads only the harness evidence folder.
3. The evidence folder holds the harness's own logs (app stdout and stderr, harness events) and screenshots. It never holds environment variables, tokens or files from outside the run.
4. Workflow `permissions` stay `contents: read`; the step gets no other permission.
5. Artifacts are kept for 7 days.

## Follow-up

- [ ] Allowlist gate changed with `Test-Change: approved #17`
- [ ] Gates for the harness evidence folder and the upload step
- [ ] Developer: harness writes evidence on failure; CI uploads it
