// Test-only Windows process lister for app-process-cleanup.ts (#46).
// Prints every process as UTF-8 JSON:
//   [{"pid":1,"executable":"C:\\...","command":"..."}]
// executable and command are null when Windows does not let this process read
// them (protected and system processes). Reads them with
// QueryFullProcessImageNameW and NtQueryInformationProcess
// (ProcessCommandLineInformation, Windows 8.1 and later); no WMI, no PowerShell.
// app-process-cleanup.ts compiles it once with csc.exe of .NET Framework 4,
// which Windows ships, so the source stays C# 5.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class ProcessList {
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr handle, int infoClass, IntPtr buffer, int length, out int returned);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern bool QueryFullProcessImageNameW(IntPtr handle, int flags, StringBuilder name, ref int size);

  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr process, int access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool LookupPrivilegeValueW(string system, string name, out long luid);
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  struct TokenPrivileges { public int Count; public long Luid; public int Attributes; }
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivileges state, int length, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  static void EnableDebug() {
    IntPtr token; long luid;
    if (!OpenProcessToken(GetCurrentProcess(), 0x28, out token)) return;
    if (!LookupPrivilegeValueW(null, "SeDebugPrivilege", out luid)) return;
    var state = new TokenPrivileges { Count = 1, Luid = luid, Attributes = 2 };
    AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero);
  }

  const int ProcessQueryLimitedInformation = 0x1000;
  const int ProcessCommandLineInformation = 60;

  static void Read(int pid, out string executable, out string command) {
    executable = null;
    command = null;
    IntPtr handle = OpenProcess(ProcessQueryLimitedInformation, false, pid);
    if (handle == IntPtr.Zero) return;
    try {
      var name = new StringBuilder(32768);
      int size = name.Capacity;
      if (QueryFullProcessImageNameW(handle, 0, name, ref size)) executable = name.ToString(0, size);
      int length;
      NtQueryInformationProcess(handle, ProcessCommandLineInformation, IntPtr.Zero, 0, out length);
      if (length <= 0) return;
      IntPtr buffer = Marshal.AllocHGlobal(length);
      try {
        if (NtQueryInformationProcess(handle, ProcessCommandLineInformation, buffer, length, out length) == 0) {
          // UNICODE_STRING: USHORT Length (bytes), USHORT MaximumLength, PWSTR Buffer.
          int bytes = (ushort)Marshal.ReadInt16(buffer);
          IntPtr text = Marshal.ReadIntPtr(buffer, IntPtr.Size);
          if (text != IntPtr.Zero) command = Marshal.PtrToStringUni(text, bytes / 2);
        }
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    } finally {
      CloseHandle(handle);
    }
  }

  static void Json(StringBuilder output, string text) {
    if (text == null) { output.Append("null"); return; }
    output.Append('"');
    foreach (char c in text) {
      if (c == '"') output.Append("\\\"");
      else if (c == '\\') output.Append("\\\\");
      else if (c < ' ') output.Append("\\u").Append(((int)c).ToString("x4"));
      else output.Append(c);
    }
    output.Append('"');
  }

  public static int Main(string[] args) {
    if (args.Length > 0 && args[0] == "--debug-privilege") EnableDebug();
    var output = new StringBuilder("[");
    bool first = true;
    foreach (Process process in Process.GetProcesses()) {
      int pid = process.Id;
      string executable, command;
      Read(pid, out executable, out command);
      if (!first) output.Append(',');
      first = false;
      output.Append("{\"pid\":").Append(pid).Append(",\"executable\":");
      Json(output, executable);
      output.Append(",\"command\":");
      Json(output, command);
      output.Append('}');
    }
    output.Append(']');
    using (Stream stdout = Console.OpenStandardOutput()) {
      byte[] bytes = new UTF8Encoding(false).GetBytes(output.ToString());
      stdout.Write(bytes, 0, bytes.Length);
    }
    return 0;
  }
}
