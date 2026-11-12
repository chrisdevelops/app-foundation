// The foundation's window factory (#15, #18; PLT-008). Every app window is
// created here, so each one gets the same locked web preferences: context
// isolation, the Chromium sandbox and no Node integration in the renderer.
//
// `window.open` (#18; PLT-008; CMP-009, spike #8): only `about:blank` opens a
// child window (child windows are React portal targets). The child gets the
// same locked web preferences, whatever its features string asks for, and its
// own `window.open` follows the same rule. Every other URL is denied,
// including the app's own `app://` pages: `window.open` returns null.
//
// Background test mode (#46; TST-018; ADR 0013 rule 1): when
// FOUNDATION_TEST_BACKGROUND=1 (test-background-mode.ts), every window and
// every `window.open` child is created hidden and is never shown or focused.
// Hidden windows still paint, so screenshots and CDP input keep working.
import { BrowserWindow, type WebContents, type WebPreferences } from 'electron';
import { isTestBackgroundModeEnabled } from './test-background-mode';

export interface CreateAppWindowOptions {
  /** URL to load: the Vite dev server in development, `app://<host>/...` in packaged builds. */
  readonly url: string;
  /** Absolute path of the built preload script (`preload.cjs`). */
  readonly preloadPath: string;
  readonly title: string;
  readonly width?: number;
  readonly height?: number;
}

const defaultAppWindowWidth = 1024;
const defaultAppWindowHeight = 768;

/** The one URL `window.open` may open. */
const appChildWindowUrl = 'about:blank';

/** Web preferences every app window and child window gets; nothing may weaken them. */
const appWindowLockedWebPreferences = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  webSecurity: true,
} as const satisfies WebPreferences;

/** Lets `contents` open only `about:blank` child windows, with the locked web preferences, also in its children. */
function applyAppWindowOpenPolicy(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (url !== appChildWindowUrl) return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        ...(isTestBackgroundModeEnabled() ? { show: false } : {}),
        webPreferences: { ...appWindowLockedWebPreferences },
      },
    };
  });
  contents.on('did-create-window', (child) => {
    if (isTestBackgroundModeEnabled() && process.platform !== 'darwin') child.showInactive();
    applyAppWindowOpenPolicy(child.webContents);
  });
}

/** Creates a window with the foundation's web preferences and loads `url` in it. */
export async function createAppWindow(options: CreateAppWindowOptions): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    title: options.title,
    width: options.width ?? defaultAppWindowWidth,
    height: options.height ?? defaultAppWindowHeight,
    // Background test mode: never shown, so never focused (ADR 0013 rule 1).
    ...(isTestBackgroundModeEnabled() ? { show: false } : {}),
    webPreferences: {
      ...appWindowLockedWebPreferences,
      preload: options.preloadPath,
    },
  });
  applyAppWindowOpenPolicy(window.webContents);
  if (isTestBackgroundModeEnabled() && process.platform !== 'darwin') window.showInactive();
  await window.loadURL(options.url);
  return window;
}
