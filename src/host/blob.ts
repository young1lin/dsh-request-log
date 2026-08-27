/**
 * The global content-addressed object store under `<directory>/objects/`:
 * 256 fan-out buckets (`objects/<2hex>/<sha256hex>.drl`) holding one dedup
 * piece each, framed as `DRL1` magic + codec byte + payload (0 identity for
 * oversized pieces, 1 deflateRaw level 6). Objects are immutable and uniquely
 * named by their sha256, so concurrent writers converge ("last rename wins"
 * is a no-op) and readers never need cache invalidation. Writes stage into a
 * temp file INSIDE the target bucket dir then rename - same volume, atomic.
 * A small byte-budgeted LRU keeps hot blobs inflated in memory; GC is
 * mark-sweep over the reachable-hash set extracted from live session files,
 * with an mtime grace floor so appends racing a sweep never lose data.
 *
 * @module dsh-request-log/host/blob
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { deflateRaw as deflateRawCb, inflateRaw as inflateRawCb } from 'node:zlib'

/**
 * Compression runs off the event loop: the host process streams model
 * responses and serves the web UI while these run, and a long session
 * deflates hundreds of KB per settled call.
 */
const deflateRaw = promisify(deflateRawCb)
const inflateRaw = promisify(inflateRawCb)

/** Frame magic at the head of every `.drl` object file. */
export const DRL_MAGIC = Buffer.from('DRL1', 'ascii')

/** Fixed frame preamble: magic + one codec byte. The rest of the file IS the payload. */
export const FRAME_HEADER_BYTES = DRL_MAGIC.length + 1

/** Codec ids: payload framing only, no transport container. */
export const CODEC_IDENTITY = 0
export const CODEC_DEFLATE_RAW = 1

/** Pieces above this raw size skip compression (codec 0) - the escape hatch. */
export const DEFAULT_MAX_CHUNK_BYTES = 32 * 1024 * 1024
/** Default raw-blob LRU budget (inflated bytes keyed by hash). */
export const DEFAULT_BLOB_CACHE_BYTES = 16 * 1024 * 1024
export const DEFAULT_DEFLATE_LEVEL = 6
/** Unreachable-but-newer-than-this objects survive a GC pass. */
export const DEFAULT_GC_GRACE_MS = 60 * 60 * 1000

export interface BlobStoreConfig {
  /** The OBJECTS ROOT directory (the caller owns its placement). */
  directory: string
  cacheBytes?: number
  maxChunkBytes?: number
  deflateLevel?: number
}

/** Full lowercase hex sha256 over exact content - the blob identity. */
export function hashOfContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/** Identity above maxChunkBytes, deflateRaw below it. */
export function codecFor(rawByteLength: number, maxChunkBytes: number): number {
  return rawByteLength > maxChunkBytes ? CODEC_IDENTITY : CODEC_DEFLATE_RAW
}

/** Wrap compressed payload bytes into one DRL1 frame. */
export function encodeFrame(codec: number, payload: Buffer): Buffer {
  const header = Buffer.allocUnsafe(DRL_MAGIC.length + 1)
  DRL_MAGIC.copy(header, 0)
  header[DRL_MAGIC.length] = codec
  return Buffer.concat([header, payload])
}

/** Split one frame back into codec + payload; throws on magic/codec corruption. */
export function decodeFrame(frame: Buffer): { codec: number; payload: Buffer } {
  if (frame.length <= DRL_MAGIC.length + 1 || !frame.subarray(0, DRL_MAGIC.length).equals(DRL_MAGIC)) {
    throw new Error('object frame magic mismatch')
  }
  const codec = frame[DRL_MAGIC.length]
  if (codec !== CODEC_IDENTITY && codec !== CODEC_DEFLATE_RAW) {
    throw new Error(`unknown object codec ${String(codec)}`)
  }
  return { codec, payload: frame.subarray(DRL_MAGIC.length + 1) }
}

/**
 * Minimal byte-budgeted LRU over immutable buffers: insertion order is
 * recency order, reads refresh it, eviction pops from the front until the
 * total fits the budget. Content-addressed values cannot go stale, so there
 * is no invalidation story at all.
 */
class ByteBudgetLru {
  private readonly entries = new Map<string, Buffer>()
  private used = 0

  constructor(private readonly budget: number) {}

