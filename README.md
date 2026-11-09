# Foundation starter kit

Drafts of the files the Implementation Operating Model needs before the first orchestrator session.

## What's here

| Path | Purpose |
| --- | --- |
| `CLAUDE.md` | Points every session at the conventions and, for the orchestrator, at its playbook |
| `.claude/agents/*.md` | The six sub-agent definitions: planner, researcher, test author, developer, reviewer, verifier |
| `implementation/ORCHESTRATOR.md` | The orchestrator's playbook: loop, decision rules, escalation, recovery |
| `implementation/ENVELOPE.md` | The return envelope every sub-agent ends with |
| `implementation/STATE.md` | Current state of the build; rewritten by the orchestrator as work moves |
| `implementation/ledger.md` | Requirement ID → status → tests → issue |
| `docs/adr/0000-template.md` | Template for architecture decision records |
| `docs/foundation/README.md` | Where the exported specs go |

## Getting started

1. Create the foundation repository on GitHub and clone it.
2. Copy everything in this folder into the repository root.
3. Export the Decision Summary and the Design Token Profile Spec to Markdown and save them as:
   - `docs/foundation/decision-summary.md`
   - `docs/foundation/token-profile-spec.md`
4. Create the GitHub labels listed in `implementation/ORCHESTRATOR.md` under "Labels" (the orchestrator can do this for you with `gh label create`).
5. Commit and push.
6. In the repository root, start Claude Code and say:
   `Act as the orchestrator. Read implementation/ORCHESTRATOR.md and start phase 0.`
