// Main process of the reference app (#15; PLT-005, PLT-008). The protocol
// handler and the window factory are foundation systems; this file only
// wires them up.
import { join } from 'node:path';
import { app } from 'electron';
import {
  appProtocolUrl,
  handleAppProtocol,
  registerAppProtocolScheme,
} from '@foundation/foundation/main/app-protocol-registration';
import { createAppWindow } from '@foundation/foundation/main/app-window';

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
