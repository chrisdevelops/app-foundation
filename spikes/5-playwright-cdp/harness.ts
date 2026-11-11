import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import electronPath from 'electron'

export interface RunningApp {
  child: ChildProcess
  userDataDir: string
  port: number
  output: () => string
}

export function startApp(port: number, opts: { exe?: string; extraArgs?: string[]; appPath?: string } = {}): RunningApp {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'spike5-'))
  const appArgs = opts.appPath === undefined && opts.exe === undefined ? [path.join(__dirname, 'app')] : opts.appPath ? [opts.appPath] : []
  const args = [...appArgs, `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, ...(opts.extraArgs ?? [])]
  const child = spawn(opts.exe ?? (electronPath as unknown as string), args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let out = ''
  child.stdout?.on('data', (d) => (out += String(d)))
  child.stderr?.on('data', (d) => (out += String(d)))
  return { child, userDataDir, port, output: () => out }
}

export async function waitForEndpoint(port: number, timeoutMs = 15000): Promise<{ Browser: string; webSocketDebuggerUrl: string }> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) return (await r.json()) as { Browser: string; webSocketDebuggerUrl: string }
    } catch (e) {
      last = e
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`CDP endpoint on ${port} not ready after ${timeoutMs}ms: ${String(last)}`)
}

export function orphanPids(userDataDir: string): string[] {
  try {
    return execFileSync('pgrep', ['-f', userDataDir], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

export async function stopApp(app: RunningApp): Promise<string[]> {
  if (app.child.exitCode === null && app.child.pid) {
    try { process.kill(-app.child.pid, 'SIGTERM') } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 1500))
  }
  return orphanPids(app.userDataDir)
}
