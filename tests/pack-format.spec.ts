import { describe, expect, it } from 'vitest'
import { hashOfContent } from '../src/host/blob.ts'
import {
  BLOCK_CODEC_DEFLATE,
  BLOCK_CODEC_ZSTD,
  decodeBlock,
  decompressBlock,
  encodeBlock,
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

  it('reads a block that starts partway into a buffer', () => {
    const first = encodeBlock([objectOf('first')])
    const second = encodeBlock([objectOf('second')])
    const joined = Buffer.concat([first, second])
    const decoded = decodeBlock(joined, first.length)
    expect(decompressBlock(decoded).toString('utf8')).toBe('second')
  })
})
