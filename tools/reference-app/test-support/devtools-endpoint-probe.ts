// Test-only helper for the reference app gate tests (#18; TST-009, PLT-008).
// Probes from outside whether a debugging endpoint answers on a port: the
// Chromium DevTools endpoint (`--remote-debugging-port`) or the Node inspector
// (`--inspect`). Both serve `GET /json/version` over HTTP. Every probe and
// every wait is bounded.
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { ElectronAppProcess } from './electron-app-process';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A port that was free on 127.0.0.1 a moment ago (the OS picks it). */
export function findFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('the OS gave no free port'))));
    });
  });
}

export interface EndpointAnswer {
  readonly answered: boolean;
  /** HTTP status, or the connection error when nothing answered. */
  readonly detail: string;
}

/** One `GET /json/version` on `host:port`; `answered` is true for any HTTP answer. */
export async function probeDebugEndpoint(host: string, port: number, timeoutMs = 1_000): Promise<EndpointAnswer> {
  const hostInUrl = host.includes(':') ? `[${host}]` : host;
  try {
    const response = await fetch(`http://${hostInUrl}:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text().catch(() => '');
    return { answered: true, detail: `HTTP ${response.status} ${body.slice(0, 200)}` };
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    return { answered: false, detail: cause?.code ?? cause?.message ?? String(error) };
  }
}

export interface EndpointWatch {
  /** Probes that got an HTTP answer, with the time since the watch began. */
  readonly answers: ReadonlyArray<{ readonly atMs: number; readonly detail: string }>;
  readonly probes: number;
  /** True when the app exited during the watch. */
  readonly appExited: boolean;
  readonly elapsedMs: number;
}

/**
 * Probes `127.0.0.1:<port>` every `intervalMs` until the app exits or
 * `windowMs` passes. A guard that opens the port even for a moment shows up as
 * an answer (Chromium answers within about one second of start: spike #5).
 */
export async function watchDebugEndpoint(
  app: ElectronAppProcess,
  port: number,
  options: { windowMs: number; intervalMs?: number },
): Promise<EndpointWatch> {
  const started = Date.now();
  const answers: Array<{ atMs: number; detail: string }> = [];
  let probes = 0;
  while (Date.now() - started < options.windowMs) {
    const exitedBefore = app.exitCode() !== null;
    const answer = await probeDebugEndpoint('127.0.0.1', port, 500);
    probes += 1;
    if (answer.answered) answers.push({ atMs: Date.now() - started, detail: answer.detail });
    if (exitedBefore) break;
    await delay(options.intervalMs ?? 50);
  }
  return { answers, probes, appExited: app.exitCode() !== null, elapsedMs: Date.now() - started };
}

/** Waits until the app exits or `timeoutMs` passes; returns its exit code, or null while it still runs. */
export async function waitForAppExit(app: ElectronAppProcess, timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (app.exitCode() === null && Date.now() < deadline) await delay(100);
  return app.exitCode();
}

/** The machine's IPv4 addresses that are not loopback (for "localhost only" checks). */
export function listNonLoopbackIpv4Addresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}
