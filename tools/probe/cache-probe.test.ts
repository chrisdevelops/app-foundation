// Probe 5 (#46): does PSModuleAnalysisCachePath decide the first-call cost inside a turbo worker?
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';

const log = 'D:\\a\\_temp\\cache-probe.log';
const query =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress';

function time(label: string, env: NodeJS.ProcessEnv): void {
  const started = Date.now();
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 120_000, env,
  });
  appendFileSync(log, `${label} | ${Date.now() - started} ms | status=${String(result.status)}\n`);
}

it('cache probe', { timeout: 1_800_000 }, () => {
  const full = JSON.parse(readFileSync('D:\\a\\_temp\\full-env.json', 'utf8')) as Record<string, string>;
  const worker = { ...process.env };
  const cachePath = full.PSModuleAnalysisCachePath;
  appendFileSync(log, `worker has PSModuleAnalysisCachePath: ${String('PSModuleAnalysisCachePath' in worker)}; runner value: ${String(cachePath)}\n`);
  const fresh = () => mkdtempSync(join(tmpdir(), 'lad-'));
  time('A worker env + PSModuleAnalysisCachePath', { ...worker, PSModuleAnalysisCachePath: cachePath });
  time('B worker env, fresh LOCALAPPDATA (cold default cache)', { ...worker, LOCALAPPDATA: fresh() });
  time('C worker env, fresh LOCALAPPDATA + PSModuleAnalysisCachePath', { ...worker, LOCALAPPDATA: fresh(), PSModuleAnalysisCachePath: cachePath });
  time('D worker env as is (first use of default cache)', worker);
  time('E worker env as is, again', worker);
  time('F full runner env, fresh LOCALAPPDATA', { ...full, LOCALAPPDATA: fresh() });
  time('G worker env, fresh LOCALAPPDATA, again', { ...worker, LOCALAPPDATA: fresh() });
});
