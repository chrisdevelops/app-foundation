// Test-only helper for the reference app gate tests (#15; TST-011).
// Removes a temporary folder an Electron app used (a packaged app copy or a
// user data folder) only after every process that uses it has exited.
// Windows locks the files of running executables, and Electron's helper
// processes (GPU, renderer, utility, crashpad) can outlive the main process
// for a moment (CI run 43182127367: EPERM on rm). Every wait is bounded; a
// process that is still running fails the gate with its name and command
// line, and is never killed silently.
//
// Windows listing (#46): a small C# program (windows-process-list.cs),
// compiled once per source version with the csc.exe of .NET Framework 4 that
// Windows ships, and cached in the temp folder. It used to be PowerShell with
// Get-CimInstance, but inside `pnpm turbo run test` workers on GitHub Windows
// runners the first cmdlet call took 41 s and more than 60 s under load, then
// about 21 s per call (probe PR #49: runs 43337463851, 43340151957,
// 43341831759). The same query outside the worker took under 2.3 s at the same
// moment. Turborepo's strict environment mode drops PSModuleAnalysisCachePath
// (the runner's prebuilt PowerShell module cache), so PowerShell analyses every
// installed module before it runs a cmdlet. The C# program needs no PowerShell
// and no WMI: about 60 ms per listing.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, unlinkSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

export interface RunningProcess {
  readonly pid: number;
  /** Path of the executable (Windows), or empty when the OS does not report it apart from the command. */
  readonly executable: string;
  /** Full command line; on POSIX it starts with the executable path. */
  readonly command: string;
}

export interface ListRunningProcessesOptions {
  /** Time limit for one attempt, in ms. Default 30 000. */
  readonly timeoutMs?: number;
  /** Attempts before the listing fails. Default 2. */
  readonly attempts?: number;
}

const defaultListTimeoutMs = 30_000;
const defaultListAttempts = 2;
/** Time limit for compiling the Windows lister (once per source version). */
const windowsListerCompileTimeoutMs = 120_000;

interface WindowsProcessEntry {
  readonly pid: number;
  readonly executable: string | null;
  readonly command: string | null;
}

/** Why one spawnSync attempt failed, in words; undefined when it exited 0. */
function describeSpawnFailure(result: SpawnSyncReturns<string>, timeoutMs: number): string | undefined {
  const spawnError: NodeJS.ErrnoException | undefined = result.error;
  const code = spawnError?.code;
  const stderr = (result.stderr ?? '').trim();
  const detail = stderr ? `: ${stderr.slice(0, 2000)}` : '';
  if (code === 'ETIMEDOUT') return `timed out after ${timeoutMs} ms${detail}`;
  if (result.error) return `could not run (${code ?? result.error.message})${detail}`;
  if (result.signal) return `stopped by ${result.signal}${detail}`;
  if (result.status !== 0) return `exit ${String(result.status)}${detail}`;
  return undefined;
}

/** Path of the compiled Windows lister; compiles windows-process-list.cs the first time. Throws when it cannot. */
function windowsListerExecutable(): string {
  const source = readFileSync(new URL('./windows-process-list.cs', import.meta.url), 'utf8');
  const version = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const executable = join(tmpdir(), `foundation-process-list-${version}.exe`);
  if (existsSync(executable)) return executable;
  const windowsDir = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const compiler = join(windowsDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!existsSync(compiler)) {
    throw new Error(`could not list processes: the C# compiler of .NET Framework 4 is missing (${compiler})`);
  }
  const workDir = mkdtempSync(join(tmpdir(), 'foundation-process-list-'));
  try {
    const sourcePath = join(workDir, 'windows-process-list.cs');
    const built = join(workDir, 'process-list.exe');
    writeFileSync(sourcePath, source);
    const result = spawnSync(compiler, ['/nologo', '/optimize+', '/target:exe', `/out:${built}`, sourcePath], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: windowsListerCompileTimeoutMs,
    });
    const failure = describeSpawnFailure(result, windowsListerCompileTimeoutMs);
    if (failure) {
      throw new Error(
        `could not list processes: compiling the Windows lister with ${compiler} failed (${failure})\n${result.stdout}`,
      );
    }
    try {
      renameSync(built, executable);
    } catch (error) {
      // Another test process compiled the same version first.
      if (!existsSync(executable)) throw error;
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  return executable;
}

/** One listing attempt: the processes, or why the attempt failed. */
function listOnce(timeoutMs: number): RunningProcess[] | string {
  if (process.platform === 'win32') {
    const result = spawnSync(windowsListerExecutable(), [], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
    });
    const failure = describeSpawnFailure(result, timeoutMs);
    if (failure) return failure;
    let parsed: WindowsProcessEntry[];
    try {
      parsed = JSON.parse(result.stdout) as WindowsProcessEntry[];
    } catch (error) {
      return `unreadable output (${(error as Error).message}): ${result.stdout.slice(0, 200)}`;
    }
    return parsed.map((entry) => ({
      pid: entry.pid,
      executable: entry.executable ?? '',
      command: entry.command ?? '',
    }));
  }
  // -ww: never cut long command lines.
  const result = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,command='], { encoding: 'utf8', timeout: timeoutMs });
  const failure = describeSpawnFailure(result, timeoutMs);
  if (failure) return failure;
  return result.stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), executable: '', command: match[2] as string }))
    .filter((entry) => entry.pid !== process.pid);
}

