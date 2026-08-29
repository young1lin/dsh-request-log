import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { basename, dirname, join, relative as relativePath, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'

// Read the manifest from cwd: the config file's own URL is not guaranteed to
// sit at the package root under every loader, and `npm run build` runs here.
const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))

// Mirrors packages/client/web/src/platform.ts in deepseek-harness: the shell
// seeds these specifiers into the frozen browser module table, so client
// bundles leave them to the injected require instead of inlining.
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]
const PRELOADED_CLIENT_EXTERNALS = ['@deepseek-ai/dsh-client-runtime/client']

// Mirrors the purity-gate allowances in packages/client/tsdown.client.ts:
// wire/type layers with no shared runtime identity may inline; every other
// @deepseek-ai/* value import is a build error (cross-plugin collaboration
// goes through cordis services). Type-only imports are erased before this gate.
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|file-reference|session|llm|tools|brand|home-paths)(\/|$)/
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/

const requested = new Set([
  ...PLATFORM_MODULES,
  ...PRELOADED_CLIENT_EXTERNALS,
  ...(pkg.dsh?.client?.external ?? []),
])
const isRequested = (specifier: string): boolean => requested.has(specifier)

// Host half: a production dependency is on disk in a real install and stays
// an import; everything else inlines. Both halves are stated so moving a
// dependency between npm sections never silently re-bundles it.
const productionDeps = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
])
const escapeSpecifier = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const productionPatterns = [...productionDeps].map(name => new RegExp(`^${escapeSpecifier(name)}(/|$)`))
const isProductionDependency = (specifier: string): boolean =>
  productionPatterns.some(pattern => pattern.test(specifier))

const NODE_ENV = process.env.NODE_ENV ?? 'production'

// CSS channels, mirrored from packages/client/tsdown.client.ts. The virtual
// ids must NOT end in `.css` — tsdown's own css-pipeline guard matches on that
// suffix; the plugin's flat rl-* class namespace is the anti-collision rule.
// Virtual ids carry a CWD-RELATIVE path so the emitted bundle's module
// comments never leak the build machine's absolute paths.
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const GLOBAL_CSS_VIRTUAL_PREFIX = '\0dsh-global-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Virtual id for a stylesheet path: relative (when under cwd) or absolute. */
function cssVirtualIdOf(prefix: string, abs: string): string {
  const rel = relativePath(process.cwd(), abs)
  return prefix + (rel === '' || rel.startsWith('..') ? abs : rel) + CSS_VIRTUAL_SUFFIX
}

/** The physical stylesheet path a css virtual id was built from. */
function cssFileIdOf(prefix: string, virtualId: string): string {
  const inner = virtualId.slice(prefix.length, -CSS_VIRTUAL_SUFFIX.length)
  return inner.includes(':') || inner.startsWith('\\') || inner.startsWith('/')
    ? inner
    : resolvePath(process.cwd(), inner)
}

/** The dedupe-guarded `<style>` injection both CSS channels emit before their exports. */
function injectStyleTag(id: string, fileId: string): string {
  return [
    `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
    `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
    `  const tag = document.createElement('style');`,
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    `  tag.dataset.pluginCss = tagId;`,
    `  tag.textContent = css;`,
    `  document.head.appendChild(tag);`,
    `}`,
  ].join('\n')
}

function styleInjectionModule(
  id: string,
  fileId: string,
  css: string,
): string {
  return [
    `const css = ${JSON.stringify(css)};`,
    injectStyleTag(id, fileId),
    'export {};',
  ].join('\n')
}

/** The default export is exactly the `styles` object an import site consumes. */
function cssModulesInjectionModule(
  id: string,
  fileId: string,
  css: string,
  classes: Record<string, string>,
): string {
  return [
    `const css = ${JSON.stringify(css)};`,
    `const classes = ${JSON.stringify(classes)};`,
    injectStyleTag(id, fileId),
    'export default classes;',
  ].join('\n')
}

function sourceAssetPath(source: string, importer: string): string {
  return resolvePath(dirname(importer), source)
}

