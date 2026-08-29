// src/host/pack.ts
/**
 * Pack storage: immutable append-only files holding many objects each, with a
 * rebuildable index. The write path never touches these — objects arrive
 * loose and the sweep moves the cold ones here — so everything in this module
 * runs off the hot path.
 *
 * Indexes are cached as raw buffers and searched in place; blocks are cached
 * decompressed under a byte budget, because one detail read touches many
 * objects that live in the same two or three blocks.
 *
 * @module dsh-request-log/host/pack
 */

import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setImmediate as setImmediateSoon } from 'node:timers/promises'
import {
  decodeBlock,
  decompressBlock,
  encodeBlockAsync,
  encodeIndex,
  encodePackHeader,
  findInIndex,
  indexRecordAt,
  MAX_BLOCK_ENTRIES,
  PACK_HEADER_BYTES,
  readIndexHeader,
  scanBlocks,
  scanPack,
  type IndexRecord,
} from './pack-format'

export const DEFAULT_BLOCK_CACHE_BYTES = 16 * 1024 * 1024
export const DEFAULT_MAX_PACK_BYTES = 64 * 1024 * 1024
/** Staging debris younger than this may still be someone's live write. */
export const DEFAULT_PACK_DEBRIS_GRACE_MS = 60 * 60 * 1000

export interface PackStoreConfig {
  directory: string
  blockCacheBytes?: number
  maxPackBytes?: number
  /**
   * Where a fault this store works around goes to be seen. Everything here
   * degrades one pack rather than the lookup, which is right — and silent,
   * which is not: a corrupt index would otherwise read as "not packed here"
   * forever, with nothing on /health to say so.
   */
  onError?: (stage: string, error: unknown) => void
}

export interface AppendResult {
  id: string
  packedBytes: number
  entryCount: number
  /**
   * Whether the index rewrite landed. False is not a failure of the append —
   * the pack is durable and the index rebuilds from it — but the caller may
   * want to surface it instead of trusting "both durable" silently.
   */
  indexWritten: boolean
}

export interface PackInfo { id: string; bytes: number; entryCount: number }

export class PackStore {
  private ids: string[] | undefined
  private readonly indexes = new Map<string, Buffer>()
  private readonly blocks = new Map<string, Buffer>()
  private blockBytes = 0
  private readonly blockBudget: number
  /** Packs barred from receiving appends (they are being replaced). */
  private readonly sealed = new Set<string>()

  constructor(private readonly config: PackStoreConfig) {
    this.blockBudget = config.blockCacheBytes ?? DEFAULT_BLOCK_CACHE_BYTES
  }

  invalidate(): void {
    this.ids = undefined
    this.indexes.clear()
  }

  /**
   * Forget only which packs exist, keeping every index already loaded. Packs
   * are immutable, so a cached index stays correct for as long as its pack
   * lives; a lookup that missed needs a fresh LISTING, never fresh indexes.
   * Conflating the two is what would make a miss - every new object the append
   * path writes - reload every index in the store.
   */
  private forgetListing(): void {
    this.ids = undefined
  }

  /** Pack ids present and not retired, oldest first (names sort by time). */
  private async listIds(): Promise<string[]> {
    if (this.ids !== undefined) return this.ids
    let names: string[]
    try {
      names = await readdir(this.config.directory)
    } catch {
      this.ids = []
      return this.ids
    }
    const retired = new Set(names.filter(n => n.endsWith('.retired')).map(n => n.slice(0, -'.retired'.length)))
    // Seals an earlier process wrote: those packs end in bytes that will not
    // decode, and are appendable never again however many restarts pass.
    for (const name of names) {
      if (name.endsWith('.sealed')) this.sealed.add(name.slice(0, -'.sealed'.length))
    }
    this.ids = names
      .filter(n => n.endsWith('.pack'))
      .map(n => n.slice(0, -'.pack'.length))
      .filter(id => !retired.has(id))
      .sort()
    return this.ids
  }

  /**
   * The index for one pack, rebuilt from the pack whenever it is missing,
   * unreadable, or older than the pack it describes. Rebuilding is the
   * recovery path for a crash between appending a block and rewriting the
   * index, so it must never be treated as an error.
   */
  private async indexOf(id: string): Promise<Buffer | null> {
    const cached = this.indexes.get(id)
    if (cached !== undefined) return cached
    const packPath = join(this.config.directory, `${id}.pack`)
    // Only the pack's LENGTH decides whether an index is current, and reading
    // the pack to learn it would charge its whole size to every lookup that
    // had to load an index.
    const info = await stat(packPath).catch(() => null)
    if (info === null) return null
    let index: Buffer | null = null
    try {
      const raw = await readFile(join(this.config.directory, `${id}.idx`))
      if (readIndexHeader(raw).packBytes === info.size) index = raw
    } catch {
      index = null
    }
    if (index === null) {
      const pack = await readFile(packPath).catch(() => null)
      if (pack === null) return null
      const { records, scannedBytes } = scanPack(pack)
      // A tail that will not decode is a torn write. Appending after it would
      // index blocks that every future rebuild silently drops — the walk stops
      // at the tear — while the loose copies of those blocks are already gone.
      // Sealing keeps the pack readable forever and sends appends elsewhere.
      // packBytes still names the full length: the file never changes again,
      // so the staleness check stays sound and rebuilds stay deterministic.
      if (scannedBytes < pack.length) await this.sealTorn(id)
      index = encodeIndex(records, pack.length)
      await this.writeIndex(id, index)
    }
    this.indexes.set(id, index)
    return index
  }

