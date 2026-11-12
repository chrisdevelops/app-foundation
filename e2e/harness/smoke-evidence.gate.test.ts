// Gate tests for #17 (ADR 0012; TST-010): the smoke harness writes failure
// evidence into the folder named by SMOKE_EVIDENCE_DIR, which CI uploads when
// the packaged smoke job fails. Tested from outside, through the harness module
// boundary and through `pnpm run smoke`:
// - A failed launch writes the app's stdout and stderr and the harness events
//   (with the error code) before it throws.
// - `writeEvidence(label)` on a running app writes a PNG screenshot of its
//   window, the app output and the label; the smoke suite calls it when a test
//   fails.
// - Evidence never holds environment variable values: a fixture variable with
//   a secret-looking value must not appear in any evidence file or file name.
// When a launch or test passes, nothing is required. The harness reads the
// variable when it writes, not when it is loaded.
// Fixture builds come from e2e/test-support/smoke-fixture-app.ts (#16).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { removeAppFolderAfterExit } from '../../tools/test-support/app-process-cleanup';
import { describeRepoCommand, repoGateRootDir, runRepoCommand } from '../../tools/test-support/run-repo-command';
import { smokeEvidenceDirVariableName } from '../../tools/test-support/smoke-evidence';
import { createSmokeFixtureBuild, type SmokeFixtureBuild } from '../test-support/smoke-fixture-app';
import {
  loadSmokeHarness,
  smokeAppExecutableVariableName,
  type ExpectedSmokeApp,
} from '../test-support/smoke-harness-contract';
import {
  smokeHarnessDeferredOnWindows,
  smokeHarnessWindowsDeferralReason,
} from '../test-support/windows-smoke-deferral';

const root = repoGateRootDir;
const slow = { timeout: 300_000 };
const fixtureStartupTimeoutMs = 60_000;
/** A variable whose value looks like a token; it must never reach the evidence. */
const secretVariableName = 'SMOKE_GATE_FAKE_TOKEN';
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// DEFERRED: TST-010 (Windows smoke harness; ADR 0011, #39): every test in this file skips on Windows.
beforeEach((context) => {
  if (smokeHarnessDeferredOnWindows) context.skip(smokeHarnessWindowsDeferralReason);
});

it.todo('TST-010: the smoke harness evidence gates pass on Windows (#39, ADR 0011)');

let fixture: SmokeFixtureBuild | undefined;
const startedApps: ExpectedSmokeApp[] = [];
const evidenceDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function requireFixture(): SmokeFixtureBuild {
  fixture ??= createSmokeFixtureBuild();
  return fixture;
}

/** A fresh, empty evidence folder; the test's process environment names it, as CI would. */
function useFreshEvidenceDir(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'smoke-evidence-gate-')));
  evidenceDirs.push(dir);
  setEnv(smokeEvidenceDirVariableName, dir);
  return dir;
}

function setEnv(name: string, value: string): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  process.env[name] = value;
}

function secretValue(): string {
  return `ghp_${randomBytes(18).toString('hex')}`;
}

interface EvidenceFile {
  readonly path: string;
  readonly bytes: Buffer;
}

function listEvidenceFiles(dir: string): EvidenceFile[] {
  if (!existsSync(dir)) return [];
  const files: EvidenceFile[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) stack.push(path);
      else if (stats.isFile()) files.push({ path, bytes: readFileSync(path) });
    }
  }
  return files;
}

function describeEvidence(dir: string, files: readonly EvidenceFile[]): string {
  return `evidence in ${dir}: ${JSON.stringify(files.map((file) => `${relative(dir, file.path)} (${file.bytes.length} bytes)`))}`;
}

function filesContaining(files: readonly EvidenceFile[], text: string): EvidenceFile[] {
  return files.filter((file) => file.bytes.includes(Buffer.from(text, 'utf8')));
}

function pngFiles(files: readonly EvidenceFile[]): EvidenceFile[] {
  return files.filter((file) => file.bytes.length > 1024 && file.bytes.subarray(0, 8).equals(pngSignature));
}

function expectNoSecret(dir: string, files: readonly EvidenceFile[], secret: string): void {
  expect(files.length, `the evidence must not be empty: ${describeEvidence(dir, files)}`).toBeGreaterThan(0);
  expect(
    filesContaining(files, secret).map((file) => relative(dir, file.path)),
    `evidence files must never hold environment variable values (${secretVariableName})`,
  ).toEqual([]);
  expect(
    files.filter((file) => file.path.includes(secret)).map((file) => file.path),
    'evidence file names must not hold environment variable values',
  ).toEqual([]);
}

/** Launches a fixture that exits before its endpoint opens, and waits for the harness to reject. */
async function launchAndFail(env: Record<string, string>): Promise<{ error: unknown }> {
  const build = requireFixture();
  build.write({ mode: 'exit-early', exitCode: 3 });
  const harness = await loadSmokeHarness();
  try {
    const app = await harness.launchSmokeApp({
      target: { kind: 'packaged', executablePath: build.executablePath },
      startupTimeoutMs: fixtureStartupTimeoutMs,
      env,
    });
    startedApps.push(app);
  } catch (error) {
    return { error };
  }
  throw new Error('the fixture exits with code 3 before its endpoint opens, so launchSmokeApp must fail');
}

