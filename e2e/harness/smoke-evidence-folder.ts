// Failure evidence of the smoke harness (#17; TST-010, ADR 0012). Internal to
// the harness system (e2e/harness); the harness module is its only caller.
//
// When SMOKE_EVIDENCE_DIR names a folder, each call writes one new subfolder
// there with the app's stdout and stderr, the harness events, the label, and
// any PNG screenshots. CI uploads the folder when the packaged smoke job fails.
// - The variable is read at the moment of writing; unset or empty means
//   nothing is written.
// - Evidence never holds environment variable values (ADR 0012 item 3): every
//   value of at least `minimumRedactedValueLength` characters, from the
//   harness's own environment and from the variables given to the app, is
//   replaced by `[env NAME]` in every text file and in the folder name.
//   Shorter values (such as `1` or `true`) are left alone: they cannot be
//   told apart from ordinary text.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Environment variable that names the folder the smoke harness writes failure evidence into (ADR 0012). */
const smokeEvidenceDirVariableName = 'SMOKE_EVIDENCE_DIR';

/** Values shorter than this are not redacted. */
const minimumRedactedValueLength = 8;

/** Longest label part of an evidence folder name. */
const maximumFolderLabelLength = 60;

export interface SmokeEvidenceScreenshot {
  /** File name without folder, for example `window-1.png`. */
  readonly fileName: string;
  readonly png: Buffer;
}

export interface SmokeEvidence {
  /** What the evidence is for: a test name, or the launch failure code. */
  readonly label: string;
  /** Combined stdout and stderr of the app. */
  readonly appOutput: string;
  /** Harness event lines, oldest first. */
  readonly events: readonly string[];
  readonly screenshots?: readonly SmokeEvidenceScreenshot[];
  /** Variables the harness gave the app; their values are redacted as well. */
  readonly appEnv?: Readonly<Record<string, string>>;
}

let evidenceSequence = 0;

/** The evidence folder named by SMOKE_EVIDENCE_DIR now, or undefined when the variable is unset or empty. */
export function readSmokeEvidenceDir(): string | undefined {
  const value = process.env[smokeEvidenceDirVariableName];
  if (value === undefined || value.trim() === '') return undefined;
  return resolve(value);
}

/**
 * Writes one evidence subfolder into the folder named by SMOKE_EVIDENCE_DIR and
 * returns its path; returns undefined and writes nothing when the variable is unset.
 */
export function writeSmokeEvidence(evidence: SmokeEvidence): string | undefined {
  const evidenceDir = readSmokeEvidenceDir();
  if (evidenceDir === undefined) return undefined;
  const redact = buildEnvironmentRedactor(evidence.appEnv ?? {});
  evidenceSequence += 1;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const label = redact(evidence.label);
  const folderName = `${stamp}-${process.pid}-${evidenceSequence}-${folderLabel(label)}`;
  const folder = join(evidenceDir, folderName);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'label.txt'), `${label}\n`);
  writeFileSync(join(folder, 'app-output.log'), redact(evidence.appOutput));
  writeFileSync(join(folder, 'harness-events.log'), `${evidence.events.map(redact).join('\n')}\n`);
  for (const screenshot of evidence.screenshots ?? []) {
    writeFileSync(join(folder, screenshot.fileName), screenshot.png);
  }
  return folder;
}

/** A label reduced to letters, digits, `.`, `_` and `-`, for a folder name. */
function folderLabel(label: string): string {
  const slug = label
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maximumFolderLabelLength);
  return slug === '' ? 'evidence' : slug;
}

/** Replaces each environment value (longest first) with `[env NAME]`. */
function buildEnvironmentRedactor(appEnv: Readonly<Record<string, string>>): (text: string) => string {
  const byValue = new Map<string, string>();
  for (const [name, value] of [...Object.entries(process.env), ...Object.entries(appEnv)]) {
    if (value === undefined || value.length < minimumRedactedValueLength || byValue.has(value)) continue;
    byValue.set(value, name);
  }
  const replacements = [...byValue].sort(([left], [right]) => right.length - left.length);
  return (text: string): string => {
    let redacted = text;
    for (const [value, name] of replacements) {
      if (redacted.includes(value)) redacted = redacted.split(value).join(`[env ${name}]`);
    }
    return redacted;
  };
}