  private async writeIndex(id: string, index: Buffer): Promise<boolean> {
    const temp = join(this.config.directory, `tmp-${randomUUID()}`)
    try {
      const handle = await open(temp, 'w', 0o600)
      try {
        await handle.writeFile(index)
        // Sync the DATA before the rename publishes it: a rename alone journals
        // the directory entry, and a header-intact body-truncated (or zero-
        // tailed) index would pass the packBytes check forever.
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temp, join(this.config.directory, `${id}.idx`))
      return true
    } catch {
      await rm(temp, { force: true }).catch(() => {})
      return false
    }
  }

  private cacheBlock(key: string, raw: Buffer): void {
    if (raw.length > this.blockBudget) return
    this.blocks.set(key, raw)
    this.blockBytes += raw.length
    while (this.blockBytes > this.blockBudget) {
      const oldest = this.blocks.keys().next().value
      if (oldest === undefined) break
      this.blockBytes -= this.blocks.get(oldest)?.length ?? 0
      this.blocks.delete(oldest)
    }
  }

  private async blockRaw(id: string, record: IndexRecord): Promise<Buffer> {
    const key = `${id}:${record.blockOffset}`
    const hit = this.blocks.get(key)
    if (hit !== undefined) {
      this.blocks.delete(key)
      this.blocks.set(key, hit)
      return hit
    }
    const handle = await open(join(this.config.directory, `${id}.pack`), 'r')
    try {
      // The index is trusted data, but it is still disk bytes: an extent that
      // runs past the file is a corrupt record, and allocating it first would
      // hand a multi-GiB allocUnsafe to a pack that cannot satisfy it.
      const { size } = await handle.stat()
      if (record.blockOffset + record.blockLength > size) {
        throw new Error(
          `pack ${id} index extent past its end: block at ${record.blockOffset} needs ${record.blockLength} of ${size} bytes`,
        )
      }
      const buffer = Buffer.allocUnsafe(record.blockLength)
      const { bytesRead } = await handle.read(buffer, 0, record.blockLength, record.blockOffset)
      // A short read leaves the rest of an allocUnsafe buffer holding whatever
      // was in that memory; decompressing it would fail somewhere far from
      // here, naming zlib rather than the pack that is actually truncated.
      if (bytesRead !== record.blockLength) {
        throw new Error(
          `pack ${id} truncated: block at ${record.blockOffset} needs ${record.blockLength} bytes, read ${bytesRead}`,
        )
      }
      const raw = decompressBlock(decodeBlock(buffer, 0))
      this.cacheBlock(key, raw)
      return raw
    } finally {
      await handle.close()
    }
  }

  private async locate(hash: string): Promise<{ id: string; record: IndexRecord } | null> {
    for (const id of await this.listIds()) {
      // An index that will not load (an empty pack a crash left mid-create, a
      // walk that will not parse) must degrade ITS pack, not every lookup —
      // but not silently either, or the pack reads as "nothing here" forever.
      const index = await this.indexOf(id).catch((error: unknown) => {
        this.config.onError?.(`pack ${id} index`, error)
        return null
      })
      if (index === null) continue
      const record = findInIndex(index, hash)
      if (record !== null) return { id, record }
    }
    return null
  }

  async read(hash: string): Promise<Buffer | null> {
    let found = await this.locate(hash)
    if (found === null) {
      // A repack may have landed a new pack since the listing was cached.
      this.forgetListing()
      found = await this.locate(hash)
      if (found === null) return null
    }
    const raw = await this.blockRaw(found.id, found.record)
    return Buffer.from(raw.subarray(found.record.rawOffset, found.record.rawOffset + found.record.rawLength))
  }

  async has(hash: string): Promise<boolean> {
    if ((await this.locate(hash)) !== null) return true
    this.forgetListing()
    return (await this.locate(hash)) !== null
  }

