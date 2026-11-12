// Security baseline smoke tests (#18; PLT-008, PLT-012). Driven by Playwright
// over CDP through the smoke harness, against the dev build (`pnpm run smoke`)
// or the packaged executable named by SMOKE_APP_EXECUTABLE. A packaged build
// opens its CDP port only when FOUNDATION_ALLOW_PACKAGED_CDP=1 is in the
// environment (ADR 0004 decision 2 B); CI's packaged smoke step sets it.
//
// Every window (the main window and a `window.open` child):
// - no Node in the main world (`require`, `process`, `module`, `global`,
//   `Buffer`, `__dirname`, `__filename`);
// - no renderer process of the app runs without the Chromium sandbox;
// - main window: the preload runs in Electron's isolated world (context
//   isolation) with no Node globals there (sandbox), and the main world holds
//   no global that a clean world lacks except contextBridge APIs (read-only,
//   non-configurable properties).
// `window.open`:
// - `about:blank` is the one allowed URL (child windows render through React
//   portals into an about:blank document: CMP-009, spike #8). The child gets
//   the same baseline, also when the request asks for Node, no isolation and
//   no sandbox in its features string.
// - Any other URL is denied: `window.open` returns null and no window opens.
// Content-Security-Policy (packaged build only: the policy is set on app://
// responses, ADR 0004 decisions 1 A and 9 B; the dev build loads the Vite dev
// server):
// - every app:// response of the page carries a policy that meets the rules in
//   tools/test-support/content-security-policy.ts;
// - an inline <script> inserted into the DOM does not run and fires
//   `securitypolicyviolation` (never `eval` through page.evaluate as proof:
//   spike #5); an inline <style> applies; the about:blank child inherits this.
// A failing test writes the harness evidence into SMOKE_EVIDENCE_DIR (ADR 0012).
import type { CDPSession, Page } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listProcessesUsing } from '../../tools/test-support/app-process-cleanup';
import { listFoundationCspProblems } from '../../tools/test-support/content-security-policy';
import {
  loadSmokeHarness,
  type ExpectedSmokeApp,
  type ExpectedSmokeAppTarget,
} from '../test-support/smoke-harness-contract';
import {
  smokeHarnessDeferredOnWindows,
  smokeHarnessWindowsDeferralReason,
} from '../test-support/windows-smoke-deferral';

/** The reference app's main window title. */
const referenceAppTitle = 'Reference';
/** The one URL `window.open` may open (#18 reading: child windows are about:blank portal targets). */
const allowedChildUrl = 'about:blank';
/** Electron's name for the isolated world the preload runs in (contextIsolation: true). */
const electronIsolatedWorldName = 'Electron Isolated Context';
/** Time a denied `window.open` has to show that no window opens. */
const deniedWindowWatchMs = 3_000;
const devBuildCspSkipReason =
  'dev build: pages come from the Vite dev server; the CSP is set on app:// responses (issue #18 criterion 3)';
const nodeGlobalNames = ['require', 'process', 'module', 'global', 'Buffer', '__dirname', '__filename'] as const;
const slow = { timeout: 180_000 };

let app: ExpectedSmokeApp | undefined;
let target: ExpectedSmokeAppTarget | undefined;

// DEFERRED: TST-010 (Windows smoke suite; ADR 0011, #39): no launch and every test skips on Windows.
beforeEach((context) => {
  if (smokeHarnessDeferredOnWindows) context.skip(smokeHarnessWindowsDeferralReason);
});

// ADR 0012: a failing test leaves its evidence in SMOKE_EVIDENCE_DIR.
beforeEach((context) => {
  context.onTestFailed(async () => {
    await app?.writeEvidence(context.task.name);
  });
});

beforeAll(async () => {
  if (smokeHarnessDeferredOnWindows) return;
  const harness = await loadSmokeHarness();
  target = harness.resolveSmokeAppTarget(process.env);
  app = await harness.launchSmokeApp({ target });
}, 300_000);

afterAll(async () => {
  await app?.teardown();
}, 120_000);

function requireApp(): ExpectedSmokeApp {
  if (!app) throw new Error('the app did not start');
  return app;
}

