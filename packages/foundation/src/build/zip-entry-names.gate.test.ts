// Gate tests for #15: the foundation step that rewrites zip entry names
// (ADR 0010; PLT-007). Forge's zip maker on Windows stores entry names with
// `\`; the ZIP format requires `/` (APPNOTE 4.4.17). Apps run this step from
// Forge's `postMake` hook on every zip that `make` produced.
//
// Contract (input and output):
// - Module `packages/foundation/src/build/zip-entry-names.ts` exports
//   `normalizeZipEntryNames(zipPath: string): Promise<NormalizedZipEntryNames>`
//   and the error class `ZipEntryNameError`. It loads in plain Node and uses
//   Node built-ins only.
// - Output: the same file, with every `\` in every entry name changed to `/`
//   in the local headers and the central directory. Nothing else changes:
//   the result is byte-identical to the same zip written with `/` names, so
//   entry data, sizes and CRC-32 stay as they were. A zip that already uses
//   only `/` is left byte-identical. The promise resolves to
//   `{ entryCount, renamedEntryCount }`.
// - Failure modes: a file that is not a zip, a truncated zip, an encrypted
//   entry, a local name that differs from its central name, and anything the
//   step cannot read safely. Each rejects with a `ZipEntryNameError`
//   (`name` "ZipEntryNameError", a `code`, and the zip path in the message),
//   and leaves the file byte-identical, with no other file left in its folder.
// - A Zip64 archive and an entry with a data descriptor are each handled
//   correctly or refused as above; never damaged.
// The make gate (tools/reference-app/reference-app-build.gate.test.ts) checks
// the real made zip on all three platforms.
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildZipFixture, inspectZipFixture, type ZipFixtureEntry } from './test-support/zip-fixture';

interface NormalizedZipEntryNames {
  readonly entryCount: number;
  readonly renamedEntryCount: number;
}

interface ZipEntryNamesModule {
  readonly normalizeZipEntryNames: (zipPath: string) => Promise<NormalizedZipEntryNames>;
  readonly ZipEntryNameError: new (...args: never[]) => Error;
}

const zipEntryNamesModuleUrl = new URL('./zip-entry-names.ts', import.meta.url).href;

/** Loads the system under test; a missing module or export fails each test with the contract text. */
async function loadZipEntryNamesModule(): Promise<ZipEntryNamesModule> {
  let loaded: Partial<ZipEntryNamesModule>;
  try {
    loaded = (await import(/* @vite-ignore */ zipEntryNamesModuleUrl)) as Partial<ZipEntryNamesModule>;
  } catch (error) {
    throw new Error(
      `packages/foundation/src/build/zip-entry-names.ts must exist and load in plain Node: ${(error as Error).message}`,
      { cause: error },
    );
  }
  if (typeof loaded.normalizeZipEntryNames !== 'function' || typeof loaded.ZipEntryNameError !== 'function') {
    throw new Error(
      'packages/foundation/src/build/zip-entry-names.ts must export normalizeZipEntryNames and ZipEntryNameError',
    );
  }
  return loaded as ZipEntryNamesModule;
}

let workDir: string | undefined;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = undefined;
});

/** Writes `bytes` as the only file of a new temporary folder and returns its path. */
function writeZip(bytes: Buffer, fileName = 'reference-win32-x64-0.0.0.zip'): string {
  workDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'zip-entry-names-gate-')));
  const path = join(workDir, fileName);
  writeFileSync(path, bytes);
  return path;
}

// A small binary payload that deflate shrinks, and one it cannot.
const repetitive = Buffer.from('app.asar payload '.repeat(200), 'utf8');
const incompressible = Buffer.from(Array.from({ length: 512 }, (_, index) => (index * 151 + 7) % 256));

/** Entries shaped like the Windows zip in CI run 43177831510, with `sep` as the separator. */
function windowsLikeEntries(sep: '\\' | '/'): ZipFixtureEntry[] {
  return [
    { name: 'reference.exe', data: incompressible, method: 'stored' },
    { name: `locales${sep}af.pak`, data: repetitive, method: 'deflated' },
    { name: `resources${sep}app.asar`, data: repetitive, method: 'deflated' },
    { name: `resources${sep}app.asar.unpacked${sep}deep${sep}file.bin`, data: incompressible, method: 'stored' },
    { name: `empty-folder${sep}`, data: Buffer.alloc(0), method: 'stored' },
  ];
}

const expectedForwardNames = [
  'reference.exe',
  'locales/af.pak',
  'resources/app.asar',
  'resources/app.asar.unpacked/deep/file.bin',
  'empty-folder/',
];

/** Text of a thrown value for an assertion message. */
function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : JSON.stringify(error);
}

