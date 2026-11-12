# Build state

> Pointer file, rewritten by the orchestrator whenever a task changes stage, a phase changes, or an escalation opens or closes. History lives in GitHub Issues and git.

- **Updated:** 2026-11-11
- **Phase:** 1. Walking skeleton
- **Phase exit gate:** Packaged app passes smoke tests on all three platforms; human walks through it by hand (menus: see ADR 0006)

## Active tasks

| Issue | Title | Stage | Attempt | Next action |
| --- | --- | --- | --- | --- |
| #12 | Monorepo: set up pnpm workspace, Turborepo, TypeScript and Vitest | tests | 1 | Check test-author envelope and red run on `task/12-monorepo-setup` |

## Last action

Phase 1 planned: #12 to #30 in one strict chain (#30 sits between #24 and #25); ADR 0006 accepted.

## Next action

Task loop on #12, then each next issue in the chain.

## Open escalations

| Issue or ADR | Waiting on | Since |
| --- | --- | --- |
| — | — | — |

## Blockers

None.

## Notes for the next orchestrator

- Order: #12 … #24, #30, #25 … #29. Phase 1 is strictly sequential.
- Spike branches `spike/5` to `spike/9` are never merged; their findings are the reference for phase 1 tasks.
- #18 may find the CDP guard impossible (Chromium opens the port before main runs); the developer returns `needs-decision`.
- `docs/upstream/react-aria-second-window-overlays.md` is a draft the human posts; do not post it.
- Open human decision in the specs: re-validation after a failed submit.
- The human approves spec-changing merges; orchestrator merges can trigger the auto mode classifier.
