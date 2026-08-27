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
 * with an mtime grace floor so appends racing a sweep never lose data - a
 * deduplicated re-reference touches that mtime back over the floor, since it
 * writes nothing that would refresh it on its own.
 *
 * @module dsh-request-log/host/blob
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
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
/**
 * A dedup hit re-touches an object whose mtime is older than this. Half the
 * grace floor: old enough that the hot path never touches, recent enough that
 * a touched object stays clear of the floor until the next hit.
 */
export const DEFAULT_TOUCH_AFTER_MS = DEFAULT_GC_GRACE_MS / 2

export interface BlobStoreConfig {
  /** The OBJECTS ROOT directory (the caller owns its placement). */
  directory: string
  cacheBytes?: number
  maxChunkBytes?: number
  deflateLevel?: number
  touchAfterMs?: number
}

/**
 * This store refused to materialize an object. Distinct from corruption: the
 * stored bytes may be perfectly valid under the config that baked them, so
 * the self-heal must not treat it as proof to delete.
 */
class ObjectCeilingError extends Error {}

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

/** What one {@link BlobStore.put} did: the payload size, and whether it wrote. */
export interface PutResult {
  /** Compressed payload length — the envelope's byte accounting unit. */
  z: number
  /** True only when THIS call materialized the object. */
  created: boolean
}

export class BlobStore {
  private readonly lru: ByteBudgetLru
  /** Deflate calls actually performed (diagnostics: dedup effectiveness). */
  private deflates = 0
  private readonly maxChunkBytes: number
  private readonly deflateLevel: number
  private readonly touchAfterMs: number
  private readonly readyBuckets = new Set<string>()
  private mkdirPromise: Promise<void> | undefined

  constructor(private readonly config: BlobStoreConfig) {
    this.lru = new ByteBudgetLru(config.cacheBytes ?? DEFAULT_BLOB_CACHE_BYTES)
    this.maxChunkBytes = config.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES
    this.deflateLevel = config.deflateLevel ?? DEFAULT_DEFLATE_LEVEL
    this.touchAfterMs = config.touchAfterMs ?? DEFAULT_TOUCH_AFTER_MS
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
    return (await this.infoOf(hash)) !== null
  }

  /**
   * The stored payload length and mtime of an existing object, or null when
   * it is absent (or too short to hold a frame at all - a truncated leftover
   * is treated as absent so the next put rewrites it). The frame preamble is
   * fixed-width and the payload is the whole rest of the file, so `z` here is
   * the exact value a fresh compression would report - WITHOUT compressing.
   */
  private async infoOf(hash: string): Promise<{ z: number; mtimeMs: number } | null> {
    try {
      const { size, mtimeMs } = await stat(this.pathOf(hash))
      return size > FRAME_HEADER_BYTES ? { z: size - FRAME_HEADER_BYTES, mtimeMs } : null
    } catch {
      return null
    }
  }

  /**
   * A dedup hit writes nothing, so an object keeps its CREATION mtime however
   * often it is re-referenced. GC deletes unreachable objects past the grace
   * floor, and a sweep fixes its reachable set BEFORE this append's envelope
   * line lands: an object that only the pending line will reference would be
   * swept out from under it. Lift the mtime back over the floor - but only
   * when the stat this put already performed says it is needed, so the
   * hottest branch of the append path stays at one syscall.
   */
  private async touchIfStale(hash: string, mtimeMs: number): Promise<void> {
    if (Date.now() - mtimeMs <= this.touchAfterMs) return
    const now = new Date()
    await utimes(this.pathOf(hash), now, now).catch(() => {})
  }

  /**
   * Materialize one immutable object for raw content. Reports the COMPRESSED
   * payload length and whether this call did the writing. Duplicates of an
   * existing hash cost one stat: consecutive calls resend nearly the whole
   * conversation, so compressing a piece already on disk just to measure z
   * would spend the entire cost dedup exists to remove. Throws when the write
   * genuinely failed AND the object is absent afterwards, so callers never
   * persist an envelope referencing an unbaked hash.
   */
  async put(hash: string, raw: string | Buffer): Promise<PutResult> {
    const buf = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw
    if (hashOfContent(buf) !== hash) throw new Error('blob put rejected: hash/content mismatch')
    const existing = await this.infoOf(hash)
    if (existing !== null) {
      await this.touchIfStale(hash, existing.mtimeMs)
      return { z: existing.z, created: false }
    }
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
    const landed = await this.infoOf(hash)
    if (landed === null) throw new Error(`blob object write failed for ${hash}`)
    return { z: landed.z, created: true }
  }

