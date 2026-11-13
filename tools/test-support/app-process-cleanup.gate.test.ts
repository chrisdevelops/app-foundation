// Gate tests for the process listing that gate-test cleanup relies on (#46
// test author attempt 4; TST-011, TST-018). Test code only (ADR 0008).
// Contract of tools/test-support/app-process-cleanup.ts:
// - listRunningProcesses() returns every running process with its pid, its
//   full command line and, on Windows, its executable path. Cleanup matches
//   processes by `--user-data-dir=<dir>` and by executable folder, so long
//   arguments, spaces and (on Windows) non-ASCII characters come back exactly.
// - One listing is fast: under 15 s, also while the rest of the suite runs.
//   On GitHub Windows runners, PowerShell cmdlets (Get-CimInstance and every
//   other one that loads a module) took about 21 s each, and more than 60 s
//   at first, while the suite ran (probe PR #49), so cleanup failed with
//   `could not list processes with PowerShell (exit null)`.
// - listRunningProcesses({ timeoutMs, attempts }) bounds each attempt and the
//   number of attempts. When every attempt fails it throws an Error whose
//   message starts with `could not list processes`, names the number of
//   attempts and says why each one failed (here: timed out); it never returns
//   an empty or partial list instead.
// - listProcessesUsing(dir) finds a process started with `--user-data-dir=<dir>`
//   and stops finding it once the process has exited.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { listProcessesUsing, listRunningProcesses, waitForProcessesToExit } from './app-process-cleanup';

const windows = process.platform === 'win32';
/** Upper bound for one listing (#46: 21-60 s on Windows runners before the fix; under 1 s after). */
const listingLimitMs = 15_000;
const slow = { timeout: 120_000 };

const started: ChildProcess[] = [];
const folders: string[] = [];

afterAll(() => {
  for (const child of started) child.kill();
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

/** A folder name with spaces (and non-ASCII characters on Windows, where the old listing garbled them). */
function makeUserDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), windows ? 'process list gate é 日本 ' : 'process list gate '));
  folders.push(dir);
  return dir;
}

/** Starts a Node process that sleeps, with `--user-data-dir=<dir>` and `extra` in its command line. */
function startSleeper(dir: string, extra: readonly string[] = []): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)', '--', `--user-data-dir=${dir}`, ...extra], {
    stdio: 'ignore',
    windowsHide: true,
  });
  started.push(child);
  return child;
}

async function waitForListed(pid: number, timeoutMs: number): Promise<ReturnType<typeof listRunningProcesses>[number]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entry = listRunningProcesses().find((candidate) => candidate.pid === pid);
    if (entry) return entry;
    if (Date.now() > deadline) throw new Error(`pid ${pid} was not listed within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe('process listing for gate-test cleanup (TST-011, #46)', () => {
  // TST-011
  it(
    'TST-011: listRunningProcesses lists a process this test started with its pid, its full command line and (Windows) its executable path',
    slow,
    async () => {
      const dir = makeUserDataDir();
      const longArgument = `--marker=${'x'.repeat(4000)}`;
      const child = startSleeper(dir, [longArgument]);
      const entry = await waitForListed(child.pid as number, 30_000);
      expect(entry.command, 'the command line must hold the user data switch exactly').toContain(`--user-data-dir=${dir}`);
      expect(entry.command, 'the command line must not be cut').toContain(longArgument);
      if (windows) {
        expect(entry.executable.toLowerCase()).toBe(process.execPath.toLowerCase());
      } else {
        expect(entry.command.startsWith(process.execPath), `POSIX command starts with the executable: ${entry.command.slice(0, 200)}`).toBe(true);
      }
    },
  );

  // TST-011
  it(
    'TST-011: listProcessesUsing finds a process by --user-data-dir and no longer finds it once it has exited',
    slow,
    async () => {
      const dir = makeUserDataDir();
      const other = makeUserDataDir();
      const child = startSleeper(dir);
      const otherChild = startSleeper(other);
      await waitForListed(child.pid as number, 30_000);
      await waitForListed(otherChild.pid as number, 30_000);
      expect(listProcessesUsing(dir).map((entry) => entry.pid)).toEqual([child.pid]);
      child.kill();
      await waitForProcessesToExit(dir, 'process list gate sleeper', 30_000);
      expect(listProcessesUsing(dir)).toEqual([]);
      expect(listProcessesUsing(other).map((entry) => entry.pid)).toEqual([otherChild.pid]);
    },
  );

  // TST-011, TST-018 (Windows runners, #46)
  it(`TST-011: one listing of every process takes less than ${listingLimitMs} ms`, slow, () => {
    for (let round = 1; round <= 3; round += 1) {
      const startedAt = Date.now();
      const entries = listRunningProcesses();
      const elapsedMs = Date.now() - startedAt;
      expect(entries.length, 'a listing holds more than this test process').toBeGreaterThan(1);
      expect(elapsedMs, `listing ${round} took ${elapsedMs} ms`).toBeLessThan(listingLimitMs);
    }
  });

  // TST-011: failure mode
  it(
    'TST-011: when every attempt times out, listRunningProcesses throws `could not list processes`, names the attempts and the timeout, and returns no list',
    slow,
    () => {
      const startedAt = Date.now();
      let outcome: unknown;
      try {
        outcome = listRunningProcesses({ timeoutMs: 1, attempts: 2 });
      } catch (error) {
        outcome = error;
      }
      const elapsedMs = Date.now() - startedAt;
      expect(outcome, 'a listing that cannot complete must throw, not return a list').toBeInstanceOf(Error);
      const message = (outcome as Error).message;
      expect(message).toMatch(/^could not list processes/);
      expect(message).toMatch(/2 attempts/);
      expect(message).toMatch(/timed out/i);
      expect(elapsedMs, 'two 1 ms attempts must fail fast').toBeLessThan(listingLimitMs);
    },
  );
});
