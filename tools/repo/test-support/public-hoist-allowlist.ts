// Test-only helper for the repo gate tests (#12; ADR 0007 item 5). The only
// packages pnpm may link into the root node_modules for every workspace
// package to see. Widening it needs an ADR.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The `publicHoistPattern` entries that pnpm-workspace.yaml may contain. */
export const publicHoistPatternAllowlist: readonly string[] = ['@types/*'];

/** True when a package name matches an entry of `publicHoistPatternAllowlist`. */
export function isPublicHoistAllowed(packageName: string): boolean {
  return publicHoistPatternAllowlist.some((pattern) => {
    const prefix = pattern.replace(/\*$/, '');
    return pattern.endsWith('*') ? packageName.startsWith(prefix) && packageName.length > prefix.length : packageName === pattern;
  });
}

/** Package names that `node_modules/.modules.yaml` records as publicly hoisted. */
export function readPublicHoistedPackages(workspaceRootDir: string): string[] {
  const text = readFileSync(join(workspaceRootDir, 'node_modules', '.modules.yaml'), 'utf8');
  const names = new Set<string>();
  try {
    const modules = JSON.parse(text) as { hoistedDependencies?: Record<string, Record<string, string>> };
    for (const aliases of Object.values(modules.hoistedDependencies ?? {})) {
      for (const [name, kind] of Object.entries(aliases)) if (kind === 'public') names.add(name);
    }
  } catch {
    // YAML form: `    name: public` under hoistedDependencies.
    for (const match of text.matchAll(/^\s+['"]?([^'"\s:][^'":]*)['"]?\s*:\s*public\s*$/gm)) {
      names.add(match[1] as string);
    }
  }
  return [...names].sort();
}

/** Packages in the root node_modules that the root package.json does not declare. */
export function listUndeclaredRootModules(workspaceRootDir: string): string[] {
  const manifest = JSON.parse(readFileSync(join(workspaceRootDir, 'package.json'), 'utf8')) as Record<
    string,
    Record<string, string> | undefined
  >;
  const declared = new Set(
    ['dependencies', 'devDependencies', 'optionalDependencies'].flatMap((field) => Object.keys(manifest[field] ?? {})),
  );
  const rootModules = join(workspaceRootDir, 'node_modules');
  if (!existsSync(rootModules)) return [];
  const names: string[] = [];
  for (const entry of readdirSync(rootModules)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      for (const scoped of readdirSync(join(rootModules, entry))) names.push(`${entry}/${scoped}`);
    } else {
      names.push(entry);
    }
  }
  return names.filter((name) => !declared.has(name)).sort();
}
