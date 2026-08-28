/**
 * Pack byte codecs: one block is one compressed stream holding many objects,
 * preceded by an UNCOMPRESSED entry table naming them. That table is what
 * makes an index rebuildable from the pack alone, which is the whole
 * crash-recovery story — so it must never move inside the compressed payload.
 *
 * @module dsh-request-log/host/pack-format
 */

import { deflateRaw as deflateRawCallback, deflateRawSync, inflateRawSync } from 'node:zlib'
import * as zlib from 'node:zlib'
import { promisify } from 'node:util'
import { constants as bufferConstants } from 'node:buffer'

export const PACK_MAGIC = Buffer.from('DRP1', 'ascii')
export const PACK_VERSION = 1
export const PACK_HEADER_BYTES = 16

export const BLOCK_CODEC_DEFLATE = 1
export const BLOCK_CODEC_ZSTD = 2

/** Entry-table width: 32-byte hash + rawOffset + rawLength. */
const ENTRY_BYTES = 40
const BLOCK_PREAMBLE_BYTES = 7
export const MAX_BLOCK_ENTRIES = 4096

export interface BlockEntry { hash: string; rawOffset: number; rawLength: number }
export interface DecodedBlock {
  codec: number
  entries: BlockEntry[]
  payload: Buffer
  /** Bytes this block occupies, header included — how far to the next one. */
  totalLength: number
}

const ZSTD_LEVEL = 12

/** Not every supported Node exposes zstd; those runtimes still write packs. */
export function zstdAvailable(): boolean {
  return typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === 'function'
}

function compress(raw: Buffer): { codec: number; payload: Buffer } {
  if (!zstdAvailable()) return { codec: BLOCK_CODEC_DEFLATE, payload: deflateRawSync(raw, { level: 9 }) }
  const zstdCompressSync = (zlib as unknown as {
    zstdCompressSync: (buf: Buffer, opts?: unknown) => Buffer
  }).zstdCompressSync
  const params = { [zlib.constants.ZSTD_c_compressionLevel as number]: ZSTD_LEVEL }
  return { codec: BLOCK_CODEC_ZSTD, payload: zstdCompressSync(raw, { params }) }
}

const deflateRawPromise = promisify(deflateRawCallback)

type CompressAsync = (buf: Buffer, opts?: unknown) => Promise<Buffer>
/** undefined = not looked up yet; null = this runtime has no async zstd. */
let zstdCompressPromise: CompressAsync | null | undefined

function zstdCompressAsync(): CompressAsync | null {
  if (zstdCompressPromise === undefined) {
    const zstd = (zlib as {
      zstdCompress?: (buf: Buffer, opts: unknown, cb: (error: Error | null, out: Buffer) => void) => void
    }).zstdCompress
    zstdCompressPromise = typeof zstd === 'function' ? promisify(zstd) : null
  }
  return zstdCompressPromise
}

/**
 * The async face of {@link compress}. A sweep packs up to a full budget in
 * one cycle, and synchronous zstd-12 costs ~10 ms per MiB — a second or more
 * of continuous event-loop stall inside the web server. The thread pool keeps
 * it off the loop, the way the loose store has always compressed.
 */
async function compressAsync(raw: Buffer): Promise<{ codec: number; payload: Buffer }> {
  const zstd = zstdCompressAsync()
  if (zstd === null) {
    return { codec: BLOCK_CODEC_DEFLATE, payload: await deflateRawPromise(raw, { level: 9 }) }
  }
  const params = { [zlib.constants.ZSTD_c_compressionLevel as number]: ZSTD_LEVEL }
  return { codec: BLOCK_CODEC_ZSTD, payload: await zstd(raw, { params }) }
}

/** A hash that is not exactly this fills less than its slot — see encodeBlock. */
const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * The entry table both encoders share, zeroed: every byte of it is written to
 * a file, and a slot only partly filled would publish whatever the allocation
 * held. A hash that is not exactly 64 hex digits is refused — Buffer.from(
 * hash, 'hex') stops at the first invalid character and copies a short buffer,
 * which would silently write a valid-looking entry naming the wrong object.
 */
function buildEntryTable(objects: readonly { hash: string; raw: Buffer }[]): { table: Buffer; raws: Buffer[] } {
  if (objects.length === 0 || objects.length > MAX_BLOCK_ENTRIES) {
    throw new Error(`block entry count out of range: ${objects.length}`)
  }
  const table = Buffer.alloc(objects.length * ENTRY_BYTES)
  const raws: Buffer[] = []
  let rawOffset = 0
  for (const [i, object] of objects.entries()) {
    const at = i * ENTRY_BYTES
    if (!SHA256_HEX.test(object.hash)) {
      throw new Error(`block entry hash is not a sha256 hex string: ${object.hash}`)
    }
    Buffer.from(object.hash, 'hex').copy(table, at)
    table.writeUInt32BE(rawOffset, at + 32)
    table.writeUInt32BE(object.raw.length, at + 36)
    raws.push(object.raw)
    rawOffset += object.raw.length
  }
  return { table, raws }
}

