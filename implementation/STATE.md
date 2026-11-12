# Build state

> Pointer file, rewritten by the orchestrator whenever a task changes stage, a phase changes, or an escalation opens or closes. History lives in GitHub Issues and git.

- **Updated:** 2026-11-12 (session handoff)
- **Phase:** 1. Walking skeleton
- **Phase exit gate:** Packaged-app smoke tests pass on macOS and Linux; on Windows the packaged app builds, starts and passes its build gates (ADR 0011); human walks through it by hand (menus: see ADR 0006)

## Active tasks

| Issue | Title | Stage | Attempt | Next action |
| --- | --- | --- | --- | --- |
| #18 | Security baseline: gate tests for isolation, CSP and the packaged CDP guard | implementing | 1 | Delegate to the developer (not started). Branch `task/18-security-baseline`, gates in a212c33; the envelope and accepted readings on #18 list the five things to build. |

## Last action

#18 test author done (a212c33, `Test-Change: approved #18`, boundary check 0): gates red for the missing guard, CSP, `window.open` denial and CI variable. The guard is possible (scratch probe). Variable `FOUNDATION_ALLOW_PACKAGED_CDP=1`. Envelope and 11 readings posted on #18.

## Next action

Start the developer for #18 with the five items in the #18 envelope comment, then CI, reviewer (explicit `ci.yml` review) and verifier, then merge.

## Open escalations

| Issue or ADR | Waiting on | Since |
| --- | --- | --- |
| Superseded branch `task/17-packaged-smoke-ci` | Human: approve deletion | 2026-11-12 |

## Blockers

None.

## Notes for the next orchestrator

- Order: #18 … #24, #30, #25 … #29. Phase 1 is strictly sequential.
- Merge procedure (ADR 0009 item 4): reviewer `approve`; `gh pr checks` shows `boundary-check`, three `check (<os>)` and three `packaged-smoke (<os>)` checks `pass` (seven in total); explicit review of any diff to `.github/workflows/` or `tools/boundary-check/`. No branch protection (ADR 0009 item 5, human decision). A job cancelled because no runner was acquired, or a known Windows flake (#39 EBUSY), is rerun with `gh run rerun <id> --failed`; it is not a code failure. The human pre-approved `gh pr merge` with a local permission rule.
- Windows: the human set a limit (ADR 0011). The smoke harness and smoke tests skip on Windows; no more phase 1 time on Windows harness work (#39); Windows keeps every other check. If a Windows-only failure needs real work, ask the human.
- Task branches are never updated by merging `main`; force-push is blocked by the permission system. Rebuild on a new branch with cherry-picks and amend trailers before the first push (ADR 0009 item 2; done in #14 and #17).
- The boundary check runs on every PR: a test-author commit that changes an existing test file needs `Test-Change: approved #<n>` in its own trailers.
- Shared test helpers used by more than one system live in `tools/test-support/`; system-only helpers stay in that system's `test-support/` (ADR 0008). Only the test author changes them. No system imports another system's `test-support/`.
- Post the decisions and readings themselves on the issue, never only a reference to an agent report.
- Prove CI behaviour that only a real run can show with a throwaway draft PR from a `probe/*` branch; close it and delete the branch afterwards (done in #13, #16, #17).
- The clean-clone gate shows only the end of nested output; a Windows or Linux e2e failure may need a direct run or a probe (#36).
- After each agent's red or green runs, `pgrep` for `smoke gate fixture`, `smoke-user-data`, `rf-gate-user-data` and `repo-gate-clone`; stop leftovers from this project only (another project, flowspec, runs Electron on this machine).
- The pinned-SHA gate needs network access; one local run failed on a connection reset (#36 adds a retry).
- Follow-ups: #36 (minor gate gaps), #39 (Windows harness, phase 3), #42 (evidence gaps, phase 2). Candidate for #18 review: `--remote-debugging-pipe` and localhost-only with `=1` are not gated.
- Spike branches `spike/5` to `spike/9` are never merged; their findings are the reference for phase 1 tasks.
- `docs/upstream/react-aria-second-window-overlays.md` is a draft the human posts; do not post it.
- Open human decision in the specs: re-validation after a failed submit.
