# Build state

> Pointer file, rewritten by the orchestrator whenever a task changes stage, a phase changes, or an escalation opens or closes. History lives in GitHub Issues and git.

- **Updated:** 2026-11-12
- **Phase:** 1. Walking skeleton
- **Phase exit gate:** Packaged app passes smoke tests on all three platforms; human walks through it by hand (menus: see ADR 0006)

## Active tasks

| Issue | Title | Stage | Attempt | Next action |
| --- | --- | --- | --- | --- |
| #15 | Reference app: Forge and Vite shell loaded through app:// with locked fuses | tests | 1 | Check test-author envelope and red run on `task/15-reference-app` |

## Last action

#14 merged (PR #35, developer attempt 2, reviewer approve): boundary check runs in CI from the base commit. #36 opened for minor test gaps (phase 2). PLT-010 done.

## Next action

Task loop on #15, then each next issue in the chain.

## Open escalations

| Issue or ADR | Waiting on | Since |
| --- | --- | --- |
| Old branches `task/14-boundary-check`, `backup/14-before-rebase` | Human: approve deletion | 2026-11-12 |

## Blockers

None.

## Notes for the next orchestrator

- Order: #15 … #24, #30, #25 … #29. Phase 1 is strictly sequential.
- Merge procedure (ADR 0009 item 4): reviewer `approve`; `gh pr checks` shows `boundary-check` and three platform checks `pass`; explicit review of any diff to `.github/workflows/` or `tools/boundary-check/`. No branch protection (ADR 0009 item 5, human decision).
- Task branches are never updated by merging `main`; force-push is blocked by the permission system. Rebuild on a new branch with cherry-picks (ADR 0009 item 2).
- Shared test helpers live in `test-support/` folders (ADR 0008); only the test author changes them.
- Post the decisions and readings themselves on the issue, never only a reference to an agent report.
- The pinned-SHA gate needs network access; one local run failed on a connection reset (#36 adds a retry).
- #15 must verify Forge packaging with `publicHoistPattern: ['@types/*']` and add `electron` to `allowBuilds` (ADR 0007 items 5 and 7).
- #18 may find the CDP guard impossible (Chromium opens the port before main runs); the developer returns `needs-decision`.
- Spike branches `spike/5` to `spike/9` are never merged; their findings are the reference for phase 1 tasks.
- `docs/upstream/react-aria-second-window-overlays.md` is a draft the human posts; do not post it.
- Open human decision in the specs: re-validation after a failed submit.
