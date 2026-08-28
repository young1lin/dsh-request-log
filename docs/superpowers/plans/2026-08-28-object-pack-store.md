# Object Pack Store (v4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop paying one filesystem cluster and one file handle per stored object — move cold objects into append-only pack files with a rebuildable index, so a permanently-retained store stays small and fast to read.

**Architecture:** The write path does not change: every append still materializes loose objects under `objects/<xx>/<sha256>.drl`. The daily sweep, after its GC decides what is reachable, moves cold loose objects into `objects/packs/<id>.pack` — a sequence of self-describing *blocks*, each block one compressed stream holding many objects concatenated in chronological order. A 48-byte-per-object index (`<id>.idx`) is a sorted binary buffer, searched without deserialization, and fully rebuildable by scanning the pack. `BlobStore.get` reads loose first, then packs; `BlobStore.put` consults both so a packed object is never re-materialized as loose. Packs are immutable: reclaiming space inside one means writing a new pack and retiring the old.

**Tech Stack:** TypeScript 7, Node ≥ 22.13, `node:zlib` (`deflateRaw` always, `zstd*` when the runtime exposes it), vitest 4, oxlint, tsdown. No new runtime dependencies — this package has zero and must keep it that way.

**Spec:** The **Design** section of this document is the spec. Task 12 writes it into `DESIGN-persistence.md` §11 as the permanent record; `DESIGN-persistence.md` §10 describes the v3 layer this builds on and must be read first.

---

## Global Constraints

- **Node ≥ 22.13** (CI runs 22 and 24). `zlib.zstdCompressSync` is present on Node 22.18 (verified on the dev machine) but not on every supported 22.x; code MUST probe for it at runtime and fall back to `deflateRawSync`. Never assume it is present.
- **No new runtime dependencies.** `package.json` has no `dependencies` block. Keep it that way.
- **LF line endings, always.** Several files in this repo were once mangled by a tool writing CRLF. Edit through the Edit/Write tools or `sed -i`; never rewrite a file with a Python text-mode write. Check with `git diff --stat` before committing: a one-line change must not show hundreds of changed lines.
- **Windows is a first-class target.** A file that any handle has open cannot be renamed over or deleted. Therefore: packs are immutable, never rewritten in place; a replaced pack is *retired* by writing a marker and deleted best-effort on a later sweep.
- **Fail-soft everywhere.** A store error must never break a model call. Every new IO path follows the existing idiom: catch, record into the sweep status via `swallowed(stage, error)`, continue.
- **TDD, no exceptions.** Write the test, run it, watch it fail *for the intended reason*, then implement. A test that passes the moment you write it is proving nothing — go back and make it fail first.
- **One commit per task**, message body explaining *why*, ending with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- **Verification gate for every task:** `npx tsc --noEmit` clean, `npx oxlint` clean, `npx vitest run` all green. A task is not done until all three pass.

## The two invariants that outrank every optimization

Violating either one destroys user data that has no other copy. Every task below is written to preserve them; if a step seems to conflict with one, the step is wrong.

1. **Incomplete knowledge ⇒ no deletion.** The sweep's reachable set is built by reading every session file. If *any* error occurred while building it, that cycle must skip the object GC **and** the packing phase **and** the repack phase. Partial knowledge marks live data as garbage.
2. **Durability before deletion.** A loose object may be unlinked only after both its pack block and an index naming it are fsynced. An old pack may be retired only after the replacement pack and its index are fsynced. Duplicated data is free to fix on the next cycle; deleted data is not.

## Measured baseline (why this work exists)

All figures measured on a real 3-day store: 2,570 calls, 11,279 objects, 36.64 MB of raw content. Reproduce with the benchmark script added in Task 13.

| | stored | on disk | files | detail read p50 | detail read p90 |
|---|---|---|---|---|---|
| today (one file per object) | 15.34 MB | **30.86 MB** | 11,279 | **43.9 ms** | 184.4 ms |
| packed, 1 MiB solid blocks | **7.55 MB** | ~7.6 MB | ~40 | **8.2 ms** | **12.2 ms** |

Two facts drive the design:

- **NTFS allocation is a step function.** Measured by free-space delta over 2,000 files: a file ≤ ~700 B lives resident in the MFT (~520 B); a file ≥ ~900 B costs a full 4096 B cluster plus its ~520 B record. 4,074 objects in the 700 B–4 KiB band hold 6.14 MB but occupy 17.94 MB. Compressing harder cannot fix this — 97 % of objects already fit in one cluster whatever their size.
- **Object order decides 36 % of the compression ratio.** Same 4 MiB blocks: chronological order packs to 6.20 MB, hash order to 9.72 MB. Consecutive calls re-send nearly the same conversation, so neighbouring objects are near-duplicates. Packing and repacking MUST preserve chronological order.

A detail read touches p50 93 / p90 390 objects but only p50 2 / p90 4 blocks, which is why packing makes reads *faster* rather than slower: today's cost is 472 µs per object (dominated by opening a file on Windows), and a 1 MiB block decompresses in 2.04 ms.

---

## Design

### Layout

```
<store>/objects/
  <xx>/<sha256>.drl          loose objects — unchanged, still the only write path
  packs/
    pack-<epochMs>-<rand>.pack    immutable; append-only while active
    pack-<epochMs>-<rand>.idx     sorted index, rebuildable from the .pack
    pack-<epochMs>-<rand>.retired marker: readers skip it, sweep deletes it
```

`objects/packs/` is invisible to the existing GC and census: both filter root entries with `/^[0-9a-f]{2}$/`, which `packs` fails. No change needed there.

### Pack file format

```
header (16 bytes)
  0..3    "DRP1"
  4       version = 1
  5..15   reserved, zero

then a sequence of blocks, each:
  u32be   payloadLength
  u8      codec            1 = deflateRaw, 2 = zstd
  u16be   entryCount       (1..4096)
  entryCount × 40 bytes:
    32    hash, raw bytes (the sha256, not hex)
    u32be rawOffset        offset of this object inside the DECOMPRESSED block
    u32be rawLength
  payloadLength bytes      the compressed concatenation of the objects, in table order
```

Blocks are self-describing: the entry table is stored uncompressed inside the block header, which is exactly what makes the index rebuildable.

### Index file format

```
header (16 bytes)
  0..3    "DRI1"
  4       version = 1
  5..7    reserved, zero
  8..11   u32be recordCount
  12..15  u32be packBytes    size of the .pack when this index was written

then recordCount × 48 bytes, sorted ascending by hash:
  32      hash, raw bytes
  u32be   blockOffset        offset of the block header in the .pack
  u32be   blockLength        total block length including its header
  u32be   rawOffset
  u32be   rawLength
```

The index is never deserialized into objects. It is held as a `Buffer` and searched with a binary search over 48-byte records: a 128k-object pack costs 6 MB of RAM, not 128k JS objects.

`packBytes` detects an index that predates a crash-interrupted append: if the `.pack` is longer than `packBytes`, the tail blocks are missing from the index and it must be rebuilt.

### Read path (`BlobStore.get`)

1. Raw-object LRU hit → return.
2. Loose file exists → today's path, unchanged (frame decode, inflate, hash verify, self-heal).
3. Otherwise ask the `PackStore`: binary-search each loaded index → read the block → decompress (block LRU) → slice `[rawOffset, rawOffset+rawLength)` → **verify the content hash** → cache → return.
4. A miss re-enumerates `packs/` once (a repack may have introduced a new pack since the last listing) and retries before throwing.

A stale cached index is *safe*: it points into a pack that still exists until retirement completes, and immutable packs return correct bytes forever.

### Write path

