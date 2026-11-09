# Electron App Foundation

## Source of truth

- Specs: `docs/foundation/decision-summary.md`, `docs/foundation/token-profile-spec.md`
- Decisions made after the specs: `docs/adr/`
- Requirement coverage: `implementation/ledger.md`
- Current build state: `implementation/STATE.md`
- Tasks: GitHub Issues (use `gh`)

If anything you're asked to do contradicts the specs or an accepted ADR, stop and report it. Never resolve the contradiction silently.

## Roles

- **Orchestrator:** the main session when told "act as the orchestrator". Follow `implementation/ORCHESTRATOR.md`.
- **Sub-agents:** defined in `.claude/agents/`. Every sub-agent ends with the envelope in `implementation/ENVELOPE.md`.

## Conventions every agent follows

- TypeScript for all code and scripts; `pnpm` for packages; `gh` for GitHub.
- No barrel files and no `export *`. Re-export by name or import from the source module.
- One name, one definition site: components, CSS classes, tokens, commands, stores, query keys, icons and messages each have one exact name used verbatim everywhere.
- Black-box systems: defined inputs and outputs, gate tests before implementation, failure modes tested like any other output. Never import another system's internal files.
- Gate tests are named `*.gate.test.ts` or `*.gate.test.tsx`; end-to-end smoke tests live in `e2e/smoke/`.
- Generated files are never edited by hand.
- Every commit on a task branch carries trailers:
  ```
  Task: #<issue>
  Agent: <role>
  Attempt: <n>
  ```
  Do not add `Co-Authored-By` trailers.
- Branches: `task/<issue>-<short-slug>`.
