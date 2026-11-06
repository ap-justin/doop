// Bundles server/index.ts into dist-server/ so the image runs `node dist-server/server.mjs`
// without tsx or esbuild's service. Packages with native or wasm parts stay external and are
// copied, with their own dependencies, into dist-server/node_modules; the files the server
// resolves next to itself (migrations, the background seed) are copied beside the bundle.
import { build } from 'esbuild'
import fs from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const out = path.join(root, 'dist-server')

const EXTERNAL = ['sharp', '@electric-sql/pglite', 'mupdf', 'puppeteer-core', 'pg-native']

fs.rmSync(out, { recursive: true, force: true })
const result = await build({
  entryPoints: [path.join(root, 'server/index.ts')],
  outfile: path.join(out, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: EXTERNAL,
  metafile: true,
  logLevel: 'warning',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
})

fs.cpSync(path.join(root, 'server/db/migrations'), path.join(out, 'migrations'), { recursive: true })
fs.copyFileSync(path.join(root, 'server/backgrounds.json'), path.join(out, 'backgrounds.json'))

/* what the bundle still imports at run time, by package name */
const imported = new Set()
for (const input of Object.values(result.metafile.outputs)) {
  for (const imp of input.imports) {
    if (!imp.external || imp.path.startsWith('node:') || builtinModules.includes(imp.path)) continue
    const parts = imp.path.split('/')
    imported.add(imp.path.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0])
  }
}

/* the closure of those packages' dependencies, resolved the way node would from the package */
const copied = new Map()
function packageDir(name, from) {
  let dir = from
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name)
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
function collect(name, from) {
  const dir = packageDir(name, from)
  if (!dir) return false
  if (copied.has(dir)) return true
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  copied.set(dir, name)
  for (const dep of Object.keys(manifest.dependencies ?? {})) collect(dep, dir)
  for (const dep of Object.keys(manifest.optionalDependencies ?? {})) collect(dep, dir)
  return true
}
for (const name of imported) {
  if (collect(name, root)) continue
  /* esbuild leaves an import it cannot resolve external when it sits in a try block: an optional peer */
  if (EXTERNAL.includes(name) && name !== 'pg-native') throw new Error(`external package ${name} is not installed`)
  console.warn(`skipping ${name}: not installed, imported optionally`)
}
for (const [dir, name] of copied) {
  /* nested copies keep their place under the parent, top-level ones go to the flat root */
  const rel = path.relative(path.join(root, 'node_modules'), dir)
  fs.cpSync(dir, path.join(out, 'node_modules', rel.startsWith('..') ? name : rel), {
    recursive: true,
    dereference: true,
  })
}
console.log(`bundled ${path.relative(root, out)}: external ${[...imported].sort().join(', ')}; ${copied.size} packages`)