  get(key: string): Buffer | undefined {
    const value = this.entries.get(key)
    if (value === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  put(key: string, value: Buffer): void {
    // One oversized entry would evict everything else on every insert:
    // keep it out of the cache entirely instead.
    if (value.length > this.budget) return
    this.delete(key)
    this.entries.set(key, value)
    this.used += value.length
    while (this.used > this.budget) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.delete(oldest)
    }
  }

  delete(key: string): void {
    const value = this.entries.get(key)
    if (value !== undefined) {
      this.used -= value.length
      this.entries.delete(key)
    }
  }

  get size(): number {
    return this.entries.size
  }
}

export interface GcResult { removedObjects: number; removedTemp: number }

export class BlobStore {
  private readonly lru: ByteBudgetLru
  /** Deflate calls actually performed (diagnostics: dedup effectiveness). */
  private deflates = 0
  private readonly maxChunkBytes: number
  private readonly deflateLevel: number
  private readonly readyBuckets = new Set<string>()
  private mkdirPromise: Promise<void> | undefined

  constructor(private readonly config: BlobStoreConfig) {
    this.lru = new ByteBudgetLru(config.cacheBytes ?? DEFAULT_BLOB_CACHE_BYTES)
    this.maxChunkBytes = config.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES
    this.deflateLevel = config.deflateLevel ?? DEFAULT_DEFLATE_LEVEL
  }

  /** The bucket dir holds the hash - the first two hex chars fan objects out. */
  private pathOf(hash: string): string {
    return join(this.config.directory, hash.slice(0, 2), `${hash}.drl`)
  }

  /** Create the root once; a failed attempt is retried on the next use. */
  private ensureDirectory(): Promise<void> {
    if (this.mkdirPromise === undefined) {
      this.mkdirPromise = mkdir(this.config.directory, { recursive: true }).then(
        () => {},
        error => {
          this.mkdirPromise = undefined
          throw error
        },
      )
    }
    return this.mkdirPromise
  }

  /** Ensure ONE fan-out bucket exists (memoized; failed attempts retry). */
  private async ensureBucketDir(bucket: string): Promise<void> {
    if (this.readyBuckets.has(bucket)) return
    await this.ensureDirectory()
    await mkdir(bucket, { recursive: true }).then(
      () => { this.readyBuckets.add(bucket) },
      () => { // Retried by the next put.
      },
    )
  }

  async has(hash: string): Promise<boolean> {
    return (await this.payloadSizeOf(hash)) !== null
  }

  /**
   * The stored payload length of an existing object, or null when it is
   * absent (or too short to hold a frame at all - a truncated leftover is
   * treated as absent so the next put rewrites it). The frame preamble is
   * fixed-width and the payload is the whole rest of the file, so this is
   * the exact `z` a fresh compression would report - WITHOUT compressing.
   */
  private async payloadSizeOf(hash: string): Promise<number | null> {
    try {
      const { size } = await stat(this.pathOf(hash))
      return size > FRAME_HEADER_BYTES ? size - FRAME_HEADER_BYTES : null
    } catch {
      return null
    }
  }

  /**
   * Materialize one immutable object for raw content. Returns the COMPRESSED
   * payload length (the envelope z), whether or not this call did the
   * writing. Duplicates of an existing hash cost one stat: consecutive calls
   * resend nearly the whole conversation, so compressing a piece already on
   * disk just to measure z would spend the entire cost dedup exists to
   * remove. Throws when the write genuinely failed AND the object is absent
   * afterwards, so callers never persist an envelope referencing an unbaked
   * hash.
   */
  async put(hash: string, raw: string | Buffer): Promise<number> {
    const buf = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw
    if (hashOfContent(buf) !== hash) throw new Error('blob put rejected: hash/content mismatch')
    const existing = await this.payloadSizeOf(hash)
    if (existing !== null) return existing
    const codec = codecFor(buf.length, this.maxChunkBytes)
    let payload: Buffer
    if (codec === CODEC_IDENTITY) {
      payload = buf
    } else {
      this.deflates += 1
      payload = await deflateRaw(buf, { level: this.deflateLevel })
    }
    const bucket = join(this.config.directory, hash.slice(0, 2))
    await this.ensureBucketDir(bucket)
    const temp = join(bucket, `tmp-${randomUUID()}`)
    try {
      await writeFile(temp, encodeFrame(codec, payload))
      try {
        await rename(temp, this.pathOf(hash))
      } catch {
        // Benign Windows races (concurrent writer won, reader-held handle):
        // a second attempt either succeeds or confirms someone else landed it.
        if (!(await this.has(hash))) await rename(temp, this.pathOf(hash))
      }
    } finally {
      // Staging files never survive: renamed away, raced away, cleaned here.
      await rm(temp, { force: true }).catch(() => {})
    }
    // The caller must learn a bake failed BEFORE any envelope references it.
    const landed = await this.payloadSizeOf(hash)
    if (landed === null) throw new Error(`blob object write failed for ${hash}`)
    return landed
  }

