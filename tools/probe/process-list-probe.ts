// Probe (#46 test author attempt 4): time Windows process-list queries on a runner.
import { spawn, spawnSync } from 'node:child_process';

const marker = `C:\\probe-marker-${process.pid}`;
const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)', `--user-data-dir=${marker}`], {
  stdio: 'ignore',
  windowsHide: true,
});

const cimQuery =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
const cimProjected =
  'Get-CimInstance -Query "SELECT ProcessId,ExecutablePath,CommandLine FROM Win32_Process" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
const dotnetWmi =
  '$s = New-Object System.Management.ManagementObjectSearcher("SELECT ProcessId,ExecutablePath,CommandLine FROM Win32_Process"); $s.Get() | ForEach-Object { [pscustomobject]@{ ProcessId = $_["ProcessId"]; ExecutablePath = $_["ExecutablePath"]; CommandLine = $_["CommandLine"] } } | ConvertTo-Json -Compress';
const getProcess = 'Get-Process | Select-Object @{n="ProcessId";e={$_.Id}},@{n="ExecutablePath";e={$_.Path}},CommandLine | ConvertTo-Json -Compress';
const ntQuery = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ProbeCmd {
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, IntPtr b, int l, out int r);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int a, bool i, int p);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr h, int f, System.Text.StringBuilder s, ref int n);
  public static string[] Read(int pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h == IntPtr.Zero) return new string[] { null, null };
    try {
      string exe = null; var sb = new System.Text.StringBuilder(32768); int n = sb.Capacity;
      if (QueryFullProcessImageNameW(h, 0, sb, ref n)) exe = sb.ToString(0, n);
      string cmd = null; int len;
      NtQueryInformationProcess(h, 60, IntPtr.Zero, 0, out len);
      if (len > 0) {
        IntPtr buf = Marshal.AllocHGlobal(len);
        try {
          if (NtQueryInformationProcess(h, 60, buf, len, out len) == 0) {
            int bytes = Marshal.ReadInt16(buf);
            IntPtr p = Marshal.ReadIntPtr(buf, IntPtr.Size);
            cmd = Marshal.PtrToStringUni(p, bytes / 2);
          }
        } finally { Marshal.FreeHGlobal(buf); }
      }
      return new string[] { exe, cmd };
    } finally { CloseHandle(h); }
  }
}
'@
[System.Diagnostics.Process]::GetProcesses() | ForEach-Object { $r = [ProbeCmd]::Read($_.Id); [pscustomobject]@{ ProcessId = $_.Id; ExecutablePath = $r[0]; CommandLine = $r[1] } } | ConvertTo-Json -Compress
`;

interface Variant {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
}
const ps = (shell: string, script: string): string[] => ['-NoProfile', '-NonInteractive', '-Command', script];
const variants: Variant[] = [
  { name: 'powershell.exe startup (exit 0)', command: 'powershell.exe', args: ps('', 'exit 0') },
  { name: 'pwsh startup (exit 0)', command: 'pwsh', args: ps('', 'exit 0') },
  { name: 'powershell.exe Get-CimInstance (current)', command: 'powershell.exe', args: ps('', cimQuery) },
  { name: 'powershell.exe Get-CimInstance (current) again', command: 'powershell.exe', args: ps('', cimQuery) },
  { name: 'powershell.exe Get-CimInstance -Query projected', command: 'powershell.exe', args: ps('', cimProjected) },
  { name: 'powershell.exe ManagementObjectSearcher', command: 'powershell.exe', args: ps('', dotnetWmi) },
  { name: 'pwsh Get-CimInstance (current)', command: 'pwsh', args: ps('', cimQuery) },
  { name: 'pwsh Get-Process CommandLine', command: 'pwsh', args: ps('', getProcess) },
  { name: 'powershell.exe Add-Type NtQueryInformationProcess', command: 'powershell.exe', args: ps('', ntQuery) },
  { name: 'pwsh Add-Type NtQueryInformationProcess', command: 'pwsh', args: ps('', ntQuery) },
  { name: 'powershell.exe Add-Type NtQueryInformationProcess again', command: 'powershell.exe', args: ps('', ntQuery) },
  { name: 'powershell.exe Win32_OperatingSystem (WMI alive?)', command: 'powershell.exe', args: ps('', 'Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version | ConvertTo-Json -Compress') },
  { name: 'winmgmt service', command: 'powershell.exe', args: ps('', 'Get-Service winmgmt | Select-Object Status,StartType | ConvertTo-Json -Compress') },
  { name: 'wmic', command: 'wmic', args: ['process', 'get', 'ProcessId'] },
];

const label = process.argv[2] ?? 'probe';
for (const variant of variants) {
  const started = Date.now();
  const result = spawnSync(variant.command, [...variant.args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 240_000,
  });
  const ms = Date.now() - started;
  let entries = -1;
  let markerSeen = false;
  let withPath = -1;
  let withCmd = -1;
  try {
    const parsed = [JSON.parse(result.stdout)].flat() as { ExecutablePath?: string; CommandLine?: string }[];
    entries = parsed.length;
    withPath = parsed.filter((e) => e.ExecutablePath).length;
    withCmd = parsed.filter((e) => e.CommandLine).length;
    markerSeen = parsed.some((e) => (e.CommandLine ?? '').includes(`--user-data-dir=${marker}`));
  } catch {
    // not JSON
  }
  console.log(
    `PROBE ${label} | ${variant.name} | ${ms} ms | status=${String(result.status)} signal=${String(result.signal)} error=${result.error ? String((result.error as NodeJS.ErrnoException).code ?? result.error.message) : 'none'} | entries=${entries} withPath=${withPath} withCmd=${withCmd} marker=${markerSeen} | stdout=${result.stdout?.length ?? 0}B stderr=${(result.stderr ?? '').slice(0, 300).replace(/\s+/g, ' ')}`,
  );
}
sleeper.kill();
