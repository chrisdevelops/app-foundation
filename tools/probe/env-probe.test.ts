// Probe 4 (#46): which inherited variable makes PowerShell slow inside a turbo-run vitest worker.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';

const log = 'D:\\a\\_temp\\env-probe.log';
const query =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress';

function time(label: string, env: NodeJS.ProcessEnv, timeout = 90_000): number {
  const started = Date.now();
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout,
    env,
  });
  const ms = Date.now() - started;
  appendFileSync(log, `${label} | ${ms} ms | status=${String(result.status)} error=${String((result.error as NodeJS.ErrnoException | undefined)?.code)}\n`);
  return ms;
}

it('env probe', { timeout: 1_800_000 }, () => {
  const worker = { ...process.env };
  writeFileSync('D:\\a\\_temp\\worker-env.json', JSON.stringify(worker, null, 1));
  const full = JSON.parse(readFileSync('D:\\a\\_temp\\full-env.json', 'utf8')) as Record<string, string>;
  const lower = new Set(Object.keys(worker).map((key) => key.toLowerCase()));
  const missing = Object.keys(full).filter((key) => !lower.has(key.toLowerCase()));
  appendFileSync(log, `worker keys: ${Object.keys(worker).sort().join(' ')}\nmissing keys: ${missing.sort().join(' ')}\n`);
  time('worker env', worker);
  time('worker env again', worker);
  time('full runner env', full);
  time('worker env + all missing', { ...worker, ...Object.fromEntries(missing.map((key) => [key, full[key]])) });
  for (const key of missing) time(`worker env + ${key}`, { ...worker, [key]: full[key] }, 40_000);
  for (const key of missing) {
    const rest = Object.fromEntries(missing.filter((other) => other !== key).map((other) => [other, full[other]]));
    time(`worker env + all missing except ${key}`, { ...worker, ...rest }, 40_000);
  }
});
