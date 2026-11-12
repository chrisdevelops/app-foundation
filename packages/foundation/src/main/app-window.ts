// The foundation's window factory (#15; PLT-008). Every app window is created
// here, so each one gets the same locked web preferences: context isolation,
// the Chromium sandbox and no Node integration in the renderer.
// DEFERRED: PLT-012 (gate tests for contextIsolation and sandbox, CSP and the packaged CDP guard; #18)
import { BrowserWindow } from 'electron';

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

/** Creates a window with the foundation's web preferences and loads `url` in it. */
export async function createAppWindow(options: CreateAppWindowOptions): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    title: options.title,
    width: options.width ?? defaultAppWindowWidth,
    height: options.height ?? defaultAppWindowHeight,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  await window.loadURL(options.url);
  return window;
}