function isPackaged(): boolean {
  return target?.kind === 'packaged';
}

let mainWindowLookup: Promise<Page> | undefined;

/**
 * The main window once it shows the reference app title. Looked up once: when
 * it never appears (for example a fixture that is not the reference app), every
 * test fails at once instead of waiting again.
 */
async function mainWindow(): Promise<Page> {
  mainWindowLookup ??= (async () => {
    const started = requireApp();
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      for (const page of started.windows()) {
        if ((await page.title().catch(() => '')) === referenceAppTitle) return page;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
      `no window titled ${referenceAppTitle}; windows ${JSON.stringify(started.windows().map((page) => page.url()))}`,
    );
  })();
  const page = await mainWindowLookup;
  await page.waitForLoadState('load');
  return page;
}

/**
 * `page.evaluate`, retried while a navigation replaces the page (the Vite dev
 * server can reload the page once after its first load); every other error throws.
 */
async function evaluateInPage<T>(page: Page, expression: string): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await page.evaluate<T>(expression);
    } catch (error) {
      const navigated = /Execution context was destroyed|navigation/i.test(String(error));
      if (!navigated || attempt >= 5) throw error;
      await page.waitForLoadState('load').catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/** `typeof` of each Node global in the page's main world. */
function readNodeGlobals(page: Page): Promise<Record<string, string>> {
  // typeof per name, written out: no eval, so the page CSP plays no part in the probe.
  return evaluateInPage(page, `({ ${nodeGlobalNames.map((name) => `${name}: typeof ${name}`).join(', ')} })`);
}

const noNodeGlobals = Object.fromEntries(nodeGlobalNames.map((name) => [name, 'undefined']));

/** Opens a child window from `opener` with `window.open(url, '_blank', features)` and returns it. */
async function openChildWindow(opener: Page, url: string, features = ''): Promise<Page> {
  const child = await requireApp().waitForNewWindow(
    () => opener.evaluate(`void window.open(${JSON.stringify(url)}, '_blank', ${JSON.stringify(features)})`),
    30_000,
  );
  await child.waitForLoadState('domcontentloaded').catch(() => undefined);
  return child;
}

/** Renderer processes of this launch that run without the Chromium sandbox. */
function unsandboxedRendererProcesses(): string[] {
  const started = requireApp();
  const processes = listProcessesUsing(started.userDataDir);
  expect(processes, `control: processes must use the user data folder ${started.userDataDir}`).not.toEqual([]);
  return processes
    .filter((entry) => /--type=renderer\b/.test(entry.command) && /--no-sandbox\b/.test(entry.command))
    .map((entry) => `pid ${entry.pid}: ${entry.command.slice(0, 400)}`);
}

interface ExecutionContextInfo {
  readonly id: number;
  readonly name: string;
  readonly origin: string;
  readonly auxData?: { readonly isDefault?: boolean; readonly frameId?: string; readonly type?: string };
}

/** Every execution context of `page`, from a fresh CDP session (Runtime.enable reports the existing ones). */
async function listExecutionContexts(page: Page): Promise<{ session: CDPSession; contexts: ExecutionContextInfo[] }> {
  const session = await page.context().newCDPSession(page);
  const contexts: ExecutionContextInfo[] = [];
  session.on('Runtime.executionContextCreated', (event) => {
    contexts.push(event.context);
  });
  // Keep only live contexts: a reload (the Vite dev server reloads once) destroys the old ones.
  session.on('Runtime.executionContextDestroyed', (event) => {
    const index = contexts.findIndex((context) => context.id === event.executionContextId);
    if (index !== -1) contexts.splice(index, 1);
  });
  session.on('Runtime.executionContextsCleared', () => {
    contexts.length = 0;
  });
  await session.send('Runtime.enable');
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { session, contexts };
}

async function evaluateInContext<T>(session: CDPSession, contextId: number, expression: string): Promise<T> {
  const result = await session.send('Runtime.evaluate', { contextId, expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(`${expression} threw: ${JSON.stringify(result.exceptionDetails)}`);
  return result.result.value as T;
}

/** Inserts an inline <script> and reports whether it ran and which violations fired. */
function probeInlineScript(page: Page): Promise<{ ran: boolean; violations: string[] }> {
  return evaluateInPage(
    page,
    `new Promise((resolve) => {
    const violations = [];
    const onViolation = (event) => violations.push(event.effectiveDirective + ' ' + event.blockedURI);
    document.addEventListener('securitypolicyviolation', onViolation);
    window.__securityGateInlineScriptRan = false;
    const script = document.createElement('script');
    script.textContent = 'window.__securityGateInlineScriptRan = true;';
    (document.head || document.documentElement).appendChild(script);
    setTimeout(() => {
      document.removeEventListener('securitypolicyviolation', onViolation);
      script.remove();
      const ran = window.__securityGateInlineScriptRan === true;
      delete window.__securityGateInlineScriptRan;
      resolve({ ran, violations });
    }, 750);
  })`,
  );
}

/** Inserts an inline <style> and reports the computed style it should set, and any style violations. */
function probeInlineStyle(page: Page): Promise<{ outlineColor: string; violations: string[] }> {
  return evaluateInPage(
    page,
    `new Promise((resolve) => {
    const violations = [];
    const onViolation = (event) => violations.push(event.effectiveDirective + ' ' + event.blockedURI);
    document.addEventListener('securitypolicyviolation', onViolation);
    const probe = document.createElement('div');
    probe.id = 'security-gate-style-probe';
    (document.body || document.documentElement).appendChild(probe);
    const style = document.createElement('style');
    style.textContent = '#security-gate-style-probe { outline-style: solid; outline-color: rgb(1, 2, 3); }';
    (document.head || document.documentElement).appendChild(style);
    setTimeout(() => {
      const outlineColor = getComputedStyle(probe).outlineColor;
      document.removeEventListener('securitypolicyviolation', onViolation);
      probe.remove();
      style.remove();
      resolve({ outlineColor, violations: violations.filter((entry) => entry.startsWith('style-src')) });
    }, 750);
  })`,
  );
}

describe('security baseline: main window', () => {
  // PLT-008; issue #18 acceptance criterion 1
  it(
    'PLT-008: the main window main world has no require, process, module, global, Buffer, __dirname or __filename',
    slow,
    async () => {
      expect(await readNodeGlobals(await mainWindow())).toEqual(noNodeGlobals);
    },
  );

  // PLT-008; issue #18 acceptance criterion 1 (context isolation and sandbox, seen from outside)
  it(
    `PLT-008: the main window runs its preload in the "${electronIsolatedWorldName}" world, which has no Node globals (context isolation and sandbox)`,
    slow,
    async () => {
      const page = await mainWindow();
      const { session, contexts } = await listExecutionContexts(page);
      try {
        await page.waitForLoadState('load');
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const isolated = contexts.filter((context) => context.name === electronIsolatedWorldName);
        expect(
          isolated,
          `the preload must run in an isolated world (contextIsolation: true); contexts ${JSON.stringify(contexts)}`,
        ).not.toEqual([]);
        for (const context of isolated) {
          const globals = await evaluateInContext<Record<string, string>>(
            session,
            context.id,
            `({ require: typeof require, process: typeof process, Buffer: typeof Buffer, module: typeof module })`,
          );
          expect(globals, 'a sandboxed preload world has no Node globals').toEqual({
            require: 'undefined',
            process: 'undefined',
            Buffer: 'undefined',
            module: 'undefined',
          });
        }
      } finally {
        await session.detach().catch(() => undefined);
      }
    },
  );

  // PLT-008; issue #18 acceptance criterion 1: preload globals are not visible, except contextBridge APIs
  it(
    'PLT-008: the main world holds no global that a clean world lacks, except read-only, non-configurable contextBridge APIs',
    slow,
    async () => {
      const page = await mainWindow();
      const session = await page.context().newCDPSession(page);
      try {
        const tree = await session.send('Page.getFrameTree');
        const world = await session.send('Page.createIsolatedWorld', {
          frameId: tree.frameTree.frame.id,
          worldName: 'security-gate-clean-world',
        });
        const namesExpression = 'JSON.stringify(Object.getOwnPropertyNames(globalThis))';
        const clean = JSON.parse(
          await evaluateInContext<string>(session, world.executionContextId, namesExpression),
        ) as string[];
        const added = await evaluateInPage<
          Array<{ name: string; writable: boolean | null; configurable: boolean | null }>
        >(
          page,
          `((clean) => Object.getOwnPropertyNames(globalThis)
          .filter((name) => !clean.includes(name))
          .map((name) => {
            const descriptor = Object.getOwnPropertyDescriptor(globalThis, name) || {};
            return {
              name,
              writable: 'writable' in descriptor ? descriptor.writable : null,
              configurable: descriptor.configurable ?? null,
            };
          }))(${JSON.stringify(clean)})`,
        );
        expect(clean.length, 'control: the clean world must list the standard globals').toBeGreaterThan(100);
        const notBridged = added.filter((entry) => entry.writable !== false || entry.configurable !== false);
        expect(notBridged, `globals added to the main world: ${JSON.stringify(added)}`).toEqual([]);
      } finally {
        await session.detach().catch(() => undefined);
      }
    },
  );

  // PLT-008; issue #18 acceptance criterion 1 (sandbox per process)
  it('PLT-008: no renderer process of the app runs with --no-sandbox', slow, async () => {
    await mainWindow();
    expect(unsandboxedRendererProcesses()).toEqual([]);
  });
});

describe('security baseline: window.open', () => {
  // PLT-008; issue #18 acceptance criterion 2
  it(
    `PLT-008: window.open("${allowedChildUrl}") opens a child window whose main world has no Node globals`,
    slow,
    async () => {
      const child = await openChildWindow(await mainWindow(), allowedChildUrl);
      try {
        expect(child.url()).toBe(allowedChildUrl);
        expect(await readNodeGlobals(child)).toEqual(noNodeGlobals);
        expect(unsandboxedRendererProcesses(), 'the child window must run sandboxed').toEqual([]);
      } finally {
        await child.close().catch(() => undefined);
      }
    },
  );

  // PLT-008; issue #18 acceptance criterion 2: the handler forces the baseline, whatever the request asks for
  it(
    'PLT-008: a window.open request for nodeIntegration, no contextIsolation and no sandbox still gets a child with no Node and the sandbox',
    slow,
    async () => {
      const child = await openChildWindow(
        await mainWindow(),
        allowedChildUrl,
        'nodeIntegration=yes,contextIsolation=no,sandbox=no,nodeIntegrationInSubFrames=yes,webSecurity=no',
      );
      try {
        expect(await readNodeGlobals(child)).toEqual(noNodeGlobals);
        expect(unsandboxedRendererProcesses(), 'the child window must run sandboxed').toEqual([]);
      } finally {
        await child.close().catch(() => undefined);
      }
    },
  );

  const deniedUrls: ReadonlyArray<[string, string]> = [
    ['an external https URL', 'https://example.invalid/'],
    ['a file URL', 'file:///'],
    ['the main window page itself', '{location.href}'],
    ['a data URL', 'data:text/html,<h1>denied</h1>'],
  ];

  // PLT-008; issue #18 acceptance criterion 2 (failure mode): any other URL is denied
  it.each(deniedUrls)(
    'PLT-008: window.open to %s is denied: it returns null and no window opens',
    slow,
    async (_label, url) => {
      const started = requireApp();
      const page = await mainWindow();
      const beforeWindows = started.windows();
      const before = beforeWindows.length;
      const urlExpression = url === '{location.href}' ? 'location.href' : JSON.stringify(url);
      const opened = await evaluateInPage<boolean>(page, `window.open(${urlExpression}, '_blank') !== null`);
      await new Promise((resolve) => setTimeout(resolve, deniedWindowWatchMs));
      const after = started.windows();
      try {
        expect(opened, 'window.open must return null for a denied URL').toBe(false);
        expect(
          after.map((window) => window.url()),
          'no window may open',
        ).toHaveLength(before);
      } finally {
        // Close only windows this test opened, never the main window.
        for (const window of after) {
          if (!beforeWindows.includes(window)) await window.close().catch(() => undefined);
        }
      }
    },
  );
});

describe('security baseline: Content-Security-Policy (packaged build)', () => {
  // PLT-008, PLT-012; issue #18 acceptance criterion 3; ADR 0004 decision 9 B
  it(
    'PLT-008: every app:// response of a main window reload carries a CSP with a strict script-src and a style-src that allows unsafe-inline',
    slow,
    async (context) => {
      if (!isPackaged()) {
        context.skip(devBuildCspSkipReason);
        return;
      }
      const page = await mainWindow();
      const session = await page.context().newCDPSession(page);
      const responses: Array<{ url: string; status: number; csp: string | undefined }> = [];
      session.on('Network.responseReceived', (event) => {
        if (!event.response.url.startsWith('app:')) return;
        const headers = Object.entries(event.response.headers);
        const csp = headers.find(([name]) => name.toLowerCase() === 'content-security-policy')?.[1];
        responses.push({ url: event.response.url, status: event.response.status, csp });
      });
      try {
        await session.send('Network.enable');
        await page.reload({ waitUntil: 'load' });
        await mainWindow();
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(
          responses.filter((response) => /\.html$/.test(new URL(response.url).pathname)),
          `control: the reload must load the page over app://; responses ${JSON.stringify(responses)}`,
        ).not.toEqual([]);
        expect(
          responses.filter((response) => /\.js$/.test(new URL(response.url).pathname)),
          `control: the reload must load a script over app://; responses ${JSON.stringify(responses)}`,
        ).not.toEqual([]);
        const problems = responses
          .map((response) => ({ ...response, problems: listFoundationCspProblems(response.csp) }))
          .filter((response) => response.problems.length > 0);
        expect(problems, 'every app:// response must carry a CSP that meets the foundation rules').toEqual([]);
      } finally {
        await session.detach().catch(() => undefined);
      }
    },
  );

  // PLT-008; issue #18 acceptance criterion 4 (failure mode: an injected inline script)
  it(
    'PLT-008: an inline <script> inserted into the main window DOM does not run and fires securitypolicyviolation for script-src',
    slow,
    async (context) => {
      if (!isPackaged()) {
        context.skip(devBuildCspSkipReason);
        return;
      }
      const result = await probeInlineScript(await mainWindow());
      expect(result.ran, 'the inline script must not run').toBe(false);
      expect(
        result.violations.filter((entry) => entry.startsWith('script-src')),
        `a script-src violation must fire; violations ${JSON.stringify(result.violations)}`,
      ).not.toEqual([]);
    },
  );

  // PLT-008; issue #18 acceptance criterion 4; ADR 0004 decision 9 B (react-aria injects inline styles)
  it(
    'PLT-008: an inline <style> inserted into the main window DOM applies, with no style-src violation',
    slow,
    async (context) => {
      if (!isPackaged()) {
        context.skip(devBuildCspSkipReason);
        return;
      }
      const result = await probeInlineStyle(await mainWindow());
      expect(result.violations, 'no style-src violation may fire').toEqual([]);
      expect(result.outlineColor, 'the inline style must apply').toBe('rgb(1, 2, 3)');
    },
  );

  // PLT-008; issue #18 acceptance criteria 2 and 4: the about:blank child inherits the policy
  it(
    `PLT-008: in a ${allowedChildUrl} child window an inline <script> does not run and an inline <style> applies`,
    slow,
    async (context) => {
      if (!isPackaged()) {
        context.skip(devBuildCspSkipReason);
        return;
      }
      const child = await openChildWindow(await mainWindow(), allowedChildUrl);
      try {
        const script = await probeInlineScript(child);
        expect(
          script.ran,
          `the inline script must not run in the child; violations ${JSON.stringify(script.violations)}`,
        ).toBe(false);
        const style = await probeInlineStyle(child);
        expect(style.outlineColor, 'the inline style must apply in the child').toBe('rgb(1, 2, 3)');
      } finally {
        await child.close().catch(() => undefined);
      }
    },
  );
});
