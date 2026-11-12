// The foundation's zip entry name step (#15; PLT-007; ADR 0010).
// Forge's zip maker on Windows (cross-zip through Windows PowerShell 5.1)
// stores entry names with `\`; the ZIP format requires `/` (APPNOTE 4.4.17).
// Apps run this step from Forge's `postMake` hook on every zip `make` wrote.
//
// Input: the path of a zip file. Output: the same file with every `\` in every
// entry name changed to `/`, in the local headers and the central directory,
// and `{ entryCount, renamedEntryCount }`. Only name bytes change; a name keeps
// its length, so offsets, sizes, data and CRC-32 stay as they were. A zip with
// no `\` in its names is not written at all.
//
// Failure modes: a `ZipEntryNameError` with a `code` and the zip path in the
// message, and the file left byte-identical:
// - `not-a-zip`: no end of central directory record.
// - `invalid-zip`: a record, offset or length that does not fit the file.
// - `unsupported-zip`: a split (multi-disk) archive.
// - `encrypted-entry`: an entry with an encryption flag.
// - `entry-name-mismatch`: a local header name that differs from its central name.
// The result is written to a temporary file in the same folder, read back and
// checked, then renamed over the original; any failure removes the temporary file.
//
// Plain Node, built-ins only.
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export type ZipEntryNameErrorCode =
  'not-a-zip' | 'invalid-zip' | 'unsupported-zip' | 'encrypted-entry' | 'entry-name-mismatch';

/** A zip the step refuses to change. The file is left as it was. */
export class ZipEntryNameError extends Error {
  override readonly name = 'ZipEntryNameError';
  readonly code: ZipEntryNameErrorCode;
  readonly zipPath: string;

  constructor(code: ZipEntryNameErrorCode, zipPath: string, detail: string, options?: ErrorOptions) {
    super(`${zipPath}: ${code}: ${detail}`, options);
    this.code = code;
    this.zipPath = zipPath;
  }
}

export interface NormalizedZipEntryNames {
  /** Entries in the central directory. */
  readonly entryCount: number;
  /** Entries whose name held at least one `\`. */
  readonly renamedEntryCount: number;
}

// APPNOTE.TXT 6.3.10: local header 4.3.7, central directory header 4.3.12,
// end of central directory record 4.3.16, Zip64 end record 4.3.14, locator 4.3.15.
const localHeaderSignature = 0x04034b50;
const centralHeaderSignature = 0x02014b50;
const endSignature = 0x06054b50;
const zip64EndSignature = 0x06064b50;
const zip64LocatorSignature = 0x07064b50;
const localHeaderLength = 30;
const centralHeaderLength = 46;
const endLength = 22;
const zip64EndMinimumLength = 56;
const zip64LocatorLength = 20;
const zip64ExtraFieldId = 0x0001;
const maxCommentLength = 0xffff;
// General purpose flags: bit 0 encrypted, bit 6 strong encryption, bit 13 encrypted central directory.
const encryptionFlags = 0x0001 | 0x0040 | 0x2000;
const backslash = 0x5c;
const slash = 0x2f;

/** Byte ranges of one entry's name in the local header and the central directory. */
interface ZipEntryNameRanges {
  readonly centralNameStart: number;
  readonly localNameStart: number;
  readonly nameLength: number;
}

type Refuse = (code: ZipEntryNameErrorCode, detail: string) => never;

function readUInt32(zip: Buffer, offset: number, refuse: Refuse, what: string): number {
  if (offset < 0 || offset + 4 > zip.length) refuse('invalid-zip', `${what} at ${offset} is outside the file`);
  return zip.readUInt32LE(offset);
}

function readUInt64(zip: Buffer, offset: number, refuse: Refuse, what: string): number {
  if (offset < 0 || offset + 8 > zip.length) refuse('invalid-zip', `${what} at ${offset} is outside the file`);
  const value = zip.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) refuse('invalid-zip', `${what} at ${offset} is too large`);
  return Number(value);
}

/** The end of central directory record: the last signature whose comment ends exactly at the end of the file. */
function findEndRecord(zip: Buffer, refuse: Refuse): number {
  const lowest = Math.max(0, zip.length - endLength - maxCommentLength);
  for (let offset = zip.length - endLength; offset >= lowest; offset -= 1) {
    if (zip.readUInt32LE(offset) !== endSignature) continue;
    if (offset + endLength + zip.readUInt16LE(offset + 20) === zip.length) return offset;
  }
  return refuse('not-a-zip', 'no end of central directory record');
}

