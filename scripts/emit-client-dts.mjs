/**
 * Emits lib/client.d.ts after tsdown: the ./client subpath's runtime face is
 * the browser module loader (plain CJS), but TypeScript consumers importing
 * the subpath still deserve real types. Self-contained on purpose — no build
 * machinery beyond a file write. Keep the ClientCtx mirror in sync with
 * src/client/services.ts.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'lib')

const declaration = [
  '/**',
  ' * Client half of dsh-request-log — loaded by the harness web module loader',
  ' * as the package\'s ./client subpath. Types mirror src/client/services.ts.',
  ' */',
  '',
  '/** The client-side context face the harness web half hands apply. */',
  'export interface ClientCtx {',
  '  effect: (setup: () => unknown, label?: string) => () => void',
  '  get: (name: string) => unknown',
  '  on: (event: string, listener: (...args: unknown[]) => unknown) => () => void',
  '  slots: {',
  '    inject: (name: string, callback: () => unknown) => unknown',
  '    register: (',
  '      registration: {',
  '        name: string',
  '        id?: string',
  '        order?: number',
  '        locale?: string',
  '        label?: () => string',
  '        inject?: (sessionId: string) => unknown',
  '      },',
  '      component: (props: { sessionId?: string }) => unknown,',
  '    ) => unknown',
  '  }',
  '  locale: {',
  '    register: (ns: string, dicts: Record<string, unknown>) => () => void',
  '    bind: (ns: string) => (key: string, params?: Record<string, string | number>) => string',
  '    subscribe: (fn: () => void) => () => void',
  '    getLocale?: () => { active: string }',
  '  }',
  '}',
  '',
  'export declare const name: string',
  'export declare const inject: string[]',
  'export declare function apply(ctx: ClientCtx): void',
].join('\n') + '\n'

await mkdir(outDir, { recursive: true })
await writeFile(join(outDir, 'client.d.ts'), declaration, 'utf8')
// tsdown's client dts experiments can leave this stray map behind.
await rm(join(outDir, 'client.ts.map'), { force: true })

// tsdown (0.22) writes a `//# sourceMappingURL=index.d.ts.map` reference
// into lib/index.d.ts even with `dts: { sourcemap: false }`, while never
// emitting the map itself — a dangling reference in the published types.
// Strip it here, where the build already post-processes the dts artifacts.
const hostDts = join(outDir, 'index.d.ts')
const hostDtsText = await readFile(hostDts, 'utf8').catch(() => null)
if (hostDtsText !== null && hostDtsText.includes('.d.ts.map')) {
  const stripped = hostDtsText.replace(/^\/\/# sourceMappingURL=[^\n]*\.d\.ts\.map[^\n]*\n?/gm, '')
  if (stripped !== hostDtsText) {
    await writeFile(hostDts, stripped, 'utf8')
    console.log('stripped dangling d.ts sourcemap reference from lib/index.d.ts')
  }
}
console.log('wrote lib/client.d.ts')
