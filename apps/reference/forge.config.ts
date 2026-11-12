// Electron Forge config for the reference app (#15; PLT-005, PLT-007, PLT-008).
// - The Vite plugin builds main, preload and the main_window renderer into .vite/.
// - The fuses lock the packaged binary; GrantFileProtocolExtraPrivileges is off
//   because the renderer loads through app:// (ADR 0004 decision 1 A).
// - MakerZIP makes a zip on every platform; the postMake hook rewrites `\` to `/`
//   in its entry names (Windows), through the foundation step (ADR 0010).
// DEFERRED: PLT-011 (App Store builds; later phases)
// DEFERRED: PLT-007 (code signing and the dmg and pkg makers; later phases)
// DEFERRED: PLT-013 (native add-on copy hook; #29)
import { MakerZIP } from '@electron-forge/maker-zip';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { normalizeZipEntryNames } from '@foundation/foundation/build/zip-entry-names';

/** The part of a Forge make result this config reads. */
interface MadeArtifacts {
  readonly artifacts: readonly string[];
}

const forgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: 'reference',
  },
  makers: [new MakerZIP({}, ['darwin', 'linux', 'win32'])],
  hooks: {
    // Every zip `make` wrote gets `/` entry names on every platform (ADR 0010).
    postMake: async (_forgeConfig: unknown, makeResults: readonly MadeArtifacts[]): Promise<void> => {
      const zips = makeResults.flatMap((result) => result.artifacts).filter((path) => path.endsWith('.zip'));
      for (const zipPath of zips) await normalizeZipEntryNames(zipPath);
    },
  },
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/main.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    }),
  ],
};

export default forgeConfig;
