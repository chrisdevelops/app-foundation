// Gate test for the foundation workspace package (#12; PLT-003, PLT-004).
// Proves that Vitest runs inside packages/foundation through Turborepo with
// the isolated pnpm layout. The package has no public systems yet; each later
// task adds gate tests beside the system it builds.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface FoundationPackageManifest {
  readonly name?: unknown;
  readonly private?: unknown;
  readonly type?: unknown;
}

function readFoundationPackageManifest(): FoundationPackageManifest {
  const manifestUrl = new URL('../package.json', import.meta.url);
  return JSON.parse(readFileSync(manifestUrl, 'utf8')) as FoundationPackageManifest;
}

describe('foundation workspace package', () => {
  it('PLT-003: is the private ES module package @foundation/foundation', () => {
    const manifest = readFoundationPackageManifest();
    expect(manifest.name).toBe('@foundation/foundation');
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe('module');
  });
});
