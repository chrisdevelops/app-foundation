// Test-only helper for the reference app gate tests (#46; TST-018; ADR 0013).
// Checks a reference app window that a gate launched in background mode
// (electron-app-process.ts sets FOUNDATION_TEST_BACKGROUND=1 by default):
// - through the DevTools protocol, on every platform: the page paints,
//   `Page.captureScreenshot` shows a colour the page painted, and CDP key
//   input reaches a focused input (tools/test-support/background-page-probes.ts);
// - on macOS, from outside the app: no window on screen and no Dock icon
//   (tools/test-support/macos-window-probe.ts).
import {
  animationFramesPerSecondExpression,
  focusKeyProbeInputExpression,
  keyProbeText,
  listScreenshotProbeProblems,
  minimumAnimationFramesPerSecond,
  paintScreenshotOverlayExpression,
  readKeyProbeValueExpression,
  removeScreenshotOverlayExpression,
} from '../../test-support/background-page-probes';
import { dockApplicationType, readMacosAppPresence } from '../../test-support/macos-window-probe';
import type { DevToolsSession } from './devtools-protocol-client';

/** Problems with painting, screenshots and key input in the page of `session`; empty when all work. */
export async function listBackgroundPageProblems(session: DevToolsSession): Promise<string[]> {
  const problems: string[] = [];
  await session.waitForValue('document.readyState === "complete"', 30_000);

  const frames = await session.evaluate<number>(animationFramesPerSecondExpression);
  if (!(frames >= minimumAnimationFramesPerSecond)) {
    problems.push(
      `the page painted ${frames} animation frames in one second (at least ${minimumAnimationFramesPerSecond} expected)`,
    );
  }

  await session.evaluate(paintScreenshotOverlayExpression);
  try {
    const shot = await session.send('Page.captureScreenshot', { format: 'png' }, 30_000);
    const data = typeof shot.data === 'string' ? Buffer.from(shot.data, 'base64') : Buffer.alloc(0);
    problems.push(...listScreenshotProbeProblems(data));
  } catch (error) {
    problems.push(`Page.captureScreenshot failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await session.evaluate(removeScreenshotOverlayExpression).catch(() => undefined);
  }

  const focused = await session.evaluate<boolean>(focusKeyProbeInputExpression);
  if (!focused) problems.push('the key probe input could not take focus in the page');
  for (const character of keyProbeText) {
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: character, text: character });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
  }
  const typed = await session.evaluate<string | null>(readKeyProbeValueExpression);
  if (typed !== keyProbeText) {
    problems.push(
      `CDP key input typed ${JSON.stringify(keyProbeText)}, the focused input holds ${JSON.stringify(typed)}`,
    );
  }
  return problems;
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
