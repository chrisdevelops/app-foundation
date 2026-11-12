# ADR 0010: Windows zip entry names

- **Status:** accepted
- **Weight:** major
- **Date:** 2026-11-12
- **Raised by:** reviewer, #15
- **Decided by:** human
- **Affects:** PLT-007; #15

## Context

`@electron-forge/maker-zip` 8.0.1 calls `cross-zip` 4.0.1. On Windows, `cross-zip` runs Windows PowerShell 5.1, whose .NET Framework `ZipFile.CreateFromDirectory` stores entry names with `\` (CI run 43177831510: `locales\af.pak`, so no entry ends with `/app.asar`). The ZIP format (APPNOTE 4.4.17) requires `/`. Windows Explorer unpacks such zips correctly; other tools may create file names that contain `\`.

## Options

1. **Rewrite entry names after `make`:** a foundation step changes `\` to `/` in the stored names. No new package.
2. **Patch `cross-zip`:** a `pnpm patch` sets the .NET switch for `/`. Redone on every `cross-zip` update.
3. **Another Windows maker:** a new package; changes what Windows users download.
4. **Accept `\` on Windows:** relax the gate; the zip stays non-standard.

## Decision

Option 1. A foundation step, run from Forge's `postMake` hook, rewrites `\` to `/` in every entry name of each zip that `make` produced, using Node built-ins only. File contents and their checksums do not change. The step refuses a zip it cannot read safely instead of writing a damaged one. The existing make gate keeps requiring `/` on all three platforms.

## Follow-up

- [ ] Gate tests for the step with a sample zip that has `\` names, run on all three platforms
- [ ] Step built and connected to `postMake` in `apps/reference`
- [ ] Windows CI shows the zip gate passing
