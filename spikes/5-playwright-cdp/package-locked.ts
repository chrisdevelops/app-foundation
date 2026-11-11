import { packager } from '@electron/packager'
import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses'
import path from 'node:path'

async function main() {
  const out = process.argv[2]!
  const [appPath] = await packager({
    dir: path.join(__dirname, 'app'),
    out,
    overwrite: true,
    platform: 'darwin',
    arch: 'arm64',
    asar: true,
    prune: false,
    name: 'Spike5',
  })
  const bin = path.join(appPath!, 'Spike5.app')
  await flipFuses(bin, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  })
  console.log('packaged', bin)
}
main().catch((e) => { console.error(e); process.exit(1) })
