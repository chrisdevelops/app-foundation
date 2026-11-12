// Test-only helper for the reference app gate tests (#15; PLT-002, PLT-008).
// Reads what an app window shows through the DevTools protocol: headings by
// accessible role and name, the React root around them, and what the page
// can reach in its main world.
import { DevToolsSession, waitForAppWindowTargets, type DevToolsTarget } from './devtools-protocol-client';
import type { ElectronAppProcess } from './electron-app-process';

export interface OpenAppWindow {
  readonly port: number;
  readonly windows: readonly DevToolsTarget[];
  readonly session: DevToolsSession;
}

/** Waits for the app's DevTools port and its windows, then connects to the first window. */
export async function openAppWindow(app: ElectronAppProcess, timeoutMs: number): Promise<OpenAppWindow> {
  const port = await app.waitForDevToolsPort(timeoutMs);
  const windows = await waitForAppWindowTargets(port, { timeoutMs, describeProcess: () => app.describe() });
  const session = await DevToolsSession.connect((windows[0] as DevToolsTarget).webSocketDebuggerUrl);
  return { port, windows, session };
}

interface AxNode {
  readonly ignored?: boolean;
  readonly role?: { readonly value?: string };
  readonly name?: { readonly value?: string };
}

/** Names of the headings in the accessibility tree (role `heading`, not ignored, non-empty name). */
export async function readAccessibleHeadingNames(session: DevToolsSession): Promise<string[]> {
  const tree = await session.send('Accessibility.getFullAXTree');
  return ((tree.nodes ?? []) as AxNode[])
    .filter((node) => !node.ignored && node.role?.value === 'heading')
    .map((node) => (node.name?.value ?? '').trim())
    .filter((name) => name !== '');
}

/** Polls the accessibility tree until it holds a named heading. */
export async function waitForAccessibleHeadingNames(session: DevToolsSession, timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const names = await readAccessibleHeadingNames(session).catch(() => []);
    if (names.length > 0) return names;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const page = await session
    .evaluate<string>('document.documentElement ? document.documentElement.outerHTML.slice(0, 2000) : ""')
    .catch((error: unknown) => String(error));
  throw new Error(`the window shows no named heading after ${timeoutMs} ms; page:\n${page}`);
}

export interface ReactRootHeadings {
  /** Elements React DOM marks as a root container (createRoot). */
  readonly reactRootCount: number;
  /** Headings inside a React root, with their text and whether they are visible. */
  readonly headings: ReadonlyArray<{ readonly text: string; readonly visible: boolean }>;
}

/**
 * Headings inside React roots. React DOM marks each root container with an
 * own property that starts with `__reactContainer$`; that is the only sign of
 * a React root that is visible from outside the app.
 */
export function readReactRootHeadings(session: DevToolsSession): Promise<ReactRootHeadings> {
  return session.evaluate<ReactRootHeadings>(`(() => {
    const roots = [...document.querySelectorAll('*')].filter((element) =>
      Object.keys(element).some((key) => key.startsWith('__reactContainer$')));
    const headings = roots.flatMap((root) => [...root.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')]);
    return {
      reactRootCount: roots.length,
      headings: headings.map((heading) => {
        const box = heading.getBoundingClientRect();
        const visible = heading.checkVisibility({ opacityProperty: true, visibilityProperty: true })
          && box.width > 0 && box.height > 0;
        return { text: (heading.textContent ?? '').trim(), visible };
      }),
    };
  })()`);
}

export interface MainWorldNodeGlobals {
  readonly require: string;
  readonly process: string;
  readonly module: string;
  readonly global: string;
}

/** `typeof` of the Node globals in the page's main world. */
export function readMainWorldNodeGlobals(session: DevToolsSession): Promise<MainWorldNodeGlobals> {
  return session.evaluate<MainWorldNodeGlobals>(
    '({ require: typeof require, process: typeof process, module: typeof module, global: typeof global })',
  );
}
