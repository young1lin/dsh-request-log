// tests/pack.spec.ts
/** PackStore specs: reading, index rebuilding, and retirement. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hashOfContent } from '../src/host/blob.ts'
import { PackStore } from '../src/host/pack.ts'
import { encodeBlock, encodeIndex, encodePackHeader, scanPack } from '../src/host/pack-format.ts'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pack-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const objectOf = (text: string) => ({ hash: hashOfContent(text), raw: Buffer.from(text, 'utf8') })

/** Hand-build one pack + index, the way the packer will. */
async function writePack(directory: string, id: string, groups: { hash: string; raw: Buffer }[][]): Promise<void> {
  const pack = Buffer.concat([encodePackHeader(), ...groups.map(group => encodeBlock(group))])
  await writeFile(join(directory, `${id}.pack`), pack)
  const { records } = scanPack(pack)
  await writeFile(join(directory, `${id}.idx`), encodeIndex(records, pack.length))
}

describe('PackStore reads', () => {
  it('returns the exact bytes an object was packed with', async () => {
    const directory = await tempDir()
    const a = objectOf('{"role":"user"}')
    const b = objectOf('x'.repeat(9000))
    await writePack(directory, 'pack-1', [[a, b]])

    const store = new PackStore({ directory })
    expect(await store.read(a.hash)).toEqual(a.raw)
    expect(await store.read(b.hash)).toEqual(b.raw)
    expect(await store.has(a.hash)).toBe(true)
  })

  it('reports an unknown hash as absent rather than throwing', async () => {
    const directory = await tempDir()
    await writePack(directory, 'pack-1', [[objectOf('only')]])
    const store = new PackStore({ directory })
    expect(await store.read(hashOfContent('missing'))).toBeNull()
    expect(await store.has(hashOfContent('missing'))).toBe(false)
  })

  it('rebuilds an index that was lost, instead of losing the objects', async () => {
    const directory = await tempDir()
    const a = objectOf('survivor')
    await writePack(directory, 'pack-1', [[a]])
    await rm(join(directory, 'pack-1.idx'))

    const store = new PackStore({ directory })
    expect(await store.read(a.hash)).toEqual(a.raw)
    // And it wrote the index back, so the next process does not rescan.
    expect((await readFile(join(directory, 'pack-1.idx'))).length).toBeGreaterThan(16)
  })

  it('rebuilds an index that is stale after a crash mid-append', async () => {
    const directory = await tempDir()
    const a = objectOf('indexed')
    const b = objectOf('appended-after-the-index')
    // Index written when the pack held only `a`, then `b`'s block appended.
    const first = Buffer.concat([encodePackHeader(), encodeBlock([a])])
    await writeFile(join(directory, 'pack-1.pack'), Buffer.concat([first, encodeBlock([b])]))
    await writeFile(join(directory, 'pack-1.idx'), encodeIndex(scanPack(first).records, first.length))

    const store = new PackStore({ directory })
    expect(await store.read(b.hash)).toEqual(b.raw)
  })

  it('skips a retired pack', async () => {
    const directory = await tempDir()
    const a = objectOf('retired content')
    await writePack(directory, 'pack-1', [[a]])
    await writeFile(join(directory, 'pack-1.retired'), '')

    const store = new PackStore({ directory })
    expect(await store.read(a.hash)).toBeNull()
    expect(await store.list()).toEqual([])
  })

  it('finds a pack that appeared after the first listing', async () => {
    const directory = await tempDir()
    await writePack(directory, 'pack-1', [[objectOf('first')]])
    const store = new PackStore({ directory })
    await store.read(hashOfContent('first'))

    const late = objectOf('written by a later repack')
    await writePack(directory, 'pack-2', [[late]])
    expect(await store.read(late.hash)).toEqual(late.raw)
  })
})
