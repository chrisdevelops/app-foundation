# ADR 0007: Toolchain versions and supporting packages

- **Status:** accepted
- **Weight:** minor
- **Date:** 2026-11-11
- **Raised by:** test author, #12
- **Decided by:** orchestrator (minor)
- **Affects:** PLT-006, PLT-009, PLT-010; ADR 0004 decision 10; #12

## Context

ADR 0004 decision 10 says to use current majors, pinned exactly. TypeScript's latest is 7.0.2 (2026-07-08), but typescript-eslint 8.72.2, the latest, accepts only TypeScript `>=4.8.4 <6.1.0`. ESLint with typed rules is required by PLT-006.

The specs name tools such as ESLint, Prettier, TypeScript, Vitest and Turborepo, but not the small packages each tool needs to run.

## Decision

1. **TypeScript 6.0.3**, pinned exactly, until typescript-eslint supports TypeScript 7. Decision 10 is read as "the newest major that works with the other named tools". Revisit when typescript-eslint supports 7.
2. **Supporting packages of a named tool count as part of that tool:** for example `typescript-eslint` and `@eslint/js` for ESLint, `@types/node` for TypeScript and Node, and official plugins of a named tool. Each is pinned exactly. Any other new package needs an ADR, as the playbook says.
3. **Gate test files are not reformatted.** The Prettier configuration must accept the existing gate tests unchanged; formatting is not a reason for a `Test-Change`.
4. **The test author's eight readings for #12 are accepted** as written in the envelope on #12.

## Follow-up

- [ ] Revisit item 1 when typescript-eslint supports TypeScript 7
