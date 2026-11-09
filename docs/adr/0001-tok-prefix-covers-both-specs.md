# ADR 0001: TOK prefix covers tokens in both specs

- **Status:** accepted
- **Weight:** minor
- **Date:** 2026-11-09
- **Raised by:** orchestrator, phase 0 preparation
- **Decided by:** orchestrator (minor)
- **Affects:** `implementation/ledger.md` ID prefixes; `docs/foundation/decision-summary.md`, section "Tokens and theming"

## Context

The ledger's prefix table maps `TOK` to the token profile spec only. The Decision Summary also has a "Tokens and theming" section, and no other prefix covers that area.

## Options

1. **Use `TOK` for token requirements in both specs:** every requirement gets the prefix of its area. No new prefix is needed.
2. **Add a new prefix for Decision Summary token rows:** one area then has two prefixes, which conflicts with one name per thing.

## Recommendation

Option 1. The prefix names an area, and this is the only reading that gives these rows an ID.

## Decision

`TOK` applies to token and theming requirements in both specs, numbered in one sequence from 001. The Decision Summary is numbered first, then the token profile spec.

## Follow-up

- [ ] Spec updated: not needed; spec wording does not change
- [ ] Ledger updated: the planner sets the `TOK` row's Spec column to "Both"
- [ ] Issues created or changed: the phase 0 requirement ID task
