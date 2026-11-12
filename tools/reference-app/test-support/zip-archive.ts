// Test-only helper for the reference app gate tests (#15; PLT-007).
// Lists the entries of a zip file from its central directory, with Node
// built-ins only, so the gate can check what `electron-forge make` produced.
import { closeSync, openSync, readSync, statSync } from 'node:fs';

const endOfCentralDirectorySignature = 0x06054b50;
const centralDirectoryEntrySignature = 0x02014b50;

/** Entry names in the zip, as stored (`/`-separated). Throws when the file is not a zip. */
export function listZipEntries(zipPath: string): string[] {
  const size = statSync(zipPath).size;
  const tailLength = Math.min(size, 22 + 65_535);
  const tail = Buffer.alloc(tailLength);
  const fd = openSync(zipPath, 'r');
  try {
    readSync(fd, tail, 0, tailLength, size - tailLength);
    let eocd = -1;
    for (let index = tailLength - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === endOfCentralDirectorySignature) {
        eocd = index;
        break;
      }
    }
    if (eocd === -1) throw new Error(`${zipPath} has no zip end-of-central-directory record`);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    const directory = Buffer.alloc(directorySize);
    readSync(fd, directory, 0, directorySize, directoryOffset);
    const names: string[] = [];
    let cursor = 0;
    while (cursor + 46 <= directory.length && directory.readUInt32LE(cursor) === centralDirectoryEntrySignature) {
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      names.push(directory.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'));
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return names;
  } finally {
    closeSync(fd);
  }
}
