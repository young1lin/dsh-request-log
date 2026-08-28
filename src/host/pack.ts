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

import { open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  decodeBlock,
  decompressBlock,
  encodeIndex,
  findInIndex,
  indexRecordAt,
  readIndexHeader,
  scanPack,
  type IndexRecord,
} from './pack-format'

export const DEFAULT_BLOCK_CACHE_BYTES = 16 * 1024 * 1024

export interface PackStoreConfig {
  directory: string
  blockCacheBytes?: number
}

export interface PackInfo { id: string; bytes: number; entryCount: number }

export class PackStore {
  private ids: string[] | undefined
  private readonly indexes = new Map<string, Buffer>()
  private readonly blocks = new Map<string, Buffer>()
  private blockBytes = 0
  private readonly blockBudget: number

  constructor(private readonly config: PackStoreConfig) {
    this.blockBudget = config.blockCacheBytes ?? DEFAULT_BLOCK_CACHE_BYTES
  }

  invalidate(): void {
    this.ids = undefined
    this.indexes.clear()
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
    let pack: Buffer
    try {
      pack = await readFile(packPath)
    } catch {
      return null
    }
    let index: Buffer | null = null
    try {
      const raw = await readFile(join(this.config.directory, `${id}.idx`))
      if (readIndexHeader(raw).packBytes === pack.length) index = raw
    } catch {
      index = null
    }
    if (index === null) {
      const { records } = scanPack(pack)
      index = encodeIndex(records, pack.length)
      await this.writeIndex(id, index)
    }
    this.indexes.set(id, index)
    return index
  }

  private async writeIndex(id: string, index: Buffer): Promise<void> {
    const temp = join(this.config.directory, `tmp-${randomUUID()}`)
    try {
      await writeFile(temp, index)
      await rename(temp, join(this.config.directory, `${id}.idx`))
    } catch {
      await rm(temp, { force: true }).catch(() => {})
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
      const buffer = Buffer.allocUnsafe(record.blockLength)
      await handle.read(buffer, 0, record.blockLength, record.blockOffset)
      const raw = decompressBlock(decodeBlock(buffer, 0))
      this.cacheBlock(key, raw)
      return raw
    } finally {
      await handle.close()
    }
  }

  private async locate(hash: string): Promise<{ id: string; record: IndexRecord } | null> {
    for (const id of await this.listIds()) {
      const index = await this.indexOf(id)
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
      this.invalidate()
      found = await this.locate(hash)
      if (found === null) return null
    }
    const raw = await this.blockRaw(found.id, found.record)
    return Buffer.from(raw.subarray(found.record.rawOffset, found.record.rawOffset + found.record.rawLength))
  }

  async has(hash: string): Promise<boolean> {
    if ((await this.locate(hash)) !== null) return true
    this.invalidate()
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
}
