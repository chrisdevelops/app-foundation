// Test-only helper for the reference app gate tests (#15; PLT-007, PLT-008).
// Finds the parts of a packaged Electron app on the current platform: the
// executable to start, the binary that holds the fuse wire, and app.asar.
import { cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface PackagedAppLayout {
  /** Folder that `electron-forge package` wrote, for example `out/Name-darwin-arm64`. */
  readonly rootDir: string;
  /** The file to start. */
  readonly executablePath: string;
  /** The file that holds the fuse wire (the framework binary on macOS). */
  readonly fuseBinaryPath: string;
  /** The `resources` folder that holds app.asar. */
  readonly resourcesDir: string;
  readonly asarPath: string;
}

/** Files Electron ships beside the app executable on Linux and Windows; never the app itself. */
const electronHelperFileNames = new Set([
  'chrome-sandbox',
  'chrome_crashpad_handler',
  'chrome_crashpad_handler.exe',
  'crashpad_handler.exe',
  'squirrel.exe',
]);

/** The one folder `electron-forge package` writes for this platform and arch under `outDir`. */
export function findPackagedAppDir(outDir: string, platform = process.platform, arch = process.arch): string {
  if (!existsSync(outDir)) throw new Error(`${outDir} does not exist: electron-forge package wrote nothing`);
  const suffix = `-${platform}-${arch}`;
  const matches = readdirSync(outDir).filter(
    (entry) => entry.endsWith(suffix) && statSync(join(outDir, entry)).isDirectory(),
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected one packaged app folder ending in "${suffix}" in ${outDir}, found ${JSON.stringify(readdirSync(outDir))}`,
    );
  }
  return join(outDir, matches[0] as string);
}

/** Reads the layout of a packaged app folder for the current platform. Throws with what it found. */
export function readPackagedAppLayout(rootDir: string, platform = process.platform): PackagedAppLayout {
  const entries = readdirSync(rootDir);
  if (platform === 'darwin') {
    const bundles = entries.filter((entry) => entry.endsWith('.app'));
    if (bundles.length !== 1)
      throw new Error(`expected one .app bundle in ${rootDir}, found ${JSON.stringify(entries)}`);
    const bundle = join(rootDir, bundles[0] as string);
    const macOsDir = join(bundle, 'Contents', 'MacOS');
    const executables = readdirSync(macOsDir);
    if (executables.length !== 1) {
      throw new Error(`expected one executable in ${macOsDir}, found ${JSON.stringify(executables)}`);
    }
    const resourcesDir = join(bundle, 'Contents', 'Resources');
    return {
      rootDir,
      executablePath: join(macOsDir, executables[0] as string),
      fuseBinaryPath: join(bundle, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework'),
      resourcesDir,
      asarPath: join(resourcesDir, 'app.asar'),
    };
  }
  const candidates = entries.filter((entry) => {
    if (electronHelperFileNames.has(entry.toLowerCase())) return false;
    const path = join(rootDir, entry);
    const stats = statSync(path);
    if (!stats.isFile()) return false;
    if (platform === 'win32') return entry.toLowerCase().endsWith('.exe');
    // Linux: an executable file with no extension (libraries end in .so or .so.N).
    return (stats.mode & 0o111) !== 0 && !entry.includes('.');
  });
  if (candidates.length !== 1) {
    throw new Error(
      `expected one app executable in ${rootDir}, found ${JSON.stringify(candidates)} among ${JSON.stringify(entries)}`,
    );
  }
  const executablePath = join(rootDir, candidates[0] as string);
  const resourcesDir = join(rootDir, 'resources');
  return {
    rootDir,
    executablePath,
    fuseBinaryPath: executablePath,
    resourcesDir,
    asarPath: join(resourcesDir, 'app.asar'),
  };
}

/** Copies a packaged app folder, keeping symlinks as they are (macOS frameworks rely on them). */
export function copyPackagedAppDir(sourceDir: string, targetDir: string): void {
  cpSync(sourceDir, targetDir, { recursive: true, verbatimSymlinks: true });
}