/** Runs the step and returns its rejection, or undefined when it resolved. */
async function runExpectingRejection(path: string): Promise<{ error: unknown; module: ZipEntryNamesModule }> {
  const module = await loadZipEntryNamesModule();
  try {
    await module.normalizeZipEntryNames(path);
  } catch (error) {
    return { error, module };
  }
  return { error: undefined, module };
}

/** The step rejected with a ZipEntryNameError and left the file and its folder as they were. */
async function expectRefusedUnchanged(bytes: Buffer, allowedCodes: readonly string[]): Promise<void> {
  const path = writeZip(bytes);
  const folderBefore = readdirSync(workDir as string).sort();
  const { error, module } = await runExpectingRejection(path);
  expect(error, 'normalizeZipEntryNames must reject').toBeDefined();
  expect(error, `must be a ZipEntryNameError: ${describeError(error)}`).toBeInstanceOf(module.ZipEntryNameError);
  const named = error as Error & { code?: unknown };
  expect(named.name).toBe('ZipEntryNameError');
  expect(allowedCodes, `unexpected code ${String(named.code)}: ${named.message}`).toContain(named.code);
  expect(named.message, 'the message must name the zip').toContain(path);
  expect(readFileSync(path).equals(bytes), 'the original zip must be byte-identical after a refusal').toBe(true);
  expect(readdirSync(workDir as string).sort(), 'no temporary or partial file may be left').toEqual(folderBefore);
}

/** Either handled exactly like the `/` twin, or refused unchanged. Never anything else. */
async function expectHandledOrRefused(withBackslashes: Buffer, forwardTwin: Buffer): Promise<void> {
  const path = writeZip(withBackslashes);
  const folderBefore = readdirSync(workDir as string).sort();
  const { error, module } = await runExpectingRejection(path);
  const after = readFileSync(path);
  if (error === undefined) {
    expect(after.equals(forwardTwin), 'when handled, the result must equal the zip written with / names').toBe(true);
  } else {
    expect(error, `a refusal must be a ZipEntryNameError: ${describeError(error)}`).toBeInstanceOf(
      module.ZipEntryNameError,
    );
    expect(after.equals(withBackslashes), 'when refused, the original zip must be byte-identical').toBe(true);
  }
  expect(readdirSync(workDir as string).sort()).toEqual(folderBefore);
}

describe('zip entry names: rewrite \\ to /', () => {
  // PLT-007; ADR 0010
  it('PLT-007: a zip with \\ names (nested folders, a top-level file, stored and deflated entries) ends up with / names only', async () => {
    const { normalizeZipEntryNames } = await loadZipEntryNamesModule();
    const original = buildZipFixture(windowsLikeEntries('\\'));
    const path = writeZip(original);
    const result = await normalizeZipEntryNames(path);
    expect(result).toEqual({ entryCount: 5, renamedEntryCount: 4 });
    const entries = inspectZipFixture(readFileSync(path));
    expect(entries.map((entry) => entry.centralName)).toEqual(expectedForwardNames);
    expect(entries.map((entry) => entry.localName)).toEqual(expectedForwardNames);
  });

  // PLT-007; ADR 0010: contents and checksums do not change
  it('PLT-007: every entry keeps its data, sizes, method and CRC-32', async () => {
    const { normalizeZipEntryNames } = await loadZipEntryNamesModule();
    const original = buildZipFixture(windowsLikeEntries('\\'));
    const before = inspectZipFixture(original);
    const path = writeZip(original);
    await normalizeZipEntryNames(path);
    const after = inspectZipFixture(readFileSync(path));
    expect(after).toHaveLength(before.length);
    after.forEach((entry, index) => {
      const old = before[index];
      expect(entry.data.equals(old?.data ?? Buffer.alloc(1)), `data of ${entry.centralName}`).toBe(true);
      expect(entry.crc32, `CRC-32 of ${entry.centralName}`).toBe(old?.crc32);
      expect(entry.actualCrc32, `computed CRC-32 of ${entry.centralName}`).toBe(entry.crc32);
      expect([entry.method, entry.compressedSize, entry.uncompressedSize, entry.flags]).toEqual([
        old?.method,
        old?.compressedSize,
        old?.uncompressedSize,
        old?.flags,
      ]);
    });
  });

  // PLT-007; ADR 0010: only the name bytes change
  it('PLT-007: the result is byte-identical to the same zip written with / names', async () => {
    const { normalizeZipEntryNames } = await loadZipEntryNamesModule();
    const path = writeZip(buildZipFixture(windowsLikeEntries('\\'), { comment: 'made on Windows' }));
    await normalizeZipEntryNames(path);
    const twin = buildZipFixture(windowsLikeEntries('/'), { comment: 'made on Windows' });
    expect(readFileSync(path).equals(twin)).toBe(true);
  });

  // PLT-007; ADR 0010: zips from macOS and Linux already use /
  it('PLT-007: a zip that already uses / names is left byte-identical', async () => {
    const { normalizeZipEntryNames } = await loadZipEntryNamesModule();
    const original = buildZipFixture(windowsLikeEntries('/'));
    const path = writeZip(original);
    const result = await normalizeZipEntryNames(path);
    expect(result).toEqual({ entryCount: 5, renamedEntryCount: 0 });
    expect(readFileSync(path).equals(original)).toBe(true);
  });
});