function preambleOf(payloadLength: number, codec: number, entryCount: number): Buffer {
  const preamble = Buffer.allocUnsafe(BLOCK_PREAMBLE_BYTES)
  preamble.writeUInt32BE(payloadLength, 0)
  preamble.writeUInt8(codec, 4)
  preamble.writeUInt16BE(entryCount, 5)
  return preamble
}

export function encodeBlock(objects: readonly { hash: string; raw: Buffer }[]): Buffer {
  const { table, raws } = buildEntryTable(objects)
  const { codec, payload } = compress(Buffer.concat(raws))
  return Buffer.concat([preambleOf(payload.length, codec, objects.length), table, payload])
}

/**
 * The same framing as {@link encodeBlock} with the compression off the event
 * loop. The compressed bytes may differ slightly between the two paths (both
 * are valid level-12 zstd / level-9 deflateRaw); blocks are self-describing,
 * so a pack may hold either.
 */
export async function encodeBlockAsync(objects: readonly { hash: string; raw: Buffer }[]): Promise<Buffer> {
  const { table, raws } = buildEntryTable(objects)
  const { codec, payload } = await compressAsync(Buffer.concat(raws))
  return Buffer.concat([preambleOf(payload.length, codec, objects.length), table, payload])
}

export function decodeBlock(buffer: Buffer, at: number): DecodedBlock {
  if (at + BLOCK_PREAMBLE_BYTES > buffer.length) throw new Error('block truncated before its preamble')
  const payloadLength = buffer.readUInt32BE(at)
  const codec = buffer.readUInt8(at + 4)
  const entryCount = buffer.readUInt16BE(at + 5)
  if (codec !== BLOCK_CODEC_DEFLATE && codec !== BLOCK_CODEC_ZSTD) throw new Error(`unknown block codec ${codec}`)
  if (entryCount === 0 || entryCount > MAX_BLOCK_ENTRIES) throw new Error(`block entry count out of range: ${entryCount}`)
  const tableAt = at + BLOCK_PREAMBLE_BYTES
  const payloadAt = tableAt + entryCount * ENTRY_BYTES
  const totalLength = payloadAt + payloadLength - at
  if (at + totalLength > buffer.length) throw new Error('block truncated before its payload ends')
  const entries: BlockEntry[] = []
  for (let i = 0; i < entryCount; i += 1) {
    const entryAt = tableAt + i * ENTRY_BYTES
    entries.push({
      hash: buffer.subarray(entryAt, entryAt + 32).toString('hex'),
      rawOffset: buffer.readUInt32BE(entryAt + 32),
      rawLength: buffer.readUInt32BE(entryAt + 36),
    })
  }
  return { codec, entries, payload: buffer.subarray(payloadAt, payloadAt + payloadLength), totalLength }
}

export function decompressBlock(block: DecodedBlock): Buffer {
  // The entry table names the exact output size. Handing it to the inflater
  // bounds a corrupt payload — which expands without limit and is only hash-
  // checked afterwards — the same way the loose store bounds its own objects.
  const maxOutputLength = Math.min(
    block.entries.reduce((sum, entry) => sum + entry.rawLength, 0),
    bufferConstants.MAX_LENGTH,
  )
  if (block.codec === BLOCK_CODEC_DEFLATE) return inflateRawSync(block.payload, { maxOutputLength })
  const zstdDecompressSync = (zlib as unknown as {
    zstdDecompressSync: (buf: Buffer, opts?: { maxOutputLength?: number }) => Buffer
  }).zstdDecompressSync
  return zstdDecompressSync(block.payload, { maxOutputLength })
}

export const IDX_MAGIC = Buffer.from('DRI1', 'ascii')
export const IDX_VERSION = 1
export const IDX_HEADER_BYTES = 16
export const IDX_RECORD_BYTES = 48

export interface IndexRecord {
  hash: string
  blockOffset: number
  blockLength: number
  rawOffset: number
  rawLength: number
}

/**
 * The index is searched as BYTES, never deserialized: a pack holding 128k
 * objects costs one 6 MB buffer instead of 128k JS objects, and a lookup is a
 * binary search over fixed 48-byte slots.
 */
