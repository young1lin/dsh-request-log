/**
 * Blob store specs: DRL1 frame codec, sha256 identity, content-addressed
 * round-trips (dedup short-circuit), fail-soft cache bounds, corruption
 * rejection, and the mark-sweep GC with its grace floor + tmp debris pass.
 */

import { deflateRawSync } from 'node:zlib'
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
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
    const z = await store.put(HASH, PIECE)
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
    const z1 = await store.put(HASH, PIECE)
    const before = (await stat(join(root, HASH.slice(0, 2), HASH + '.drl'))).mtimeMs
    const z2 = await store.put(HASH, PIECE)
    expect(z2).toBe(z1)
    const after = (await stat(join(root, HASH.slice(0, 2), HASH + '.drl'))).mtimeMs
    expect(after).toBe(before) // untouched: content-addressed duplicates are no-ops
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

    // Restore requires an actual re-bake (CAS puts skip existing objects):
    await rm(objectPath)
    await store.put(HASH, PIECE)
    // Valid magic + VALID deflate stream but wrong content: the stream
    // inflates cleanly and content addressing catches the substitution.
    const genuine = await readFile(objectPath)
    const forged = Buffer.concat([genuine.subarray(0, 5), deflateRawSync(Buffer.from('entirely different content'))])
    await writeFile(objectPath, forged)
    await expect(store.get(HASH)).rejects.toThrow(/hash mismatch/)
    // A payload flipped INSIDE the deflate stream also never serves data:
    await rm(objectPath)
    await store.put(HASH, PIECE)
    const flipped = Buffer.from(await readFile(objectPath))
    flipped[flipped.length - 1] ^= 0xff
    await writeFile(objectPath, flipped)
    await expect(store.get(HASH)).rejects.toThrow() // zlib error or hash mismatch, never data

    // A genuinely corrupt store entry is removable so recovery can re-bake.
    await rm(objectPath)
    expect(await store.has(HASH)).toBe(false)
    const z = await store.put(HASH, PIECE)
    expect(z).toBeGreaterThan(0)
    expect((await store.get(HASH)).toString('utf8')).toBe(PIECE)
  })

  it('stores oversized pieces uncompressed behind the identity codec', async () => {
    const root = await tempDir()
    const store = new BlobStore({ directory: root, maxChunkBytes: 8 })
    const z = await store.put(HASH, PIECE)
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

    // Backdate ONLY the stale object past the grace floor.
    const old = new Date(Date.now() - DEFAULT_GC_GRACE_MS * 2)
    await utimes(join(root, staleHash.slice(0, 2), staleHash + '.drl'), old, old)

    const now = Date.now()
    const result = await store.gc(new Set([keptHash]), now)
    expect(result.removedObjects).toBe(1) // stale unreachable only
    expect(result.removedTemp).toBe(1) // tmp debris regardless of reachability
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
})