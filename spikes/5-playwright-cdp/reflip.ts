import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses'

// usage: reflip.ts <Spike5.app> <on|off>
async function main() {
  await flipFuses(process.argv[2]!, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: process.argv[3] === 'on',
  })
}
main().catch((e) => { console.error(e); process.exit(1) })
