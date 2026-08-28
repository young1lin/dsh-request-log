/**
 * Pack byte codecs: one block is one compressed stream holding many objects,
 * preceded by an UNCOMPRESSED entry table naming them. That table is what
 * makes an index rebuildable from the pack alone, which is the whole
 * crash-recovery story — so it must never move inside the compressed payload.
 *
 * @module dsh-request-log/host/pack-format
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib'
import * as zlib from 'node:zlib'

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

export function encodeBlock(objects: readonly { hash: string; raw: Buffer }[]): Buffer {
  if (objects.length === 0 || objects.length > MAX_BLOCK_ENTRIES) {
    throw new Error(`block entry count out of range: ${objects.length}`)
  }
  const table = Buffer.allocUnsafe(objects.length * ENTRY_BYTES)
  const raws: Buffer[] = []
  let rawOffset = 0
  for (const [i, object] of objects.entries()) {
    const at = i * ENTRY_BYTES
    Buffer.from(object.hash, 'hex').copy(table, at)
    table.writeUInt32BE(rawOffset, at + 32)
    table.writeUInt32BE(object.raw.length, at + 36)
    raws.push(object.raw)
    rawOffset += object.raw.length
  }
  const { codec, payload } = compress(Buffer.concat(raws))
  const preamble = Buffer.allocUnsafe(BLOCK_PREAMBLE_BYTES)
  preamble.writeUInt32BE(payload.length, 0)
  preamble.writeUInt8(codec, 4)
  preamble.writeUInt16BE(objects.length, 5)
  return Buffer.concat([preamble, table, payload])
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
  if (block.codec === BLOCK_CODEC_DEFLATE) return inflateRawSync(block.payload)
  const zstdDecompressSync = (zlib as unknown as {
    zstdDecompressSync: (buf: Buffer) => Buffer
  }).zstdDecompressSync
  return zstdDecompressSync(block.payload)
}
