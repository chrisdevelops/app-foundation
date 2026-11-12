// Test-only shared name for #17 (ADR 0012; TST-010). The smoke harness writes
// its failure evidence (app stdout and stderr, harness events, screenshots)
// into the folder this environment variable names; CI uploads that folder
// when the packaged smoke job fails. Used by the e2e harness gates and the
// tools/repo packaged smoke CI gates.

/** Environment variable that names the folder the smoke harness writes failure evidence into. */
export const smokeEvidenceDirVariableName = 'SMOKE_EVIDENCE_DIR';
