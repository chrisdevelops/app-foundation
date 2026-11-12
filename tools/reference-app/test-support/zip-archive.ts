// Test-only helper for the reference app gate tests (#15; PLT-007).
// Lists the entries of a zip file from its central directory, with Node
// built-ins only, so the gate can check what `electron-forge make` produced.
import { closeSync, openSync, readSync, statSync } from 'node:fs';

const endOfCentralDirectorySignature = 0x06054b50;
const centralDirectoryEntrySignature = 0x02014b50;
const zip64EndOfCentralDirectoryLocatorSignature = 0x07064b50;
const zip64EndOfCentralDirectorySignature = 0x06064b50;

/**
 * Entry names in the zip, exactly as stored (APPNOTE 4.4.17 requires `/`;
 * a backslash is reported as is, not converted). Names are read as UTF-8,
 * which equals CP437 for ASCII names. Data descriptors (flag bit 3) change
 * only local headers, and this reader uses the central directory only.
 * Throws when the file is not a zip.
 */
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
    let directorySize = tail.readUInt32LE(eocd + 12);
    let directoryOffset = tail.readUInt32LE(eocd + 16);
    // Zip64 (APPNOTE 4.3.14 to 4.3.15): a field set to all ones means the real
    // value is in the Zip64 end record, which the locator just before the
    // end record points to. Without this, a Zip64 archive is mis-read.
    const entryCount = tail.readUInt16LE(eocd + 10);
    if (directorySize === 0xffffffff || directoryOffset === 0xffffffff || entryCount === 0xffff) {
      const locator = eocd - 20;
      if (locator < 0 || tail.readUInt32LE(locator) !== zip64EndOfCentralDirectoryLocatorSignature) {
        throw new Error(`${zipPath} marks Zip64 fields but has no Zip64 end-of-central-directory locator`);
      }
      const recordOffset = Number(tail.readBigUInt64LE(locator + 8));
      const record = Buffer.alloc(56);
      readSync(fd, record, 0, 56, recordOffset);
      if (record.readUInt32LE(0) !== zip64EndOfCentralDirectorySignature) {
        throw new Error(`${zipPath} has no Zip64 end-of-central-directory record at offset ${recordOffset}`);
      }
      directorySize = Number(record.readBigUInt64LE(40));
      directoryOffset = Number(record.readBigUInt64LE(48));
    }
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