describe('zip entry names: failure modes', () => {
  // PLT-007; ADR 0010, failure mode: not a zip
  it('PLT-007: a file that is not a zip is refused with ZipEntryNameError and left unchanged', async () => {
    await expectRefusedUnchanged(Buffer.from('this is not a zip file\n'.repeat(10), 'utf8'), ['not-a-zip']);
  });

  // PLT-007; ADR 0010, failure mode: an empty file
  it('PLT-007: an empty file is refused with ZipEntryNameError', async () => {
    await expectRefusedUnchanged(Buffer.alloc(0), ['not-a-zip']);
  });

  // PLT-007; ADR 0010, failure mode: truncated zips
  it.each([
    ['cut in half (the end record is gone)', (zip: Buffer): Buffer => zip.subarray(0, Math.floor(zip.length / 2))],
    ['cut inside the end record', (zip: Buffer): Buffer => zip.subarray(0, zip.length - 10)],
    [
      'with the data before the central directory shortened, so offsets point past the entries',
      (zip: Buffer): Buffer => Buffer.concat([zip.subarray(0, 40), zip.subarray(140)]),
    ],
  ])('PLT-007: a truncated zip (%s) is refused with ZipEntryNameError and left unchanged', async (_label, cut) => {
    await expectRefusedUnchanged(cut(buildZipFixture(windowsLikeEntries('\\'))), ['not-a-zip', 'invalid-zip']);
  });

  // PLT-007; ADR 0010, failure mode: encrypted entries
  it('PLT-007: a zip with an encrypted entry is refused with ZipEntryNameError and left unchanged', async () => {
    const entries = windowsLikeEntries('\\');
    entries[2] = { ...(entries[2] as ZipFixtureEntry), encrypted: true };
    await expectRefusedUnchanged(buildZipFixture(entries), ['encrypted-entry']);
  });

  // PLT-007; ADR 0010, failure mode: local and central names differ
  it.each([
    ['a different file name', 'resources\\app.bsar'],
    ['a different length', 'resources\\app.asar.x'],
    ['the same name with / in the local header only', 'resources/app.asar'],
  ])(
    'PLT-007: a local name that differs from its central name (%s) is refused unchanged',
    async (_label, localName) => {
      const entries = windowsLikeEntries('\\');
      entries[2] = { ...(entries[2] as ZipFixtureEntry), localName };
      await expectRefusedUnchanged(buildZipFixture(entries), ['entry-name-mismatch']);
    },
  );

  // PLT-007; ADR 0010, failure mode: anything the step cannot read safely
  it('PLT-007: a central directory entry whose local header offset points outside the file is refused unchanged', async () => {
    const zip = Buffer.from(buildZipFixture(windowsLikeEntries('\\')));
    const directoryOffset = zip.readUInt32LE(zip.length - 22 + 16);
    zip.writeUInt32LE(zip.length + 1000, directoryOffset + 42);
    await expectRefusedUnchanged(zip, ['invalid-zip']);
  });

  // PLT-007; ADR 0010, failure mode: a split (multi-disk) archive
  it('PLT-007: an end record that names another disk is refused unchanged', async () => {
    const zip = Buffer.from(buildZipFixture(windowsLikeEntries('\\')));
    zip.writeUInt16LE(1, zip.length - 22 + 4);
    await expectRefusedUnchanged(zip, ['invalid-zip', 'unsupported-zip']);
  });
});

describe('zip entry names: handled or refused, never damaged', () => {
  // PLT-007; ADR 0010: Zip64
  it('PLT-007: a Zip64 zip with \\ names is rewritten exactly or refused unchanged', async () => {
    await expectHandledOrRefused(
      buildZipFixture(windowsLikeEntries('\\'), { zip64: true }),
      buildZipFixture(windowsLikeEntries('/'), { zip64: true }),
    );
  });

  // PLT-007; ADR 0010: entries with a data descriptor (general purpose flag bit 3)
  it('PLT-007: a zip whose entries use data descriptors is rewritten exactly or refused unchanged', async () => {
    const withDescriptors = (sep: '\\' | '/'): ZipFixtureEntry[] =>
      windowsLikeEntries(sep).map((entry) => ({ ...entry, dataDescriptor: true }));
    await expectHandledOrRefused(buildZipFixture(withDescriptors('\\')), buildZipFixture(withDescriptors('/')));
  });
});
