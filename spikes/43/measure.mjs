// Spike #43 measurement runner. Usage: node measure.mjs <label> <launcher> <MODE> [runs] [appPath]
// launcher: direct | open-g | open-j | open-plain
// Tracks only pids whose command line carries its own --user-data-dir.
import { spawn, spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [label, launcher, mode, runsArg, appArg] = process.argv.slice(2);
const runs = Number(runsArg ?? 3);
const electronApp = '/Users/cal/projects/lab/app-foundation/node_modules/.pnpm/electron@45.3.0/node_modules/electron/dist/Electron.app';
const exe = appArg ?? join(electronApp, 'Contents/MacOS/Electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (c) => spawnSync('/bin/sh', ['-c', c], { encoding: 'utf8' }).stdout.trim();

function front() {
  const asn = sh('lsappinfo front');
  const info = sh(`lsappinfo info -only pid -only name ${asn}`);
  return { pid: Number(/"pid"=(\d+)/.exec(info)?.[1]), name: /"LSDisplayName"="([^"]*)"/.exec(info)?.[1] };
}
function windowsOf(pids) {
  const js = `ObjC.import('CoreGraphics');var l=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll,0)));JSON.stringify(l.filter(function(w){return ${JSON.stringify(pids)}.indexOf(w.kCGWindowOwnerPID)>=0}).map(function(w){return {pid:w.kCGWindowOwnerPID,onscreen:!!w.kCGWindowIsOnscreen,layer:w.kCGWindowLayer,b:w.kCGWindowBounds}}))`;
  const r = spawnSync('osascript', ['-l', 'JavaScript', '-e', js], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout.trim()); } catch { return 'err:' + r.stderr.slice(0, 120); }
}
function zOrder(myPids, frontPid) {
  const js = `ObjC.import('CoreGraphics');var l=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly,0)));JSON.stringify(l.filter(function(w){return w.kCGWindowLayer==0&&w.kCGWindowBounds.Width>=100&&w.kCGWindowBounds.Height>=100}).map(function(w){return w.kCGWindowOwnerPID}))`;
  const r = spawnSync('osascript', ['-l', 'JavaScript', '-e', js], { encoding: 'utf8' });
  try {
    const order = JSON.parse(r.stdout.trim());
    const mine = order.findIndex((p) => myPids.includes(p));
    const theirs = order.indexOf(frontPid);
    return mine < 0 ? 'mine-not-onscreen' : theirs < 0 ? 'mine-onscreen(front-app-no-window)' : mine < theirs ? 'mine-ABOVE-front-app' : 'mine-below-front-app';
  } catch { return 'err'; }
}
function sysVisible(pid) {
  const r = spawnSync('osascript', ['-e', `tell application "System Events" to get visible of (first process whose unix id is ${pid})`], { encoding: 'utf8' });
  return r.stdout.trim() || ('err:' + r.stderr.slice(0, 80));
}
function dockType(pid) {
  const asn = sh(`lsappinfo find pid=${pid}`);
  if (!asn) return 'no-asn';
  return /"ApplicationType"="([^"]*)"/.exec(sh(`lsappinfo info -only applicationtype ${asn}`))?.[1] ?? '?';
}
function pidsFor(dir) {
  return sh('ps -Ao pid,command').split('\n').filter((l) => l.includes(`--user-data-dir=${dir}`) && !l.includes('pgrep') && !l.includes('/bin/sh') && !l.includes('ps -Ao')).map((l) => Number(l.trim().split(/\s+/)[0])).sort((a, b) => a - b);
}

class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.p = new Map(); this.ready = new Promise((r) => (this.ws.onopen = r));
    this.ws.onmessage = (e) => { const m = JSON.parse(e.data); const h = this.p.get(m.id); if (h) { this.p.delete(m.id); m.error ? h.rej(new Error(JSON.stringify(m.error))) : h.res(m.result); } }; }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => { this.p.set(id, { res, rej }); setTimeout(() => rej(new Error('timeout ' + method)), 8000); }); }
  async ev(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result.value; }
}

