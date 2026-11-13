// Test-only helper for the reference app gate tests (#46; TST-018; ADR 0013
// rule 1 and amendment 1). Checks a reference app window that a gate launched
// in background mode (electron-app-process.ts sets FOUNDATION_TEST_BACKGROUND=1
// by default):
// - through the DevTools protocol, on every platform: the page paints,
//   `Page.captureScreenshot` shows a colour the page painted, and CDP key
//   input reaches a focused input (tools/test-support/background-page-probes.ts);
// - through the DevTools protocol, on every platform: the window never has OS
//   focus (`document.hasFocus()` stays false and no `focus` event fires; this
//   client never turns on CDP focus emulation);
// - on macOS, from outside the app: no window on screen and no Dock icon
//   (tools/test-support/macos-window-probe.ts).
// Every CDP call has its own time limit; after a call gets no answer the
// remaining steps do not run (the page no longer answers), so a hang fails in
// seconds with the step that hung.
import {
  backgroundProbeStepTimeoutMs,
  focusKeyProbeInputExpression,
  focusProbeWatchMs,
  keyProbeText,
  listDocumentFocusProblems,
  listPaintProbeProblems,
  listScreenshotProbeProblems,
  paintProbeExpression,
  paintScreenshotOverlayExpression,
  readKeyProbeValueExpression,
  removeScreenshotOverlayExpression,
  watchDocumentFocusExpression,
  watchPaintAfterStallExpression,
  withBackgroundProbeTimeout,
  type DocumentFocusWatch,
  type PaintProbeResult,
  type PaintStallWatch,
  type ScreenshotOverlayResult,
} from '../../test-support/background-page-probes';
import { dockApplicationType, readMacosAppPresence } from '../../test-support/macos-window-probe';
import type { DevToolsSession } from './devtools-protocol-client';

/** One CDP call of a probe, with the probe time limit on the session and around it. */
function probeSend(session: DevToolsSession, method: string, params: Record<string, unknown> = {}) {
  return withBackgroundProbeTimeout(
    `DevTools ${method}`,
    session.send(method, params, backgroundProbeStepTimeoutMs + 1_000),
  );
}

