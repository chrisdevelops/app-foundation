# ADR 0003: Token extension namespace

- **Status:** accepted
- **Weight:** major
- **Date:** 2026-11-11
- **Raised by:** orchestrator, open decision in both specs
- **Decided by:** human (choice of value delegated to the orchestrator)
- **Affects:** TOK-094, TOK-100 to TOK-103; token-profile-spec.md, section "Profile extension"

## Context

DTCG asks that extension keys use reverse domain notation, so keys from different tools do not collide. The specs used the placeholder `<namespace>.ui`. The human asked for a sensible default, for example `com.foundation.app`.

## Options

1. **`io.github.chrisdevelops.ui`:** based on a domain that the owner's GitHub account controls. It cannot collide with another organisation's key.
2. **`com.foundation.app.ui`:** short, but it uses a domain that someone else probably owns. This is against the intent of reverse domain notation.

## Recommendation

Option 1.

## Decision

The extension key is `io.github.chrisdevelops.ui`. If the foundation moves to a domain the owner registers, a later ADR replaces the key in every token file in one change.

## Follow-up

- [x] Spec updated (`docs/foundation/token-profile-spec.md`, `docs/foundation/decision-summary.md`)
- [x] Ledger updated: no row change needed
- [x] Issues created or changed: #3