/**
 * Every running process, from the compiled lister on Windows and `ps`
 * elsewhere. Each attempt has `timeoutMs`; after `attempts` failed attempts it
 * throws `could not list processes ...` with the reason for each attempt. It
 * never returns a partial or empty list in place of an error.
 */
export function listRunningProcesses(options: ListRunningProcessesOptions = {}): RunningProcess[] {
  const timeoutMs = options.timeoutMs ?? defaultListTimeoutMs;
  const attempts = Math.max(1, options.attempts ?? defaultListAttempts);
  const tool = process.platform === 'win32' ? 'the Windows lister' : 'ps';
  const failures: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const outcome = listOnce(timeoutMs);
    if (typeof outcome !== 'string') return outcome;
    failures.push(`  attempt ${attempt}: ${outcome}`);
  }
  throw new Error(
    `could not list processes with ${tool} (${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}):\n${failures.join('\n')}`,
  );
}

/**
 * Processes that use folder `dir`: their executable is inside it, or they
 * run with `--user-data-dir=<dir>` (also quoted as a whole, or with the value
 * quoted as Chromium helpers have it). Other processes whose command text only
 * mentions the path (a shell, an editor) do not count. Case-insensitive on Windows.
 */
export function listProcessesUsing(dir: string): RunningProcess[] {
  const windows = process.platform === 'win32';
  const fold = (text: string): string => (windows ? text.toLowerCase() : text);
  const inside = fold(dir.endsWith(sep) ? dir : `${dir}${sep}`);
  const userDataSwitch = fold(`--user-data-dir=${dir}`);
  // Chromium starts its helper processes with the value quoted:
  // --user-data-dir="C:\...\dir" (#46, probe PR #50).
  const quotedValueSwitch = fold(`--user-data-dir="${dir}"`);
  return listRunningProcesses().filter((entry) => {
    const executable = fold(windows ? entry.executable : entry.command);
    const command = fold(entry.command);
    const usesSwitch =
      command.includes(userDataSwitch) ||
      command.includes(`"${userDataSwitch}"`) ||
      command.includes(quotedValueSwitch);
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
      `${label}: could not remove ${path} after every process using it exited [DIAG ${probeDiag(path)}] (${(error as NodeJS.ErrnoException).code ?? String(error)})`,
      { cause: error },
    );
  }
}

function probeDiag(path: string): string {
  if (process.platform !== 'win32') return 'not windows';
  const out: string[] = [];
  const fold = path.toLowerCase();
  const mine = listRunningProcesses();
  const tasklist = spawnSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
  const names = new Map<number, string>();
  for (const line of tasklist.split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(line);
    if (m) names.set(Number(m[2]), m[1] as string);
  }
  out.push('lister unreadable: ' + mine.filter((e) => !e.command || !e.executable).map((e) => `${e.pid}:${names.get(e.pid) ?? '?'}:exe=${e.executable ? 'y' : 'n'}:cmd=${e.command ? 'y' : 'n'}`).join(' '));
  out.push('lister mentions folder: ' + mine.filter((e) => e.command.toLowerCase().includes(fold) || e.executable.toLowerCase().includes(fold)).map((e) => `${e.pid}:${names.get(e.pid) ?? '?'}:${e.command.slice(0, 200)}`).join(' || '));
  const wmi = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress'], {
    env: { ...process.env, PSModuleAnalysisCachePath: 'C:\\PSModuleAnalysisCachePath\\ModuleAnalysisCache' },
    encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 120_000,
  });
  try {
    const list = [JSON.parse(wmi.stdout)].flat() as { ProcessId: number; Name: string; ExecutablePath: string | null; CommandLine: string | null }[];
    out.push('wmi mentions folder: ' + list.filter((e) => (e.ExecutablePath ?? '').toLowerCase().includes(fold) || (e.CommandLine ?? '').toLowerCase().includes(fold)).map((e) => `${e.ProcessId}:${e.Name}:${(e.CommandLine ?? 'null').slice(0, 200)}`).join(' || '));
  } catch (error) {
    out.push('wmi failed ' + String(error));
  }
  const tools = 'D:\\a\\_temp\\handle';
  if (!existsSync(tools + '\\handle64.exe')) {
    spawnSync('cmd.exe', ['/c', `mkdir ${tools} & curl.exe -sSL -o ${tools}\\h.zip https://download.sysinternals.com/files/Handle.zip & tar -xf ${tools}\\h.zip -C ${tools}`], { encoding: 'utf8', timeout: 120_000 });
  }
  const handle = spawnSync(tools + '\\handle64.exe', ['-accepteula', '-nobanner', path], { encoding: 'utf8', timeout: 120_000 });
  out.push('handle64: status=' + String(handle.status) + ' ' + (handle.stdout ?? '').slice(0, 3000) + (handle.stderr ?? '').slice(0, 500));
  const stuck: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = dir + '\\' + entry.name;
      if (entry.isDirectory()) walk(full);
      else { try { unlinkSync(full); } catch (error) { stuck.push(full.slice(path.length) + ':' + String((error as NodeJS.ErrnoException).code)); } }
    }
  };
  try { walk(path); } catch (error) { stuck.push('walk failed ' + String(error)); }
  out.push('undeletable files: ' + stuck.slice(0, 15).join(' ') + (stuck.length > 15 ? ' ... ' + String(stuck.length) : ''));
  return out.join('\n');
}
