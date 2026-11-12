import { FuseV1Options, FuseVersion } from '@electron/fuses'
import { FusesPlugin } from '@electron-forge/plugin-fuses'
import { VitePlugin } from '@electron-forge/plugin-vite'
import { MakerZIP } from '@electron-forge/maker-zip'
import type { ForgeConfig } from '@electron-forge/shared-types'

import { chmod, rm } from 'node:fs/promises'
import path from 'node:path'
import { copyNativeModules } from './copy-native-modules'

const NATIVE_MODULES = ['better-sqlite3', 'sharp', 'node-pty']

const config: ForgeConfig = {
  packagerConfig: {
    // Native binaries cannot be dlopen()ed from inside the asar. Unpack them (and node-pty's spawn-helper executable).
    asar: process.env.SPIKE_NO_UNPACK === '1' ? true : { unpack: '**/{*.node,*.dylib,spawn-helper}' },
    // The Vite plugin ignores everything except /.vite, so externalised packages must be copied in by hand.
    afterCopy: [
      async ({ buildPath }) => {
        if (process.env.SPIKE_NO_COPY === '1') return
        const names = await copyNativeModules(NATIVE_MODULES, __dirname, buildPath)
        console.log('copyNativeModules copied: ' + names.join(', '))
        {
          // node-pty 1.1.0 publishes prebuilds/*/spawn-helper with mode 0644; posix_spawnp then fails.
          for (const arch of ['darwin-arm64', 'darwin-x64']) await chmod(path.join(buildPath, 'node_modules/node-pty/prebuilds', arch, 'spawn-helper'), 0o755).catch(() => undefined)
          console.log('chmod 755 on prebuilt node-pty spawn-helper')
        }
        if (process.env.SPIKE_STRIP_BUILD === '1') {
          // Experiment: ship only the prebuilt N-API binaries, not the Forge/@electron/rebuild output.
          for (const d of ['node-pty/build', 'node-pty/bin', 'better-sqlite3/build']) await rm(path.join(buildPath, 'node_modules', d), { recursive: true, force: true })
          console.log('SPIKE_STRIP_BUILD: removed rebuilt output from the package')
        }
      },
    ],
  },
  makers: [new MakerZIP({}, ['darwin'])],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
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
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
    }),
  ],
}

export default config
