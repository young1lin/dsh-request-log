// tests/pack.spec.ts
/** PackStore specs: reading, index rebuilding, and retirement. */
import { mkdtemp, open, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
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

  it('names a pack that is shorter than its index claims, instead of inflating garbage', async () => {
    const directory = await tempDir()
    // Incompressible, so the block is comfortably longer than the cut below.
    const raw = randomBytes(4000)
    const a = { hash: hashOfContent(raw), raw }
    const pack = Buffer.concat([encodePackHeader(), encodeBlock([a])])
    const { records } = scanPack(pack)
    // A pack cut short after the index was written: the index passes its own
    // length check, so nothing upstream catches the short read.
    await writeFile(join(directory, 'pack-1.pack'), pack.subarray(0, pack.length - 200))
    await writeFile(join(directory, 'pack-1.idx'), encodeIndex(records, pack.length - 200))

    const store = new PackStore({ directory })
    await expect(store.read(a.hash)).rejects.toThrow(/extent past its end|truncat/i)
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

  it('keeps a loaded index through a miss, instead of loading it all over again', async () => {
    const directory = await tempDir()
    const a = objectOf('kept')
    await writePack(directory, 'pack-1', [[a]])

    const store = new PackStore({ directory })
    expect(await store.has(a.hash)).toBe(true) // loads and caches the index
    // From here only the in-memory index can answer: the file is gone.
    await rm(join(directory, 'pack-1.idx'))
    expect(await store.has(hashOfContent('absent'))).toBe(false)
    expect(await store.has(a.hash)).toBe(true)
    // A miss that discarded the loaded index would have rebuilt it from the
    // pack here - reading every pack byte on the append path's every new object.
    await expect(stat(join(directory, 'pack-1.idx'))).rejects.toThrow()
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

describe('PackStore writes', () => {
  it('makes the objects readable and the index durable before it resolves', async () => {
    const directory = await tempDir()
    const store = new PackStore({ directory })
    const objects = [objectOf('one'), objectOf('two'), objectOf('three')]

    const result = await store.append(objects, 1024 * 1024)
    expect(result.entryCount).toBe(3)

    // A fresh store — no warm caches — sees them.
    const cold = new PackStore({ directory })
    for (const object of objects) expect(await cold.read(object.hash)).toEqual(object.raw)
    const idx = await stat(join(directory, `${result.id}.idx`))
    expect(idx.size).toBeGreaterThan(16)
  })

  it('cuts blocks at the requested size instead of one block per pack', async () => {
    const directory = await tempDir()
    const store = new PackStore({ directory })
    // Four 4 KB objects with a 6 KB block budget => more than one block.
    const objects = [0, 1, 2, 3].map(i => objectOf(String(i) + 'y'.repeat(4000)))
    const { id } = await store.append(objects, 6000)

    const pack = await readFile(join(directory, `${id}.pack`))
    const { records } = scanPack(pack)
    expect(new Set(records.map(r => r.blockOffset)).size).toBeGreaterThan(1)
    for (const object of objects) expect(await store.read(object.hash)).toEqual(object.raw)
  })

  it('indexes both appends when a pack receives more than one', async () => {
    const directory = await tempDir()
    const store = new PackStore({ directory })
    const first = [objectOf('first-a'), objectOf('first-b')]
    const second = [objectOf('second-a'), objectOf('second-b')]
    const one = await store.append(first, 1024 * 1024)
    const two = await store.append(second, 1024 * 1024)
    expect(two.id).toBe(one.id)
    expect(two.entryCount).toBe(4)

    const cold = new PackStore({ directory })
    for (const object of [...first, ...second]) expect(await cold.read(object.hash)).toEqual(object.raw)
  })

  it('indexes blocks a crashed append left behind, alongside its own', async () => {
    const directory = await tempDir()
    const store = new PackStore({ directory })
    const mine = objectOf('written through the store')
    const { id } = await store.append([mine], 1024 * 1024)
    // A block that landed in the pack without its index — what a crash between
    // the fsync and the index rewrite leaves. The next append must not drop it.
    const orphan = objectOf('landed before the crash')
    const handle = await open(join(directory, `${id}.pack`), 'a')
    await handle.writeFile(encodeBlock([orphan]))
    await handle.close()

    const later = objectOf('after the crash')
    const result = await store.append([later], 1024 * 1024)
    expect(result.entryCount).toBe(3)

    const cold = new PackStore({ directory })
    for (const object of [mine, orphan, later]) expect(await cold.read(object.hash)).toEqual(object.raw)
  })

  it('keeps the stored order, which is what the compression ratio depends on', async () => {
    const directory = await tempDir()
    const store = new PackStore({ directory })
    const objects = ['a', 'b', 'c', 'd'].map(objectOf)
    const { id } = await store.append(objects, 1024 * 1024)
    expect(await store.entriesOf(id)).toEqual(objects.map(o => o.hash))
  })

  it('appends to the same pack on a second call', async () => {
    const directory = await tempDir()
    const store = new PackStore({ directory })
    const first = await store.append([objectOf('first')], 1024 * 1024)
    const second = await store.append([objectOf('second')], 1024 * 1024)
    expect(second.id).toBe(first.id)
    expect((await readdir(directory)).filter(n => n.endsWith('.pack'))).toHaveLength(1)
    expect(await store.read(hashOfContent('first'))).toEqual(Buffer.from('first'))
    expect(await store.read(hashOfContent('second'))).toEqual(Buffer.from('second'))
  })

  it('retires a pack so readers skip it, and reaps it only past the grace floor', async () => {
    const directory = await tempDir()
    const store = new PackStore({ directory })
    const { id } = await store.append([objectOf('doomed')], 1024 * 1024)

    await store.retire(id)
    expect(await store.read(hashOfContent('doomed'))).toBeNull()
    // A fresh retire survives the reap: an unpack retires a pack the same
    // cycle it writes the loose copies back — fsync-less — and deleting the
    // pack before those bytes land would leave neither copy durable.
    expect(await store.reapRetired()).toBe(0)
    expect((await readdir(directory)).filter(n => n.endsWith('.pack'))).toHaveLength(1)
    // A torn pack carries a seal marker; repacking it away must not leave the
    // marker behind for the life of the store.
    await writeFile(join(directory, id + '.sealed'), '')
    const past = new Date(Date.now() - 3 * 60 * 60 * 1000)
    await utimes(join(directory, id + '.retired'), past, past)
    expect(await store.reapRetired()).toBe(1)
    expect((await readdir(directory)).filter(n => n.startsWith(id))).toEqual([])
  })

  it('seals a pack with a torn tail, so later appends land elsewhere and survive rebuilds', async () => {
    const directory = await tempDir()
    const store = new PackStore({ directory })
    const before = objectOf('packed before the crash')
    const { id } = await store.append([before], 1024 * 1024)
    // A crash between the append's write and its fsync left half a block —
    // bytes no index will ever name — at the tail of the pack.
    const handle = await open(join(directory, id + '.pack'), 'a')
    await handle.writeFile(Buffer.alloc(37, 0xab))
    await handle.close()
    await rm(join(directory, id + '.idx'))

    // Rebuilt indexes stop at the tear; the store must notice (scannedBytes)
    // and never append after the garbage: blocks there would be dropped by
    // every future rebuild while their loose copies are already deleted.
    const after = objectOf('packed after the recovery')
    const result = await store.append([after], 1024 * 1024)
    expect(result.id).not.toBe(id)
    const tornBytes = (await stat(join(directory, id + '.pack'))).size
    await store.append([objectOf('yet more')], 1024 * 1024)
    expect((await stat(join(directory, id + '.pack'))).size).toBe(tornBytes)

    // Cold caches, every index rebuilt from the packs alone: everything
    // readable, on both sides of the tear.
    const cold = new PackStore({ directory })
    expect(await cold.read(before.hash)).toEqual(before.raw)
    expect(await cold.read(after.hash)).toEqual(after.raw)
  })

  it('remembers a sealed pack across a restart, not just in memory', async () => {
    const directory = await tempDir()
    const store = new PackStore({ directory })
    const before = objectOf('packed before the crash')
    const { id } = await store.append([before], 1024 * 1024)
    const handle = await open(join(directory, id + '.pack'), 'a')
    await handle.writeFile(Buffer.alloc(37, 0xab))
    await handle.close()
    await rm(join(directory, id + '.idx'))
    // Recovery seals the torn pack and opens a fresh one — but the index it
    // rebuilds names the pack's FULL length, tear included, so the staleness
    // check passes from here on and nothing ever rescans it. An in-memory seal
    // is forgotten at the next start; only a marker on disk carries it over.
    const opened = await store.append([objectOf('packed after the recovery')], 1024 * 1024)
    // Time passes: the pack that took over goes mostly dead and is repacked
    // away, which makes the torn one the newest again.
    await rm(join(directory, opened.id + '.pack'))
    await rm(join(directory, opened.id + '.idx'), { force: true })

    const restarted = new PackStore({ directory })
    const tornBytes = (await stat(join(directory, id + '.pack'))).size
    const late = objectOf('written by the next process')
    const result = await restarted.append([late], 1024 * 1024)
    expect(result.id).not.toBe(id)
    expect((await stat(join(directory, id + '.pack'))).size).toBe(tornBytes)

    // What the seal is FOR: bytes appended past a tear are dropped by every
    // future rebuild, while their loose copies have already been unlinked.
    await rm(join(directory, result.id + '.idx'))
    const cold = new PackStore({ directory })
    expect(await cold.read(late.hash)).toEqual(late.raw)
    expect(await cold.read(before.hash)).toEqual(before.raw)
  })

  it('rebuilds an index whose body was truncated, instead of trusting its header', async () => {
    const directory = await tempDir()
    const a = objectOf('indexed object')
    await writePack(directory, 'pack-1', [[a]])
    // A crash left the 16-byte header (packBytes included) but cut the body:
    // packBytes still matches the pack, so only a length check catches it.
    const full = await readFile(join(directory, 'pack-1.idx'))
    await writeFile(join(directory, 'pack-1.idx'), full.subarray(0, 16 + 24))

    const store = new PackStore({ directory })
    expect(await store.read(a.hash)).toEqual(a.raw)
    // And the rewritten index is whole again, so the next cold load trusts it.
    expect((await readFile(join(directory, 'pack-1.idx'))).length).toBe(full.length)
  })

  it('reaps the staging debris a crash leaves in the pack directory', async () => {
    const directory = await tempDir()
    const store = new PackStore({ directory })
    await store.append([objectOf('kept')], 1024 * 1024)
    // A temp index a crash left between its write and its rename. The loose
    // GC only descends into 2-hex buckets, so nothing else looks in here.
    const stale = join(directory, 'tmp-from-a-crash')
    await writeFile(stale, 'half an index')
    const past = new Date(Date.now() - 3 * 60 * 60 * 1000)
    await utimes(stale, past, past)
    const fresh = join(directory, 'tmp-being-written-now')
    await writeFile(fresh, 'in flight')

    await store.reapRetired()

    await expect(stat(stale)).rejects.toThrow()
    // A temp file younger than the grace floor may be another writer's.
    expect((await stat(fresh)).size).toBeGreaterThan(0)
  })
})
