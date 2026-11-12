# Build state

> Pointer file, rewritten by the orchestrator whenever a task changes stage, a phase changes, or an escalation opens or closes. History lives in GitHub Issues and git.

- **Updated:** 2026-11-12
- **Phase:** 1. Walking skeleton
- **Phase exit gate:** Packaged app passes smoke tests on all three platforms; human walks through it by hand (menus: see ADR 0006)

## Active tasks

| Issue | Title | Stage | Attempt | Next action |
| --- | --- | --- | --- | --- |
| #16 | Smoke harness: drive the app over CDP with free-port and ownership checks | tests | 1 | Check test-author envelope and red run on `task/16-smoke-harness` |

## Last action

#15 merged (PR #37, developer attempt 3, reviewer approve, verifier 5/5): reference app through `app://`, fuses locked, symlink refusal, Windows zip names fixed (ADR 0010). PLT-002, PLT-005, TST-013 done. Old #14 branches deleted (human approved).

## Next action

Task loop on #16, then each next issue in the chain.

## Open escalations

| Issue or ADR | Waiting on | Since |
| --- | --- | --- |
| — | — | — |

## Blockers

None.

## Notes for the next orchestrator

- Order: #16 … #24, #30, #25 … #29. Phase 1 is strictly sequential.
- Merge procedure (ADR 0009 item 4): reviewer `approve`; `gh pr checks` shows `boundary-check` and three platform checks `pass`; explicit review of any diff to `.github/workflows/` or `tools/boundary-check/`. No branch protection (ADR 0009 item 5, human decision).
- Task branches are never updated by merging `main`; force-push is blocked by the permission system. Rebuild on a new branch with cherry-picks (ADR 0009 item 2).
- Shared test helpers live in `test-support/` folders (ADR 0008); only the test author changes them.
- Post the decisions and readings themselves on the issue, never only a reference to an agent report.
- The pinned-SHA gate needs network access; one local run failed on a connection reset (#36 adds a retry).
- Packaged-app helpers in `tools/reference-app/test-support/` (CDP client, process start, cleanup) are reusable by later gates; packaged launches need a Windows-safe cleanup (see #15).
- #18 may find the CDP guard impossible (Chromium opens the port before main runs); the developer returns `needs-decision`.
- Spike branches `spike/5` to `spike/9` are never merged; their findings are the reference for phase 1 tasks.
- `docs/upstream/react-aria-second-window-overlays.md` is a draft the human posts; do not post it.
- Open human decision in the specs: re-validation after a failed submit.