interface CentralDirectory {
  readonly entryCount: number;
  readonly offset: number;
  readonly size: number;
  /** First byte after the central directory that belongs to the end records. */
  readonly limit: number;
}

function readCentralDirectory(zip: Buffer, refuse: Refuse): CentralDirectory {
  const end = findEndRecord(zip, refuse);
  const diskNumber = zip.readUInt16LE(end + 4);
  const directoryDisk = zip.readUInt16LE(end + 6);
  let entriesOnDisk = zip.readUInt16LE(end + 8);
  let entryCount = zip.readUInt16LE(end + 10);
  let size = zip.readUInt32LE(end + 12);
  let offset = zip.readUInt32LE(end + 16);
  let limit = end;
  if (diskNumber !== 0 || directoryDisk !== 0) refuse('unsupported-zip', 'the archive is split across disks');

  const zip64 = entryCount === 0xffff || entriesOnDisk === 0xffff || size === 0xffffffff || offset === 0xffffffff;
  if (zip64) {
    const locator = end - zip64LocatorLength;
    if (locator < 0 || zip.readUInt32LE(locator) !== zip64LocatorSignature) {
      refuse('invalid-zip', 'the end record is marked Zip64 but has no Zip64 locator');
    }
    if (zip.readUInt32LE(locator + 4) !== 0 || zip.readUInt32LE(locator + 16) !== 1) {
      refuse('unsupported-zip', 'the Zip64 locator names another disk');
    }
    const record = readUInt64(zip, locator + 8, refuse, 'Zip64 end record offset');
    if (
      record + zip64EndMinimumLength > locator ||
      readUInt32(zip, record, refuse, 'Zip64 end record') !== zip64EndSignature
    ) {
      refuse('invalid-zip', `no Zip64 end record at ${record}`);
    }
    if (zip.readUInt32LE(record + 16) !== 0 || zip.readUInt32LE(record + 20) !== 0) {
      refuse('unsupported-zip', 'the Zip64 end record names another disk');
    }
    entriesOnDisk = readUInt64(zip, record + 24, refuse, 'Zip64 entry count on disk');
    entryCount = readUInt64(zip, record + 32, refuse, 'Zip64 entry count');
    size = readUInt64(zip, record + 40, refuse, 'Zip64 central directory size');
    offset = readUInt64(zip, record + 48, refuse, 'Zip64 central directory offset');
    limit = record;
  }
  if (entriesOnDisk !== entryCount) refuse('unsupported-zip', 'the archive is split across disks');
  if (offset + size > limit) {
    refuse('invalid-zip', `the central directory (offset ${offset}, size ${size}) does not fit before the end records`);
  }
  return { entryCount, offset, size, limit };
}

/** The local header offset from a Zip64 extra field, when the central header holds 0xFFFFFFFF. */
function readZip64LocalOffset(
  zip: Buffer,
  extraStart: number,
  extraEnd: number,
  sizes: { compressed: number; uncompressed: number },
  refuse: Refuse,
): number {
  let cursor = extraStart;
  while (cursor + 4 <= extraEnd) {
    const id = zip.readUInt16LE(cursor);
    const length = zip.readUInt16LE(cursor + 2);
    const dataStart = cursor + 4;
    if (dataStart + length > extraEnd) break;
    if (id === zip64ExtraFieldId) {
      let field = dataStart;
      if (sizes.uncompressed === 0xffffffff) field += 8;
      if (sizes.compressed === 0xffffffff) field += 8;
      if (field + 8 > dataStart + length) break;
      return readUInt64(zip, field, refuse, 'Zip64 local header offset');
    }
    cursor = dataStart + length;
  }
  return refuse('invalid-zip', 'a central header needs a Zip64 extra field for its local header offset');
}

