// Test-only helper for the reference app gate tests (#15). Names the
// reference app's folder and the versions the phase 0 spikes proved.

/** Folder of the reference app, relative to the repository root (ADR 0006 item 4). */
export const referenceAppRelativeDir = 'apps/reference';

/**
 * The lowest version of each package the spikes proved (spike #6: Electron,
 * Forge, the Vite plugin, Vite; spike #8: React). The reference app pins each
 * exactly, at this version or newer (issue #15, ADR 0004 decision 10).
 */
export const referenceAppSpikeMinimumVersions: Readonly<Record<string, string>> = {
  electron: '45.3.0',
  '@electron-forge/cli': '8.0.1',
  '@electron-forge/plugin-vite': '8.0.1',
  vite: '8.3.8',
  react: '19.3.1',
  'react-dom': '19.3.1',
};

/** The version spec of a package in dependencies or devDependencies. */
export function readReferenceAppDependencySpec(
  manifest: Record<string, unknown>,
  packageName: string,
): string | undefined {
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const spec = ((manifest[field] ?? {}) as Record<string, string>)[packageName];
    if (spec !== undefined) return spec;
  }
  return undefined;
}

/** The dev command: the `dev` script, else the `start` script, when it runs `electron-forge start`. */
export function findReferenceAppDevScript(scripts: Record<string, string>): string | undefined {
  for (const name of ['dev', 'start']) {
    const script = scripts[name];
    if (script !== undefined && /(^|\s)electron-forge\s+start(\s|$)/.test(script)) return name;
  }
  return undefined;
}