async function launchWindowFixture(env: Record<string, string>): Promise<ExpectedSmokeApp> {
  const build = requireFixture();
  build.write({ mode: 'window', title: 'Smoke evidence fixture' });
  const harness = await loadSmokeHarness();
  const app = await harness.launchSmokeApp({
    target: { kind: 'packaged', executablePath: build.executablePath },
    startupTimeoutMs: fixtureStartupTimeoutMs,
    env,
  });
  startedApps.push(app);
  return app;
}

/** Waits until the app has a window with a non-empty title, so a screenshot shows a page. */
async function waitForWindow(app: ExpectedSmokeApp): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const titles = await Promise.all(app.windows().map((page) => page.title().catch(() => '')));
    if (titles.some((title) => title !== '')) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('the fixture window did not appear within 60 s');
}

afterEach(async () => {
  while (startedApps.length > 0) await startedApps.pop()?.teardown();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete savedEnv[name];
  }
}, 120_000);

afterAll(async () => {
  for (const dir of evidenceDirs) rmSync(dir, { recursive: true, force: true });
  if (fixture) await removeAppFolderAfterExit(fixture.dir, 'smoke evidence gate fixture build');
}, 180_000);

// TST-010; issue #17 acceptance criterion 6; ADR 0012 item 3
it(
  `TST-010: a failed launch writes the app stdout and stderr and the harness events with the error code into ${smokeEvidenceDirVariableName}`,
  slow,
  async () => {
    const dir = useFreshEvidenceDir();
    const build = requireFixture();
    const { error } = await launchAndFail({});
    const files = listEvidenceFiles(dir);
    const shown = `${describeEvidence(dir, files)}\nlaunch error: ${error instanceof Error ? error.message : String(error)}`;
    expect(
      filesContaining(files, build.stdoutMarker).length,
      `the app stdout must be in the evidence; ${shown}`,
    ).toBeGreaterThan(0);
    expect(
      filesContaining(files, build.stderrMarker).length,
      `the app stderr must be in the evidence; ${shown}`,
    ).toBeGreaterThan(0);
    expect(
      filesContaining(files, 'app-exited').length,
      `the harness events must name the failure code app-exited; ${shown}`,
    ).toBeGreaterThan(0);
  },
);

// TST-010; issue #17 acceptance criterion 6; ADR 0012 item 3
it(
  `TST-010: writeEvidence on a running app writes a PNG screenshot of its window, the app output and the label into ${smokeEvidenceDirVariableName}`,
  slow,
  async () => {
    const dir = useFreshEvidenceDir();
    const build = requireFixture();
    const app = await launchWindowFixture({});
    await waitForWindow(app);
    const label = `evidence-label-${randomBytes(4).toString('hex')}`;
    expect(typeof app.writeEvidence, 'the launched app must have writeEvidence (#17 contract)').toBe('function');
    await app.writeEvidence(label);
    const files = listEvidenceFiles(dir);
    const shown = describeEvidence(dir, files);
    expect(pngFiles(files).length, `a PNG screenshot of the window must be in the evidence; ${shown}`).toBeGreaterThan(
      0,
    );
    expect(
      filesContaining(files, build.stdoutMarker).length,
      `the app stdout must be in the evidence; ${shown}`,
    ).toBeGreaterThan(0);
    expect(filesContaining(files, label).length, `the evidence must name its label; ${shown}`).toBeGreaterThan(0);
  },
);

// TST-010 (failure mode); ADR 0012 item 3: never environment variables or tokens
it(
  'TST-010: evidence from a failed launch and from writeEvidence never holds an environment variable value',
  slow,
  async () => {
    const dir = useFreshEvidenceDir();
    const secret = secretValue();
    setEnv(secretVariableName, secret);
    await launchAndFail({ [secretVariableName]: secret });
    const app = await launchWindowFixture({ [secretVariableName]: secret });
    await waitForWindow(app);
    await app.writeEvidence('secret check');
    expectNoSecret(dir, listEvidenceFiles(dir), secret);
  },
);

// TST-010; issue #17 acceptance criteria 5 and 6: a failing smoke test leaves evidence, through the CI command
it(
  `TST-010: pnpm run smoke with a failing smoke test writes a screenshot and the app output into ${smokeEvidenceDirVariableName}, and no environment value`,
  { timeout: 900_000 },
  () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'smoke-evidence-gate-')));
    evidenceDirs.push(dir);
    const build = requireFixture();
    build.write({ mode: 'window', title: 'Not the reference app' });
    const secret = secretValue();
    const result = runRepoCommand('pnpm', ['run', 'smoke'], {
      cwd: root,
      timeoutMs: 840_000,
      env: {
        [smokeAppExecutableVariableName]: build.executablePath,
        [smokeEvidenceDirVariableName]: dir,
        [secretVariableName]: secret,
      },
    });
    expect(
      result.exitCode,
      `the fixture is not the reference app, so the suite must fail:\n${describeRepoCommand(result)}`,
    ).not.toBe(0);
    const files = listEvidenceFiles(dir);
    const shown = `${describeEvidence(dir, files)}\n${describeRepoCommand(result, 3000)}`;
    expect(pngFiles(files).length, `a PNG screenshot must be in the evidence; ${shown}`).toBeGreaterThan(0);
    expect(
      filesContaining(files, build.stdoutMarker).length,
      `the app stdout must be in the evidence; ${shown}`,
    ).toBeGreaterThan(0);
    expectNoSecret(dir, files, secret);
  },
);
