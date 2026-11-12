// usage: node sample-hang.mjs <app-binary> <outfile>
// Starts the app, waits 8 s, samples its main thread for 1 s with /usr/bin/sample, captures stderr, kills it.
import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const [bin, out] = process.argv.slice(2)
let stderr = ''
const child = spawn(bin, [], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1', SPIKE_REPORT: out + '.report.json', SPIKE_QUIT: '1' } })
child.stderr.on('data', (d) => (stderr += d))
child.stdout.on('data', (d) => (stderr += d))
await new Promise((r) => setTimeout(r, 8000))
const s = spawnSync('/usr/bin/sample', [String(child.pid), '1'], { encoding: 'utf8', timeout: 30000 })
const lines = s.stdout.split('\n').filter((l) => /runModal|NSAlert|ShowMessageBox|ShowErrorBox|ShowMessageBoxSync|UncaughtException|MessageBox|Dialog|JavascriptError|node::/i.test(l))
writeFileSync(out, `stderr:\n${stderr}\n--- sample (filtered) ---\n${lines.slice(0, 40).join('\n')}\n--- sample head ---\n${s.stdout.split('\n').slice(0, 60).join('\n')}\n`)
try {
  process.kill(-child.pid, 'SIGKILL')
} catch {}
console.log('done')