  /**
   * Read one object, verify its frame magic + content hash, inflate, and
   * serve from the LRU next time. Any corruption (magic, codec, hash
   * mismatch, oversized declared payload) throws - wrong data is impossible;
   * missing data degrades at the CALLER (fail-soft slots), never here.
   */
  async get(hash: string): Promise<Buffer> {
    const cached = this.lru.get(hash)
    if (cached !== undefined) return cached
    const frame = await readFile(this.pathOf(hash))
    const { codec, payload } = decodeFrame(frame)
    // Declared-size sanity gate applies to INFLATING only: identity payloads
    // are already materialized bytes bounded by the file itself.
    let raw: Buffer
    if (codec === CODEC_IDENTITY) {
      raw = Buffer.from(payload)
    } else {
      if (payload.length > this.maxChunkBytes) throw new Error(`oversized object payload for ${hash}`)
      raw = await inflateRaw(payload)
    }
    if (hashOfContent(raw) !== hash) throw new Error(`object content hash mismatch for ${hash}`)
    this.lru.put(hash, raw)
    return raw
  }

  /** In-memory occupancy probe (tests / diagnostics). */
  get cachedCount(): number {
    return this.lru.size
  }

  /**
   * How many pieces this store actually compressed (tests / diagnostics).
   * On the append path it should stay near the count of NEW pieces - a
   * number climbing with total pieces means dedup stopped short-circuiting.
   */
  get compressions(): number {
    return this.deflates
  }

  /**
   * Mark-sweep GC: delete every .drl object NOT in reachable whose mtime
   * predates the grace floor (fresh objects may belong to an append that
   * has not yet written its envelope line), plus any leftover tmp-* debris
   * regardless. One unreadable entry never aborts the walk.
   */
  async gc(reachable: ReadonlySet<string>, now: number, graceMs: number = DEFAULT_GC_GRACE_MS): Promise<GcResult> {
    const result = { removedObjects: 0, removedTemp: 0 }
    let rootEntries: string[]
    try {
      rootEntries = await readdir(this.config.directory)
    } catch {
      return result
    }
    const sweepBucket = async (dir: string): Promise<void> => {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        return
      }
      for (const name of names) {
        const full = join(dir, name)
        if (name.startsWith('tmp-')) {
          await rm(full, { force: true }).then(
            () => { result.removedTemp += 1 },
            () => {},
          )
          continue
        }
        if (!name.endsWith('.drl')) continue
        const hash = name.slice(0, -'.drl'.length)
        if (reachable.has(hash)) continue
        try {
          const info = await stat(full)
          if (now - info.mtimeMs > graceMs) {
            await rm(full, { force: true }).then(
              () => { result.removedObjects += 1 },
              () => {},
            )
          }
        } catch {
          // Vanished mid-walk or unreadable: fail-soft, maybe next cycle.
        }
      }
    }
    const buckets = [] as Promise<void>[]
    for (const name of rootEntries) {
      const full = join(this.config.directory, name)
      if (/^[0-9a-f]{2}$/.test(name)) {
        buckets.push(sweepBucket(full))
        continue
      }
      // Crash debris can also sit directly in the objects root.
      if (name.startsWith('tmp-')) {
        await rm(full, { force: true }).then(
          () => { result.removedTemp += 1 },
          () => {},
        )
      }
    }
    await Promise.all(buckets)
    return result
  }

  /** Physical object census (count + bytes), failing soft to zeros. */
  async counts(): Promise<{ objects: number; bytes: number }> {
    let objects = 0
    let bytes = 0
    let rootEntries: string[]
    try {
      rootEntries = await readdir(this.config.directory)
    } catch {
      return { objects, bytes }
    }
    for (const name of rootEntries) {
      if (!/^[0-9a-f]{2}$/.test(name)) continue
      let files: string[] = []
      try {
        files = await readdir(join(this.config.directory, name))
      } catch {
        continue
      }
      for (const file of files) {
        if (!file.endsWith('.drl')) continue
        try {
          const info = await stat(join(this.config.directory, name, file))
          objects += 1
          bytes += info.size
        } catch {
          // Unreadable now, gone later: fine.
        }
      }
    }
    return { objects, bytes }
  }
}