// scripts/bench-pack.mjs
/**
 * Reproduce the pack design's numbers against any store directory, read only.
 * Usage: node scripts/bench-pack.mjs <storeDir>
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { encodeBlock, MAX_BLOCK_ENTRIES } from '../src/host/pack-format.ts'

const ROOT = process.argv[2]
if (ROOT === undefined) throw new Error('usage: node scripts/bench-pack.mjs <storeDir>')
const OBJ = join(ROOT, 'objects')
// Loose object frame, verified against src/host/blob.ts: 'DRL1' magic (4
// bytes) + one codec byte + payload. Codec 0 is identity, 1 is deflateRaw.
const FRAME_HEADER_BYTES = 5
const CODEC_IDENTITY = 0
// Measured NTFS behaviour: <=700 B lives resident in the MFT, anything larger
// costs a whole 4 KiB cluster plus its record.
const alloc = size => (size <= 700 ? 520 : Math.ceil(size / 4096) * 4096 + 520)
const mb = n => (n / 1048576).toFixed(2) + ' MB'
const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))]

const objects = new Map()
let looseStored = 0
let looseDisk = 0
for (const bucket of readdirSync(OBJ)) {
  const dir = join(OBJ, bucket)
  if (!/^[0-9a-f]{2}$/.test(bucket) || !statSync(dir).isDirectory()) continue
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.drl')) continue
    const frame = readFileSync(join(dir, name))
    // Too short to hold a frame, or the wrong magic: what the store itself
    // treats as absent (blob.ts infoOf), so it is not an object here either.
    if (frame.length <= FRAME_HEADER_BYTES || frame.subarray(0, 4).toString('latin1') !== 'DRL1') continue
    looseStored += frame.length
    looseDisk += alloc(frame.length)
    const payload = frame.subarray(FRAME_HEADER_BYTES)
    objects.set(name.slice(0, -4), frame[4] === CODEC_IDENTITY ? payload : inflateRawSync(payload))
  }
}

// Chronological order, and the object set each detail read touches.
const calls = []
for (const name of readdirSync(ROOT)) {
  if (!name.endsWith('.jsonl')) continue
  for (const line of readFileSync(join(ROOT, name), 'utf8').split('\n')) {
    if (line === '') continue
    const env = JSON.parse(line)
    const touched = new Set()
    let cursor = env.tree
    while (cursor !== undefined && objects.has(cursor)) {
      touched.add(cursor)
      const node = JSON.parse(objects.get(cursor).toString('utf8'))
      for (const entry of node.e) if (objects.has(entry.h)) touched.add(entry.h)
      cursor = node.p
    }
    if (env.resp !== undefined && objects.has(env.resp)) touched.add(env.resp)
    calls.push({ at: env.timing?.startedAt ?? 0, touched: [...touched] })
  }
}
calls.sort((a, b) => a.at - b.at)

const BLOCK = 1024 * 1024
const blockOf = new Map()
let packed = 0
let blockIndex = 0
let group = []
let groupBytes = 0
const cut = () => {
  if (group.length === 0) return
  packed += encodeBlock(group).length
  blockIndex += 1
  group = []
  groupBytes = 0
}
for (const call of calls) {
  for (const hash of call.touched) {
    if (blockOf.has(hash)) continue
    blockOf.set(hash, blockIndex)
    group.push({ hash, raw: objects.get(hash) })
    groupBytes += objects.get(hash).length
    if (groupBytes >= BLOCK || group.length >= MAX_BLOCK_ENTRIES) cut()
  }
}
for (const [hash, raw] of objects) {
  if (blockOf.has(hash)) continue
  blockOf.set(hash, blockIndex)
  group.push({ hash, raw })
  groupBytes += raw.length
  if (groupBytes >= BLOCK || group.length >= MAX_BLOCK_ENTRIES) cut()
}
cut()

const index = objects.size * 48
const spans = calls.map(c => new Set(c.touched.map(h => blockOf.get(h))).size).sort((a, b) => a - b)
console.log(`objects        ${objects.size}   calls ${calls.length}`)
console.log(`loose          stored ${mb(looseStored)}   on disk ${mb(looseDisk)}   files ${objects.size}`)
console.log(`packed 1 MiB   stored ${mb(packed + index)}   blocks ${blockIndex}`)
console.log(`blocks per detail read   p50 ${pct(spans, 0.5)}   p90 ${pct(spans, 0.9)}   max ${spans.at(-1)}`)