Unchanged. `put` still writes loose objects, so every atomicity guarantee of the append chain survives untouched. `put` gains one lookup: if the hash is already in a pack, return `{ z: 0, created: false }` without writing and without `utimes` (a packed object has no mtime to refresh, and it is not GC'd by mtime).

### Packing (sweep phase, after GC)

Candidates are loose objects that are **reachable** and **older than the GC grace floor**. Freshly written objects stay loose — the same window that protects an object whose envelope line has not landed yet.

Order candidates by first appearance in the chronological envelope scan the sweep already performs; anything unreferenced goes last, ordered by hash. Fill blocks to `packBlockBytes` (1 MiB raw) or 4096 entries, whichever comes first. Append to the active pack, or start a new one when the active pack would exceed `maxPackBytes` (64 MiB). Spend at most `packBudgetBytes` (64 MiB raw) per cycle.

Then, in this exact order: fsync the pack → write the index via temp+rename → fsync the index → unlink the loose copies.

### Repack (sweep phase, after packing)

A pack whose reachable entries fall below `repackLiveRatio` (0.5) and which holds at least `repackMinBytes` (8 MiB) is rewritten: read its live objects **in stored order** (preserving the compression locality), write them into a new pack + index, then write a `.retired` marker beside the old pack. Deleting the retired files is best-effort and retried on later sweeps — on Windows a reader may still hold the handle.

### Configuration

Public (`Config`, zod, README): `pack: 'auto' | 'off'`, default `'auto'`. `'off'` stops creating packs and gradually unpacks existing ones, which is the rollback door for downgrading to a build that cannot read packs.

Internal (`StoreConfig` only, following `migrationBudgetBytes`): `packBlockBytes`, `maxPackBytes`, `packBudgetBytes`, `repackLiveRatio`, `repackMinBytes`, `blockCacheBytes`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/host/pack-format.ts` (new) | Pure byte codecs: block encode/decode, index encode/decode/search, index rebuild by scanning a pack buffer. No filesystem, no hashing, no imports from `blob.ts`. |
| `src/host/pack.ts` (new) | `PackStore`: enumerate packs, lazily load/rebuild indexes, read an object, append blocks, retire packs. Filesystem only; still no knowledge of hashing or records. |
| `src/host/blob.ts` (modify) | Accept an optional `PackStore`; fall through to it in `get`/`has`/`put`; expose `looseCensus()` for the packer. |
| `src/host/store.ts` (modify) | Sweep phases `pack` and `repack`, chronological order derivation, budgets, the invariant guard, status fields. |
| `src/host/index.ts` (modify) | `pack` config field, zod, `resolveStoreConfig` passthrough. |
| `tests/pack-format.spec.ts` (new) | Byte-level codec tests including truncation and corruption. |
| `tests/pack.spec.ts` (new) | `PackStore` behaviour: rebuild, crash recovery, retirement. |
| `tests/blob.spec.ts` (modify) | Loose/pack fall-through, put dedup against packs. |
| `tests/store.spec.ts` (modify) | Sweep integration, invariants, budgets, unpacking. |
| `scripts/bench-pack.mjs` (new) | Reproduce the baseline table against any store directory. |
| `DESIGN-persistence.md`, `README.md` (modify) | §11 and the config table. |

Keep `pack-format.ts` free of `blob.ts` imports in both directions: `blob.ts` → `pack.ts` → `pack-format.ts` is the only allowed direction. Content hashing stays in `blob.ts`, which verifies every byte a pack hands back.

---

## Task 1: Block codec

**Files:**
- Create: `src/host/pack-format.ts`
- Test: `tests/pack-format.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export const PACK_MAGIC: Buffer               // "DRP1"
  export const PACK_HEADER_BYTES = 16
  export const BLOCK_CODEC_DEFLATE = 1
  export const BLOCK_CODEC_ZSTD = 2
  export const MAX_BLOCK_ENTRIES = 4096
  export interface BlockEntry { hash: string; rawOffset: number; rawLength: number }
  export interface DecodedBlock { codec: number; entries: BlockEntry[]; payload: Buffer; totalLength: number }
  export function zstdAvailable(): boolean
  export function encodeBlock(objects: readonly { hash: string; raw: Buffer }[]): Buffer
  export function decodeBlock(buffer: Buffer, at: number): DecodedBlock   // throws on malformed
  export function decompressBlock(block: DecodedBlock): Buffer
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/pack-format.spec.ts
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/pack-format.spec.ts`
Expected: FAIL — `Failed to resolve import "../src/host/pack-format.ts"`.

- [ ] **Step 3: Implement**

```ts
// src/host/pack-format.ts
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
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/pack-format.spec.ts && npx tsc --noEmit && npx oxlint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/host/pack-format.ts tests/pack-format.spec.ts
git commit -m "Add the pack block codec"
```

---

## Task 2: Index codec and lookup

**Files:**
- Modify: `src/host/pack-format.ts`
- Test: `tests/pack-format.spec.ts`

**Interfaces:**
- Consumes: `BlockEntry` from Task 1.
- Produces:
  ```ts
  export const IDX_MAGIC: Buffer                // "DRI1"
  export const IDX_HEADER_BYTES = 16
  export const IDX_RECORD_BYTES = 48
  export interface IndexRecord { hash: string; blockOffset: number; blockLength: number; rawOffset: number; rawLength: number }
  export function encodeIndex(records: readonly IndexRecord[], packBytes: number): Buffer
  export function readIndexHeader(buffer: Buffer): { recordCount: number; packBytes: number }
  export function findInIndex(buffer: Buffer, hash: string): IndexRecord | null
  export function indexRecordAt(buffer: Buffer, i: number): IndexRecord
  ```

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/pack-format.spec.ts
import {
  encodeIndex,
  findInIndex,
  indexRecordAt,
  readIndexHeader,
  type IndexRecord,
} from '../src/host/pack-format.ts'

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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/pack-format.spec.ts`
Expected: FAIL — `encodeIndex is not a function` / import error.

- [ ] **Step 3: Implement**

Append to `src/host/pack-format.ts`:

```ts
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
  return { recordCount: buffer.readUInt32BE(8), packBytes: buffer.readUInt32BE(12) }
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
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/pack-format.spec.ts && npx tsc --noEmit && npx oxlint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/host/pack-format.ts tests/pack-format.spec.ts
git commit -m "Add the pack index codec with byte-level lookup"
```

---

## Task 3: Rebuild an index by scanning a pack

This is the crash-recovery path. It must stop cleanly at the first damaged block rather than throwing away the blocks before it.

**Files:**
- Modify: `src/host/pack-format.ts`
- Test: `tests/pack-format.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export function encodePackHeader(): Buffer
  export function readPackHeader(buffer: Buffer): void          // throws on magic/version mismatch
  export function scanPack(buffer: Buffer): { records: IndexRecord[]; scannedBytes: number }
  ```
  `scannedBytes` is where the last intact block ended: everything past it is a torn tail.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/pack-format.spec.ts
import { encodePackHeader, readPackHeader, scanPack } from '../src/host/pack-format.ts'

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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/pack-format.spec.ts`
Expected: FAIL — `scanPack is not a function`.

- [ ] **Step 3: Implement**

```ts
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
  const records: IndexRecord[] = []
  let at = PACK_HEADER_BYTES
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
        blockOffset: at,
        blockLength: block.totalLength,
        rawOffset: entry.rawOffset,
        rawLength: entry.rawLength,
      })
    }
    at += block.totalLength
  }
  return { records, scannedBytes: at }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/pack-format.spec.ts && npx tsc --noEmit && npx oxlint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/host/pack-format.ts tests/pack-format.spec.ts
