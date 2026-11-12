// Test-only helper for the reference app gate tests (#15; PLT-008, TST-011).
// A small Chrome DevTools Protocol client on Node's built-in fetch and
// WebSocket, so the gate can read the running app's windows without a
// browser-automation dependency. The smoke harness (#16) replaces it for
// smoke tests; this gate only reads targets, evaluates and navigates.

export interface DevToolsTarget {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The targets the DevTools endpoint lists (pages, iframes, workers). */
export async function listDevToolsTargets(port: number): Promise<DevToolsTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`GET /json/list on port ${port} returned ${response.status}`);
  return (await response.json()) as DevToolsTarget[];
}

/** Page targets that are app windows (DevTools front ends are not windows of the app). */
export function isAppWindowTarget(target: DevToolsTarget): boolean {
  return target.type === 'page' && !target.url.startsWith('devtools://');
}

/** Polls until at least one app window target exists and `settleMs` passes with no change in the list. */
export async function waitForAppWindowTargets(
  port: number,
  options: { timeoutMs: number; settleMs?: number; describeProcess?: () => string },
): Promise<DevToolsTarget[]> {
  const deadline = Date.now() + options.timeoutMs;
  const settleMs = options.settleMs ?? 1500;
  let last: DevToolsTarget[] = [];
  let lastKey = '';
  let stableSince = 0;
  while (Date.now() < deadline) {
    try {
      const windows = (await listDevToolsTargets(port)).filter(isAppWindowTarget);
      const key = windows.map((target) => `${target.id} ${target.url}`).join('\n');
      if (key !== lastKey) {
        lastKey = key;
        stableSince = Date.now();
      }
      last = windows;
      if (windows.length > 0 && Date.now() - stableSince >= settleMs) return windows;
    } catch {
      // The endpoint may not answer yet.
    }
    await delay(200);
  }
  throw new Error(
    `no stable app window on DevTools port ${port} after ${options.timeoutMs} ms; last targets: ${JSON.stringify(last)}` +
      (options.describeProcess ? `\n${options.describeProcess()}` : ''),
  );
}

interface CdpMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly error?: { message: string };
}

type CdpEventHandler = (params: Record<string, unknown>) => void;

/** One WebSocket connection to one DevTools target. */
export class DevToolsSession {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  private readonly handlers = new Map<string, Set<CdpEventHandler>>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result ?? {});
        return;
      }
      if (message.method) for (const handler of this.handlers.get(message.method) ?? []) handler(message.params ?? {});
    });
    socket.addEventListener('close', () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error('DevTools connection closed'));
      this.pending.clear();
    });
  }

  static async connect(webSocketUrl: string, timeoutMs = 10_000): Promise<DevToolsSession> {
    const socket = new WebSocket(webSocketUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`DevTools WebSocket ${webSocketUrl} did not open`)), timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`DevTools WebSocket ${webSocketUrl} failed to open`));
      });
    });
    return new DevToolsSession(socket);
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DevTools ${method} got no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, handler: CdpEventHandler): () => void {
    const set = this.handlers.get(method) ?? new Set<CdpEventHandler>();
    set.add(handler);
    this.handlers.set(method, set);
    return () => set.delete(handler);
  }

  /** Evaluates an expression in the page's main world and returns its JSON value. Throws on a page exception. */
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const exception = result.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
    if (exception) {
      throw new Error(
        `page threw while evaluating ${expression}: ${exception.exception?.description ?? exception.text ?? 'unknown'}`,
      );
    }
    return (result.result as { value?: T } | undefined)?.value as T;
  }

  /** Re-evaluates `expression` until it returns a truthy value, then returns it. */
  async waitForValue<T>(expression: string, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        const value = await this.evaluate<T>(expression);
        if (value) return value;
        last = value;
      } catch (error) {
        last = error;
      }
      await delay(200);
    }
    throw new Error(`${expression} stayed falsy for ${timeoutMs} ms; last value: ${String(last)}`);
  }

  /**
   * Navigates the page to `url` like an address-bar navigation and reports
   * what the page then shows. `errorText` is set when Chromium refused or
   * failed the load.
   */
  async navigate(
    url: string,
    timeoutMs = 15_000,
  ): Promise<{ errorText: string | undefined; href: string; text: string; html: string }> {
    await this.send('Page.enable');
    const stopped = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      const off = this.on('Page.frameStoppedLoading', () => {
        clearTimeout(timer);
        off();
        resolve();
      });
    });
    const result = await this.send('Page.navigate', { url }, timeoutMs);
    const errorText = typeof result.errorText === 'string' && result.errorText !== '' ? result.errorText : undefined;
    await stopped;
    const shown = await this.evaluate<{ href: string; text: string; html: string }>(
      `(() => { const root = document.documentElement; return { href: location.href, text: root ? root.innerText ?? "" : "", html: root ? root.outerHTML : "" }; })()`,
    );
    return { errorText, ...shown };
  }

  close(): void {
    this.socket.close();
  }
}
