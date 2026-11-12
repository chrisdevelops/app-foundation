// usage: node run-with-timeout.mjs <seconds> <logfile> <cmd> [args...]
// Runs cmd in its own process group, tees output to logfile, kills the whole group on timeout, appends "exit=<code>".
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'

const [secs, logfile, cmd, ...args] = process.argv.slice(2)
const log = createWriteStream(logfile)
const child = spawn(cmd, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.pipe(log, { end: false })
child.stderr.pipe(log, { end: false })
let timedOut = false
const timer = setTimeout(() => {
  timedOut = true
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {}
}, Number(secs) * 1000)
child.on('exit', (code, signal) => {
  clearTimeout(timer)
  // kill any leftovers in the group
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {}
  log.end(`\nexit=${code} signal=${signal} timedOut=${timedOut}\n`, () => process.exit(timedOut ? 124 : (code ?? 1)))
})