git commit -m "Rebuild a pack index by scanning the pack itself"
```

---

## Task 4: PackStore read side

**Files:**
- Create: `src/host/pack.ts`
- Test: `tests/pack.spec.ts`

**Interfaces:**
- Consumes: everything from `pack-format.ts`.
- Produces:
  ```ts
  export const DEFAULT_BLOCK_CACHE_BYTES = 16 * 1024 * 1024
  export interface PackStoreConfig { directory: string; blockCacheBytes?: number }
  export interface PackInfo { id: string; bytes: number; entryCount: number }
  export class PackStore {
    constructor(config: PackStoreConfig)
    async read(hash: string): Promise<Buffer | null>
    async has(hash: string): Promise<boolean>
    async list(): Promise<PackInfo[]>
    async entriesOf(id: string): Promise<string[]>     // every hash in one pack, in stored order
    invalidate(): void                                  // drop cached listings and indexes
  }
  ```

Rules the implementation must hold:
- A missing, unreadable, stale (`packBytes` < actual pack size) or malformed index is **rebuilt from the pack** and rewritten; it is never a reason to report the objects missing.
- `read` returns `null` for "not here", and only throws for genuine IO/corruption failures.
- A read miss re-enumerates the directory **once** and retries, so a pack written by a concurrent repack is found.
- Retired packs (`<id>.retired` present) are skipped.

- [ ] **Step 1: Write the failing test**

```ts
// tests/pack.spec.ts
/** PackStore specs: reading, index rebuilding, and retirement. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hashOfContent } from '../src/host/blob.ts'
import { PackStore } from '../src/host/pack.ts'
import { encodeBlock, encodeIndex, encodePackHeader, scanPack } from '../src/host/pack-format.ts'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pack-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const objectOf = (text: string) => ({ hash: hashOfContent(text), raw: Buffer.from(text, 'utf8') })

/** Hand-build one pack + index, the way the packer will. */
async function writePack(directory: string, id: string, groups: { hash: string; raw: Buffer }[][]): Promise<void> {
  const pack = Buffer.concat([encodePackHeader(), ...groups.map(group => encodeBlock(group))])
  await writeFile(join(directory, `${id}.pack`), pack)
  const { records } = scanPack(pack)
  await writeFile(join(directory, `${id}.idx`), encodeIndex(records, pack.length))
}

