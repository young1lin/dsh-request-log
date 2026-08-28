/**
 * Blob store specs: DRL1 frame codec, sha256 identity, content-addressed
 * round-trips (dedup short-circuit), fail-soft cache bounds, corruption
 * rejection, and the mark-sweep GC with its grace floor + tmp debris pass.
 */

import { deflateRawSync } from 'node:zlib'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BlobStore,
  CODEC_DEFLATE_RAW,
  CODEC_IDENTITY,
  DEFAULT_GC_GRACE_MS,
  decodeFrame,
  encodeFrame,
  hashOfContent,
  codecFor,
} from '../src/host/blob.ts'
import { PackStore } from '../src/host/pack.ts'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-blob-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const PIECE = JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'hello blobs' }] })
const HASH = hashOfContent(PIECE)

describe('frames and hashing', () => {
  it('hashes content into full lowercase hex sha256', () => {
    expect(HASH).toMatch(/^[0-9a-f]{64}$/)
    expect(hashOfContent('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(hashOfContent(PIECE)).toBe(hashOfContent(Buffer.from(PIECE, 'utf8')))
  })

  it('picks identity above the chunk ceiling and deflateRaw below it', () => {
    expect(codecFor(0, 8)).toBe(CODEC_DEFLATE_RAW)
    expect(codecFor(8, 8)).toBe(CODEC_DEFLATE_RAW)
    expect(codecFor(9, 8)).toBe(CODEC_IDENTITY)
  })

  it('round-trips frames and rejects corrupt ones', () => {
    const payload = deflateRawSync(Buffer.from(PIECE), { level: 6 })
    const frame = encodeFrame(CODEC_DEFLATE_RAW, payload)
    expect(frame.subarray(0, 4).toString('ascii')).toBe('DRL1')
    const decoded = decodeFrame(frame)
    expect(decoded.codec).toBe(CODEC_DEFLATE_RAW)
    expect(decoded.payload.equals(payload)).toBe(true)
    expect(decodeFrame(encodeFrame(CODEC_IDENTITY, payload)).codec).toBe(CODEC_IDENTITY)
    // Truncated / wrong magic / unknown codec all throw.
    expect(() => decodeFrame(frame.subarray(0, 3))).toThrow()
    expect(() => decodeFrame(Buffer.from('XRL1' + 'zz'))).toThrow()
    expect(() => decodeFrame(Buffer.concat([frame.subarray(0, 4), Buffer.from([9]), payload]))).toThrow()
  })
})

describe('BlobStore', () => {
  it('puts and gets objects with compressed sizes reported as z', async () => {
    const store = new BlobStore({ directory: await tempDir() })
    const { z } = await store.put(HASH, PIECE)
    expect(z).toBeGreaterThan(0)
    expect(z).toBeLessThan(PIECE.length) // compressible text dedups hard
    expect(await store.has(HASH)).toBe(true)
    const raw = await store.get(HASH)
    expect(raw.toString('utf8')).toBe(PIECE)
  })

  it('lands objects in the 2-hex bucket under the DRL1 frame name', async () => {
    const root = await tempDir()
    const store = new BlobStore({ directory: root })
    await store.put(HASH, PIECE)
    const objectPath = join(root, HASH.slice(0, 2), `${HASH}.drl`)
    const frame = await readFile(objectPath)
    expect(frame.subarray(0, 4).toString('ascii')).toBe('DRL1')
    expect((await readdir(root)).filter(name => /^[0-9a-f]{2}$/.test(name))).toEqual([HASH.slice(0, 2)])
  })

  it('skips the disk write for an existing hash but still measures z', async () => {
    const root = await tempDir()
    const store = new BlobStore({ directory: root })
    const { z: z1 } = await store.put(HASH, PIECE)
    const before = (await stat(join(root, HASH.slice(0, 2), HASH + '.drl'))).mtimeMs
    const { z: z2 } = await store.put(HASH, PIECE)
    expect(z2).toBe(z1)
    const after = (await stat(join(root, HASH.slice(0, 2), HASH + '.drl'))).mtimeMs
    expect(after).toBe(before) // untouched: content-addressed duplicates are no-ops
  })

  it('does not recompress a piece already in the store', async () => {
    const root = await tempDir()
    const store = new BlobStore({ directory: root })
    const { z: z1 } = await store.put(HASH, PIECE)
    expect(store.compressions).toBe(1)
    const { z: z2 } = await store.put(HASH, PIECE)
    // The dedup hot path resends the whole history every call: a piece already
    // on disk must cost a lookup, never a second deflate.
    expect(store.compressions).toBe(1)
    expect(z2).toBe(z1)
  })

  it('reports z for an existing object from its frame, matching a fresh compression', async () => {
    const root = await tempDir()
    const first = new BlobStore({ directory: root })
    const { z: z1 } = await first.put(HASH, PIECE)
    // A cold process (no in-memory knowledge) must derive the same z from disk.
    const second = new BlobStore({ directory: root })
    expect((await second.put(HASH, PIECE)).z).toBe(z1)
    expect(second.compressions).toBe(0)
  })

  it('reports whether the put created the object or found it already baked', async () => {
    const store = new BlobStore({ directory: await tempDir() })
    const first = await store.put(HASH, PIECE)
    expect(first.created).toBe(true)
    expect(first.z).toBeGreaterThan(0)
    // The append path needs this to bill only the bytes it actually added.
    const second = await store.put(HASH, PIECE)
    expect(second.created).toBe(false)
    expect(second.z).toBe(first.z)
  })

  it('rejects a put whose declared hash does not match its content', async () => {
    const store = new BlobStore({ directory: await tempDir() })
    await expect(store.put('f'.repeat(64), PIECE)).rejects.toThrow(/hash\/content mismatch/)
  })

  it('throws on missing objects instead of inventing data', async () => {
    const store = new BlobStore({ directory: await tempDir() })
    await expect(store.get('a'.repeat(64))).rejects.toThrow()
  })

  it('refuses corrupted objects via magic and hash verification', async () => {
    const root = await tempDir()
    const store = new BlobStore({ directory: root })
    await store.put(HASH, PIECE)
    const objectPath = join(root, HASH.slice(0, 2), HASH + '.drl')

    // Flipped magic byte.
    const frame = await readFile(objectPath)
    frame[1] = 88
    await writeFile(objectPath, frame)
    await expect(store.get(HASH)).rejects.toThrow(/magic mismatch/)

    // A refused read drops the object, so the next put re-bakes it rather
    // than short-circuiting on a file that is merely the right size.
    expect(await store.has(HASH)).toBe(false)
    await store.put(HASH, PIECE)
    // Valid magic + VALID deflate stream but wrong content: the stream
    // inflates cleanly and content addressing catches the substitution.
    const genuine = await readFile(objectPath)
    const forged = Buffer.concat([genuine.subarray(0, 5), deflateRawSync(Buffer.from('entirely different content'))])
    await writeFile(objectPath, forged)
    await expect(store.get(HASH)).rejects.toThrow(/hash mismatch/)
    // A payload flipped INSIDE the deflate stream also never serves data:
    expect(await store.has(HASH)).toBe(false)
    await store.put(HASH, PIECE)
    const flipped = Buffer.from(await readFile(objectPath))
    flipped[flipped.length - 1] ^= 0xff
    await writeFile(objectPath, flipped)
    await expect(store.get(HASH)).rejects.toThrow() // zlib error or hash mismatch, never data

    // Recovery needs no operator step: the failed read already reclaimed it.
    expect(await store.has(HASH)).toBe(false)
    const { z } = await store.put(HASH, PIECE)
    expect(z).toBeGreaterThan(0)
    expect((await store.get(HASH)).toString('utf8')).toBe(PIECE)
  })

  it('stores oversized pieces uncompressed behind the identity codec', async () => {
    const root = await tempDir()
    const store = new BlobStore({ directory: root, maxChunkBytes: 8 })
    const { z } = await store.put(HASH, PIECE)
    expect(z).toBe(Buffer.byteLength(PIECE)) // no compression attempted
    const raw = await store.get(HASH)
    expect(raw.toString('utf8')).toBe(PIECE)
  })

  it('bounds the inflated LRU to its byte budget', async () => {
    const store = new BlobStore({ directory: await tempDir(), cacheBytes: 100 })
    const values: string[] = []
    for (let i = 0; i < 5; i += 1) values.push(JSON.stringify({ i, pad: 'x'.repeat(40) }))
    for (let i = 0; i < values.length; i += 1) await store.put(hashOfContent(values[i]), values[i])
    // Everything fits individually; budget 100 bytes evicts down to a couple.
    for (const value of values) await store.get(hashOfContent(value))
    expect(store.cachedCount).toBeLessThan(values.length)
    // Reads still hit disk after eviction — correctness never rides the cache.
    expect((await store.get(hashOfContent(values[0]))).toString('utf8')).toBe(values[0])
  })

  it('keeps an oversized blob out of the LRU entirely', async () => {
    const store = new BlobStore({ directory: await tempDir(), cacheBytes: 10 })
    await store.put(HASH, PIECE)
    await store.get(HASH)
    expect(store.cachedCount).toBe(0)
    expect((await store.get(HASH)).toString('utf8')).toBe(PIECE)
  })

  it('gc spares reachable and fresh objects, reclaims stale unreachable ones and tmp debris', async () => {
    const root = await tempDir()
    const store = new BlobStore({ directory: root })
    const keptHash = HASH
    const freshHash = hashOfContent('fresh-but-unreferenced')
    const staleHash = hashOfContent('stale-and-unreferenced')
    await store.put(keptHash, PIECE)
    await store.put(freshHash, 'fresh-but-unreferenced')
    await store.put(staleHash, 'stale-and-unreferenced')
    // A crash leftover and some junk in a bucket.
    const bucket = join(root, keptHash.slice(0, 2))
    await writeFile(join(bucket, 'tmp-crash-leftover'), 'junk')
    const stale = new Date(Date.now() - DEFAULT_GC_GRACE_MS * 2)
    await utimes(join(bucket, 'tmp-crash-leftover'), stale, stale)

    // Backdate ONLY the stale object past the grace floor.
    const old = new Date(Date.now() - DEFAULT_GC_GRACE_MS * 2)
    await utimes(join(root, staleHash.slice(0, 2), staleHash + '.drl'), old, old)

    const now = Date.now()
    const result = await store.gc(new Set([keptHash]), now)
    expect(result.removedObjects).toBe(1) // stale unreachable only
    expect(result.removedTemp).toBe(1) // crash debris, past the floor
    expect(await store.has(keptHash)).toBe(true) // referenced survives despite age
    expect(await store.has(freshHash)).toBe(true) // inside the grace floor
    expect(await store.has(staleHash)).toBe(false)
    expect((await store.get(keptHash)).toString('utf8')).toBe(PIECE) // survives intact
  })

  it('counts objects and bytes, failing soft to zeros', async () => {
    const root = await tempDir()
    const store = new BlobStore({ directory: root })
    expect(await store.counts()).toEqual({ objects: 0, bytes: 0 })
    await store.put(HASH, PIECE)
    const census = await store.counts()
    expect(census.objects).toBe(1)
    expect(census.bytes).toBeGreaterThan(5) // frame header at minimum
    // A nonexistent root reports zeros rather than throwing.
    const empty = new BlobStore({ directory: join(root, 'nowhere') })
    expect(await empty.counts()).toEqual({ objects: 0, bytes: 0 })
  })

  it('creates nested roots on demand (mkdir-on-first-put)', async () => {
    const base = await tempDir()
    const store = new BlobStore({ directory: join(base, 'objects') })
    await store.put(HASH, PIECE)
    expect((await readdir(join(base, 'objects'))).length).toBeGreaterThan(0)
  })
  it('touches a deduplicated object back above the gc grace floor', async () => {
    const root = await tempDir()
    const store = new BlobStore({ directory: root })
    await store.put(HASH, PIECE)
    const path = join(root, HASH.slice(0, 2), HASH + '.drl')

    // A hot object's mtime is its CREATION time — dedup hits never rewrite it.
    // A fresh one must not be touched at all: that would be a wasted syscall
    // on the append path's hottest branch.
    const fresh = (await stat(path)).mtimeMs
    expect((await store.put(HASH, PIECE)).created).toBe(false)
    expect((await stat(path)).mtimeMs).toBe(fresh)

    // Past the touch floor, the hit must lift it back over the grace line:
    // the envelope referencing it has not landed yet, so a sweep whose
    // reachable set predates this append would otherwise delete it.
    const old = new Date(Date.now() - DEFAULT_GC_GRACE_MS * 2)
    await utimes(path, old, old)
    expect((await store.put(HASH, PIECE)).created).toBe(false)
    expect(await store.gc(new Set<string>(), Date.now())).toEqual({ removedObjects: 0, removedTemp: 0 })
    expect(await store.has(HASH)).toBe(true)
  })

  it('spares a staging file young enough to belong to a put still in flight', async () => {
    const root = await tempDir()
    const store = new BlobStore({ directory: root })
    await store.put(HASH, PIECE)
    const bucket = join(root, HASH.slice(0, 2))
    const inFlight = join(bucket, 'tmp-in-flight')
    await writeFile(inFlight, 'staged bytes')

    // Deleting it would make the owning put's rename fail and lose the bake.
    expect((await store.gc(new Set([HASH]), Date.now())).removedTemp).toBe(0)
    expect(await readFile(inFlight, 'utf8')).toBe('staged bytes')
  })

  it('drops a corrupt object so the next put can re-bake it', async () => {
    const root = await tempDir()
    const store = new BlobStore({ directory: root })
    await store.put(HASH, PIECE)
    const path = join(root, HASH.slice(0, 2), HASH + '.drl')

    // Size-preserving damage: put() short-circuits on the stat alone, so
    // without a self-heal the slot degrades forever with the content in hand.
    const frame = await readFile(path)
    const damaged = Buffer.from(frame)
    damaged[damaged.length - 1] ^= 0xff
    await writeFile(path, damaged)

    await expect(store.get(HASH)).rejects.toThrow()
    expect(await store.has(HASH)).toBe(false)
    expect((await store.put(HASH, PIECE)).created).toBe(true)
    expect((await store.get(HASH)).toString('utf8')).toBe(PIECE)
  })

  it('refuses to inflate past the chunk ceiling without materializing the output', async () => {
    const root = await tempDir()
    const maxChunkBytes = 1024
    const store = new BlobStore({ directory: root, maxChunkBytes })

    // Compressed size is no bound on inflated size: 64 KiB of zeros frames
    // into well under the ceiling and would expand unchecked before the hash
    // check ever runs.
    const bomb = Buffer.alloc(64 * 1024, 0)
    const bombHash = hashOfContent(bomb)
    const payload = deflateRawSync(bomb)
    expect(payload.length).toBeLessThan(maxChunkBytes)
    const bucket = join(root, bombHash.slice(0, 2))
    await mkdir(bucket, { recursive: true })
    await writeFile(join(bucket, bombHash + '.drl'), encodeFrame(CODEC_DEFLATE_RAW, payload))

    await expect(store.get(bombHash)).rejects.toThrow(/larger than/i)
    // A ceiling rejection is a policy refusal, not proof the bytes are wrong:
    // lowering maxChunkBytes must never delete objects baked under a higher one.
    expect(await store.has(bombHash)).toBe(true)

    // An object exactly AT the ceiling is legal and must still round-trip.
    const edge = Buffer.alloc(maxChunkBytes, 7)
    const edgeHash = hashOfContent(edge)
    expect(codecFor(edge.length, maxChunkBytes)).toBe(CODEC_DEFLATE_RAW)
    await store.put(edgeHash, edge)
    expect((await store.get(edgeHash)).equals(edge)).toBe(true)
  })
})

describe('loose and packed objects together', () => {
  it('reads an object that only exists in a pack', async () => {
    const directory = await tempDir()
    const packs = new PackStore({ directory: join(directory, 'packs') })
    const store = new BlobStore({ directory, packs })
    const payload = '{"packed":true}'
    const hash = hashOfContent(payload)
    await packs.append([{ hash, raw: Buffer.from(payload) }], 1024 * 1024)

    expect(await store.has(hash)).toBe(true)
    expect((await store.get(hash)).toString('utf8')).toBe(payload)
  })

  it('does not re-materialize a packed object as a loose file', async () => {
    const directory = await tempDir()
    const packs = new PackStore({ directory: join(directory, 'packs') })
    const store = new BlobStore({ directory, packs })
    const payload = '{"already":"packed"}'
    const hash = hashOfContent(payload)
    await packs.append([{ hash, raw: Buffer.from(payload) }], 1024 * 1024)

    const result = await store.put(hash, payload)
    expect(result.created).toBe(false)
    // Nothing new on disk: the bucket for this hash must not exist.
    await expect(stat(join(directory, hash.slice(0, 2), `${hash}.drl`))).rejects.toThrow()
  })

  it('prefers the loose copy while both exist', async () => {
    const directory = await tempDir()
    const packs = new PackStore({ directory: join(directory, 'packs') })
    const store = new BlobStore({ directory, packs })
    const payload = 'both places'
    const hash = hashOfContent(payload)
    await store.put(hash, payload)
    await packs.append([{ hash, raw: Buffer.from(payload) }], 1024 * 1024)
    expect((await store.get(hash)).toString('utf8')).toBe(payload)
  })

  it('refuses packed bytes whose hash does not match, without touching the pack', async () => {
    const directory = await tempDir()
    const packsDir = join(directory, 'packs')
    const packs = new PackStore({ directory: packsDir })
    const store = new BlobStore({ directory, packs })
    const lie = hashOfContent('the truth')
    await packs.append([{ hash: lie, raw: Buffer.from('a different body') }], 1024 * 1024)

    await expect(store.get(lie)).rejects.toThrow(/hash mismatch/i)
    // The pack survives: one bad object degrades one record, not the store.
    expect((await readdir(packsDir)).filter(n => n.endsWith('.pack'))).toHaveLength(1)
  })

  it('censuses loose objects with the size and mtime the packer needs', async () => {
    const directory = await tempDir()
    const store = new BlobStore({ directory })
    await store.put(hashOfContent('one'), 'one')
    await store.put(hashOfContent('two'), 'two')
    const census = await store.looseCensus()
    expect(census).toHaveLength(2)
    expect(census.every(row => row.size > 0 && row.mtimeMs > 0)).toBe(true)
  })
})