async function once(i) {
  let before;
  for (let k = 0; k < 6; k++) { sh('open -a TextEdit'); await sleep(1500); before = front(); if (before.name === 'TextEdit') break; }
  const dir = mkdtempSync(join(tmpdir(), 'spike43-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, ...(process.env.EXTRA_ARGS ? process.env.EXTRA_ARGS.split(' ') : [])];
  if (process.env.COVER) { sh(`osascript -e 'tell application "TextEdit" to set bounds of window 1 to {0,0,1600,1000}'`); await sleep(500); }
  const appArgs = (launcher === 'packaged' || process.env.PACKAGED) ? args : [here, ...args];
  let child;
  const t0 = Date.now();
  if (launcher === 'direct' || launcher === 'packaged') {
    child = spawn(exe, appArgs, { env: { ...process.env, MODE: mode }, stdio: 'ignore', detached: true });
  } else {
    const flag = { 'open-g': '-g', 'open-j': '-j', 'open-gj': '-g -j', 'open-plain': '' }[launcher];
    const bundle = launcher.startsWith('open') && appArg ? appArg : electronApp;
    sh(`open ${flag} -n -a '${bundle}' --env MODE=${mode} ${process.env.OPEN_ENV ?? ""} --args ${appArgs.map((a) => `'${a}'`).join(' ')}`);
  }
  const samples = [];
  const st = { stop: false };
  const sampler = (async () => { while (!st.stop) { const f = front(); samples.push(f.name + ':' + f.pid); await sleep(150); } })();
  const portFile = join(dir, 'DevToolsActivePort');
  while (!existsSync(portFile) && Date.now() - t0 < 20000) await sleep(100);
  await sleep(1500);
  const pids = pidsFor(dir);
  const mainPid = pids[0];
  const out = { run: i, beforeFront: before.name + ':' + before.pid, mainPid };
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = targets.find((t) => t.type === 'page');
    const c = new Cdp(page.webSocketDebuggerUrl); await c.ready;
    await sleep(500);
    out.hasFocus = await c.ev('document.hasFocus()');
    out.visibility = await c.ev('document.visibilityState');
    out.activeIsInput = await c.ev('document.activeElement && document.activeElement.id');
    const a = await c.ev('({...window.ticks})').catch(() => ({raf:0,timer:0})); await sleep(2000); const b = await c.ev('({...window.ticks})').catch(() => ({raf:0,timer:0}));
    out.rafPerSec = (b.raf - a.raf) / 2; out.timerPerSec = (b.timer - a.timer) / 2;
    const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(shot.data, 'base64');
    out.shotBytes = buf.length; out.shotPng = buf.subarray(1, 4).toString() === 'PNG';
    // distinct-colour check: background #39c should dominate; read the pixel via canvas-free route: compare bytes entropy proxy
    out.shotLooksBlank = buf.length < 3000;
    await c.send('Runtime.evaluate', { expression: 'document.getElementById("i").focus()' });
    for (const ch of 'abc') await c.send('Input.dispatchKeyEvent', { type: 'char', text: ch, key: ch });
    out.typed = await c.ev('document.getElementById("i").value');
    // mitigation: focus emulation
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    out.hasFocusWithEmulation = await c.ev('document.hasFocus()');
    c.ws.close();
  } catch (e) { out.cdpError = String(e.message ?? e); }
  st.stop = true; await sleep(200);
  const allPids = pidsFor(dir);
  const ws = windowsOf(allPids);
  out.windows = Array.isArray(ws) ? ws.filter((w) => w.b.Width >= 100 && w.b.Height >= 100).map((w) => `${w.onscreen ? 'ON' : 'off'}@${w.b.X},${w.b.Y}`).join(' ') : ws;
  out.z = zOrder(allPids, before.pid);
  out.appVisible = mainPid ? sysVisible(mainPid) : 'n/a';
  out.dock = mainPid ? dockType(mainPid) : 'n/a';
  out.frontSamples = [...new Set(samples)].join(' > ');
  out.stoleFocus = samples.some((s) => !s.endsWith(':' + before.pid) && allPids.includes(Number(s.split(':').pop())));
  out.foreignFront = samples.filter((s) => !s.endsWith(':' + before.pid) && !allPids.includes(Number(s.split(':').pop()))).length;
  // cleanup: only pids carrying our unique dir
  for (const p of allPids) { try { process.kill(p, 'SIGKILL'); } catch {} }
  await sleep(500);
  if (pidsFor(dir).length) for (const p of pidsFor(dir)) { try { process.kill(p, 'SIGKILL'); } catch {} }
  rmSync(dir, { recursive: true, force: true });
  return out;
}

console.log(`== ${label} (${launcher}, MODE=${mode})`);
for (let i = 1; i <= runs; i++) console.log(JSON.stringify(await once(i)));