  /**
   * Read one object, verify its frame magic + content hash, inflate, and
   * serve from the LRU next time. Any corruption (magic, codec, hash
   * mismatch, oversized declared payload) throws - wrong data is impossible;
   * missing data degrades at the CALLER (fail-soft slots), never here.
   *
   * Corruption also DELETES the object: put() short-circuits on a stat, so a
   * damaged file the right length would otherwise freeze every future append
   * into re-referencing a record that can never be read again.
   */
  async get(hash: string): Promise<Buffer> {
    const cached = this.lru.get(hash)
    if (cached !== undefined) return cached
    const frame = await readFile(this.pathOf(hash))
    let raw: Buffer
    try {
      const { codec, payload } = decodeFrame(frame)
      // Declared-size sanity gate applies to INFLATING only: identity payloads
      // are already materialized bytes bounded by the file itself.
      if (codec === CODEC_IDENTITY) {
        raw = Buffer.from(payload)
      } else {
        // Compressed length bounds nothing - a corrupt or crafted payload
        // expands without limit, and the hash check only runs afterwards, so
        // the ceiling has to be handed to the inflater itself. Every
        // deflate-coded object was raw-smaller than it by construction.
        if (payload.length > this.maxChunkBytes) {
          throw new ObjectCeilingError(`oversized object payload for ${hash}`)
        }
        raw = await inflateRaw(payload, { maxOutputLength: this.maxChunkBytes }).catch((error: unknown) => {
          const code = (error as NodeJS.ErrnoException | null)?.code
          if (code !== 'ERR_BUFFER_TOO_LARGE') throw error
          throw new ObjectCeilingError(`${(error as Error).message} (object ${hash})`)
        })
      }
      if (hashOfContent(raw) !== hash) throw new Error(`object content hash mismatch for ${hash}`)
    } catch (error) {
      // A ceiling rejection is this store's policy, not proof the bytes are
      // wrong: lowering maxChunkBytes must never delete objects baked under a
      // higher one. Everything else here IS proof - drop it so the next put
      // re-bakes the content from the caller's own copy.
      if (!(error instanceof ObjectCeilingError)) {
        await rm(this.pathOf(hash), { force: true }).catch(() => {})
      }
      throw error
    }
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
   * Is this path older than the grace floor? Unreadable or vanished counts as
   * NOT stale: GC then only ever risks sparing a file, never deleting a live
   * one. Fail-soft, retried next cycle.
   */
  private async pastGraceFloor(path: string, now: number, graceMs: number): Promise<boolean> {
    try {
      return now - (await stat(path)).mtimeMs > graceMs
    } catch {
      return false
    }
  }

  /**
   * Mark-sweep GC: delete every .drl object NOT in reachable whose mtime
   * predates the grace floor (fresh objects may belong to an append that has
   * not yet written its envelope line), plus leftover tmp-* debris under the
   * same floor - a staging file is renamed into place within one put, so a
   * young one belongs to a put in flight and deleting it fails that bake.
   * One unreadable entry never aborts the walk.
   */
  async gc(reachable: ReadonlySet<string>, now: number, graceMs: number = DEFAULT_GC_GRACE_MS): Promise<GcResult> {
    const result = { removedObjects: 0, removedTemp: 0 }
    let rootEntries: string[]
    try {
      rootEntries = await readdir(this.config.directory)
    } catch {
      return result
    }
    const reapTemp = async (full: string): Promise<void> => {
      if (!(await this.pastGraceFloor(full, now, graceMs))) return
      await rm(full, { force: true }).then(
        () => { result.removedTemp += 1 },
        () => {},
      )
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
          await reapTemp(full)
          continue
        }
        if (!name.endsWith('.drl')) continue
        const hash = name.slice(0, -'.drl'.length)
        if (reachable.has(hash)) continue
        if (!(await this.pastGraceFloor(full, now, graceMs))) continue
        await rm(full, { force: true }).then(
          () => { result.removedObjects += 1 },
          () => {},
        )
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
      if (name.startsWith('tmp-')) await reapTemp(full)
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