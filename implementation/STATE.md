# Build state

> Pointer file, rewritten by the orchestrator whenever a task changes stage, a phase changes, or an escalation opens or closes. History lives in GitHub Issues and git.

- **Updated:** 2026-11-12
- **Phase:** 1. Walking skeleton
- **Phase exit gate:** Packaged-app smoke tests pass on macOS and Linux; on Windows the packaged app builds, starts and passes its build gates (ADR 0011); human walks through it by hand (menus: see ADR 0006)

## Active tasks

| Issue | Title | Stage | Attempt | Next action |
| --- | --- | --- | --- | --- |
| #18 | Security baseline: gate tests for isolation, CSP and the packaged CDP guard | review | 2 | Reviewer approved 70f9178 on condition of CI; verifier passed (attempt 1). Merge PR #44 when all seven checks on run 43298986676 pass. |
| #46 | Background test runs: no window shown, no focus taken (TST-018) | planned | — | Next after #18 (ADR 0013). |

## Last action

#18 attempt 2: test author added gates for child-window `window.open` and the address and inspector refusals (0e09a70); developer named #45 in the pipe deferral (70f9178); reviewer approved. Spike #43 done: background mode works on macOS. Human accepted ADR 0013 (background test runs, new TST-018); task #46 created; #45 opened for `--remote-debugging-pipe` (phase 2).

## Next action

Merge #18 after CI; update ledger and STATE; write a minor ADR for #18 readings 12 and 13. Then start #46 (test author).

## Open escalations

| Issue or ADR | Waiting on | Since |
| --- | --- | --- |
| None | | |

## Blockers

None.

## Notes for the next orchestrator

- Order: #18, #46, #19 … #24, #30, #25 … #29. Phase 1 is strictly sequential.
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
- Follow-ups: #36 (minor gate gaps), #39 (Windows harness, phase 3), #42 (evidence gaps, phase 2), #45 (`--remote-debugging-pipe`, phase 2). After #46 merges: update `.claude/agents/verifier.md` and `test-author.md` for background mode (ADR 0013 follow-up).
- Spike branches `spike/5` to `spike/9` and `spike/43` are never merged; their findings are the reference for phase 1 tasks.
- `docs/upstream/react-aria-second-window-overlays.md` is a draft the human posts; do not post it.
- Open human decision in the specs: re-validation after a failed submit.