  async list(): Promise<PackInfo[]> {
    const infos: PackInfo[] = []
    for (const id of await this.listIds()) {
      const index = await this.indexOf(id)
      if (index === null) continue
      const { recordCount, packBytes } = readIndexHeader(index)
      infos.push({ id, bytes: packBytes, entryCount: recordCount })
    }
    return infos
  }

  /** Every hash one pack holds, in the order it was stored. */
  async entriesOf(id: string): Promise<string[]> {
    const index = await this.indexOf(id)
    if (index === null) return []
    const { recordCount } = readIndexHeader(index)
    const records: IndexRecord[] = []
    for (let i = 0; i < recordCount; i += 1) records.push(indexRecordAt(index, i))
    records.sort((a, b) => a.blockOffset - b.blockOffset || a.rawOffset - b.rawOffset)
    return records.map(record => record.hash)
  }

  private async ensureDirectory(): Promise<void> {
    // Owner-only where the platform honors modes (POSIX): pack bytes are
    // the conversation plaintext, compressed — not encrypted.
    await mkdir(this.config.directory, { recursive: true, mode: 0o700 })
  }

  /** The pack to append to: the newest one still under the size ceiling. */
  private async activePack(): Promise<{ id: string; bytes: number }> {
    const ids = await this.listIds()
    const newest = ids.filter(id => !this.sealed.has(id)).at(-1)
    if (newest !== undefined) {
      const info = await stat(join(this.config.directory, `${newest}.pack`)).catch(() => null)
      if (info !== null && info.size < (this.config.maxPackBytes ?? DEFAULT_MAX_PACK_BYTES)) {
        return { id: newest, bytes: info.size }
      }
    }
    const id = `pack-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
    await writeFile(join(this.config.directory, `${id}.pack`), encodePackHeader(), { flag: 'wx', mode: 0o600 })
    await this.syncDirectory()
    this.ids = undefined
    return { id, bytes: PACK_HEADER_BYTES }
  }

  /**
   * Flush the directory entry itself. Syncing the file promises its CONTENT
   * survives a crash, not its NAME — and a pack the sweep is about to delete
   * loose copies for must exist by name afterwards. Not every platform lets a
   * directory be opened; where it cannot, its metadata journal is the promise.
   */
  private async syncDirectory(): Promise<void> {
    const handle = await open(this.config.directory, 'r').catch(() => null)
    if (handle === null) return
    try {
      await handle.sync()
    } catch {
      // Directory fsync unsupported here; nothing else to try.
    } finally {
      await handle.close()
    }
  }

  async append(objects: readonly { hash: string; raw: Buffer }[], blockBytes: number): Promise<AppendResult> {
    await this.ensureDirectory()
    let active = await this.activePack()
    let prior = active.bytes === PACK_HEADER_BYTES ? [] : await this.recordsOf(active.id)
    // recordsOf may have rebuilt an index and SEALed the pack it read (a torn
    // tail was found). Appending after undecodable bytes would index blocks a
    // later rebuild drops while their loose copies are being deleted, so start
    // over: each iteration seals one more pack, and a fresh pack never is.
    while (this.sealed.has(active.id)) {
      active = await this.activePack()
      prior = active.bytes === PACK_HEADER_BYTES ? [] : await this.recordsOf(active.id)
    }
    const { id, bytes: startAt } = active
    const path = join(this.config.directory, `${id}.pack`)

    const blocks: Buffer[] = []
    let group: { hash: string; raw: Buffer }[] = []
    let groupBytes = 0
    const cut = async (): Promise<void> => {
      if (group.length === 0) return
      blocks.push(await encodeBlockAsync(group))
      group = []
      groupBytes = 0
      // A full budget's worth of blocks must not become one continuous event-
      // loop stall: compression itself is on the thread pool, and this yield
      // keeps even the sync fallback path serving requests between blocks.
      await setImmediateSoon()
    }
    for (const object of objects) {
      group.push(object)
      groupBytes += object.raw.length
      if (groupBytes >= blockBytes || group.length >= MAX_BLOCK_ENTRIES) await cut()
    }
    await cut()

    // Durability order is the invariant: pack bytes first and fsynced, index
    // second. A crash between them leaves an index the reader rebuilds; the
    // reverse would leave an index pointing at bytes that never landed.
    const appended = Buffer.concat(blocks)
    const handle = await open(path, 'a', 0o600)
    let packBytes: number
    try {
      await handle.writeFile(appended)
      await handle.sync()
      packBytes = (await handle.stat()).size
    } finally {
      await handle.close()
    }

    // The prior index plus the blocks just written IS the whole index, as long
    // as the pack ended up exactly as long as this append implies. When it did
    // not - an index that would not load, or a file some other writer grew -
    // the pack itself is the authority and gets read back in full.
    let records: IndexRecord[] | null = null
    if (prior !== null && packBytes === startAt + appended.length) {
      records = [...prior, ...scanBlocks(appended, startAt).records]
    }
    if (records === null) {
      const pack = await readFile(path)
      const scanned = scanPack(pack)
      if (scanned.scannedBytes < pack.length) await this.sealTorn(id)
      records = scanned.records
      packBytes = pack.length
    }
    this.indexes.delete(id)
    const indexWritten = await this.writeIndex(id, encodeIndex(records, packBytes))
    this.indexes.delete(id)
    return { id, packedBytes: packBytes, entryCount: records.length, indexWritten }
  }

  /** Every record an index holds, decoded — the base a fresh append extends. */
  private async recordsOf(id: string): Promise<IndexRecord[] | null> {
    // The one caller a cached index may lie to: a torn tail (an ENOSPC
    // partial write, say) grew the pack after the cache was built without
    // the process dying, and appending after that tear is exactly what a
    // later rebuild drops. The index FILE is the truth — it is rewritten on
    // every append — so drop the cache and let indexOf reload or rebuild
    // (which seals the pack when the walk stops short of the file's end).
    this.indexes.delete(id)
    const index = await this.indexOf(id)
    if (index === null) return null
    const { recordCount } = readIndexHeader(index)
    const records: IndexRecord[] = []
    for (let i = 0; i < recordCount; i += 1) records.push(indexRecordAt(index, i))
    return records
  }

  /** Bar a pack from receiving appends (it is being replaced). */
  seal(id: string): void {
    this.sealed.add(id)
  }

  /**
   * Bar a torn pack from appends in this process AND every later one. A
   * repack's seal lasts seconds, so memory is enough for it; a tear lasts
   * forever, and memory is exactly what a restart forgets. Nothing would
   * rediscover it either: the index this rebuild is about to write names the
   * pack's full length, tear included, so the staleness check passes from
   * here on and the pack is never rescanned. The marker is fsynced BEFORE
   * that index exists, so no crash can leave one without the other.
   */
  private async sealTorn(id: string): Promise<void> {
    this.sealed.add(id)
    try {
      const handle = await open(join(this.config.directory, `${id}.sealed`), 'w', 0o600)
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.syncDirectory()
    } catch (error) {
      this.config.onError?.(`pack ${id} seal`, error)
    }
  }

  /** Mark a pack unreadable to this and every other process, atomically. */
  async retire(id: string): Promise<void> {
    await writeFile(join(this.config.directory, `${id}.retired`), '', { mode: 0o600 })
    this.invalidate()
  }

  /**
   * Delete retired packs, and the staging debris a crash between an index's
   * write and its rename leaves behind. Both wait out the grace floor: debris
   * may be a live write, and a fresh retire's replacement (the loose copies an
   * unpack just wrote back, fsync-less) may not be durable yet. Best-effort by
   * design: on Windows a reader may still hold the handle, and the next sweep
   * will try again.
   *
   * The loose GC only descends into the object store's 2-hex buckets, which
   * is what keeps it away from this directory — so nothing but this reaps
   * here, and debris would otherwise accumulate for the life of the store.
   */
  async reapRetired(now: number = Date.now(), graceMs: number = DEFAULT_PACK_DEBRIS_GRACE_MS): Promise<number> {
    let names: string[]
    try {
      names = await readdir(this.config.directory)
    } catch {
      return 0
    }
    let reaped = 0
    for (const name of names) {
      if (name.startsWith('tmp-')) {
        // Younger than the floor: it may be an index being written right now.
        const info = await stat(join(this.config.directory, name)).catch(() => null)
        if (info !== null && now - info.mtimeMs > graceMs) {
          await rm(join(this.config.directory, name), { force: true }).catch(() => {})
        }
        continue
      }
      if (!name.endsWith('.retired')) continue
      const id = name.slice(0, -'.retired'.length)
      // The same grace floor as staging debris: an unpack retires a pack the
      // same cycle it writes the loose copies back — fsync-less — and deleting
      // the pack before those bytes land would leave neither copy durable.
      const marker = await stat(join(this.config.directory, name)).catch(() => null)
      if (marker !== null && now - marker.mtimeMs <= graceMs) continue
      const removed = await Promise.all([
        rm(join(this.config.directory, `${id}.pack`), { force: true }).then(() => true, () => false),
        rm(join(this.config.directory, `${id}.idx`), { force: true }).then(() => true, () => false),
        // A torn pack that gets repacked away takes its seal marker with it.
        rm(join(this.config.directory, `${id}.sealed`), { force: true }).then(() => true, () => false),
      ])
      if (removed.every(Boolean)) {
        await rm(join(this.config.directory, name), { force: true }).catch(() => {})
        reaped += 1
      }
    }
    if (reaped > 0) this.invalidate()
    return reaped
  }
}
