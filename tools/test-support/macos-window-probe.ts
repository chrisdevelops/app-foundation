// Test-only helper for #46 (TST-018; ADR 0013). Measures, from outside the
// app, what macOS shows for a launched app, with the method of spike #43
// (`spikes/43/measure.mjs` on origin/spike/43-focus-free-tests):
// - the frontmost app, sampled every 150 ms (`lsappinfo front`);
// - the app's windows on screen (`CGWindowListCopyWindowInfo` through JXA);
// - the app's Dock presence (`lsappinfo` ApplicationType: `Foreground` has a
//   Dock icon and a menu bar; `UIElement` is the `accessory` activation policy).
// The app's processes are found by their `--user-data-dir` switch
// (app-process-cleanup.ts), never by name: other Electron apps may run on the
// same machine.
//
// Focus is measured as "the frontmost app never became one of the app's
// processes". A person may switch apps while the tests run, and other agents'
// apps may come to the front, so a changed front app is not by itself a failure
// (spike #43 "Contamination").
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listProcessesUsing } from './app-process-cleanup';

const execFileAsync = promisify(execFile);

/** True on macOS, where spike #43 measured background mode. */
export const macosWindowProbeAvailable = process.platform === 'darwin';

/** Skip note for the OS-level checks on other platforms. */
export const macosWindowProbeSkipReason =
  'OS-level window and focus checks run on macOS only: spike #43 measured macOS; Linux runs under xvfb-run and Windows is not measured in phase 1 (ADR 0013 rule 4, ADR 0011)';

/** Smallest window side that counts as an app window (smaller ones are helper surfaces, as in spike #43). */
const minimumWindowSide = 100;

async function run(command: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, [...args], { encoding: 'utf8', timeout: 15_000 });
  return stdout.trim();
}

/** The process IDs of the app that runs with `--user-data-dir=<userDataDir>` (main process and helpers). */
export function listAppProcessIds(userDataDir: string): number[] {
  return listProcessesUsing(userDataDir)
    .map((entry) => entry.pid)
    .sort((a, b) => a - b);
}

export interface FrontmostAppSample {
  /** Process ID of the frontmost app, or undefined when macOS reported none. */
  readonly pid: number | undefined;
  readonly name: string;
  /** Milliseconds since the sampler started. */
  readonly atMs: number;
}

/** The frontmost app now, or undefined when macOS reports none. */
export async function readFrontmostApp(): Promise<{ pid: number; name: string } | undefined> {
  const asn = await run('lsappinfo', ['front']);
  if (asn === '' || /^\[\s*NULL\s*\]$/i.test(asn)) return undefined;
  const info = await run('lsappinfo', ['info', '-only', 'pid', '-only', 'name', asn]);
  const pid = Number(/"pid"\s*=\s*(\d+)/.exec(info)?.[1]);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return { pid, name: /"LSDisplayName"\s*=\s*"([^"]*)"/.exec(info)?.[1] ?? '' };
}

export interface FrontmostAppSampler {
  /** Stops sampling and returns every sample, oldest first. Safe to call twice. */
  stop(): Promise<FrontmostAppSample[]>;
  /** Samples so far. */
  samples(): FrontmostAppSample[];
}

/** Samples the frontmost app every `intervalMs` until stopped. A failing read is kept as a sample without a pid. */
export function startFrontmostAppSampler(intervalMs = 150): FrontmostAppSampler {
  const started = Date.now();
  const taken: FrontmostAppSample[] = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const front = await readFrontmostApp().catch(() => undefined);
      taken.push({ pid: front?.pid, name: front?.name ?? '', atMs: Date.now() - started });
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  })();
  let stopping: Promise<FrontmostAppSample[]> | undefined;
  return {
    samples: () => [...taken],
    stop: () => {
      stopping ??= (async () => {
        stopped = true;
        await loop;
        return [...taken];
      })();
      return stopping;
    },
  };
}

/** Samples in which the frontmost app was one of `appPids`. */
export function samplesWhereAppWasFrontmost(
  samples: readonly FrontmostAppSample[],
  appPids: readonly number[],
): FrontmostAppSample[] {
  return samples.filter((sample) => sample.pid !== undefined && appPids.includes(sample.pid));
}

