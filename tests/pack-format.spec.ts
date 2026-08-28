import { describe, expect, it } from 'vitest'
import { hashOfContent } from '../src/host/blob.ts'
import {
  BLOCK_CODEC_DEFLATE,
  BLOCK_CODEC_ZSTD,
  decodeBlock,
  decompressBlock,
  encodeBlock,
  encodeIndex,
  encodePackHeader,
  findInIndex,
  indexRecordAt,
  readPackHeader,
  readIndexHeader,
  scanPack,
  type IndexRecord,
  zstdAvailable,
} from '../src/host/pack-format.ts'

const objectOf = (text: string) => {
  const raw = Buffer.from(text, 'utf8')
  return { hash: hashOfContent(raw), raw }
}

describe('block codec', () => {
  it('round-trips several objects and reports where each one starts', () => {
    const objects = [objectOf('{"a":1}'), objectOf('{"b":[2,3]}'), objectOf('x'.repeat(5000))]
    const block = encodeBlock(objects)
    const decoded = decodeBlock(block, 0)

    expect(decoded.totalLength).toBe(block.length)
    expect(decoded.entries.map(e => e.hash)).toEqual(objects.map(o => o.hash))
    const raw = decompressBlock(decoded)
    for (const [i, entry] of decoded.entries.entries()) {
      expect(raw.subarray(entry.rawOffset, entry.rawOffset + entry.rawLength)).toEqual(objects[i].raw)
    }
  })

  it('picks zstd when the runtime has it and deflate otherwise, and says which', () => {
    const block = encodeBlock([objectOf('hello world '.repeat(100))])
    const decoded = decodeBlock(block, 0)
    expect(decoded.codec).toBe(zstdAvailable() ? BLOCK_CODEC_ZSTD : BLOCK_CODEC_DEFLATE)
    // Whatever it picked, the bytes come back.
    expect(decompressBlock(decoded).toString('utf8')).toContain('hello world')
  })

  it('refuses a truncated or corrupt block instead of returning partial entries', () => {
    const block = encodeBlock([objectOf('one'), objectOf('two')])
    expect(() => decodeBlock(block.subarray(0, block.length - 3), 0)).toThrow(/truncat/i)
    expect(() => decodeBlock(block.subarray(0, 4), 0)).toThrow(/truncat/i)
    const badCodec = Buffer.from(block)
    badCodec[4] = 9
    expect(() => decodeBlock(badCodec, 0)).toThrow(/codec/i)
  })

  it('refuses an entry whose hash is not a sha256, rather than padding it', () => {
    // Buffer.from(hash, 'hex') stops at the first invalid character, so a
    // malformed hash would leave the rest of its 32-byte slot untouched -
    // writing whatever the allocation happened to hold into a pack file.
    expect(() => encodeBlock([{ hash: 'not-a-hash', raw: Buffer.from('x') }]))
      .toThrow(/sha256/i)
    expect(() => encodeBlock([{ hash: 'ab'.repeat(31), raw: Buffer.from('x') }]))
      .toThrow(/sha256/i)
  })

  it('reads a block that starts partway into a buffer', () => {
    const first = encodeBlock([objectOf('first')])
    const second = encodeBlock([objectOf('second')])
    const joined = Buffer.concat([first, second])
    const decoded = decodeBlock(joined, first.length)
    expect(decompressBlock(decoded).toString('utf8')).toBe('second')
  })
})

describe('index codec', () => {
  const recordOf = (hash: string, blockOffset: number): IndexRecord =>
    ({ hash, blockOffset, blockLength: 100, rawOffset: 7, rawLength: 9 })

  it('sorts records by hash so lookup can binary-search 48-byte slots', () => {
    const hashes = ['ff', 'a0', '01', '7e'].map(prefix => hashOfContent(prefix))
    const index = encodeIndex(hashes.map((hash, i) => recordOf(hash, i * 100)), 4096)

    expect(readIndexHeader(index)).toEqual({ recordCount: 4, packBytes: 4096 })
    const ordered = [0, 1, 2, 3].map(i => indexRecordAt(index, i).hash)
    expect(ordered).toEqual([...ordered].sort())
    for (const hash of hashes) expect(findInIndex(index, hash)?.hash).toBe(hash)
  })

  it('returns null for a hash it does not hold, at both ends and in the middle', () => {
    const index = encodeIndex([recordOf(hashOfContent('b'), 0), recordOf(hashOfContent('d'), 1)], 10)
    for (const missing of ['a', 'c', 'e']) expect(findInIndex(index, hashOfContent(missing))).toBeNull()
  })

  it('carries every field through unchanged', () => {
    const hash = hashOfContent('one')
    const index = encodeIndex([{ hash, blockOffset: 16, blockLength: 4096, rawOffset: 1234, rawLength: 77 }], 5000)
    expect(findInIndex(index, hash)).toEqual({ hash, blockOffset: 16, blockLength: 4096, rawOffset: 1234, rawLength: 77 })
  })

  it('rejects a buffer that is not an index at all', () => {
    expect(() => readIndexHeader(Buffer.alloc(16))).toThrow(/magic/i)
    expect(() => readIndexHeader(Buffer.alloc(4))).toThrow()
  })
})

describe('pack scan', () => {
  const packOf = (...groups: { hash: string; raw: Buffer }[][]) =>
    Buffer.concat([encodePackHeader(), ...groups.map(group => encodeBlock(group))])

  it('recovers every entry with the offsets a reader needs', () => {
    const a = objectOf('alpha')
    const b = objectOf('beta')
    const c = objectOf('gamma')
    const pack = packOf([a, b], [c])
    const { records, scannedBytes } = scanPack(pack)

    expect(scannedBytes).toBe(pack.length)
    expect(records.map(r => r.hash).sort()).toEqual([a.hash, b.hash, c.hash].sort())
    const record = records.find(r => r.hash === c.hash)!
    const block = decodeBlock(pack, record.blockOffset)
    const raw = decompressBlock(block)
    expect(raw.subarray(record.rawOffset, record.rawOffset + record.rawLength)).toEqual(c.raw)
  })

  it('keeps the intact prefix when the tail was torn by a crash', () => {
    const a = objectOf('kept')
    const b = objectOf('lost')
    const pack = packOf([a], [b])
    const torn = pack.subarray(0, pack.length - 5)

    const { records, scannedBytes } = scanPack(torn)
    // The first block survives; the half-written one is simply not there.
    expect(records.map(r => r.hash)).toEqual([a.hash])
    expect(scannedBytes).toBeLessThan(torn.length)
    expect(scannedBytes).toBeGreaterThan(0)
  })

  it('refuses a file that is not a pack', () => {
    expect(() => readPackHeader(Buffer.from('NOPE............', 'ascii'))).toThrow(/magic/i)
    expect(() => scanPack(Buffer.alloc(4))).toThrow()
  })
})
