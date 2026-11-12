# ADR 0009: Boundary check roles, merge commits and merge procedure

- **Status:** accepted
- **Weight:** minor (items 1 to 4); human decision recorded (item 5)
- **Date:** 2026-11-12
- **Raised by:** reviewer, #14
- **Decided by:** orchestrator (items 1 to 4); human (item 5)
- **Affects:** ORCHESTRATOR.md sections 3 and 6; #14

## Context

The review of #14 found that an unknown `Agent:` value skips both path rules, that a merge of `main` into a task branch attributes `main`'s changes to the branch's agent, and that only CI protects the boundary-check job, because the repository has no branch protection.

## Decision

1. **Closed list of roles.** Valid `Agent:` values are `planner`, `researcher`, `test-author`, `developer`, `reviewer`, `verifier` and `orchestrator`: the six sub-agents in `.claude/agents/` plus the orchestrator. Any other value, or more than one `Agent:` trailer in one commit, is rejected with the rule id `invalid-agent-trailer`. A missing `Agent:` trailer stays `missing-agent-trailer`.
2. **No merges into task branches.** A task branch is never updated by merging `main` into it; when it must move to a newer `main`, a new branch is built from `main` and the commits are cherry-picked (as in #14). The check stays fail-closed on merge commits, and this limit is stated in the script header.
3. **Base commit must exist.** The CI job fails when the base commit cannot be read; only a readable base without the script triggers the pull request fallback.
4. **The orchestrator's merge procedure.** Before any merge, the orchestrator confirms: the reviewer verdict is `approve`; `gh pr checks` lists `boundary-check` and the three platform checks, all `pass`; and any diff to `.github/workflows/` or `tools/boundary-check/` was reviewed explicitly.
5. **No branch protection for now** (human decision, 2026-11-12). The private repository on the current plan cannot use branch protection or rulesets (HTTP 403). Item 4 stands in for required checks. Revisit when other people push to the repository or before agents merge in parallel.

## Follow-up

- [ ] #14 gates and code cover items 1 to 3
- [ ] STATE.md notes record items 4 and 5
