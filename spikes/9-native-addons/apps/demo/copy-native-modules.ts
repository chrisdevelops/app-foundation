import { cp, mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

interface PackageJson {
  name: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

async function readPackageJson(dir: string): Promise<PackageJson> {
  return JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as PackageJson
}

// Resolve the real directory of `name` as seen from `fromDir` (follows pnpm symlinks).
async function findPackageDir(name: string, fromDir: string): Promise<string | null> {
  const require = createRequire(path.join(fromDir, 'noop.js'))
  // Walk up node_modules lookup paths; do not rely on "exports" allowing package.json.
  for (const base of require.resolve.paths(name) ?? []) {
    const candidate = path.join(base, name)
    try {
      await readFile(path.join(candidate, 'package.json'))
      const { realpath } = await import('node:fs/promises')
      return await realpath(candidate)
    } catch {
      continue
    }
  }
  return null
}

// Copies each root module and its runtime dependency closure into <buildPath>/node_modules/<name>.
// Optional dependencies that are not installed (other platforms) are skipped.
export async function copyNativeModules(rootNames: string[], projectDir: string, buildPath: string): Promise<string[]> {
  const copied = new Map<string, string>()
  const queue: Array<{ name: string; fromDir: string; optional: boolean }> = rootNames.map((name) => ({ name, fromDir: projectDir, optional: false }))
  while (queue.length > 0) {
    const { name, fromDir, optional } = queue.shift()!
    if (copied.has(name)) continue
    const dir = await findPackageDir(name, fromDir)
    if (!dir) {
      if (optional) continue
      throw new Error(`copyNativeModules: cannot resolve "${name}" from ${fromDir}`)
    }
    const target = path.join(buildPath, 'node_modules', name)
    await mkdir(path.dirname(target), { recursive: true })
    await cp(dir, target, { recursive: true, dereference: true })
    copied.set(name, dir)
    const pkg = await readPackageJson(dir)
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push({ name: dep, fromDir: dir, optional: false })
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) queue.push({ name: dep, fromDir: dir, optional: true })
  }
  return [...copied.keys()].sort()
}
