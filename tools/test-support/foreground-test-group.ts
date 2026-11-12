// Test-only marker for the foreground test group (#46; TST-018; ADR 0013 rule 3).
//
// The foreground group holds the tests that need real OS focus, a native menu,
// a native dialog, or a window that is shown on screen (for example the
// failure modes of the background switch: a launch without
// FOUNDATION_TEST_BACKGROUND=1 shows its window and takes focus).
//
// Contract (issue #46, recorded reading):
// - Mark: the test file is named `*.foreground.gate.test.ts` and calls
//   `joinForegroundTestGroup(import.meta.url)` at its top level. Nothing else
//   marks a foreground test.
// - Default: a run without FOUNDATION_TEST_FOREGROUND=1 skips every test in
//   the file, with `foregroundTestGroupSkipReason` shown. So the default runs
//   (`pnpm test`, `pnpm turbo run test`, the e2e gates) never run the group on
//   a developer machine, and never take focus.
// - On request: `pnpm run test:foreground` at the repository root prints a
//   notice before any test starts, then runs every `*.foreground.gate.test.ts`
//   file (and no other test file) with FOUNDATION_TEST_FOREGROUND=1, so every
//   launch in the group is normal (foreground).
// - CI runs `pnpm run test:foreground` (tools/repo/foreground-test-group.gate.test.ts).
//
// Probe (gate tests only): when FOREGROUND_GROUP_PROBE_FILE names a file, each
// foreground file appends one JSON line {file, foreground} there when it is
// loaded and skips all its tests, so a gate can see which files a command runs
// and with which FOUNDATION_TEST_FOREGROUND value, without launching anything.
import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach } from 'vitest';
import {
  isForegroundTestRun,
  testForegroundEnabledValue,
  testForegroundVariableName,
} from './background-test-variables';
import { repoGateRootDir } from './run-repo-command';

/** Suffix of every foreground test file. */
export const foregroundTestFileSuffix = '.foreground.gate.test.ts';

/** The root script that runs the foreground group on request and in CI. */
export const foregroundTestScriptName = 'test:foreground';

/** Environment variable that turns the foreground files into probes (see the file header). */
export const foregroundGroupProbeVariableName = 'FOREGROUND_GROUP_PROBE_FILE';

/** Skip note shown for each foreground test in a default run. */
export const foregroundTestGroupSkipReason = `foreground test group (shows windows, takes focus): runs in CI and on request with \`pnpm run ${foregroundTestScriptName}\` (${testForegroundVariableName}=${testForegroundEnabledValue}); ADR 0013 rule 3`;

/** One line of the probe file. */
export interface ForegroundGroupProbeRecord {
  /** The test file, relative to the repository root, with `/` separators. */
  readonly file: string;
  /** FOUNDATION_TEST_FOREGROUND as the file saw it (null when unset). */
  readonly foreground: string | null;
}

export interface ForegroundTestGroupMembership {
  /** True when this run executes the file's tests. */
  readonly runs: boolean;
  readonly skipReason: string;
}

/**
 * Marks the calling file as part of the foreground group. Call once at the top
 * level of a `*.foreground.gate.test.ts` file with `import.meta.url`.
 */
export function joinForegroundTestGroup(fileUrl: string): ForegroundTestGroupMembership {
  const file = relative(repoGateRootDir, fileURLToPath(fileUrl)).split('\\').join('/');
  if (!file.endsWith(foregroundTestFileSuffix)) {
    throw new Error(`${file} joins the foreground test group, so its name must end in ${foregroundTestFileSuffix}`);
  }
  const probeFile = process.env[foregroundGroupProbeVariableName];
  let membership: ForegroundTestGroupMembership;
  if (probeFile !== undefined && probeFile !== '') {
    const record: ForegroundGroupProbeRecord = { file, foreground: process.env[testForegroundVariableName] ?? null };
    appendFileSync(probeFile, `${JSON.stringify(record)}\n`);
    membership = { runs: false, skipReason: `${foregroundGroupProbeVariableName} is set: probe run, nothing launches` };
  } else {
    membership = { runs: isForegroundTestRun(), skipReason: foregroundTestGroupSkipReason };
  }
  beforeEach((context) => {
    if (!membership.runs) context.skip(membership.skipReason);
  });
  return membership;
}
