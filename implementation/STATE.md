# Build state

> Pointer file, rewritten by the orchestrator whenever a task changes stage, a phase changes, or an escalation opens or closes. History lives in GitHub Issues and git.

- **Updated:** 2026-11-11
- **Phase:** 0. Preparation and spikes
- **Phase exit gate:** Human approves requirement IDs (done), then the spike go/no-go

## Active tasks

| Issue | Title | Stage | Attempt | Next action |
| --- | --- | --- | --- | --- |
| #5 | Spike: Playwright over CDP | implementing | 1 | Check researcher envelope and branch `spike/5-playwright-cdp` |
| #6 | Spike: Forge with Vite in a pnpm workspace | implementing | 1 | Check researcher envelope and branch `spike/6-forge-vite` |
| #7 | Spike: Terrazzo profile rules and outputs | implementing | 1 | Check researcher envelope and branch `spike/7-terrazzo-profile` |
| #8 | Spike: React Aria overlays in child windows | implementing | 1 | Check researcher envelope and branch `spike/8-child-window-overlays` |

## Last action

PR #4 merged: ADR 0002 (all A) and ADR 0003 applied to the specs; #3 closed. Four researchers started in parallel.

## Next action

Check each spike's evidence, then give the human a go/no-go recommendation per spike.

## Open escalations

| Issue or ADR | Waiting on | Since |
| --- | --- | --- |
| — | — | — |

## Blockers

None.

## Notes for the next orchestrator

- Spike branches are never merged. Findings live in `docs/spikes/` on each spike branch.
- Decisions expected after spikes: colour gamut (#7); how smoke tests reach a packaged build if fuses block CDP (#5, major).
- Open human decision in the specs: re-validation after a failed submit.
- Merges by the orchestrator can trigger the auto mode classifier; the human approves spec-changing merges.