export interface OnscreenWindow {
  readonly pid: number;
  readonly layer: number;
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

interface CgWindowInfo {
  readonly kCGWindowOwnerPID?: number;
  readonly kCGWindowLayer?: number;
  readonly kCGWindowBounds?: { X?: number; Y?: number; Width?: number; Height?: number };
}

/** Windows of `pids` that macOS has on screen now (layer 0, at least 100 x 100 points). */
export async function listOnscreenWindows(pids: readonly number[]): Promise<OnscreenWindow[]> {
  if (pids.length === 0) return [];
  const script =
    "ObjC.import('CoreGraphics');" +
    'JSON.stringify(ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0))));';
  const text = await run('osascript', ['-l', 'JavaScript', '-e', script]);
  const all = JSON.parse(text === '' ? '[]' : text) as CgWindowInfo[];
  return all
    .filter((window) => pids.includes(window.kCGWindowOwnerPID ?? -1))
    .map((window) => ({
      pid: window.kCGWindowOwnerPID ?? -1,
      layer: window.kCGWindowLayer ?? 0,
      bounds: {
        x: window.kCGWindowBounds?.X ?? 0,
        y: window.kCGWindowBounds?.Y ?? 0,
        width: window.kCGWindowBounds?.Width ?? 0,
        height: window.kCGWindowBounds?.Height ?? 0,
      },
    }))
    .filter(
      (window) =>
        window.layer === 0 && window.bounds.width >= minimumWindowSide && window.bounds.height >= minimumWindowSide,
    );
}

/** `lsappinfo` ApplicationType of each of `pids` that macOS knows as an app (helpers without one are left out). */
export async function readApplicationTypes(pids: readonly number[]): Promise<Map<number, string>> {
  const types = new Map<number, string>();
  for (const pid of pids) {
    const asn = await run('lsappinfo', ['find', `pid=${pid}`]).catch(() => '');
    if (asn === '') continue;
    const info = await run('lsappinfo', ['info', '-only', 'applicationtype', asn]).catch(() => '');
    const type = /"ApplicationType"\s*=\s*"([^"]*)"/.exec(info)?.[1];
    if (type !== undefined) types.set(pid, type);
  }
  return types;
}

/** The `lsappinfo` ApplicationType of an app with a Dock icon and a menu bar (the `regular` activation policy). */
export const dockApplicationType = 'Foreground';

export interface MacosAppPresence {
  readonly pids: readonly number[];
  readonly onscreenWindows: readonly OnscreenWindow[];
  readonly applicationTypes: ReadonlyMap<number, string>;
  describe(): string;
}

/** What macOS shows now for the app that uses `userDataDir`. */
export async function readMacosAppPresence(userDataDir: string): Promise<MacosAppPresence> {
  const pids = listAppProcessIds(userDataDir);
  const onscreenWindows = await listOnscreenWindows(pids);
  const applicationTypes = await readApplicationTypes(pids);
  return {
    pids,
    onscreenWindows,
    applicationTypes,
    describe: () =>
      `app processes ${JSON.stringify(pids)}; windows on screen ${JSON.stringify(onscreenWindows)}; application types ${JSON.stringify([...applicationTypes])}`,
  };
}

/** Polls until the app that uses `userDataDir` has a window on screen, or `timeoutMs` passes; returns the last reading. */
export async function waitForOnscreenAppWindow(userDataDir: string, timeoutMs: number): Promise<MacosAppPresence> {
  const deadline = Date.now() + timeoutMs;
  let presence = await readMacosAppPresence(userDataDir);
  while (presence.onscreenWindows.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    presence = await readMacosAppPresence(userDataDir);
  }
  return presence;
}

/** Describes samples for an assertion message (the distinct front apps in order). */
export function describeFrontmostSamples(samples: readonly FrontmostAppSample[]): string {
  const sequence: string[] = [];
  for (const sample of samples) {
    const label = sample.pid === undefined ? '(none)' : `${sample.name}:${sample.pid}`;
    if (sequence[sequence.length - 1] !== label) sequence.push(label);
  }
  return `${samples.length} samples: ${sequence.join(' > ')}`;
}