/** `Runtime.evaluate` of `expression` with the probe time limit; throws on a page exception. */
async function probeEvaluate<T>(session: DevToolsSession, label: string, expression: string): Promise<T> {
  return withBackgroundProbeTimeout(`DevTools Runtime.evaluate (${label})`, session.evaluate<T>(expression));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Problems with painting, screenshots and key input in the page of `session`; empty when all work. */
export async function listBackgroundPageProblems(session: DevToolsSession): Promise<string[]> {
  const problems: string[] = [];
  // Diagnostics (#46 reviewer attempt 2, finding 1): each step and how long it took, so a failure
  // tells a page Chromium treats as hidden from a stalled renderer. They never change the verdict.
  const probeStart = Date.now();
  const steps: string[] = [];
  let lastStepAt = probeStart;
  const noteStep = (name: string, detail = '') => {
    const now = Date.now();
    steps.push(`${name} ${now - lastStepAt} ms (at ${now - probeStart} ms)${detail === '' ? '' : `: ${detail}`}`);
    lastStepAt = now;
  };
  // Page loads during the probe (a dev page that Vite or Forge reloads, for example), with their time.
  const pageEvents: string[] = [];
  const offPageEvents = ['Page.frameStartedLoading', 'Page.frameNavigated', 'Page.loadEventFired'].map((method) =>
    session.on(method, (params) => {
      const frame = (params.frame ?? {}) as { parentId?: string; url?: string };
      if (frame.parentId) return;
      pageEvents.push(`${method} at ${Date.now() - probeStart} ms${frame.url ? ` (${frame.url})` : ''}`);
    }),
  );
  const addDiagnostics = () => {
    // Electron answers no Browser.getWindowForTarget ("wasn't found"), and the main process (BrowserWindow
    // isVisible) is not reachable over this port, so the page's own view is all the probe can report.
    problems.push(
      `diagnostics: steps [${steps.join('; ')}]; page events during the probe ${JSON.stringify(pageEvents)}`,
    );
  };
  try {
    await probeSend(session, 'Page.enable').catch((error: unknown) => {
      pageEvents.push(`Page.enable failed: ${describeError(error)}`);
    });
    await session.waitForValue('document.readyState === "complete"', 30_000);
    noteStep('readyState complete');

    const paint = await probeEvaluate<PaintProbeResult>(session, 'paint probe', paintProbeExpression);
    noteStep('paint probe', `${paint?.frames} frames`);
    const paintProblems = listPaintProbeProblems(paint);
    problems.push(...paintProblems);
    if (paintProblems.length > 0) {
      const watch = await probeEvaluate<PaintStallWatch>(
        session,
        'paint stall watch (diagnostics only)',
        watchPaintAfterStallExpression,
      ).catch((error: unknown) => describeError(error));
      noteStep('paint stall watch (diagnostics only)', JSON.stringify(watch));
    }

    const overlay = await probeEvaluate<ScreenshotOverlayResult>(
      session,
      'screenshot overlay',
      paintScreenshotOverlayExpression,
    );
    noteStep('screenshot overlay', JSON.stringify(overlay));
    try {
      const shot = await probeSend(session, 'Page.captureScreenshot', { format: 'png' });
      const data = typeof shot.data === 'string' ? Buffer.from(shot.data, 'base64') : Buffer.alloc(0);
      noteStep('Page.captureScreenshot', `${data.length} bytes`);
      problems.push(...listScreenshotProbeProblems(data));
    } catch (error) {
      noteStep('Page.captureScreenshot', 'failed');
      problems.push(`Page.captureScreenshot failed: ${describeError(error)}`);
      for (const off of offPageEvents) off();
      addDiagnostics();
      return problems;
    }
    await probeEvaluate(session, 'remove screenshot overlay', removeScreenshotOverlayExpression);

    const focused = await probeEvaluate<boolean>(session, 'focus key probe input', focusKeyProbeInputExpression);
    if (!focused) problems.push('the key probe input could not take focus in the page');
    for (const character of keyProbeText) {
      await probeSend(session, 'Input.dispatchKeyEvent', { type: 'keyDown', key: character, text: character });
      await probeSend(session, 'Input.dispatchKeyEvent', { type: 'keyUp', key: character });
    }
    const typed = await probeEvaluate<string | null>(session, 'read key probe value', readKeyProbeValueExpression);
    noteStep('key input');
    if (typed !== keyProbeText) {
      problems.push(
        `CDP key input typed ${JSON.stringify(keyProbeText)}, the focused input holds ${JSON.stringify(typed)}`,
      );
    }
  } catch (error) {
    noteStep('failed step');
    problems.push(`a background probe step failed: ${describeError(error)}`);
  }
  for (const off of offPageEvents) off();
  if (problems.length > 0) addDiagnostics();
  return problems;
}

/**
 * Problems with OS focus in the page of `session` (TST-018: never focused, on every platform);
 * empty when `document.hasFocus()` stayed false and no `focus` event fired for `focusProbeWatchMs`.
 * `session` must be a raw DevTools session without focus emulation.
 */
export async function listBackgroundFocusProblems(session: DevToolsSession): Promise<string[]> {
  try {
    await session.waitForValue('document.readyState === "complete"', 30_000);
    const watch = await withBackgroundProbeTimeout(
      'DevTools Runtime.evaluate (focus watch)',
      session.evaluate<DocumentFocusWatch>(watchDocumentFocusExpression),
      focusProbeWatchMs + backgroundProbeStepTimeoutMs,
    );
    return listDocumentFocusProblems(watch);
  } catch (error) {
    return [`the focus probe failed: ${describeError(error)}`];
  }
}

/** macOS: problems with what the app that uses `userDataDir` shows; empty when it shows no window and no Dock icon. */
export async function listMacosBackgroundProblems(userDataDir: string): Promise<string[]> {
  const presence = await readMacosAppPresence(userDataDir);
  const problems: string[] = [];
  if (presence.pids.length === 0) problems.push('control: no process runs with this user data folder');
  if (presence.onscreenWindows.length > 0) problems.push('a window of the app is on screen');
  if ([...presence.applicationTypes.values()].includes(dockApplicationType)) {
    problems.push(`a process of the app has a Dock icon (ApplicationType ${dockApplicationType}, not accessory)`);
  }
  return problems.length === 0 ? [] : [...problems, presence.describe()];
}