/** Reads and checks every entry; returns where each name is stored. Refuses anything it cannot read safely. */
function readZipEntryNameRanges(zip: Buffer, refuse: Refuse): ZipEntryNameRanges[] {
  if (zip.length < endLength) refuse('not-a-zip', `the file is ${zip.length} bytes, shorter than an end record`);
  const directory = readCentralDirectory(zip, refuse);
  const directoryEnd = directory.offset + directory.size;
  const ranges: ZipEntryNameRanges[] = [];
  let cursor = directory.offset;
  for (let index = 0; index < directory.entryCount; index += 1) {
    if (cursor + centralHeaderLength > directoryEnd || zip.readUInt32LE(cursor) !== centralHeaderSignature) {
      refuse('invalid-zip', `no central directory header for entry ${index} at ${cursor}`);
    }
    const flags = zip.readUInt16LE(cursor + 8);
    const compressed = zip.readUInt32LE(cursor + 20);
    const uncompressed = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const startDisk = zip.readUInt16LE(cursor + 34);
    const centralNameStart = cursor + centralHeaderLength;
    const extraStart = centralNameStart + nameLength;
    const next = extraStart + extraLength + commentLength;
    if (next > directoryEnd) refuse('invalid-zip', `central directory entry ${index} runs past the directory`);
    const name = zip.subarray(centralNameStart, extraStart);
    if ((flags & encryptionFlags) !== 0) {
      refuse('encrypted-entry', `entry ${JSON.stringify(name.toString('utf8'))} is encrypted`);
    }
    if (startDisk !== 0 && startDisk !== 0xffff) refuse('unsupported-zip', 'an entry starts on another disk');
    let localOffset = zip.readUInt32LE(cursor + 42);
    if (localOffset === 0xffffffff) {
      localOffset = readZip64LocalOffset(
        zip,
        extraStart,
        extraStart + extraLength,
        { compressed, uncompressed },
        refuse,
      );
    }
    if (localOffset + localHeaderLength > directory.offset || zip.readUInt32LE(localOffset) !== localHeaderSignature) {
      refuse('invalid-zip', `no local header for ${JSON.stringify(name.toString('utf8'))} at ${localOffset}`);
    }
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localNameStart = localOffset + localHeaderLength;
    if (localNameStart + localNameLength > directory.offset) {
      refuse('invalid-zip', `the local name of ${JSON.stringify(name.toString('utf8'))} runs past the entries`);
    }
    const localName = zip.subarray(localNameStart, localNameStart + localNameLength);
    if (!localName.equals(name)) {
      refuse(
        'entry-name-mismatch',
        `local name ${JSON.stringify(localName.toString('utf8'))} differs from central name ${JSON.stringify(name.toString('utf8'))}`,
      );
    }
    ranges.push({ centralNameStart, localNameStart, nameLength });
    cursor = next;
  }
  if (cursor !== directoryEnd) {
    refuse(
      'invalid-zip',
      `the central directory is ${directory.size} bytes, but its entries use ${cursor - directory.offset}`,
    );
  }
  return ranges;
}

function hasBackslash(zip: Buffer, start: number, length: number): boolean {
  return zip.subarray(start, start + length).includes(backslash);
}

function replaceBackslashes(zip: Buffer, start: number, length: number): void {
  for (let index = start; index < start + length; index += 1) {
    if (zip[index] === backslash) zip[index] = slash;
  }
}

/**
 * Changes every `\` in every entry name of the zip at `zipPath` to `/`.
 * Rejects with a `ZipEntryNameError` and leaves the file unchanged when the
 * zip cannot be read safely.
 */
export async function normalizeZipEntryNames(zipPath: string): Promise<NormalizedZipEntryNames> {
  const refuse: Refuse = (code, detail) => {
    throw new ZipEntryNameError(code, zipPath, detail);
  };
  const original = await readFile(zipPath);
  const ranges = readZipEntryNameRanges(original, refuse);
  const renamed = ranges.filter((range) => hasBackslash(original, range.centralNameStart, range.nameLength));
  if (renamed.length === 0) return { entryCount: ranges.length, renamedEntryCount: 0 };

  const result = Buffer.from(original);
  for (const range of renamed) {
    replaceBackslashes(result, range.centralNameStart, range.nameLength);
    replaceBackslashes(result, range.localNameStart, range.nameLength);
  }
  // The rewritten zip must read back with the same entries and no `\` left.
  const check = readZipEntryNameRanges(result, refuse);
  if (
    check.length !== ranges.length ||
    check.some((range) => hasBackslash(result, range.centralNameStart, range.nameLength))
  ) {
    refuse('invalid-zip', 'the rewritten zip did not read back as expected');
  }

  const temporaryPath = join(dirname(zipPath), `.${basename(zipPath)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temporaryPath, result, { flag: 'wx' });
    if (!(await readFile(temporaryPath)).equals(result)) {
      refuse('invalid-zip', `the temporary file ${temporaryPath} did not read back as written`);
    }
    await rename(temporaryPath, zipPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  return { entryCount: ranges.length, renamedEntryCount: renamed.length };
}
