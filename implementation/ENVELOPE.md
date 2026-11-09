# Return envelope

Every sub-agent ends its run by replying with this envelope and nothing else after it. Keep it compact: the summary is at most five lines and there is no narrative elsewhere.

```markdown
## Envelope
- task: #<issue>
- role: planner | researcher | test-author | developer | reviewer | verifier
- attempt: <n>
- status: done | failed | blocked | needs-decision
- summary: <at most five lines>
- requirements: <requirement IDs addressed, comma-separated>
- commits: <short SHAs, or none>
- files: <paths changed, or none>
- checks: <command=exit code, e.g. typecheck=0, lint=0, gate-tests=1>
- evidence: <paths to test output, screenshots, logs>
- deviations: none | <what differs from the spec, and why>
- questions: none | <what the orchestrator must answer>
- next: <recommended next step>
## Role fields
<only the fields for your role>
```

## Status meanings

| Status | Meaning |
| --- | --- |
| `done` | Your job is complete and the evidence supports it |
| `failed` | You tried and could not complete it; say why |
| `blocked` | Something outside the task stops you; say what |
| `needs-decision` | You hit a question you must not answer yourself |

## Role fields

| Role | Fields |
| --- | --- |
| Planner | `issues`: created issue numbers · `dependencies`: blocking links · `mapped`: requirement IDs per issue · `risks` |
| Researcher | `question` · `answer` · `confidence`: high, medium or low · `sources`: links · `affects-decision`: yes or no, and which |
| Test author | `cases`: test name → requirement ID · `red-run`: proof each test fails for the right reason before implementation · `failure-modes`: covered · `ambiguities`: spec gaps found |
| Developer | `deferred`: `DEFERRED:` markers added, with IDs · `limitations` |
| Reviewer | `verdict`: approve, changes-required, tests-wrong or escalate · `findings`: severity, location, spec reference, required fix · `test-quality`: are the tests strong enough to catch a wrong implementation |
| Verifier | `scenarios`: name → pass or fail · `screenshots`: paths · `console-errors` · `accessibility`: scan results |
