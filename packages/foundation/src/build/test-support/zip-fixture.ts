// Test-only helper for the zip entry name gate (#15; ADR 0010; PLT-007).
// Builds sample zips byte by byte with Node built-ins (zlib), the same on
// every OS, and reads them back with full detail: names in the local headers
// and the central directory, flags, sizes, CRC-32 and the entry data.
// Format: APPNOTE.TXT 6.3.10 (local header 4.3.7, central directory 4.3.12,
// end of central directory 4.3.16, Zip64 end record 4.3.14 and locator 4.3.15).
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export interface ZipFixtureEntry {
  /** Name stored in the central directory, exactly as given (may hold `\`). */
  readonly name: string;
  /** Name stored in the local header; defaults to `name`. */
  readonly localName?: string;
  readonly data: Buffer;
  readonly method: 'stored' | 'deflated';
  /** General purpose flag bit 0: the entry claims to be encrypted. */
  readonly encrypted?: boolean;
  /** General purpose flag bit 3: sizes and CRC-32 follow the data in a data descriptor. */
  readonly dataDescriptor?: boolean;
}

export interface ZipFixtureOptions {
  /** Write a Zip64 end record and locator, and mark the normal end record fields as 0xFFFF / 0xFFFFFFFF. */
  readonly zip64?: boolean;
  readonly comment?: string;
}

const localHeaderSignature = 0x04034b50;
const centralHeaderSignature = 0x02014b50;
const endSignature = 0x06054b50;
const zip64EndSignature = 0x06064b50;
const zip64LocatorSignature = 0x07064b50;
const dataDescriptorSignature = 0x08074b50;
// Fixed DOS time and date (2026-11-12 12:00:00), so two builds are byte-identical.
const dosTime = (12 << 11) | (0 << 5) | 0;
const dosDate = ((2026 - 1980) << 9) | (11 << 5) | 12;

function flagsOf(entry: ZipFixtureEntry): number {
  return (entry.encrypted ? 0x0001 : 0) | (entry.dataDescriptor ? 0x0008 : 0);
}

/** Builds a zip file from `entries`, in order. Two calls with equal input give equal bytes. */
export function buildZipFixture(entries: readonly ZipFixtureEntry[], options: ZipFixtureOptions = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const localName = Buffer.from(entry.localName ?? entry.name, 'utf8');
    const stored = entry.method === 'deflated' ? deflateRawSync(entry.data) : entry.data;
    const method = entry.method === 'deflated' ? 8 : 0;
    const crc = crc32(entry.data);
    const flags = flagsOf(entry);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(localHeaderSignature, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    // With a data descriptor, the local header holds zeros for CRC-32 and sizes.
    local.writeUInt32LE(entry.dataDescriptor ? 0 : crc, 14);
    local.writeUInt32LE(entry.dataDescriptor ? 0 : stored.length, 18);
    local.writeUInt32LE(entry.dataDescriptor ? 0 : entry.data.length, 22);
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(0, 28);
    const chunk = [local, localName, stored];
    if (entry.dataDescriptor) {
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(dataDescriptorSignature, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(stored.length, 8);
      descriptor.writeUInt32LE(entry.data.length, 12);
      chunk.push(descriptor);
    }
    const header = Buffer.alloc(46);
    header.writeUInt32LE(centralHeaderSignature, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(dosTime, 12);
    header.writeUInt16LE(dosDate, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(stored.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(entry.name.endsWith('/') || entry.name.endsWith('\\') ? 0x10 : 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    for (const part of chunk) {
      parts.push(part);
      offset += part.length;
    }
  }
  const directory = Buffer.concat(central);
  const directoryOffset = offset;
  parts.push(directory);
  offset += directory.length;
  if (options.zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(zip64EndSignature, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeUInt32LE(0, 16);
    record.writeUInt32LE(0, 20);
    record.writeBigUInt64LE(BigInt(entries.length), 24);
    record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(directoryOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(zip64LocatorSignature, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(offset), 8);
    locator.writeUInt32LE(1, 16);
    parts.push(record, locator);
  }
  const comment = Buffer.from(options.comment ?? '', 'utf8');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(endSignature, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(options.zip64 ? 0xffff : entries.length, 8);
  end.writeUInt16LE(options.zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(options.zip64 ? 0xffffffff : directory.length, 12);
  end.writeUInt32LE(options.zip64 ? 0xffffffff : directoryOffset, 16);
  end.writeUInt16LE(comment.length, 20);
  parts.push(end, comment);
  return Buffer.concat(parts);
}

export interface InspectedZipEntry {
  readonly centralName: string;
  readonly localName: string;
  readonly flags: number;
  readonly method: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  /** The entry data after decompression. */
  readonly data: Buffer;
  /** CRC-32 computed from `data`. */
  readonly actualCrc32: number;
}

/** Reads every entry of a zip buffer, following the central directory (and the Zip64 end record when marked). */
export function inspectZipFixture(zip: Buffer): InspectedZipEntry[] {
  let end = -1;
  for (let index = zip.length - 22; index >= Math.max(0, zip.length - 22 - 65_535); index -= 1) {
    if (zip.readUInt32LE(index) === endSignature) {
      end = index;
      break;
    }
  }
  if (end === -1) throw new Error('no end of central directory record');
  let count = zip.readUInt16LE(end + 10);
  let directorySize = zip.readUInt32LE(end + 12);
  let directoryOffset = zip.readUInt32LE(end + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    const locator = end - 20;
    if (zip.readUInt32LE(locator) !== zip64LocatorSignature) throw new Error('no Zip64 locator');
    const recordOffset = Number(zip.readBigUInt64LE(locator + 8));
    if (zip.readUInt32LE(recordOffset) !== zip64EndSignature) throw new Error('no Zip64 end record');
    count = Number(zip.readBigUInt64LE(recordOffset + 32));
    directorySize = Number(zip.readBigUInt64LE(recordOffset + 40));
    directoryOffset = Number(zip.readBigUInt64LE(recordOffset + 48));
  }
  const entries: InspectedZipEntry[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(cursor) !== centralHeaderSignature) throw new Error(`no central header at ${cursor}`);
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const uncompressedSize = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const centralName = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;
    if (zip.readUInt32LE(localOffset) !== localHeaderSignature) throw new Error(`no local header at ${localOffset}`);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const localName = zip.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8');
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    const encrypted = (flags & 0x0001) !== 0;
    const data = encrypted ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    entries.push({
      centralName,
      localName,
      flags,
      method,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      data,
      actualCrc32: crc32(data),
    });
  }
  if (cursor - directoryOffset !== directorySize) throw new Error('central directory size does not match its entries');
  return entries;
}
