// Test-only helper for the reference app gate tests (#15; PLT-007, PLT-008).
// Reads an Electron asar archive with Node built-ins only, so the gate sees
// what the package holds without @electron/asar.
//
// Format: UInt32LE 4, UInt32LE header pickle size, then the header pickle
// (UInt32LE payload size, UInt32LE JSON length, JSON). File data starts after
// the header pickle; each file entry gives its offset from there.
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';

interface AsarFileEntry {
  readonly offset?: string;
  readonly size?: number;
  readonly unpacked?: boolean;
  readonly link?: string;
}

interface AsarDirectoryEntry {
  readonly files: Record<string, AsarEntry>;
}

type AsarEntry = AsarFileEntry | AsarDirectoryEntry;

interface AsarHeader {
  readonly root: AsarDirectoryEntry;
  readonly dataOffset: number;
}

function readAsarHeader(asarPath: string): AsarHeader {
  const fd = openSync(asarPath, 'r');
  try {
    const sizeBuffer = Buffer.alloc(8);
    readSync(fd, sizeBuffer, 0, 8, 0);
    const headerPickleSize = sizeBuffer.readUInt32LE(4);
    const headerBuffer = Buffer.alloc(headerPickleSize);
    readSync(fd, headerBuffer, 0, headerPickleSize, 8);
    const jsonLength = headerBuffer.readUInt32LE(4);
    const json = headerBuffer.subarray(8, 8 + jsonLength).toString('utf8');
    return { root: JSON.parse(json) as AsarDirectoryEntry, dataOffset: 8 + headerPickleSize };
  } finally {
    closeSync(fd);
  }
}

function isDirectory(entry: AsarEntry): entry is AsarDirectoryEntry {
  return 'files' in entry;
}

/** Every file path in the archive, `/`-separated with a leading `/`, sorted. Directories are not listed. */
export function listAsarFiles(asarPath: string): string[] {
  const { root } = readAsarHeader(asarPath);
  const paths: string[] = [];
  const walk = (directory: AsarDirectoryEntry, prefix: string): void => {
    for (const [name, entry] of Object.entries(directory.files)) {
      const path = `${prefix}/${name}`;
      if (isDirectory(entry)) walk(entry, path);
      else paths.push(path);
    }
  };
  walk(root, '');
  return paths.sort();
}

/** The bytes of one file in the archive (or in `app.asar.unpacked` beside it). Throws when it is absent. */
export function readAsarFile(asarPath: string, filePath: string): Buffer {
  const { root, dataOffset } = readAsarHeader(asarPath);
  const segments = filePath.split('/').filter((segment) => segment !== '');
  let entry: AsarEntry = root;
  for (const segment of segments) {
    if (!isDirectory(entry) || !(segment in entry.files)) {
      throw new Error(`${filePath} is not in ${asarPath}`);
    }
    entry = entry.files[segment] as AsarEntry;
  }
  if (isDirectory(entry)) throw new Error(`${filePath} is a directory in ${asarPath}`);
  if (entry.unpacked) return readFileSync(join(`${asarPath}.unpacked`, ...segments));
  const size = entry.size ?? 0;
  const buffer = Buffer.alloc(size);
  const fd = openSync(asarPath, 'r');
  try {
    readSync(fd, buffer, 0, size, dataOffset + Number(entry.offset ?? '0'));
  } finally {
    closeSync(fd);
  }
  return buffer;
}
