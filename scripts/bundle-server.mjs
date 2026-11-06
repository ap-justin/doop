// Bundles server/index.ts into <out>/ so the image runs `node <out>/server.mjs`
// without tsx or esbuild's service. Packages with native or wasm parts stay external and are
// copied, with their own dependencies, into <out>/node_modules; the files the server
// resolves next to itself (migrations, the background seed) are copied beside the bundle.
import { build } from 'esbuild'
import fs from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
/* under node_modules/.cache so git, prettier, the linters and docker already ignore it */
const out = path.join(root, 'node_modules/.cache/server-bundle')

/* `--without=<package>` leaves a package out of the output: imports of it (and of the bundled
   modules that import it, `WITHOUT_ALSO`) resolve to a stub that throws when evaluated. esbuild
   inlines `import()` targets, so leaving it external instead would put its static import at the
   bundle's top level, and node would fail to resolve it before any code ran */
const without = process.argv.filter((arg) => arg.startsWith('--without=')).map((arg) => arg.slice('--without='.length))
/* not external: a second drizzle-orm copy would fail drizzle's entityKind checks */
const WITHOUT_ALSO = { '@electric-sql/pglite': ['drizzle-orm/pglite'] }
/* server/db/index.ts reaches pglite (via `await import()`) only when DATABASE_URL is unset */
const needsDatabaseUrl = without.includes('@electric-sql/pglite')

const EXTERNAL = ['sharp', '@electric-sql/pglite', 'mupdf', 'puppeteer-core', 'pg-native'].filter(
  (name) => !without.includes(name),
)

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const stubWithout = {
  name: 'without',
  setup(build) {
    const stubbed = without.flatMap((name) => [name, ...(WITHOUT_ALSO[name] ?? [])])
    if (stubbed.length === 0) return
    const filter = new RegExp(`^(${stubbed.map(escapeRegExp).join('|')})(/.*)?$`)
    build.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'without' }))
    build.onLoad({ filter: /.*/, namespace: 'without' }, (args) => ({
      contents: `throw new Error(${JSON.stringify(`${args.path} was left out of this build (--without)`)})`,
      loader: 'js',
    }))
  },
}

fs.rmSync(out, { recursive: true, force: true })
const result = await build({
  plugins: [stubWithout],
  /* a bundle without the embedded database starts through a check that says so, rather than
     failing later on the missing package */
  ...(needsDatabaseUrl
    ? {
        stdin: {
          contents: `
            if (!process.env.DATABASE_URL) {
              console.error('DATABASE_URL is not set. This image has no embedded database: set DATABASE_URL to a Postgres connection string.')
              process.exit(1)
            }
            await import('./server/index.ts')
          `,
          resolveDir: root,
          sourcefile: 'server-entry.ts',
          loader: 'ts',
        },
      }
    : { entryPoints: [path.join(root, 'server/index.ts')] }),
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
/* a build for another platform never loads at run time. Assumes Dockerfile.fly: its build and
   runtime stages share one platform and arch, and both are Debian, so glibc */
function fitsTarget(manifest) {
  /* npm's rule: a `!value` entry blocks that value; any plain entry makes the list an allow-list */
  const listed = (field, value) => {
    const entries = [manifest[field] ?? []].flat()
    const allowed = entries.filter((entry) => !entry.startsWith('!'))
    return !entries.includes(`!${value}`) && (allowed.length === 0 || allowed.includes(value))
  }
  return listed('os', process.platform) && listed('cpu', process.arch) && listed('libc', 'glibc')
}
const skipped = new Set()
function collect(name, from) {
  const dir = packageDir(name, from)
  if (!dir) return false
  if (copied.has(dir) || skipped.has(dir)) return true
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  if (!fitsTarget(manifest)) {
    skipped.add(dir)
    console.warn(`skipping ${name}: built for another os, cpu or libc`)
    return true
  }
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
