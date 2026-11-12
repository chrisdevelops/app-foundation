// Vitest global setup for the end-to-end package (#16).
// Electron 45.3.0 has no install script: its binary downloads on first use
// (pnpm-workspace.yaml, allowBuilds). After a fresh `pnpm install` nothing has
// used it yet, but the dev target starts it and the gate fixtures copy it.
// Loading the reference app's `electron` package from Node returns the binary
// path and downloads the binary first when it is missing.
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export default function ensureElectronBinary(): void {
  const referenceAppManifest = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'apps',
    'reference',
    'package.json',
  );
  const electronPath: unknown = createRequire(referenceAppManifest)('electron');
  if (typeof electronPath !== 'string') {
    throw new Error(`the electron package of apps/reference gave no binary path (got ${typeof electronPath})`);
  }
}
