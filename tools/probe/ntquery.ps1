
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
