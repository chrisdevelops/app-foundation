// Probe 3 (#46 test author attempt 4): time process-list variants in a loop while the suite runs.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const log = process.argv[2] as string;
const stopFile = process.argv[3] as string;
const here = import.meta.dirname;
const marker = `C:\\probe-marker-${process.pid}`;
spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3600000)', '--', `--user-data-dir=${marker}`], {
  stdio: 'ignore',
  windowsHide: true,
}).unref();

const csc = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const exe = join(mkdtempSync(join(tmpdir(), 'probe-pl-')), 'process-list.exe');

const cim =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
const noCmdletWmi = String.raw`
[void][System.Reflection.Assembly]::Load('System.Management, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
$searcher = [System.Management.ManagementObjectSearcher]::new('SELECT ProcessId,ExecutablePath,CommandLine FROM Win32_Process')
$out = [System.Text.StringBuilder]::new('[')
$first = $true
foreach ($p in $searcher.Get()) {
  if (-not $first) { [void]$out.Append(',') }
  $first = $false
  $cmd = $p['CommandLine']; $exe = $p['ExecutablePath']
  $c = if ($null -eq $cmd) { 'null' } else { '"' + ($cmd -replace '\\','\\' -replace '"','\"') + '"' }
  $e = if ($null -eq $exe) { 'null' } else { '"' + ($exe -replace '\\','\\' -replace '"','\"') + '"' }
  [void]$out.Append('{"pid":' + $p['ProcessId'] + ',"executable":' + $e + ',"command":' + $c + '}')
}
[void]$out.Append(']')
[Console]::Out.Write($out.ToString())
`;

interface Variant {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
}
const ps = (script: string, extra: readonly string[] = []): string[] => [
  '-NoProfile',
  '-NonInteractive',
  ...extra,
  '-Command',
  script,
];
const variants: Variant[] = [
  { name: 'ps51 exit0', command: 'powershell.exe', args: ps('exit 0') },
  { name: 'ps51 dotnet GetProcesses count', command: 'powershell.exe', args: ps('[Console]::Out.Write([System.Diagnostics.Process]::GetProcesses().Count)') },
  { name: 'ps51 Import-Module Utility', command: 'powershell.exe', args: ps('Import-Module Microsoft.PowerShell.Utility') },
  { name: 'ps51 Import-Module Management', command: 'powershell.exe', args: ps('Import-Module Microsoft.PowerShell.Management') },
  { name: 'ps51 Import-Module CimCmdlets', command: 'powershell.exe', args: ps('Import-Module CimCmdlets') },
  { name: 'ps51 current', command: 'powershell.exe', args: ps(cim) },
  { name: 'ps51 current Bypass', command: 'powershell.exe', args: ps(cim, ['-ExecutionPolicy', 'Bypass']) },
  { name: 'ps51 no-cmdlet WMI', command: 'powershell.exe', args: ps(noCmdletWmi) },
  { name: 'pwsh exit0', command: 'pwsh', args: ps('exit 0') },
  { name: 'pwsh current', command: 'pwsh', args: ps(cim) },
  { name: 'csc exe', command: exe, args: [] },
];

function record(name: string, started: number, result: ReturnType<typeof spawnSync>): void {
  let info = '';
  try {
    const parsed = [JSON.parse(String(result.stdout))].flat() as Record<string, unknown>[];
    const text = JSON.stringify(parsed);
    info = `entries=${parsed.length} marker=${text.includes(`--user-data-dir=${marker.replace(/\\/g, '\\\\')}`)}`;
  } catch {
    info = `stdout=${String(result.stdout ?? '').slice(0, 60)}`;
  }
  appendFileSync(
    log,
    `${new Date().toISOString()} ${name} | ${Date.now() - started} ms | status=${String(result.status)} signal=${String(result.signal)} error=${String((result.error as NodeJS.ErrnoException | undefined)?.code)} | ${info} | err=${String(result.stderr ?? '').slice(0, 200).replace(/\s+/g, ' ')}\n`,
  );
}

let started = Date.now();
record(
  'csc compile',
  started,
  spawnSync(csc, ['/nologo', '/optimize+', `/out:${exe}`, join(here, 'ProcessList.cs')], { encoding: 'utf8', timeout: 180_000 }),
);
let round = 0;
while (!existsSync(stopFile)) {
  round += 1;
  appendFileSync(log, `--- round ${round}\n`);
  for (const variant of variants) {
    if (existsSync(stopFile)) break;
    started = Date.now();
    record(
      variant.name,
      started,
      spawnSync(variant.command, [...variant.args], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
      }),
    );
  }
  spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
}
void readFileSync;