export function encodeIndex(records: readonly IndexRecord[], packBytes: number): Buffer {
  const sorted = [...records].sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
  const buffer = Buffer.alloc(IDX_HEADER_BYTES + sorted.length * IDX_RECORD_BYTES)
  IDX_MAGIC.copy(buffer, 0)
  buffer.writeUInt8(IDX_VERSION, 4)
  buffer.writeUInt32BE(sorted.length, 8)
  buffer.writeUInt32BE(packBytes, 12)
  for (const [i, record] of sorted.entries()) {
    const at = IDX_HEADER_BYTES + i * IDX_RECORD_BYTES
    // Same refusal as buildEntryTable: a short hex copy would leave zero fill
    // in the slot, and a record the binary search can never find.
    if (!SHA256_HEX.test(record.hash)) {
      throw new Error(`index record hash is not a sha256 hex string: ${record.hash}`)
    }
    Buffer.from(record.hash, 'hex').copy(buffer, at)
    buffer.writeUInt32BE(record.blockOffset, at + 32)
    buffer.writeUInt32BE(record.blockLength, at + 36)
    buffer.writeUInt32BE(record.rawOffset, at + 40)
    buffer.writeUInt32BE(record.rawLength, at + 44)
  }
  return buffer
}

export function readIndexHeader(buffer: Buffer): { recordCount: number; packBytes: number } {
  if (buffer.length < IDX_HEADER_BYTES) throw new Error('index shorter than its header')
  if (!buffer.subarray(0, 4).equals(IDX_MAGIC)) throw new Error('index magic mismatch')
  if (buffer.readUInt8(4) !== IDX_VERSION) throw new Error(`unknown index version ${buffer.readUInt8(4)}`)
  const recordCount = buffer.readUInt32BE(8)
  // A crash-truncated body would otherwise binary-search slots that are not
  // there: every lookup silently misses forever, because packBytes still
  // matches the pack and nothing ever rebuilds the index.
  if (buffer.length !== IDX_HEADER_BYTES + recordCount * IDX_RECORD_BYTES) {
    throw new Error(`index holds ${buffer.length} bytes for ${recordCount} records`)
  }
  return { recordCount, packBytes: buffer.readUInt32BE(12) }
}

export function indexRecordAt(buffer: Buffer, i: number): IndexRecord {
  const at = IDX_HEADER_BYTES + i * IDX_RECORD_BYTES
  return {
    hash: buffer.subarray(at, at + 32).toString('hex'),
    blockOffset: buffer.readUInt32BE(at + 32),
    blockLength: buffer.readUInt32BE(at + 36),
    rawOffset: buffer.readUInt32BE(at + 40),
    rawLength: buffer.readUInt32BE(at + 44),
  }
}

export function findInIndex(buffer: Buffer, hash: string): IndexRecord | null {
  if (!SHA256_HEX.test(hash)) return null // a key no index of ours can hold
  const { recordCount } = readIndexHeader(buffer)
  const needle = Buffer.from(hash, 'hex')
  let low = 0
  let high = recordCount - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const at = IDX_HEADER_BYTES + mid * IDX_RECORD_BYTES
    const cmp = Buffer.compare(buffer.subarray(at, at + 32), needle)
    if (cmp === 0) return indexRecordAt(buffer, mid)
    if (cmp < 0) low = mid + 1
    else high = mid - 1
  }
  return null
}

export function encodePackHeader(): Buffer {
  const header = Buffer.alloc(PACK_HEADER_BYTES)
  PACK_MAGIC.copy(header, 0)
  header.writeUInt8(PACK_VERSION, 4)
  return header
}

export function readPackHeader(buffer: Buffer): void {
  if (buffer.length < PACK_HEADER_BYTES) throw new Error('pack shorter than its header')
  if (!buffer.subarray(0, 4).equals(PACK_MAGIC)) throw new Error('pack magic mismatch')
  if (buffer.readUInt8(4) !== PACK_VERSION) throw new Error(`unknown pack version ${buffer.readUInt8(4)}`)
}

/**
 * Rebuild what an index would hold by walking the blocks themselves. A torn
 * tail — the half-written block a crash left behind — ends the walk without
 * discarding the blocks before it: those objects are intact and may already
 * have had their loose copies deleted.
 */
export function scanPack(buffer: Buffer): { records: IndexRecord[]; scannedBytes: number } {
  readPackHeader(buffer)
  const { records, scannedBytes } = scanBlocks(buffer.subarray(PACK_HEADER_BYTES), PACK_HEADER_BYTES)
  return { records, scannedBytes: PACK_HEADER_BYTES + scannedBytes }
}

/**
 * The same walk over a bare run of blocks that will live at `baseOffset` in
 * a pack. An append knows exactly where its own blocks landed, so it can
 * index them without reading back the pack they were added to.
 */
export function scanBlocks(buffer: Buffer, baseOffset: number): { records: IndexRecord[]; scannedBytes: number } {
  const records: IndexRecord[] = []
  let at = 0
  while (at < buffer.length) {
    let block: DecodedBlock
    try {
      block = decodeBlock(buffer, at)
    } catch {
      break
    }
    for (const entry of block.entries) {
      records.push({
        hash: entry.hash,
        blockOffset: baseOffset + at,
        blockLength: block.totalLength,
        rawOffset: entry.rawOffset,
        rawLength: entry.rawLength,
      })
    }
    at += block.totalLength
  }
  return { records, scannedBytes: at }
}
