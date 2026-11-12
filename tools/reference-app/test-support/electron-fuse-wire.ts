// Test-only helper for the reference app gate tests (#15; PLT-008).
// Reads the Electron fuse wire straight from a packaged binary, without
// @electron/fuses, so the gate does not trust the library that wrote the fuses.
//
// Format (Electron fuses, V1): the ASCII sentinel below, then one version byte
// (1 for V1), one length byte, then one byte per fuse in a fixed order. '0' (0x30) is
// disabled, '1' (0x31) is enabled, 'r' (0x72) is removed.
import { closeSync, openSync, readSync, statSync } from 'node:fs';

export const electronFuseSentinel = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';

/** Fuse names in wire order (Electron fuses V1). */
export const electronFuseV1Names = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
  'WasmTrapHandlers',
] as const;

export type ElectronFuseName = (typeof electronFuseV1Names)[number];
export type ElectronFuseState = 'enabled' | 'disabled' | 'removed' | 'missing' | `unknown(0x${string})`;

export interface ElectronFuseWire {
  /** Byte offset of the sentinel in the file. */
  readonly offset: number;
  /** Fuse wire version byte (1 for V1). */
  readonly version: number;
  readonly fuses: Readonly<Record<ElectronFuseName, ElectronFuseState>>;
}

function decodeFuseByte(byte: number | undefined): ElectronFuseState {
  if (byte === undefined) return 'missing';
  if (byte === 0x30) return 'disabled';
  if (byte === 0x31) return 'enabled';
  if (byte === 0x72) return 'removed';
  return `unknown(0x${byte.toString(16)})`;
}

/** Every fuse wire in the file (two in a universal macOS binary). Throws when there is none. */
export function readElectronFuseWires(binaryPath: string): ElectronFuseWire[] {
  const sentinel = Buffer.from(electronFuseSentinel, 'ascii');
  const size = statSync(binaryPath).size;
  const chunkSize = 8 * 1024 * 1024;
  const overlap = sentinel.length + 2 + 255;
  const buffer = Buffer.alloc(chunkSize + overlap);
  const wires: ElectronFuseWire[] = [];
  const fd = openSync(binaryPath, 'r');
  try {
    for (let start = 0; start < size; start += chunkSize) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
      const view = buffer.subarray(0, bytesRead);
      let index = view.indexOf(sentinel);
      while (index !== -1) {
        const offset = start + index;
        // A match inside the overlap is found again by the next chunk.
        if (index < chunkSize && !wires.some((wire) => wire.offset === offset)) {
          const wireStart = index + sentinel.length;
          const version = view[wireStart] ?? 0;
          const length = view[wireStart + 1] ?? 0;
          const fuses = Object.fromEntries(
            electronFuseV1Names.map((name, position) => [
              name,
              position < length ? decodeFuseByte(view[wireStart + 2 + position]) : 'missing',
            ]),
          ) as Record<ElectronFuseName, ElectronFuseState>;
          wires.push({ offset, version, fuses });
        }
        index = view.indexOf(sentinel, index + 1);
      }
    }
  } finally {
    closeSync(fd);
  }
  if (wires.length === 0) {
    throw new Error(`${binaryPath} holds no Electron fuse sentinel, so it is not an Electron binary with fuses`);
  }
  return wires;
}
