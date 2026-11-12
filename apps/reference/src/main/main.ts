// Main process of the reference app (#15, #18, #46; PLT-005, PLT-008, TST-009,
// TST-018). The debugging-switch guard, the background test mode, the protocol
// handler and the window factory are foundation systems; this file only wires
// them up.
import { join } from 'node:path';
import { app } from 'electron';
import {
  appProtocolUrl,
  handleAppProtocol,
  registerAppProtocolScheme,
} from '@foundation/foundation/main/app-protocol-registration';
import { createAppWindow } from '@foundation/foundation/main/app-window';
import { enforcePackagedCdpGuard } from '@foundation/foundation/main/packaged-cdp-guard';
import { applyTestBackgroundMode } from '@foundation/foundation/main/test-background-mode';

// First, before `ready`: a packaged build refuses the DevTools port unless its
// environment enables it, and never starts a Node debugger (#18; TST-009).
enforcePackagedCdpGuard();

// Before `ready`: with FOUNDATION_TEST_BACKGROUND=1 (test runs) the app gets no
// Dock icon on macOS and its windows are never focused; they are never shown on
// macOS and shown without focus on Linux and Windows (#46; TST-018).
applyTestBackgroundMode();

/** The app:// host of the reference app (`rf`, ADR 0006 item 4). */
const referenceAppProtocolHost = 'rf';

// Privileged schemes must be registered before `ready`.
registerAppProtocolScheme();

async function openMainWindow(): Promise<void> {
  // main.cjs is in .vite/build; the renderers are in .vite/renderer/<name>.
  const rendererDir = join(__dirname, '..', 'renderer');
  handleAppProtocol({ host: referenceAppProtocolHost, rendererDir });
  await createAppWindow({
    title: 'Reference',
    preloadPath: join(__dirname, 'preload.cjs'),
    url:
      MAIN_WINDOW_VITE_DEV_SERVER_URL ??
      appProtocolUrl(referenceAppProtocolHost, `${MAIN_WINDOW_VITE_NAME}/index.html`),
  });
}

app.on('window-all-closed', () => app.quit());

app
  .whenReady()
  .then(openMainWindow)
  .catch((error: unknown) => {
    console.error('The reference app could not open its main window:', error);
    app.exit(1);
  });
