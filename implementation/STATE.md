# Build state

> Pointer file, rewritten by the orchestrator whenever a task changes stage, a phase changes, or an escalation opens or closes. History lives in GitHub Issues and git.

- **Updated:** 2026-11-12
- **Phase:** 1. Walking skeleton
- **Phase exit gate:** Packaged-app smoke tests pass on macOS and Linux; on Windows the packaged app builds, starts and passes its build gates (ADR 0011); human walks through it by hand (menus: see ADR 0006)

## Active tasks

| Issue | Title | Stage | Attempt | Next action |
| --- | --- | --- | --- | --- |
| #17 | CI: package the reference app and run smoke tests on three platforms | tests | 1 | Check test-author envelope and red run on `task/17-packaged-smoke-ci` |

## Last action

#16 merged (PR #38, developer attempt 3, reviewer approve, verifier 5/5): smoke harness over CDP with ownership checks and safe whole-tree teardown; Windows harness gates skipped under ADR 0011 (follow-up #39). TST-007 done.

## Next action

Task loop on #17, then each next issue in the chain.

## Open escalations

| Issue or ADR | Waiting on | Since |
| --- | --- | --- |
| — | — | — |

## Blockers

None.

## Notes for the next orchestrator

- Order: #17 … #24, #30, #25 … #29. Phase 1 is strictly sequential.
- Merge procedure (ADR 0009 item 4): reviewer `approve`; `gh pr checks` shows `boundary-check` and three platform checks `pass`; explicit review of any diff to `.github/workflows/` or `tools/boundary-check/`. No branch protection (ADR 0009 item 5, human decision). A job that GitHub cancels because no runner was acquired is rerun with `gh run rerun <id> --failed`; it is not a code failure.
- Windows: the human set a limit (ADR 0011). The smoke harness and smoke tests skip on Windows; no more phase 1 time on Windows harness work (#39). Windows keeps every other check. For #17, packaged smoke runs on macOS and Linux; on Windows the packaged app only builds, starts and passes its build gates.
- Task branches are never updated by merging `main`; force-push is blocked by the permission system. Rebuild on a new branch with cherry-picks (ADR 0009 item 2).
- Shared test helpers used by more than one system live in `tools/test-support/`; system-only helpers stay in that system's `test-support/` (ADR 0008). Only the test author changes them. No system imports another system's `test-support/`.
- Post the decisions and readings themselves on the issue, never only a reference to an agent report.
- The clean-clone gate shows only the end of nested output; a Windows or Linux e2e failure may need a direct run or a throwaway probe branch (never merged) to see the first failure (#36).
- The pinned-SHA gate needs network access; one local run failed on a connection reset (#36 adds a retry).
- #18 may find the CDP guard impossible (Chromium opens the port before main runs); the developer returns `needs-decision`. #18 must also update the packaged launch in `reference-app-build.gate.test.ts` (note on #18).
- Spike branches `spike/5` to `spike/9` are never merged; their findings are the reference for phase 1 tasks.
- `docs/upstream/react-aria-second-window-overlays.md` is a draft the human posts; do not post it.
- Open human decision in the specs: re-validation after a failed submit.
