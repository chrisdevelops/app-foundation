# ADR 0015: Public repository for CI

- **Status:** accepted
- **Weight:** major
- **Date:** 2026-11-12
- **Raised by:** human (GitHub Actions monthly limit reached on the Free plan)
- **Decided by:** human
- **Affects:** ADR 0009 item 4 (merge procedure); TST-015; phase 1 exit gate

## Context

The repository was private on the GitHub Free plan. Private repositories get a fixed monthly amount of hosted-runner compute; one CI run on three platforms (macOS is the most expensive runner) used a large part of it, and the monthly limit was reached during #46. GitHub Docs state that standard hosted runners are free for public repositories. This Mac cannot run Windows locally.

Before the change, the orchestrator scanned all branches and the full history (pattern search; no dedicated scanner installed): no tokens, keys, `.env` or credential files; no Actions secrets or variables. The owner's personal email is on most commit records; the local home path appears in five spike evidence files.

## Options

1. **Public as is:** free CI on three platforms; the email on past commits becomes public.
2. **Rewrite history first:** email replaced on all branches; every cited SHA changes; needs force-push.
3. **Stay private:** local CI (macOS, Linux in Docker); no Windows coverage until credits return.

## Decision

Option 1 (human, 2026-11-12). The spike evidence files stay unchanged. The repository's local git config uses the GitHub noreply address for future commits. ADR 0009's merge procedure is unchanged.

## Follow-up

- [x] Repository visibility set to public
- [x] Local `user.email` set to the noreply address
- [ ] Human: set the global git email or GitHub's "Keep my email addresses private" setting, if wanted
