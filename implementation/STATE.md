# Build state

> Pointer file, rewritten by the orchestrator whenever a task changes stage, a phase changes, or an escalation opens or closes. History lives in GitHub Issues and git.

- **Updated:** 2026-11-09 14:46
- **Phase:** 0. Preparation and spikes
- **Phase exit gate:** Human approves requirement IDs, then the spike go/no-go

## Active tasks

| Issue | Title | Stage | Attempt | Next action |
| --- | --- | --- | --- | --- |
| — | — | — | — | — |

## Last action

Exported both specs from Claude Docs to `docs/foundation/`, byte-exact, with no requirement IDs yet.

## Next action

After the human chooses the repository owner and visibility: `git init`, create the GitHub repository, commit, push, create labels, then delegate requirement IDs to the planner.

## Open escalations

| Issue or ADR | Waiting on | Since |
| --- | --- | --- |
| No git or GitHub repository exists | Human: repository owner and visibility | 2026-11-09 |

## Blockers

Phase 0 cannot use GitHub Issues until the repository exists.

## Notes for the next orchestrator

- Spec sources: Claude Docs artifacts `3pw1TKuLLz8gVgPWoz4hHb` (Decision Summary, rev 11) and `8qrpoNZtckJcbuhHSxQezE` (Token Profile Spec, rev 30).
- `ledger.md` maps `TOK` to the token spec only, but the Decision Summary also has a "Tokens and theming" section. Resolve this before the planner assigns IDs.
- Open human decisions in the specs: token extension namespace; re-validation after a failed submit.
