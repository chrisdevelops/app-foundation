// Test-only helper for the reference app gate tests (#15; TST-011).
// Removes a temporary folder an Electron app used (a packaged app copy or a
// user data folder) only after every process that uses it has exited.
// Windows locks the files of running executables, and Electron's helper
// processes (GPU, renderer, utility, crashpad) can outlive the main process
// for a moment (CI run 43182127367: EPERM on rm). Every wait is bounded; a
// process that is still running fails the gate with its name and command
// line, and is never killed silently.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { sep } from 'node:path';

export interface RunningProcess {
  readonly pid: number;
  /** Path of the executable (Windows), or empty when the OS does not report it apart from the command. */
  readonly executable: string;
  /** Full command line; on POSIX it starts with the executable path. */
  readonly command: string;
}

const windowsProcessQuery =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress';

interface WindowsProcessEntry {
  readonly ProcessId: number;
  readonly ExecutablePath: string | null;
  readonly CommandLine: string | null;
}

/** Every running process, from PowerShell on Windows and `ps` elsewhere. Throws when the list cannot be read. */
export function listRunningProcesses(): RunningProcess[] {
  if (process.platform === 'win32') {
    const probeStart = Date.now();
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsProcessQuery], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
    });
    probeCall('current', Date.now() - probeStart, result);
    if (result.status !== 0) probeDiagnose();
    else probeTime('ntquery', 'powershell.exe', readFileSync(new URL('../probe/ntquery.ps1', import.meta.url), 'utf8'));
    if (result.status !== 0) {
      throw new Error(`could not list processes with PowerShell (exit ${String(result.status)}): ${result.stderr}`);
    }
    const parsed = JSON.parse(result.stdout || '[]') as WindowsProcessEntry[] | WindowsProcessEntry;
    return [parsed].flat().map((entry) => ({
      pid: entry.ProcessId,
      executable: entry.ExecutablePath ?? '',
      command: entry.CommandLine ?? '',
    }));
  }
  // -ww: never cut long command lines.
  const result = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 60_000 });
  if (result.status !== 0)
    throw new Error(`could not list processes with ps (exit ${String(result.status)}): ${result.stderr}`);
  return result.stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), executable: '', command: match[2] as string }))
    .filter((entry) => entry.pid !== process.pid);
}

/**
 * Processes that use folder `dir`: their executable is inside it, or they
 * run with `--user-data-dir=<dir>`. Other processes whose command text only
 * mentions the path (a shell, an editor) do not count. Case-insensitive on Windows.
 */
export function listProcessesUsing(dir: string): RunningProcess[] {
  const windows = process.platform === 'win32';
  const fold = (text: string): string => (windows ? text.toLowerCase() : text);
  const inside = fold(dir.endsWith(sep) ? dir : `${dir}${sep}`);
  const userDataSwitch = fold(`--user-data-dir=${dir}`);
  return listRunningProcesses().filter((entry) => {
    const executable = fold(windows ? entry.executable : entry.command);
    const command = fold(entry.command);
    const usesSwitch = command.includes(userDataSwitch) || command.includes(`"${userDataSwitch}"`);
    return executable.startsWith(inside) || executable.startsWith(`"${inside}`) || usesSwitch;
  });
}

/** Waits until no process uses `path` (see listProcessesUsing); throws with the processes still running after `timeoutMs`. */
export async function waitForProcessesToExit(path: string, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let running = listProcessesUsing(path);
  while (running.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    running = listProcessesUsing(path);
  }
  if (running.length > 0) {
    throw new Error(
      `${label}: ${running.length} process(es) started from ${path} still run ${timeoutMs} ms after the app was stopped:\n` +
        running.map((entry) => `  pid ${entry.pid}: ${entry.command}`).join('\n'),
    );
  }
}

/**
 * Removes `path` once no process uses it. `fs.rm` retries EPERM, EBUSY
 * and ENOTEMPTY (Windows releases file handles a moment after a process
 * exits); a folder that still cannot be removed fails with a clear message.
 */
export async function removeAppFolderAfterExit(path: string, label: string): Promise<void> {
  if (!existsSync(path)) return;
  await waitForProcessesToExit(path, label);
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (error) {
    throw new Error(
      `${label}: could not remove ${path} after every process using it exited (${(error as NodeJS.ErrnoException).code ?? String(error)})`,
      { cause: error },
    );
  }
}

const probeLog = 'D:\\a\\_temp\\probe-calls.log';
function probeCall(name: string, ms: number, result: ReturnType<typeof spawnSync>): void {
  const where = (new Error().stack ?? '').split('\n').slice(3, 7).map((l) => l.trim()).join(' < ');
  appendFileSync(probeLog, `${new Date().toISOString()} CALL ${name} ${ms} ms status=${String(result.status)} signal=${String(result.signal)} error=${String((result.error as NodeJS.ErrnoException | undefined)?.code)} out=${String(result.stdout?.length ?? 0)} err=${String(result.stderr ?? '').slice(0, 200).replace(/\s+/g, ' ')} | ${where}\n`);
}
function probeTime(name: string, command: string, script: string, timeout = 90_000): void {
  const started = Date.now();
  const result = spawnSync(command, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout });
  probeCall(name, Date.now() - started, result);
}
function probeDiagnose(): void {
  probeTime('diag powershell exit 0', 'powershell.exe', 'exit 0');
  probeTime('diag pwsh exit 0', 'pwsh', 'exit 0');
  probeTime('diag ntquery', 'powershell.exe', readFileSync(new URL('../probe/ntquery.ps1', import.meta.url), 'utf8'));
  probeTime('diag Win32_OperatingSystem', 'powershell.exe', 'Get-CimInstance Win32_OperatingSystem | Out-Null');
  probeTime('diag Get-Process only', 'powershell.exe', 'Get-Process | Measure-Object | Out-Null');
  probeTime('diag Win32_Process ProcessId only', 'powershell.exe', 'Get-CimInstance -Query "SELECT ProcessId FROM Win32_Process" | Out-Null');
  probeTime('diag current again', 'powershell.exe', windowsProcessQuery);
}