function cssChannels(id: string) {
  return [{
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
      return cssVirtualIdOf(CSS_VIRTUAL_PREFIX, abs)
    },
    async load(this: { addWatchFile(file: string): void }, virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = cssFileIdOf(CSS_VIRTUAL_PREFIX, virtualId)
      // The virtual id otherwise hides the physical stylesheet from the watch graph.
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      // lightningcss rewrites every local class to its hashed name in BOTH the
      // emitted CSS and the returned export mapping, so the default export and
      // the injected stylesheet always agree.
      const { code, exports } = transform({ filename: fileId, code: source, cssModules: true })
      const classes: Record<string, string> = {}
      for (const [name, entry] of Object.entries(exports ?? {})) classes[name] = entry.name
      return cssModulesInjectionModule(id, fileId, code.toString(), classes)
    },
  }, {
    name: 'dsh-css-global-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.css') || source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
      return cssVirtualIdOf(GLOBAL_CSS_VIRTUAL_PREFIX, abs)
    },
    async load(this: { addWatchFile(file: string): void }, virtualId: string) {
      if (!virtualId.startsWith(GLOBAL_CSS_VIRTUAL_PREFIX)) return null
      const fileId = cssFileIdOf(GLOBAL_CSS_VIRTUAL_PREFIX, virtualId)
      // The virtual id otherwise hides the physical stylesheet from the watch graph.
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code } = transform({ filename: fileId, code: source, minify: true })
      return styleInjectionModule(id, fileId, code.toString())
    },
  }]
}

export default defineConfig([
  {
    name: pkg.name,
    entry: { index: 'src/host/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    // engines is node>=20; es2024 syntax would ship untranspilable on 20.x/21 runtimes.
    target: 'es2023',
    fixedExtension: false,
    // sourcemap: false — with the default the .d.ts ships a dangling
    // `//# sourceMappingURL=index.d.ts.map` while the map itself is never
    // emitted nor listed in files (the client entry already does this).
    dts: { sourcemap: false },
    minify: true,
    // Symmetric with the client bundle: stack traces resolve past the minifier.
    sourcemap: true,
    clean: true,
    deps: {
      neverBundle: isProductionDependency,
      alwaysBundle: (specifier: string) => !isBuiltin(specifier) && !isProductionDependency(specifier),
    },
  },
  {
    name: `${pkg.name}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    // Emits lib/client.d.ts so TypeScript consumers of the ./client
    // subpath get types (the runtime consumer is the module loader).
    dts: { sourcemap: false },
    minify: true,
    sourcemap: true,
    clean: false,
    deps: {
      // A require() the module table cannot answer is a guaranteed runtime
      // throw: requested specifiers stay imports, everything else inlines.
      neverBundle: isRequested,
      alwaysBundle: (specifier: string) => !isRequested(specifier),
    },
    // Browser bundles inline node-idiom deps that read process.env.NODE_ENV
    // or probe import.meta.env(.MODE); without these substitutions the
    // factory throws ReferenceError at boot.
    define: {
      'process.env': '{}',
      'process.env.NODE_ENV': JSON.stringify(NODE_ENV),
      'import.meta.env.MODE': JSON.stringify(NODE_ENV),
      'import.meta.env': JSON.stringify({ MODE: NODE_ENV }),
    },
    plugins: [{
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (isRequested(source)) return null
        if (VENDORED_LIBRARY.test(source)) return null
        if (INLINE_SAFE.test(source)) return null
        throw new Error(
          `client bundle purity: "${source}" is not in the default client externals or ${pkg.name}'s dsh.client.external, or an inline-safe wire layer — `
          + 'cross-plugin value imports are forbidden; declare a non-default module request or collaborate through cordis services '
          + '(type-only imports are erased and never reach this gate)',
        )
      },
    }, ...cssChannels(pkg.name)],
    outputOptions: {
      entryFileNames: 'client.js',
      // The closure-factory handoff every `dsh.client` package's ./client
      // export must use; mirrors tsdown.client.ts banner/intro/footer.
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