describe('PackStore reads', () => {
  it('returns the exact bytes an object was packed with', async () => {
    const directory = await tempDir()
    const a = objectOf('{"role":"user"}')
    const b = objectOf('x'.repeat(9000))
    await writePack(directory, 'pack-1', [[a, b]])

    const store = new PackStore({ directory })
    expect(await store.read(a.hash)).toEqual(a.raw)
    expect(await store.read(b.hash)).toEqual(b.raw)
    expect(await store.has(a.hash)).toBe(true)
  })

  it('reports an unknown hash as absent rather than throwing', async () => {
    const directory = await tempDir()
    await writePack(directory, 'pack-1', [[objectOf('only')]])
    const store = new PackStore({ directory })
    expect(await store.read(hashOfContent('missing'))).toBeNull()
    expect(await store.has(hashOfContent('missing'))).toBe(false)
  })

  it('rebuilds an index that was lost, instead of losing the objects', async () => {
    const directory = await tempDir()
    const a = objectOf('survivor')
    await writePack(directory, 'pack-1', [[a]])
    await rm(join(directory, 'pack-1.idx'))

    const store = new PackStore({ directory })
    expect(await store.read(a.hash)).toEqual(a.raw)
    // And it wrote the index back, so the next process does not rescan.
    expect((await readFile(join(directory, 'pack-1.idx'))).length).toBeGreaterThan(16)
  })

  it('rebuilds an index that is stale after a crash mid-append', async () => {
    const directory = await tempDir()
    const a = objectOf('indexed')
    const b = objectOf('appended-after-the-index')
    // Index written when the pack held only `a`, then `b`'s block appended.
    const first = Buffer.concat([encodePackHeader(), encodeBlock([a])])
    await writeFile(join(directory, 'pack-1.pack'), Buffer.concat([first, encodeBlock([b])]))
    await writeFile(join(directory, 'pack-1.idx'), encodeIndex(scanPack(first).records, first.length))

    const store = new PackStore({ directory })
    expect(await store.read(b.hash)).toEqual(b.raw)
  })

  it('skips a retired pack', async () => {
    const directory = await tempDir()
    const a = objectOf('retired content')
    await writePack(directory, 'pack-1', [[a]])
    await writeFile(join(directory, 'pack-1.retired'), '')

    const store = new PackStore({ directory })
    expect(await store.read(a.hash)).toBeNull()
    expect(await store.list()).toEqual([])
  })

  it('finds a pack that appeared after the first listing', async () => {
    const directory = await tempDir()
    await writePack(directory, 'pack-1', [[objectOf('first')]])
    const store = new PackStore({ directory })
    await store.read(hashOfContent('first'))

    const late = objectOf('written by a later repack')
    await writePack(directory, 'pack-2', [[late]])
    expect(await store.read(late.hash)).toEqual(late.raw)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/pack.spec.ts`
Expected: FAIL — cannot resolve `../src/host/pack.ts`.

- [ ] **Step 3: Implement the read side**

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/pack.spec.ts && npx tsc --noEmit && npx oxlint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/host/pack.ts tests/pack.spec.ts
git commit -m "Read objects out of pack files, rebuilding a lost index"
```

---

## Task 5: PackStore write side

**Files:**
- Modify: `src/host/pack.ts`
- Test: `tests/pack.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export const DEFAULT_MAX_PACK_BYTES = 64 * 1024 * 1024
  export interface AppendResult { id: string; packedBytes: number; entryCount: number }
  // On PackStore:
  async append(objects: readonly { hash: string; raw: Buffer }[], blockBytes: number): Promise<AppendResult>
  async retire(id: string): Promise<void>
  async reapRetired(): Promise<number>
  ```
  `append` groups the objects **in the order given** into blocks of at most `blockBytes` raw, appends them to the active pack (starting a new pack when the active one would pass `DEFAULT_MAX_PACK_BYTES`), fsyncs, then rewrites the index. It resolves only after both are durable.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/pack.spec.ts
import { readdir, stat } from 'node:fs/promises'

describe('PackStore writes', () => {
  it('makes the objects readable and the index durable before it resolves', async () => {
    const directory = await tempDir()
    const store = new PackStore({ directory })
    const objects = [objectOf('one'), objectOf('two'), objectOf('three')]

    const result = await store.append(objects, 1024 * 1024)
    expect(result.entryCount).toBe(3)

    // A fresh store — no warm caches — sees them.
    const cold = new PackStore({ directory })
    for (const object of objects) expect(await cold.read(object.hash)).toEqual(object.raw)
    const idx = await stat(join(directory, `${result.id}.idx`))
    expect(idx.size).toBeGreaterThan(16)
  })

  it('cuts blocks at the requested size instead of one block per pack', async () => {
    const directory = await tempDir()
    const store = new PackStore({ directory })
    // Four 4 KB objects with a 6 KB block budget => more than one block.
    const objects = [0, 1, 2, 3].map(i => objectOf(String(i) + 'y'.repeat(4000)))
    const { id } = await store.append(objects, 6000)

    const pack = await readFile(join(directory, `${id}.pack`))
    const { records } = scanPack(pack)
    expect(new Set(records.map(r => r.blockOffset)).size).toBeGreaterThan(1)
    for (const object of objects) expect(await store.read(object.hash)).toEqual(object.raw)
  })

  it('keeps the stored order, which is what the compression ratio depends on', async () => {
    const directory = await tempDir()
    const store = new PackStore({ directory })
    const objects = ['a', 'b', 'c', 'd'].map(objectOf)
    const { id } = await store.append(objects, 1024 * 1024)
    expect(await store.entriesOf(id)).toEqual(objects.map(o => o.hash))
  })

  it('appends to the same pack on a second call', async () => {
    const directory = await tempDir()
    const store = new PackStore({ directory })
    const first = await store.append([objectOf('first')], 1024 * 1024)
    const second = await store.append([objectOf('second')], 1024 * 1024)
    expect(second.id).toBe(first.id)
    expect((await readdir(directory)).filter(n => n.endsWith('.pack'))).toHaveLength(1)
    expect(await store.read(hashOfContent('first'))).toEqual(Buffer.from('first'))
    expect(await store.read(hashOfContent('second'))).toEqual(Buffer.from('second'))
  })

  it('retires a pack so readers skip it, and reaps it afterwards', async () => {
    const directory = await tempDir()
    const store = new PackStore({ directory })
    const { id } = await store.append([objectOf('doomed')], 1024 * 1024)

    await store.retire(id)
    expect(await store.read(hashOfContent('doomed'))).toBeNull()
    expect(await store.reapRetired()).toBe(1)
    expect((await readdir(directory)).filter(n => n.endsWith('.pack'))).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/pack.spec.ts`
Expected: FAIL — `store.append is not a function`.

- [ ] **Step 3: Implement**

Add to `src/host/pack.ts`. The import lines grow: `mkdir` and `stat` from `node:fs/promises`, and `encodeBlock`, `encodePackHeader`, `MAX_BLOCK_ENTRIES`, `PACK_HEADER_BYTES` from `./pack-format`.

```ts
export const DEFAULT_MAX_PACK_BYTES = 64 * 1024 * 1024

export interface AppendResult { id: string; packedBytes: number; entryCount: number }

  // ---- inside class PackStore ----

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.config.directory, { recursive: true })
  }

  /** The pack to append to: the newest one still under the size ceiling. */
  private async activePack(): Promise<{ id: string; bytes: number }> {
    const ids = await this.listIds()
    const newest = ids[ids.length - 1]
    if (newest !== undefined) {
      const info = await stat(join(this.config.directory, `${newest}.pack`)).catch(() => null)
      if (info !== null && info.size < (this.config.maxPackBytes ?? DEFAULT_MAX_PACK_BYTES)) {
        return { id: newest, bytes: info.size }
      }
    }
    const id = `pack-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
    await writeFile(join(this.config.directory, `${id}.pack`), encodePackHeader(), { flag: 'wx' })
    this.ids = undefined
    return { id, bytes: PACK_HEADER_BYTES }
  }

  async append(objects: readonly { hash: string; raw: Buffer }[], blockBytes: number): Promise<AppendResult> {
    await this.ensureDirectory()
    const { id } = await this.activePack()
    const path = join(this.config.directory, `${id}.pack`)

    const blocks: Buffer[] = []
    let group: { hash: string; raw: Buffer }[] = []
    let groupBytes = 0
    const cut = (): void => {
      if (group.length === 0) return
      blocks.push(encodeBlock(group))
      group = []
      groupBytes = 0
    }
    for (const object of objects) {
      group.push(object)
      groupBytes += object.raw.length
      if (groupBytes >= blockBytes || group.length >= MAX_BLOCK_ENTRIES) cut()
    }
    cut()

    // Durability order is the invariant: pack bytes first and fsynced, index
    // second. A crash between them leaves an index the reader rebuilds; the
    // reverse would leave an index pointing at bytes that never landed.
    const handle = await open(path, 'a')
    try {
      await handle.writeFile(Buffer.concat(blocks))
      await handle.sync()
    } finally {
      await handle.close()
    }
    this.indexes.delete(id)
    const pack = await readFile(path)
    const { records } = scanPack(pack)
    await this.writeIndex(id, encodeIndex(records, pack.length))
    this.indexes.delete(id)
    return { id, packedBytes: pack.length, entryCount: records.length }
  }

  /** Mark a pack unreadable to this and every other process, atomically. */
  async retire(id: string): Promise<void> {
    await writeFile(join(this.config.directory, `${id}.retired`), '')
    this.invalidate()
  }

  /**
   * Delete retired packs. Best-effort by design: on Windows a reader may still
   * hold the handle, and the next sweep will try again.
   */
  async reapRetired(): Promise<number> {
    let names: string[]
    try {
      names = await readdir(this.config.directory)
    } catch {
      return 0
    }
    let reaped = 0
    for (const name of names) {
      if (!name.endsWith('.retired')) continue
      const id = name.slice(0, -'.retired'.length)
      const removed = await Promise.all([
        rm(join(this.config.directory, `${id}.pack`), { force: true }).then(() => true, () => false),
        rm(join(this.config.directory, `${id}.idx`), { force: true }).then(() => true, () => false),
      ])
      if (removed.every(Boolean)) {
        await rm(join(this.config.directory, name), { force: true }).catch(() => {})
        reaped += 1
      }
    }
    if (reaped > 0) this.invalidate()
    return reaped
  }
```

Add `maxPackBytes?: number` to `PackStoreConfig`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/pack.spec.ts && npx tsc --noEmit && npx oxlint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/host/pack.ts tests/pack.spec.ts
git commit -m "Append blocks to packs, index after fsync, retire by marker"
```

---

## Task 6: BlobStore falls through to packs

**Files:**
- Modify: `src/host/blob.ts`
- Test: `tests/blob.spec.ts`

**Interfaces:**
- Consumes: `PackStore` from Task 4/5.
- Produces: `BlobStoreConfig.packs?: PackStore`; `BlobStore.looseCensus(): Promise<{ hash: string; size: number; mtimeMs: number }[]>`.

Behaviour to implement:
- `get`: LRU → loose file → `packs.read(hash)` → verify the content hash of what the pack returned → cache → return. A pack byte that fails hash verification throws *without* deleting anything: packs are shared, and a single bad object must degrade one record, not destroy a pack.
- `has` / `put`: after the loose `infoOf` miss, ask the pack store. A pack hit returns `{ z: 0, created: false }` and skips `touchIfStale` — packed objects have no mtime and are not reclaimed by one.
- `looseCensus`: walk the fan-out buckets, returning every loose object with size and mtime. This is what the packer picks candidates from.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/blob.spec.ts
import { PackStore } from '../src/host/pack.ts'

describe('loose and packed objects together', () => {
  it('reads an object that only exists in a pack', async () => {
    const directory = await tempDir()
    const packs = new PackStore({ directory: join(directory, 'packs') })
    const store = new BlobStore({ directory, packs })
    const payload = '{"packed":true}'
    const hash = hashOfContent(payload)
    await packs.append([{ hash, raw: Buffer.from(payload) }], 1024 * 1024)

    expect(await store.has(hash)).toBe(true)
    expect((await store.get(hash)).toString('utf8')).toBe(payload)
  })

  it('does not re-materialize a packed object as a loose file', async () => {
    const directory = await tempDir()
    const packs = new PackStore({ directory: join(directory, 'packs') })
    const store = new BlobStore({ directory, packs })
    const payload = '{"already":"packed"}'
    const hash = hashOfContent(payload)
    await packs.append([{ hash, raw: Buffer.from(payload) }], 1024 * 1024)

    const result = await store.put(hash, payload)
    expect(result.created).toBe(false)
    // Nothing new on disk: the bucket for this hash must not exist.
    await expect(stat(join(directory, hash.slice(0, 2), `${hash}.drl`))).rejects.toThrow()
  })

  it('prefers the loose copy while both exist', async () => {
    const directory = await tempDir()
    const packs = new PackStore({ directory: join(directory, 'packs') })
    const store = new BlobStore({ directory, packs })
    const payload = 'both places'
    const hash = hashOfContent(payload)
    await store.put(hash, payload)
    await packs.append([{ hash, raw: Buffer.from(payload) }], 1024 * 1024)
    expect((await store.get(hash)).toString('utf8')).toBe(payload)
  })

  it('refuses packed bytes whose hash does not match, without touching the pack', async () => {
    const directory = await tempDir()
    const packsDir = join(directory, 'packs')
    const packs = new PackStore({ directory: packsDir })
    const store = new BlobStore({ directory, packs })
    const lie = hashOfContent('the truth')
    await packs.append([{ hash: lie, raw: Buffer.from('a different body') }], 1024 * 1024)

    await expect(store.get(lie)).rejects.toThrow(/hash mismatch/i)
    // The pack survives: one bad object degrades one record, not the store.
    expect((await readdir(packsDir)).filter(n => n.endsWith('.pack'))).toHaveLength(1)
  })

  it('censuses loose objects with the size and mtime the packer needs', async () => {
    const directory = await tempDir()
    const store = new BlobStore({ directory })
    await store.put(hashOfContent('one'), 'one')
    await store.put(hashOfContent('two'), 'two')
    const census = await store.looseCensus()
    expect(census).toHaveLength(2)
    expect(census.every(row => row.size > 0 && row.mtimeMs > 0)).toBe(true)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/blob.spec.ts`
Expected: FAIL — `BlobStoreConfig` has no `packs`, `looseCensus` is not a function.

- [ ] **Step 3: Implement**

In `src/host/blob.ts`:
- add `packs?: PackStore` to `BlobStoreConfig` and `import type { PackStore } from './pack'`;
- in `get`, after the loose `readFile` throws ENOENT, consult the pack store:

```ts
    const packed = await this.config.packs?.read(hash) ?? null
    if (packed !== null) {
      if (hashOfContent(packed) !== hash) throw new Error(`object content hash mismatch for ${hash}`)
      this.lru.put(hash, packed)
      return packed
    }
```

- in `put`, after `infoOf` returns null:

```ts
    // A packed object is already durable; re-writing it loose would undo the
    // sweep's work and bill bytes the store did not materialize.
    if (await this.config.packs?.has(hash)) return { z: 0, created: false }
```

- add:

```ts
  /** Every loose object with the size and mtime the packer selects on. */
  async looseCensus(): Promise<{ hash: string; size: number; mtimeMs: number }[]> {
    const rows: { hash: string; size: number; mtimeMs: number }[] = []
    let rootEntries: string[]
    try {
      rootEntries = await readdir(this.config.directory)
    } catch {
      return rows
    }
    for (const name of rootEntries) {
      if (!/^[0-9a-f]{2}$/.test(name)) continue
      let files: string[]
      try {
        files = await readdir(join(this.config.directory, name))
      } catch {
        continue
      }
      for (const file of files) {
        if (!file.endsWith('.drl')) continue
        const info = await stat(join(this.config.directory, name, file)).catch(() => null)
        if (info === null) continue
        rows.push({ hash: file.slice(0, -'.drl'.length), size: info.size, mtimeMs: info.mtimeMs })
      }
    }
    return rows
  }

  /** Drop the loose copy of an object that now lives in a pack. */
  async dropLoose(hash: string): Promise<boolean> {
    return rm(this.pathOf(hash), { force: true }).then(() => true, () => false)
  }
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run && npx tsc --noEmit && npx oxlint`
Expected: PASS, clean — the whole suite, since `blob.ts` is shared.

- [ ] **Step 5: Commit**

```bash
git add src/host/blob.ts tests/blob.spec.ts
git commit -m "Fall through to packs on read, and never re-loose a packed object"
```

---

## Task 7: Chronological packing order

**Files:**
- Modify: `src/host/store.ts`
- Test: `tests/store.spec.ts`

**Interfaces:**
- Produces (module-level, exported for the test):
  ```ts
  export function packingOrder(lines: readonly { at: number; hashes: readonly string[] }[]): string[]
  ```
  First appearance wins; ties keep input order. This is a pure function so the ordering rule — worth 36 % of the compression ratio — is testable without a filesystem.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/store.spec.ts
import { packingOrder } from '../src/host/store.ts'

describe('packingOrder', () => {
  it('orders objects by the call that first referenced them', () => {
    const order = packingOrder([
      { at: 200, hashes: ['c', 'd'] },
      { at: 100, hashes: ['a', 'b'] },
      { at: 300, hashes: ['b', 'e'] },
    ])
    // Sorted by time first: a,b (t=100), then c,d (t=200), then e (t=300).
    expect(order).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('keeps a re-referenced object at its FIRST position, not its last', () => {
    // Retries and unchanged history re-name the same pieces every call; moving
    // them would scatter a conversation across blocks and cost compression.
    expect(packingOrder([
      { at: 1, hashes: ['x', 'y'] },
      { at: 2, hashes: ['x', 'z'] },
    ])).toEqual(['x', 'y', 'z'])
  })

  it('is stable for calls sharing a timestamp', () => {
    expect(packingOrder([
      { at: 5, hashes: ['p'] },
      { at: 5, hashes: ['q'] },
    ])).toEqual(['p', 'q'])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/store.spec.ts`
Expected: FAIL — `packingOrder is not exported`.

- [ ] **Step 3: Implement**

```ts
/**
 * The order objects are packed in, and the reason packing is worth doing:
 * consecutive calls re-send nearly the same conversation, so neighbouring
 * objects are near-duplicates and compress together. Measured on a real
 * store, chronological order packs to 6.20 MB where hash order needs 9.72 MB
 * — a 36 % swing that repacking must not throw away.
 */
export function packingOrder(lines: readonly { at: number; hashes: readonly string[] }[]): string[] {
  const ordered = lines.map((line, i) => ({ line, i })).sort((a, b) => a.line.at - b.line.at || a.i - b.i)
  const seen = new Set<string>()
  const order: string[] = []
  for (const { line } of ordered) {
    for (const hash of line.hashes) {
      if (seen.has(hash)) continue
      seen.add(hash)
      order.push(hash)
    }
  }
  return order
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/store.spec.ts && npx tsc --noEmit && npx oxlint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/host/store.ts tests/store.spec.ts
git commit -m "Derive the chronological order packing depends on"
```

---

## Task 8: Sweep packs cold objects

**Files:**
- Modify: `src/host/store.ts`
- Test: `tests/store.spec.ts`

**Interfaces:**
- Consumes: `packingOrder` (Task 7), `BlobStore.looseCensus`/`dropLoose` (Task 6), `PackStore.append` (Task 5).
- Produces: `StoreConfig` gains `pack?: 'auto' | 'off'`, `packBlockBytes?`, `packBudgetBytes?`; `SweepStatus` gains `packedObjects: number`, `packedBytes: number`; `SweepPhase` gains `'pack'`.

Placement inside `sweep()`: after the GC block, before the migration block. The mark phase must have completed and the reachable set must be trusted (Task 9 enforces that).

Selection rules:
- candidate = loose ∧ `reachable.has(hash)` ∧ `now - mtimeMs > graceMs` (reuse `DEFAULT_GC_GRACE_MS`);
- sort by index in `packingOrder`, unknown hashes last by hash;
- stop once accumulated raw size ≥ `packBudgetBytes` (default 64 MiB), but always pack at least one block;
- after `append` resolves, `dropLoose` each packed hash.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/store.spec.ts
import { PackStore } from '../src/host/pack.ts'

describe('sweep packing', () => {
  const oldEnough = (directory: string, hashes: string[]) => Promise.all(hashes.map(hash => {
    const past = new Date(Date.now() - 3 * 60 * 60 * 1000)
    return utimes(join(directory, 'objects', hash.slice(0, 2), `${hash}.drl`), past, past)
  }))

  it('moves cold reachable objects into a pack and drops the loose copies', async () => {
    const directory = await tempDir()
    const store = new CallStore(resolveStoreConfig({ directory }))
    await store.append(recordOf({ id: 'a' }))
    await store.append(recordOf({ id: 'b', request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'second' }] }] } }))

    const objectsDir = join(directory, 'objects')
    const loose = (await store.objectCensusForTest()).map(row => row.hash)
    await oldEnough(directory, loose)

    await store.sweep()

    const packs = (await readdir(join(objectsDir, 'packs'))).filter(n => n.endsWith('.pack'))
    expect(packs).toHaveLength(1)
    // Loose copies are gone...
    const remaining = await store.objectCensusForTest()
    expect(remaining).toHaveLength(0)
    // ...and every record still reads back byte for byte.
    expect((await store.get('sess-1', 'a'))?.request.messages).toEqual(recordOf({ id: 'a' }).request.messages)
    expect((await store.get('sess-1', 'b'))?.id).toBe('b')
  })

  it('leaves a fresh object loose, so a pending append cannot lose its body', async () => {
    const directory = await tempDir()
    const store = new CallStore(resolveStoreConfig({ directory }))
    await store.append(recordOf({ id: 'fresh' }))

    await store.sweep()

    // Nothing packed: every object is younger than the grace floor.
    expect(await store.objectCensusForTest()).not.toHaveLength(0)
    const packDir = join(directory, 'objects', 'packs')
    const packs = await readdir(packDir).catch(() => [])
    expect(packs.filter(n => n.endsWith('.pack'))).toHaveLength(0)
  })

  it('bounds one cycle by the packing budget', async () => {
    const directory = await tempDir()
    const store = new CallStore({ ...resolveStoreConfig({ directory }), packBudgetBytes: 1 })
    for (let i = 0; i < 4; i += 1) {
      await store.append(recordOf({ id: `r${i}`, request: { messages: [{ role: 'user', content: [{ type: 'text', text: `body ${i} ${'z'.repeat(500)}` }] }] } }))
    }
    await oldEnough(directory, (await store.objectCensusForTest()).map(row => row.hash))

    await store.sweep()
    const status = store.lastSweepStatus
    expect(status?.packedObjects).toBeGreaterThan(0)
    // A 1-byte budget still makes progress, but does not drain the store.
    expect(await store.objectCensusForTest()).not.toHaveLength(0)
  })

  it('packs nothing when pack is off', async () => {
    const directory = await tempDir()
    const store = new CallStore(resolveStoreConfig({ directory, pack: 'off' }))
    await store.append(recordOf({ id: 'a' }))
    await oldEnough(directory, (await store.objectCensusForTest()).map(row => row.hash))

    await store.sweep()
    expect(await readdir(join(directory, 'objects', 'packs')).catch(() => [])).toEqual([])
  })
})
```

Add the small test seam this needs, next to the other `ForTest` helpers if any exist, otherwise as a plainly-named method with a doc comment saying it exists for tests:

```ts
  /** Loose object census — exposed so specs can age objects deterministically. */
  objectCensusForTest(): Promise<{ hash: string; size: number; mtimeMs: number }[]> {
    return this.blobs.looseCensus()
  }
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/store.spec.ts`
Expected: FAIL — no `packs/` directory is ever created; `packedObjects` is undefined.

- [ ] **Step 3: Implement**

Wire a `PackStore` beside the `BlobStore` in the `CallStore` constructor. Construct it **unconditionally** — `pack: 'off'` must stop *writing* packs, never stop reading them, or turning the switch off would hide every already-packed record:

```ts
    const objectsDir = join(config.directory, 'objects')
    this.packs = new PackStore({ directory: join(objectsDir, 'packs') })
    this.packingEnabled = config.pack !== 'off'
    this.blobs = blobStore ?? new BlobStore({ directory: objectsDir, packs: this.packs })
```

Then add the phase in `sweep()`, after GC:

```ts
      if (this.v2Enabled && this.packingEnabled) {
        status.phase = 'pack'
        try {
          await this.packColdObjects(reachable, order, now, status)
        } catch (error) {
          // Packing is an optimization: a failure leaves everything loose.
          swallowed('pack', error)
        }
      }
```

where `order` came from `packingOrder(...)` built during the file walk (collect `{ at, hashes }` per envelope line while the text is already in hand), and:

```ts
  private async packColdObjects(
    reachable: ReadonlySet<string>,
    order: readonly string[],
    now: number,
    status: SweepStatus,
  ): Promise<void> {
    const rank = new Map(order.map((hash, i) => [hash, i]))
    const grace = DEFAULT_GC_GRACE_MS
    const candidates = (await this.blobs.looseCensus())
      .filter(row => reachable.has(row.hash) && now - row.mtimeMs > grace)
      .sort((a, b) => (rank.get(a.hash) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.hash) ?? Number.MAX_SAFE_INTEGER)
        || (a.hash < b.hash ? -1 : 1))
    if (candidates.length === 0) return

    const budget = this.config.packBudgetBytes ?? DEFAULT_PACK_BUDGET_BYTES
    const objects: { hash: string; raw: Buffer }[] = []
    let spent = 0
    for (const candidate of candidates) {
      if (spent > 0 && spent >= budget) break
      const raw = await this.blobs.get(candidate.hash).catch(() => null)
      if (raw === null) continue
      objects.push({ hash: candidate.hash, raw })
      spent += raw.length
    }
    if (objects.length === 0) return

    await this.packs.append(objects, this.config.packBlockBytes ?? DEFAULT_PACK_BLOCK_BYTES)
    // Only now: the blocks and an index naming them are both durable.
    for (const object of objects) {
      if (await this.blobs.dropLoose(object.hash)) status.packedObjects += 1
    }
    status.packedBytes += spent
  }
```

Add these beside the other defaults in `src/host/store.ts` (all four are used by Tasks 8, 10 and 11):

```ts
/** Raw bytes per solid block: 1 MiB measured best on tail latency (p90 12.2 ms). */
export const DEFAULT_PACK_BLOCK_BYTES = 1024 * 1024
/** Raw bytes one sweep may move into packs, mirroring the migration budget. */
export const DEFAULT_PACK_BUDGET_BYTES = 64 * 1024 * 1024
/** Below this share of still-reachable entries, a pack is worth rewriting. */
export const DEFAULT_REPACK_LIVE_RATIO = 0.5
/** Rewriting anything smaller costs more IO than the space it reclaims. */
export const DEFAULT_REPACK_MIN_BYTES = 8 * 1024 * 1024
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run && npx tsc --noEmit && npx oxlint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/host/store.ts tests/store.spec.ts
git commit -m "Pack cold reachable objects during the sweep"
```

---

## Task 9: The incomplete-knowledge guard

The single most dangerous failure in this design: a mark phase that failed halfway produces a small reachable set, and both the GC and the repack would then treat live data as garbage. Today's sweep is fail-soft per stage, which is exactly wrong here.

**Files:**
- Modify: `src/host/store.ts`
- Test: `tests/store.spec.ts`

**Interfaces:**
- Produces: a local `markComplete` flag in `sweep()`, set false by any failure in the retention/mark loop or in `markTreeChains`, and required by the GC, pack, and repack phases. `SweepStatus` gains `markComplete: boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/store.spec.ts
describe('sweep safety', () => {
  it('skips GC and packing entirely when the reachable set is incomplete', async () => {
    const directory = await tempDir()
    const store = new CallStore(resolveStoreConfig({ directory }))
    await store.append(recordOf({ id: 'kept' }))

    // A session file the mark phase cannot read: a directory where a .jsonl
    // should be. The reachable set is now missing whatever it referenced.
    await mkdir(join(directory, 'wedged.jsonl'))
    const before = (await store.objectCensusForTest()).length
    const past = new Date(Date.now() - 3 * 60 * 60 * 1000)
    for (const row of await store.objectCensusForTest()) {
      await utimes(join(directory, 'objects', row.hash.slice(0, 2), `${row.hash}.drl`), past, past)
    }

    await store.sweep()

    const status = store.lastSweepStatus
    expect(status?.markComplete).toBe(false)
    expect(status?.removedObjects).toBe(0)
    expect(status?.packedObjects).toBe(0)
    // Nothing was deleted and nothing was moved: the store is exactly as it was.
    expect(await store.objectCensusForTest()).toHaveLength(before)
    expect((await store.get('sess-1', 'kept'))?.id).toBe('kept')
  })

  it('still reports the failure it swallowed', async () => {
    const directory = await tempDir()
    const store = new CallStore(resolveStoreConfig({ directory }))
    await store.append(recordOf({ id: 'x' }))
    await mkdir(join(directory, 'wedged.jsonl'))
    await store.sweep()
    expect(store.lastSweepStatus?.error).toBeDefined()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/store.spec.ts`
Expected: FAIL — `markComplete` is undefined, and the GC runs regardless.

- [ ] **Step 3: Implement**

- Declare `let markComplete = true` before the file loop.
- In the `catch` of the per-file loop, after `swallowed(...)`, set `markComplete = false`. Do the same in the `markTreeChains` catch.
- Gate the phases:

```ts
        // A reachable set built from an incomplete read marks live objects as
        // garbage. Missing a cycle costs a day of disk; deleting a body costs
        // the record forever.
        if (markComplete) {
          try { ... blobs.gc ... } catch { ... }
        }
```
  and the same condition on the pack phase (Task 8) and the repack phase (Task 10).
- Publish `status.markComplete = markComplete`.

Note that retention *deletion* of stale session files is unaffected: it depends on mtime, not on the reachable set.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run && npx tsc --noEmit && npx oxlint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/host/store.ts tests/store.spec.ts
git commit -m "Never reclaim on an incomplete reachable set"
```

---

## Task 10: Repack a pack that has gone mostly dead

**Files:**
- Modify: `src/host/store.ts`
- Test: `tests/store.spec.ts`

**Interfaces:**
- Consumes: `PackStore.list`, `entriesOf`, `append`, `retire`, `reapRetired`.
- Produces: `StoreConfig` gains `repackLiveRatio?`, `repackMinBytes?`; `SweepStatus` gains `repackedPacks: number`; `SweepPhase` gains `'repack'`.

Algorithm: for each pack, count entries in `reachable`. If `live / total < repackLiveRatio` (0.5) and `bytes >= repackMinBytes` (8 MiB), read the live objects **in `entriesOf` order**, append them (they land in a new pack because the old one is retired first — no: append first, then retire, per invariant 2), then retire the old pack. Always call `reapRetired()` at the end of the phase.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/store.spec.ts
describe('repack', () => {
  it('rewrites a pack whose objects are mostly unreachable, keeping the live ones', async () => {
    const directory = await tempDir()
    const store = new CallStore({
      ...resolveStoreConfig({ directory }),
      repackMinBytes: 1,
      maxCallsPerSession: 1,
    })
    // Two calls, then the cap trims the first away: its objects go unreachable.
    await store.append(recordOf({ id: 'first', request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'a'.repeat(4000) }] }] } }))
    const past = new Date(Date.now() - 3 * 60 * 60 * 1000)
    for (const row of await store.objectCensusForTest()) {
      await utimes(join(directory, 'objects', row.hash.slice(0, 2), `${row.hash}.drl`), past, past)
    }
    await store.sweep()                       // packs everything
    await store.append(recordOf({ id: 'second' }))
    await store.sweep()                       // trims 'first', repacks

    const status = store.lastSweepStatus
    expect(status?.repackedPacks).toBeGreaterThan(0)
    expect((await store.get('sess-1', 'second'))?.id).toBe('second')
  })

  it('keeps a healthy pack untouched', async () => {
    const directory = await tempDir()
    const store = new CallStore({ ...resolveStoreConfig({ directory }), repackMinBytes: 1 })
    await store.append(recordOf({ id: 'alive' }))
    const past = new Date(Date.now() - 3 * 60 * 60 * 1000)
    for (const row of await store.objectCensusForTest()) {
      await utimes(join(directory, 'objects', row.hash.slice(0, 2), `${row.hash}.drl`), past, past)
    }
    await store.sweep()
    const before = await readdir(join(directory, 'objects', 'packs'))
    await store.sweep()
    expect(store.lastSweepStatus?.repackedPacks).toBe(0)
    expect(await readdir(join(directory, 'objects', 'packs'))).toEqual(before)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/store.spec.ts`
Expected: FAIL — `repackedPacks` undefined.

- [ ] **Step 3: Implement**

```ts
  /**
   * Packs are immutable, so space inside one is reclaimed by writing a new
   * pack holding only what is still reachable and retiring the old file.
   * Stored order is preserved on purpose: it is what the compression ratio
   * rests on, and a repack that reordered would inflate the store it was
   * called to shrink.
   */
  private async repackDeadPacks(reachable: ReadonlySet<string>, status: SweepStatus): Promise<void> {
    const ratio = this.config.repackLiveRatio ?? DEFAULT_REPACK_LIVE_RATIO
    const minBytes = this.config.repackMinBytes ?? DEFAULT_REPACK_MIN_BYTES
    for (const info of await this.packs.list()) {
      if (info.bytes < minBytes || info.entryCount === 0) continue
      const hashes = await this.packs.entriesOf(info.id)
      const live = hashes.filter(hash => reachable.has(hash))
      if (live.length / hashes.length >= ratio) continue

      const objects: { hash: string; raw: Buffer }[] = []
      for (const hash of live) {
        const raw = await this.blobs.get(hash).catch(() => null)
        if (raw !== null) objects.push({ hash, raw })
      }
      // Could not read them all: leave the pack exactly as it is.
      if (objects.length !== live.length) continue
      // Seal FIRST: without it the survivors could be appended to the very
      // pack about to be retired, and the retire would take them with it.
      this.packs.seal(info.id)
      if (objects.length > 0) await this.packs.append(objects, this.config.packBlockBytes ?? DEFAULT_PACK_BLOCK_BYTES)
      await this.packs.retire(info.id)
      status.repackedPacks += 1
    }
    await this.packs.reapRetired()
  }
```

Add the seal to `PackStore` — an in-memory set that only bars a pack from being the *append target*; reads are unaffected:

```ts
  private readonly sealed = new Set<string>()

  /** Bar a pack from receiving appends (it is being replaced). */
  seal(id: string): void {
    this.sealed.add(id)
  }
```

and in `activePack()`, skip a newest id that is sealed:

```ts
    const newest = ids.filter(id => !this.sealed.has(id)).at(-1)
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run && npx tsc --noEmit && npx oxlint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/host/pack.ts src/host/store.ts tests/store.spec.ts
git commit -m "Repack a pack whose objects have mostly gone unreachable"
```

---

## Task 11: Unpacking — the rollback door

`pack: 'off'` must not merely stop packing; it must be able to undo it, or the format is a one-way door for anyone who needs to downgrade.

**Files:**
- Modify: `src/host/store.ts`, `src/host/pack.ts`
- Test: `tests/store.spec.ts`

**Interfaces:**
- Produces: `SweepStatus.unpackedObjects: number`; a `'unpack'` phase; `PackStore.entriesOf` reused.

Behaviour: when `pack === 'off'` and packs exist, each sweep moves up to `packBudgetBytes` of packed objects back to loose (via `BlobStore.put`), and retires a pack once every object it holds is loose again.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/store.spec.ts
it('unpacks back to loose objects when packing is turned off', async () => {
  const directory = await tempDir()
  const packed = new CallStore(resolveStoreConfig({ directory }))
  await packed.append(recordOf({ id: 'a' }))
  const past = new Date(Date.now() - 3 * 60 * 60 * 1000)
  for (const row of await packed.objectCensusForTest()) {
    await utimes(join(directory, 'objects', row.hash.slice(0, 2), `${row.hash}.drl`), past, past)
  }
  await packed.sweep()
  expect(await packed.objectCensusForTest()).toHaveLength(0)

  const off = new CallStore(resolveStoreConfig({ directory, pack: 'off' }))
  await off.sweep()

  expect(off.lastSweepStatus?.unpackedObjects).toBeGreaterThan(0)
  expect(await off.objectCensusForTest()).not.toHaveLength(0)
  expect((await off.get('sess-1', 'a'))?.id).toBe('a')
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/store.spec.ts`
Expected: FAIL — `unpackedObjects` undefined; the census stays empty.

- [ ] **Step 3: Implement**

```ts
  /**
   * The way back out. Packing changes only where bytes live, so undoing it is
   * a copy in the other direction — but a build that cannot read packs is a
   * build that would see every packed record as unavailable, so this exists
   * before anyone needs it, not after.
   */
  private async unpackObjects(status: SweepStatus): Promise<void> {
    const budget = this.config.packBudgetBytes ?? DEFAULT_PACK_BUDGET_BYTES
    let spent = 0
    for (const info of await this.packs.list()) {
      const hashes = await this.packs.entriesOf(info.id)
      let allLoose = true
      for (const hash of hashes) {
        if (spent >= budget) { allLoose = false; break }
        const raw = await this.packs.read(hash).catch(() => null)
        if (raw === null) continue
        const result = await this.blobs.putLoose(hash, raw)
        if (result.created) status.unpackedObjects += 1
        spent += raw.length
      }
      if (allLoose) await this.packs.retire(info.id)
    }
    await this.packs.reapRetired()
  }
```

`blobs.put` consults the pack store and would short-circuit on a packed hash, so unpacking needs a door around that check. Add it to `BlobStore` as a named method rather than an option flag, because the two callers want genuinely different things:

```ts
  /**
   * Materialize a loose copy even though the object is already packed — the
   * unpack path, and the only caller that wants to ignore a pack hit.
   */
  putLoose(hash: string, json: string | Buffer): Promise<PutResult> {
    return this.write(hash, json)
  }
```

Extract today's `put` body below the pack check into a private `write(hash, json)` that both `put` and `putLoose` call.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run && npx tsc --noEmit && npx oxlint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/host/pack.ts src/host/store.ts tests/store.spec.ts
git commit -m "Unpack when packing is turned off, so the format is a two-way door"
```

---

## Task 12: Config, /health, and the docs

**Files:**
- Modify: `src/host/index.ts`, `README.md`, `DESIGN-persistence.md`
- Test: `tests/plugin.spec.ts`, `tests/api.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/plugin.spec.ts
it('takes the pack switch and nothing else', () => {
  expect(Config.parse({ pack: 'off' }).pack).toBe('off')
  expect(Config.parse({}).pack).toBe('auto')
  expect(() => Config.parse({ pack: 'yes' })).toThrow()
  expect(resolveStoreConfig({ pack: 'off' }).pack).toBe('off')
})
```

```ts
// tests/api.spec.ts — add inside the existing describe, reusing the file's
// own seededStore() / makeHandler() / handle() helpers.
it('reports the packing counters on /health', async () => {
  const store = await seededStore()
  await store.sweep()
  const { handler, dispose } = await makeHandler(store)
  const health = await handle(handler, 'GET', '/dsh-request-log/health', { host: '127.0.0.1:3080' })
  expect(health.status).toBe(200)
  const body = JSON.parse(health.body) as { sweep?: Record<string, unknown> }
  expect(body.sweep).toMatchObject({
    markComplete: true,
    packedObjects: expect.any(Number),
    repackedPacks: expect.any(Number),
  })
  dispose()
})
```

If `handle()` in that file returns the parsed body rather than a string, assert on it directly — match the shape the neighbouring tests already use.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/plugin.spec.ts tests/api.spec.ts`
Expected: FAIL — unknown key `pack` is rejected by `.strict()`.

- [ ] **Step 3: Implement**

- `Config`: `pack?: 'auto' | 'off'` with `z.enum(['auto', 'off']).default('auto')`, doc comment explaining that `off` also unpacks.
- `resolveStoreConfig`: pass it through.
- `/health`: the sweep status already serializes wholesale; confirm the new fields appear and add them to the README's health description if one exists.
- README: add the `pack` row to the config table; update the Storage bullet with the measured pack figures (11,279 objects: 30.86 MB loose → ~7.6 MB packed, ~40 files) and replace the "budget roughly 3–4×" occupancy guidance, which the NTFS residency measurement showed to be 1.9× for loose objects and ~1.0× once packed.
- `DESIGN-persistence.md`: add §11 with this document's **Design** section — layout, both formats, read/write paths, packing, repack, and the two invariants, stated as invariants.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run && npx tsc --noEmit && npx oxlint && npm run build`
Expected: PASS, clean, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/host/index.ts README.md DESIGN-persistence.md tests/plugin.spec.ts tests/api.spec.ts
git commit -m "Expose the pack switch and document the v4 object layout"
```

---

## Task 13: Benchmark script and a real-store rehearsal

The numbers in this plan came from a real store. Before this ships, reproduce them against a **copy** of one.

**Files:**
- Create: `scripts/bench-pack.mjs`

- [ ] **Step 1: Write the script**

```js
// scripts/bench-pack.mjs
/**
 * Reproduce the pack design's numbers against any store directory, read only.
 * Usage: node scripts/bench-pack.mjs <storeDir>
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { encodeBlock } from '../src/host/pack-format.ts'

const ROOT = process.argv[2]
if (ROOT === undefined) throw new Error('usage: node scripts/bench-pack.mjs <storeDir>')
const OBJ = join(ROOT, 'objects')
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
    looseStored += frame.length
    looseDisk += alloc(frame.length)
    objects.set(name.slice(0, -4), frame[4] === 0 ? frame.subarray(5) : inflateRawSync(frame.subarray(5)))
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
    if (groupBytes >= BLOCK) cut()
  }
}
for (const [hash, raw] of objects) {
  if (blockOf.has(hash)) continue
  blockOf.set(hash, blockIndex)
  group.push({ hash, raw })
  groupBytes += raw.length
  if (groupBytes >= BLOCK) cut()
}
cut()

const index = objects.size * 48
const spans = calls.map(c => new Set(c.touched.map(h => blockOf.get(h))).size).sort((a, b) => a - b)
console.log(`objects        ${objects.size}   calls ${calls.length}`)
console.log(`loose          stored ${mb(looseStored)}   on disk ${mb(looseDisk)}   files ${objects.size}`)
console.log(`packed 1 MiB   stored ${mb(packed + index)}   blocks ${blockIndex}`)
console.log(`blocks per detail read   p50 ${pct(spans, 0.5)}   p90 ${pct(spans, 0.9)}   max ${spans.at(-1)}`)
```

Run it with `npx tsx scripts/bench-pack.mjs <dir>` if importing the `.ts` module directly is a problem in your Node setup; otherwise inline the two constants it needs and keep it dependency-free.

- [ ] **Step 2: Rehearse on a copy of the live store**

```bash
cp -r "$HOME/.dsh/request-log" /tmp/store-copy
node scripts/bench-pack.mjs /tmp/store-copy
```
Expected, for a store like the one measured: loose ≈ 30.9 MB → packed ≈ 7.6 MB, ~11k objects → tens of files.

- [ ] **Step 3: Run a real sweep against the copy and diff every record**

Write a throwaway script that opens the copy with `CallStore`, reads every record via `listIndex` + `get`, runs `sweep()` until packing settles, then reads every record again and compares JSON byte for byte. **Zero differences is the gate.** Do not proceed to a live rollout on a non-zero diff.

- [ ] **Step 4: Commit**

```bash
git add scripts/bench-pack.mjs
git commit -m "Add the pack benchmark that reproduces the design's numbers"
```

---

## Rollout

1. Ship with `pack: 'auto'`. The first sweep after upgrade packs at most 64 MiB and the rest follows on later cycles, so the first run is bounded.
2. Watch `/health`: `markComplete` must stay `true`, `packedObjects` should climb then settle, `repackedPacks` should stay near zero on a healthy store.
3. If anything looks wrong, set `pack: 'off'` in the profile patch. Later sweeps unpack; nothing is lost either way.

## Out of scope

- Changing the envelope, tree, or record formats. This plan touches only where object bytes live.
- Changing `zn` accounting. Packing shrinks physical bytes below what `zn` recorded, which makes `maxFileBytes` conservative — document it, do not "fix" it.
- Encrypting anything. Discussed and deliberately rejected: device-bound key storage protects against disk theft only, which full-disk encryption already covers, and it would add a total-loss failure mode to a store that has no second copy.
