# v3 Tree Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Stop the v2 `refs[]` array from re-listing the whole conversation on every append — move the piece list into content-addressed *tree objects* chained by parent pointer with periodic keyframes, so an envelope line stays ~200 bytes no matter how long the session runs.

**Architecture:** The object store gains a second object kind: a **tree**, whose content is JSON naming either every request piece (a *keyframe*) or a parent tree plus the pieces this turn added (a *delta*). A v3 envelope carries one `tree` hash, one optional `resp` hash, and `zn` — the compressed bytes of objects this append actually created. Reads resolve a tree by walking parent pointers (bounded at 32 by the keyframe interval). GC marking becomes transitive through tree objects. v1 and v2 lines stay readable forever and migrate to v3 lazily.

**Tech Stack:** TypeScript 7 (experimental API), Node >= 20, vitest 4, tsdown/rolldown, oxlint. No new runtime dependencies.

**Spec:** This document. The "Design" section below is the spec; the tasks implement it. The measurements that motivate it are in "Why". The existing v2 design doc is `DESIGN-v2-persistence.md` at the repo root — **read it first**; this plan assumes its vocabulary (envelope, piece, blob, DRL1 frame, logical/attributed bytes, the serialized per-file append chain).

## Global Constraints

- **Node floor is `>=20`.** Emit es2023 syntax only. No `Object.groupBy`, no `Array.fromAsync`, no `Promise.withResolvers`.
- **No new runtime dependencies.** `dependencies` stays empty; `peerDependencies` unchanged.
- **All store IO is fail-soft.** A storage error must never break or delay a model call. Missing data degrades at the *caller* (a `{ "$unavailable": "<hash>" }` slot); corrupt data throws in the blob layer and is never served.
- **Wrong data must be impossible.** Every blob read verifies `sha256(content) === hash` before returning. Never weaken this.
- **Crash tolerance:** every object an envelope references must be renamed into place *before* the envelope line is appended, inside the same per-session serialized chain.
- **Per-line independence:** every JSONL line stays independently parseable and independently resolvable. A trim that keeps the newest N lines must never orphan them. (This is exactly why the parent chain lives in the object store, not in the line.)
- **Windows and POSIX both.** CI runs `ubuntu-latest` and `windows-latest`. Never assume POSIX separators or atomic-overwrite semantics beyond same-directory rename.
- **Verification commands** (from the repo root):
  - `npx tsc --noEmit` — exits 0
  - `npx oxlint` — prints nothing, exits 0
  - `npx vitest run` — all tests pass
  - `npm run build` — succeeds
- **TDD is mandatory.** Every behavioural step: write the failing test, run it, watch it fail *for the right reason*, then implement. A test that passes the moment you write it is testing nothing — change it until it fails first.
- **Commit after every task**, using the message given in that task's final step.

## Before you start: what the branch already does

Branch: `release-readiness-pass`. Read `git log --oneline 60bfeb4..HEAD` — eight commits of release-readiness work already landed and this plan builds on all of them. Two in particular constrain your edits:

- **`sweep()` publishes a live `SweepStatus`** (`CallStore.lastSweepStatus`, served verbatim by `/health`): `phase`, `filesSeen`, `deletedFiles`, `trimmedFiles`, `migrationCandidates`, `migratedFiles`, `removedObjects`, `removedTemp`, timing, and `error` — the most recent failure a fail-soft stage swallowed, via a local `swallowed(stage, error)` helper. **Every stage you add or touch inside `sweep` must keep feeding that status**, including the new tree-marking pass. A migration that silently never runs is precisely the bug that motivated it. `migrateFile` returns `Promise<boolean>` for the same reason.
- **The per-file append chains assume one writer per directory.** Two processes pointed at the same `directory` can still interleave rewrites. Do not add anything that widens that window; the tree chain lives in the immutable object store precisely so concurrent writers converge rather than conflict.

The store currently has 186 passing tests across 14 files. Do not let that number go down.

---

## Why (measured on a real 830-call store — do not re-derive)

| measurement | value |
| --- | --- |
| v2 envelope lines on disk | 17.8 MB |
| unique blob content those lines index | 5.14 MB (3,444 objects) |
| index overhead vs content | **3.5x** overall, **6.8x** on the longest sessions |
| `refs[]` share of envelope bytes | **97.6%** (57% on 6-call sessions, 99% on 135-call sessions) |
| mean envelope line | 26,271 B (max 53,701 B) |
| `Σz` (what `maxFileBytes` counts) | 262 MB — against 5.14 MB of real content |

Cause: every append re-lists every piece hash of the whole conversation. Envelope bytes grow as `calls × messages × ~85 B` — quadratic in session length. The v2 dedup removed redundancy from message *bodies* and reintroduced it in message *hashes*.

A second, independent problem this plan also fixes: `logicalBytesOfLine` sums `refs[].z` per envelope, counting a shared blob once per referencing record. On the largest real session that attributes 62.82 MB to 5.44 MB of actual disk — **12.4x** — so `maxFileBytes: 128 MiB` starts discarding history at roughly 10 MB of real occupancy. v3's `zn` counts only objects an append actually created, which is exact by construction.

---

## Design

### The tree object

A tree is an ordinary object in the existing store (`objects/<2hex>/<sha256>.drl`, DRL1 frame, deflateRaw). Its content is this JSON, keys in exactly this order:

```json
{"t":3,"p":"<parent tree sha256>","e":[{"k":"m","h":"<sha256>"}]}
```

- `t` — always `3`. Distinguishes a tree from a piece blob.
- `p` — parent tree hash. **Absent on a keyframe.**
- `e` — the entries this node *adds*. On a keyframe, `e` is the complete ordered entry list.
- `k` — `s` (system), `t` (tools), or `m` (message). The v2 `EnvelopeRef['k']` vocabulary minus `r`.

There is no `z` on a tree entry; byte accounting moved to the envelope's `zn`.

**Entry order is canonical:** `s` (if present), then `t` (if present), then every `m` in conversation order — identical to what `splitPieces` produces today, minus the response.

### Delta vs keyframe

Given this call's entry list and the previous tree state for the same session:

1. **Identical list** → reuse the previous tree hash. No new tree object. (This is what a retry produces.)
2. **Strict extension** (previous list is a prefix of the new one) **and** chain depth < 32 → emit a delta: `{"t":3,"p":<previous hash>,"e":[<added entries>]}`.
3. **Anything else** — different system prompt, changed tools, a compaction that rewrote history, depth already at 32, or no previous state at all (cold process, evicted cache) → emit a **keyframe**: `{"t":3,"e":[<whole list>]}`.

Rule 3 is what makes this correct rather than merely small: compaction replaces the message list wholesale and a delta cannot express that.

### Resolution

`resolveTree(hash, read)` walks `p` to the root collecting nodes, then concatenates their `e` arrays **root-first**. Because a delta is only ever emitted for a strict extension, that concatenation reproduces the exact original list.

The walk is bounded at `TREE_MAX_WALK = 64` nodes and refuses a repeated hash (cycle). Exceeding either throws — corrupt structure must never loop or serve a partial list.

### The v3 envelope

```json
{"v":3,"id":"...","sessionId":"...","provider":"...","model":"...","requestHash":"...","attempt":1,"timing":{},"status":"ok","opts":{},"tree":"<sha256>","resp":"<sha256>","zn":1234,"sum":{}}
```

- `tree` — required, the request's tree hash.
- `resp` — the response body's blob hash; absent when the record has no response.
- `zn` — sum of compressed payload sizes of every object **this append created**: new pieces, the new tree node (when one was written), the response blob (when new). A retry that creates nothing has `zn: 0`.
- `sum` — unchanged from v2 (`EnvelopeSum`). Index pages still project from the line alone, zero blob IO.

`id` stays immediately after `v` so `store.get()`'s substring prefilter keeps working.

### Byte accounting

`logicalBytesOfLine` gains a v3 branch: `lineBytes + env.zn`. Exact, stateless, no double counting. v2 lines keep their existing `lineBytes + Σ refs[].z` behaviour (a documented over-estimate) — files migrate to v3 and the over-estimate retires with them. v1 lines keep counting their physical size.

### GC

The mark phase currently regex-scans JSONL text for `"h":"<64hex>"`. It becomes two passes:

1. Collect every 64-hex string appearing in any line. Over-marking is safe — it only spares objects; under-marking deletes live data.
2. For every hash that appeared as `"tree":"<hash>"`, read the tree object and add its `p` and every `e[].h`, recursing with a visited set.

Pass 2 is why the GC change must ship **before or with** the first v3 write, never after.

### Compatibility

- Readers accept v1, v2 and v3 lines forever.
- Writers emit v3 when `format` is `auto` (the default), v1 when `format` is `v1` (the unchanged kill switch).
- `format: 'v2'` is deliberately **not** added — YAGNI; v2 was never a release the config needed to pin.

---

## File Structure

| file | responsibility |
| --- | --- |
| `src/host/tree.ts` | **Create.** Tree vocabulary: constants, `TreeEntry`/`TreeNode`/`TreeState` types, `encodeTree`, `decodeTree`, `chooseTreeNode`, `resolveTree`. Pure — no filesystem, no store knowledge. Reads are injected as a callback. |
| `tests/tree.spec.ts` | **Create.** Unit specs for everything in `tree.ts`. |
| `src/host/blob.ts` | **Modify.** `put()` reports whether it created the object, so the store can compute `zn`. |
| `src/shared/types.ts` | **Modify.** `RECORD_SCHEMA_V3`, `CallEnvelopeV3`, and `entryFromEnvelopeV3`. |
| `src/host/store.ts` | **Modify.** v3 write path, v3 read path, v3 accounting, transitive GC marking, v1/v2 → v3 migration. |
| `tests/blob.spec.ts`, `tests/store.spec.ts` | **Modify.** New specs alongside the existing ones. |
| `README.md`, `DESIGN-v2-persistence.md` | **Modify.** Document v3 (final task). |

`tree.ts` is deliberately free of `BlobStore`: it takes a `read: (hash) => Promise<Buffer>` callback. That keeps it unit-testable without a filesystem and keeps `store.ts` the only place that knows about both.

---

## Task 1: `put()` reports whether it created the object

`zn` needs to know which objects an append actually wrote. `put()` currently returns only the payload length.

**Files:**
- Modify: `src/host/blob.ts` (the `put` method and its two `payloadSizeOf` call sites)
- Modify: `src/host/store.ts` (`sealEnvelope`, the only current caller)
- Test: `tests/blob.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `BlobStore.put(hash: string, raw: string | Buffer): Promise<PutResult>` where `interface PutResult { z: number; created: boolean }`. `z` is the compressed payload length exactly as before; `created` is `true` only when this call wrote the object.

- [x] **Step 1: Write the failing test**

Add to `tests/blob.spec.ts`, inside the existing `describe('BlobStore', ...)` block, immediately before the test named `'rejects a put whose declared hash does not match its content'`:

```ts
  it('reports whether the put created the object or found it already baked', async () => {
    const store = new BlobStore({ directory: await tempDir() })
    const first = await store.put(HASH, PIECE)
    expect(first.created).toBe(true)
    expect(first.z).toBeGreaterThan(0)
    // The append path needs this to bill only the bytes it actually added.
    const second = await store.put(HASH, PIECE)
    expect(second.created).toBe(false)
    expect(second.z).toBe(first.z)
  })
```

- [x] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/blob.spec.ts`

Expected: FAIL on `expect(first.created).toBe(true)` with `expected undefined to be true` — `put` still resolves to a number.

Other tests in the file will also fail (they compare the return to a number). That is expected; Step 3 fixes them.

- [x] **Step 3: Change `put` to return `PutResult`**

In `src/host/blob.ts`, add the exported interface directly above `export class BlobStore`:

```ts
/** What one {@link BlobStore.put} did: the payload size, and whether it wrote. */
export interface PutResult {
  /** Compressed payload length — the envelope's byte accounting unit. */
  z: number
  /** True only when THIS call materialized the object. */
  created: boolean
}
```

Then change the `put` signature and its three returns:

```ts
  async put(hash: string, raw: string | Buffer): Promise<PutResult> {
    const buf = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw
    if (hashOfContent(buf) !== hash) throw new Error('blob put rejected: hash/content mismatch')
    const existing = await this.payloadSizeOf(hash)
    if (existing !== null) return { z: existing, created: false }
```

and the tail of the method:

```ts
    // The caller must learn a bake failed BEFORE any envelope references it.
    const landed = await this.payloadSizeOf(hash)
    if (landed === null) throw new Error(`blob object write failed for ${hash}`)
    return { z: landed, created: true }
  }
```

Update the doc comment's first sentence to: `Materialize one immutable object for raw content. Reports the COMPRESSED payload length and whether this call did the writing.`

- [x] **Step 4: Update the existing callers and specs**

In `src/host/store.ts`, `sealEnvelope` becomes:

```ts
  private async sealEnvelope(env: CallEnvelope, pieces: Piece[]): Promise<void> {
    for (let i = 0; i < env.refs.length; i += 1) {
      env.refs[i].z = (await this.blobs.put(env.refs[i].h, pieces[i].json)).z
    }
  }
```

In `tests/blob.spec.ts`, every existing `await store.put(...)` used as a number needs `.z`. The affected assertions are in these tests — update each:
- `'puts and gets objects with compressed sizes reported as z'`
- `'lands objects in the 2-hex bucket under the DRL1 frame name'`
- `'skips the disk write for an existing hash but still measures z'`
- `'does not recompress a piece already in the store'`
- `'reports z for an existing object from its frame, matching a fresh compression'`
- `'stores oversized pieces uncompressed behind the identity codec'`
- `'refuses corrupted objects via magic and hash verification'` (the trailing `const z = await store.put(HASH, PIECE)`)
- `'creates nested roots on demand (mkdir-on-first-put)'`

Mechanically: `const z = await store.put(a, b)` becomes `const { z } = await store.put(a, b)`; a bare `await store.put(a, b)` with no binding needs no change.

- [x] **Step 5: Run the full suite**

Run: `npx vitest run && npx tsc --noEmit && npx oxlint`

Expected: all tests pass, typecheck clean, lint silent.

- [x] **Step 6: Commit**

```bash
git add src/host/blob.ts src/host/store.ts tests/blob.spec.ts
git commit -m "Report whether a blob put created the object

The v3 envelope bills only the bytes an append actually added, so put()
must say whether it wrote or found the object already baked.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: The tree module

Pure vocabulary and algorithms, no filesystem. Fully unit-tested before anything wires it in.

**Files:**
- Create: `src/host/tree.ts`
- Test: `tests/tree.spec.ts`

**Interfaces:**
- Consumes: `hashOfContent` from `src/host/blob.ts`.
- Produces:
  - `const TREE_SCHEMA = 3`, `const TREE_KEYFRAME_INTERVAL = 32`, `const TREE_MAX_WALK = 64`
  - `interface TreeEntry { k: 's' | 't' | 'm'; h: string }`
  - `interface TreeNode { t: 3; p?: string; e: TreeEntry[] }`
  - `interface TreeState { hash: string; entries: TreeEntry[]; depth: number }`
  - `type TreeChoice = { kind: 'reuse' } | { kind: 'node'; node: TreeNode; depth: number }`
  - `encodeTree(node: TreeNode): string`
  - `decodeTree(json: string): TreeNode` — throws on anything malformed
  - `chooseTreeNode(entries: TreeEntry[], previous: TreeState | undefined): TreeChoice`
  - `resolveTree(hash: string, read: (hash: string) => Promise<Buffer>): Promise<TreeEntry[]>`

- [x] **Step 1: Write the failing tests**

Create `tests/tree.spec.ts`:

```ts
/**
 * Tree specs: the delta/keyframe choice, canonical encoding, decode
 * validation, and bounded chain resolution.
 */

import { describe, expect, it } from 'vitest'
import { hashOfContent } from '../src/host/blob.ts'
import {
  TREE_KEYFRAME_INTERVAL,
  TREE_SCHEMA,
  chooseTreeNode,
  decodeTree,
  encodeTree,
  resolveTree,
  type TreeEntry,
  type TreeState,
} from '../src/host/tree.ts'

const hashOf = (name: string): string => hashOfContent(name)
const entry = (k: TreeEntry['k'], name: string): TreeEntry => ({ k, h: hashOf(name) })

/** A read callback over an in-memory object table, as resolveTree expects. */
function readerOf(objects: Map<string, string>): (hash: string) => Promise<Buffer> {
  return async hash => {
    const value = objects.get(hash)
    if (value === undefined) throw new Error('missing object ' + hash)
    return Buffer.from(value, 'utf8')
  }
}

/** Store one node and return its hash, mirroring what the store does. */
function bake(objects: Map<string, string>, node: Parameters<typeof encodeTree>[0]): string {
  const json = encodeTree(node)
  const hash = hashOfContent(json)
  objects.set(hash, json)
  return hash
}

describe('encodeTree / decodeTree', () => {
  it('round-trips a keyframe with no parent key at all', () => {
    const node = { t: TREE_SCHEMA, e: [entry('s', 'sys'), entry('m', 'm1')] } as const
    const json = encodeTree(node)
    expect(json.startsWith('{"t":3,"e":')).toBe(true)
    expect(json).not.toContain('"p"')
    expect(decodeTree(json)).toEqual(node)
  })

  it('round-trips a delta with its parent first', () => {
    const parent = hashOf('parent')
    const json = encodeTree({ t: TREE_SCHEMA, p: parent, e: [entry('m', 'm2')] })
    expect(json.startsWith('{"t":3,"p":"' + parent + '"')).toBe(true)
    expect(decodeTree(json).p).toBe(parent)
  })

  it('refuses anything that is not a well-formed tree', () => {
    expect(() => decodeTree('not json')).toThrow()
    expect(() => decodeTree('null')).toThrow()
    expect(() => decodeTree('{"t":2,"e":[]}')).toThrow()
    expect(() => decodeTree('{"t":3}')).toThrow()
    expect(() => decodeTree('{"t":3,"e":{}}')).toThrow()
    expect(() => decodeTree('{"t":3,"e":[{"k":"x","h":"' + hashOf('a') + '"}]}')).toThrow()
    expect(() => decodeTree('{"t":3,"e":[{"k":"m","h":"short"}]}')).toThrow()
    expect(() => decodeTree('{"t":3,"p":"short","e":[]}')).toThrow()
  })
})

describe('chooseTreeNode', () => {
  const base: TreeEntry[] = [entry('s', 'sys'), entry('m', 'm1'), entry('m', 'm2')]

  it('emits a keyframe when there is no previous state', () => {
    const choice = chooseTreeNode(base, undefined)
    expect(choice.kind).toBe('node')
    if (choice.kind !== 'node') throw new Error('unreachable')
    expect(choice.node.p).toBeUndefined()
    expect(choice.node.e).toEqual(base)
    expect(choice.depth).toBe(0)
  })

  it('reuses the previous tree when the list is unchanged (a retry)', () => {
    const previous: TreeState = { hash: hashOf('prev'), entries: base, depth: 2 }
    expect(chooseTreeNode([...base], previous)).toEqual({ kind: 'reuse' })
  })

  it('emits a delta carrying only the added entries', () => {
    const previous: TreeState = { hash: hashOf('prev'), entries: base, depth: 2 }
    const next = [...base, entry('m', 'm3'), entry('m', 'm4')]
    const choice = chooseTreeNode(next, previous)
    if (choice.kind !== 'node') throw new Error('expected a node')
    expect(choice.node.p).toBe(previous.hash)
    expect(choice.node.e).toEqual([entry('m', 'm3'), entry('m', 'm4')])
    expect(choice.depth).toBe(3)
  })

  it('falls back to a keyframe when history was rewritten, not extended', () => {
    // What compaction does: the message list is replaced wholesale.
    const previous: TreeState = { hash: hashOf('prev'), entries: base, depth: 1 }
    const compacted = [entry('s', 'sys'), entry('m', 'summary')]
    const choice = chooseTreeNode(compacted, previous)
    if (choice.kind !== 'node') throw new Error('expected a node')
    expect(choice.node.p).toBeUndefined()
    expect(choice.node.e).toEqual(compacted)
    expect(choice.depth).toBe(0)
  })

  it('falls back to a keyframe when a changed system prompt shifts the prefix', () => {
    const previous: TreeState = { hash: hashOf('prev'), entries: base, depth: 1 }
    const next = [entry('s', 'other-sys'), entry('m', 'm1'), entry('m', 'm2'), entry('m', 'm3')]
    const choice = chooseTreeNode(next, previous)
    if (choice.kind !== 'node') throw new Error('expected a node')
    expect(choice.node.p).toBeUndefined()
  })

  it('cuts a fresh keyframe once the chain reaches the interval', () => {
    const atLimit: TreeState = { hash: hashOf('prev'), entries: base, depth: TREE_KEYFRAME_INTERVAL - 1 }
    const deep = chooseTreeNode([...base, entry('m', 'm3')], atLimit)
    if (deep.kind !== 'node') throw new Error('expected a node')
    expect(deep.node.p).toBe(atLimit.hash)
    expect(deep.depth).toBe(TREE_KEYFRAME_INTERVAL)

    const past: TreeState = { hash: hashOf('prev'), entries: base, depth: TREE_KEYFRAME_INTERVAL }
    const cut = chooseTreeNode([...base, entry('m', 'm3')], past)
    if (cut.kind !== 'node') throw new Error('expected a node')
    expect(cut.node.p).toBeUndefined()
    expect(cut.depth).toBe(0)
    // A keyframe must carry the WHOLE list, or resolution loses history.
    expect(cut.node.e).toHaveLength(4)
  })
})

describe('resolveTree', () => {
  it('rebuilds the exact list a keyframe plus deltas encoded', () => {
    const objects = new Map<string, string>()
    const first = [entry('s', 'sys'), entry('m', 'm1')]
    const rootHash = bake(objects, { t: TREE_SCHEMA, e: first })
    const second = [...first, entry('m', 'm2')]
    const midHash = bake(objects, { t: TREE_SCHEMA, p: rootHash, e: [entry('m', 'm2')] })
    const third = [...second, entry('m', 'm3'), entry('m', 'm4')]
    const leafHash = bake(objects, { t: TREE_SCHEMA, p: midHash, e: [entry('m', 'm3'), entry('m', 'm4')] })

    return Promise.all([
      expect(resolveTree(rootHash, readerOf(objects))).resolves.toEqual(first),
      expect(resolveTree(midHash, readerOf(objects))).resolves.toEqual(second),
      expect(resolveTree(leafHash, readerOf(objects))).resolves.toEqual(third),
    ])
  })

  it('propagates a missing link instead of returning a partial list', async () => {
    const objects = new Map<string, string>()
    const rootHash = bake(objects, { t: TREE_SCHEMA, e: [entry('m', 'm1')] })
    const leafHash = bake(objects, { t: TREE_SCHEMA, p: rootHash, e: [entry('m', 'm2')] })
    objects.delete(rootHash)
    // A truncated history is WRONG data; the caller degrades the whole slot.
    await expect(resolveTree(leafHash, readerOf(objects))).rejects.toThrow()
  })

  it('refuses a cyclic chain rather than looping forever', async () => {
    const objects = new Map<string, string>()
    // Forge a self-referencing node: encode with a placeholder, then rewrite
    // the stored content so its own hash is its parent.
    const selfJson = '{"t":3,"p":"PLACEHOLDER","e":[]}'
    const selfHash = hashOfContent(selfJson)
    objects.set(selfHash, selfJson.replace('PLACEHOLDER', selfHash))
    await expect(resolveTree(selfHash, readerOf(objects))).rejects.toThrow(/cycle|walk/i)
  })

  it('refuses a chain longer than the walk bound', async () => {
    const objects = new Map<string, string>()
    let hash = bake(objects, { t: TREE_SCHEMA, e: [entry('m', 'root')] })
    for (let i = 0; i < 80; i += 1) {
      hash = bake(objects, { t: TREE_SCHEMA, p: hash, e: [entry('m', 'm' + String(i))] })
    }
    await expect(resolveTree(hash, readerOf(objects))).rejects.toThrow(/walk/i)
  })
})
```

- [x] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/tree.spec.ts`

Expected: the whole file fails to load — `Failed to load url ../src/host/tree.ts`. That is the correct first failure.

- [x] **Step 3: Implement `src/host/tree.ts`**

```ts
/**
 * Tree objects: the request piece list of one call, stored in the object
 * store instead of being re-listed on every envelope line.
 *
 * A tree is either a KEYFRAME (`{"t":3,"e":[...]}` — the whole ordered entry
 * list) or a DELTA (`{"t":3,"p":<parent>,"e":[...]}` — the entries this turn
 * added on top of its parent). Consecutive calls extend the conversation, so
 * a delta is normally two entries; a keyframe every
 * {@link TREE_KEYFRAME_INTERVAL} nodes bounds how far a read has to walk.
 *
 * A delta is only ever emitted when the new list STRICTLY EXTENDS the
 * previous one. Compaction rewrites history wholesale, so it falls through
 * to a keyframe — which is what makes the concatenation in
 * {@link resolveTree} exact rather than approximate.
 *
 * This module is pure: reads arrive as a callback, so it never touches the
 * filesystem and never needs to know a BlobStore exists.
 *
 * @module dsh-request-log/host/tree
 */

/** Tree object format marker; also distinguishes a tree from a piece blob. */
export const TREE_SCHEMA = 3

/** Chain length at which the next node is cut as a fresh keyframe. */
export const TREE_KEYFRAME_INTERVAL = 32

/** Hard ceiling on nodes one resolution may visit (corruption guard). */
export const TREE_MAX_WALK = 64

const SHA256_HEX = /^[0-9a-f]{64}$/

/** One referenced request piece: system, tools, or one message. */
export interface TreeEntry {
  k: 's' | 't' | 'm'
  h: string
}

/** One stored tree node. `p` absent means keyframe: `e` is the whole list. */
export interface TreeNode {
  t: typeof TREE_SCHEMA
  p?: string
  e: TreeEntry[]
}

/** What the writer remembers about the tree it last wrote for a session. */
export interface TreeState {
  hash: string
  entries: TreeEntry[]
  /** Nodes between this one and its keyframe; a keyframe itself is 0. */
  depth: number
}

/**
 * The writer's decision for one call: reuse the previous tree unchanged (a
 * retry re-sends an identical list), or write this node at this depth.
 */
export type TreeChoice =
  | { kind: 'reuse' }
  | { kind: 'node'; node: TreeNode; depth: number }

/** Canonical JSON: fixed key order so identical trees hash identically. */
export function encodeTree(node: TreeNode): string {
  const parts: string[] = ['{"t":' + String(TREE_SCHEMA)]
  if (node.p !== undefined) parts.push(',"p":' + JSON.stringify(node.p))
  parts.push(',"e":[')
  parts.push(node.e.map(item => '{"k":' + JSON.stringify(item.k) + ',"h":' + JSON.stringify(item.h) + '}').join(','))
  parts.push(']}')
  return parts.join('')
}

/** Parse one stored tree, rejecting every malformed shape. */
export function decodeTree(json: string): TreeNode {
  const value: unknown = JSON.parse(json)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('tree is not an object')
  const raw = value as { t?: unknown; p?: unknown; e?: unknown }
  if (raw.t !== TREE_SCHEMA) throw new Error('unknown tree schema')
  if (!Array.isArray(raw.e)) throw new Error('tree entries missing')
  const entries: TreeEntry[] = raw.e.map(item => {
    if (item === null || typeof item !== 'object') throw new Error('tree entry is not an object')
    const { k, h } = item as { k?: unknown; h?: unknown }
    if (k !== 's' && k !== 't' && k !== 'm') throw new Error('unknown tree entry kind')
    if (typeof h !== 'string' || !SHA256_HEX.test(h)) throw new Error('tree entry hash malformed')
    return { k, h }
  })
  if (raw.p === undefined) return { t: TREE_SCHEMA, e: entries }
  if (typeof raw.p !== 'string' || !SHA256_HEX.test(raw.p)) throw new Error('tree parent hash malformed')
  return { t: TREE_SCHEMA, p: raw.p, e: entries }
}

/** Whether `entries` starts with every entry of `prefix`, in order. */
function extendsPrefix(entries: readonly TreeEntry[], prefix: readonly TreeEntry[]): boolean {
  if (entries.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i += 1) {
    if (entries[i].k !== prefix[i].k || entries[i].h !== prefix[i].h) return false
  }
  return true
}

/**
 * Pick the node for this call's entry list. A delta needs the previous list
 * to be a prefix of this one AND the chain to be under the keyframe
 * interval; everything else — rewritten history, a changed system prompt, a
 * cold process with no previous state — cuts a keyframe.
 */
export function chooseTreeNode(entries: TreeEntry[], previous: TreeState | undefined): TreeChoice {
  if (previous !== undefined && extendsPrefix(entries, previous.entries)) {
    if (entries.length === previous.entries.length) return { kind: 'reuse' }
    if (previous.depth < TREE_KEYFRAME_INTERVAL) {
      return {
        kind: 'node',
        node: { t: TREE_SCHEMA, p: previous.hash, e: entries.slice(previous.entries.length) },
        depth: previous.depth + 1,
      }
    }
  }
  return { kind: 'node', node: { t: TREE_SCHEMA, e: [...entries] }, depth: 0 }
}

/**
 * The full ordered entry list a tree hash stands for: walk parents to the
 * keyframe, then concatenate the nodes' entries root-first. A missing link,
 * a cycle, or a chain past {@link TREE_MAX_WALK} throws — a partial list
 * would be wrong data, and the caller degrades the whole slot instead.
 */
export async function resolveTree(
  hash: string,
  read: (hash: string) => Promise<Buffer>,
): Promise<TreeEntry[]> {
  const chain: TreeNode[] = []
  const seen = new Set<string>()
  let cursor: string | undefined = hash
  while (cursor !== undefined) {
    if (seen.has(cursor)) throw new Error(`tree chain cycle at ${cursor}`)
    if (chain.length >= TREE_MAX_WALK) throw new Error(`tree chain exceeds the walk bound at ${cursor}`)
    seen.add(cursor)
    const node = decodeTree((await read(cursor)).toString('utf8'))
    chain.push(node)
    cursor = node.p
  }
  const entries: TreeEntry[] = []
  for (let i = chain.length - 1; i >= 0; i -= 1) entries.push(...chain[i].e)
  return entries
}
```

- [x] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run tests/tree.spec.ts && npx tsc --noEmit && npx oxlint`

Expected: all tree specs pass, typecheck clean, lint silent.

If the cycle test fails with a walk-bound message instead of a cycle message, that is still acceptable — the assertion accepts either. If it hangs, the `seen` guard is wrong; fix it before moving on.

- [x] **Step 5: Commit**

```bash
git add src/host/tree.ts tests/tree.spec.ts
git commit -m "Add tree objects: keyframe plus delta piece lists

A tree names one call's request pieces as either a keyframe (the whole
ordered list) or a delta on a parent. Deltas are only emitted for strict
extensions, so compaction — which rewrites history wholesale — falls back
to a keyframe and resolution stays exact.

Pure module: reads arrive as a callback, so it needs no filesystem.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Transitive GC marking

Must land **before** any v3 line is written, or a sweep would delete live trees.

**Files:**
- Modify: `src/host/store.ts` (the `REACHABLE_HASH` constant and the `sweep` mark phase)
- Test: `tests/store.spec.ts`

**Interfaces:**
- Consumes: `decodeTree` from `src/host/tree.ts` (Task 2).
- Produces: `CallStore.sweep` marks transitively. No new public API.

- [x] **Step 1: Write the failing test**

Add to `tests/store.spec.ts`, immediately before the test named `'migrates a legacy file losslessly and idempotently'`:

```ts
  it('marks tree chains transitively so a swept store keeps live pieces', async () => {
    const directory = await tempDir()
    const objects = join(directory, 'objects')
    await mkdir(directory, { recursive: true })

    // Bake one piece, one keyframe naming it, one delta naming a second piece.
    const bakeRaw = async (content: string): Promise<string> => {
      const hash = hashOfContent(content)
      await mkdir(join(objects, hash.slice(0, 2)), { recursive: true })
      await writeFile(
        join(objects, hash.slice(0, 2), hash + '.drl'),
        encodeFrame(CODEC_DEFLATE_RAW, deflateRawSync(Buffer.from(content, 'utf8'), { level: 6 })),
      )
      return hash
    }
    const older = await bakeRaw(JSON.stringify({ role: 'user', content: [] }))
    const newer = await bakeRaw(JSON.stringify({ role: 'assistant', content: [] }))
    const rootHash = await bakeRaw(encodeTree({ t: TREE_SCHEMA, e: [{ k: 'm', h: older }] }))
    const leafHash = await bakeRaw(encodeTree({ t: TREE_SCHEMA, p: rootHash, e: [{ k: 'm', h: newer }] }))

    // Only the LEAF appears in the line. Everything behind it is reachable
    // solely through the tree chain.
    await writeFile(
      join(directory, 'sess-1.jsonl'),
      JSON.stringify({ v: 3, id: 'c-1', tree: leafHash }) + '\n',
    )
    // Age every object past the GC grace floor so nothing is spared by mtime.
    const stale = new Date(Date.now() - 3 * 60 * 60 * 1000)
    for (const hash of [older, newer, rootHash, leafHash]) {
      await utimes(join(objects, hash.slice(0, 2), hash + '.drl'), stale, stale)
    }

    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    await store.sweep()

    for (const hash of [older, newer, rootHash, leafHash]) {
      expect(await stat(join(objects, hash.slice(0, 2), hash + '.drl')).then(() => true, () => false))
        .toBe(true)
    }
  })
```

Add these imports at the top of `tests/store.spec.ts` (extend the existing import lines, do not duplicate them):

```ts
import { CODEC_DEFLATE_RAW, encodeFrame, hashOfContent } from '../src/host/blob.ts'
import { TREE_SCHEMA, encodeTree } from '../src/host/tree.ts'
```

(`CODEC_DEFLATE_RAW`, `encodeFrame` and `hashOfContent` are already imported in that file — only add `TREE_SCHEMA` and `encodeTree`.)

- [x] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/store.spec.ts -t "marks tree chains"`

Expected: FAIL — the first `expect(...).toBe(true)` gets `false`, because `REACHABLE_HASH` only matches `"h":"<hash>"` and the line contains `"tree":"<hash>"`, so the sweep deletes everything.

- [x] **Step 3: Broaden the mark, then expand tree chains**

In `src/host/store.ts`, replace the `REACHABLE_HASH` constant:

```ts
/**
 * Any sha256 appearing in a line: v2 `refs[].h`, a v3 `tree` or `resp`.
 * Over-marking only spares an object from GC; under-marking deletes live
 * data, so this is deliberately broad.
 */
const REACHABLE_HASH = /[0-9a-f]{64}/g

/** Tree hashes specifically: only these get walked for transitive marks. */
const REACHABLE_TREE = /"tree":"([0-9a-f]{64})"/g
```

Add the import at the top of the file:

```ts
import { decodeTree } from './tree'
```

Inside `sweep`, find the mark phase (search for `matchAll(REACHABLE_HASH)` — currently around line 847, inside the per-file `try` under the comment `The GC mark phase rides reads this sweep performs anyway`). Keep its existing indentation and change the body to:

```ts
            for (const match of text.matchAll(REACHABLE_HASH)) reachable.add(match[0])
            for (const match of text.matchAll(REACHABLE_TREE)) treeRoots.add(match[1])
```

Note `match[0]` — the broadened regex has no capture group.

Declare `treeRoots` next to `reachable` (search for `const reachable = new Set<string>()`, around line 826):

```ts
      const reachable = new Set<string>()
      const treeRoots = new Set<string>()
```

Then expand the chains immediately **before** the GC call (search for `await this.blobs.gc(reachable, now)`, around line 870). Route its failures through the same `swallowed(stage, error)` helper the surrounding stages use, so a broken chain shows up on `/health` instead of vanishing:

```ts
      try {
        await this.markTreeChains(treeRoots, reachable)
      } catch (error) {
        swallowed('tree mark', error)
      }
```

And add this private method to `CallStore`:

```ts
  /**
   * Walk every tree chain rooted in `roots`, adding each node's own hash,
   * its parent, and its entries to `reachable`. A node that cannot be read
   * or parsed stops that branch: GC then only risks sparing objects, never
   * deleting live ones.
   */
  private async markTreeChains(roots: ReadonlySet<string>, reachable: Set<string>): Promise<void> {
    const pending = [...roots]
    const visited = new Set<string>()
    while (pending.length > 0) {
      const hash = pending.pop() as string
      if (visited.has(hash)) continue
      visited.add(hash)
      reachable.add(hash)
      let node
      try {
        node = decodeTree((await this.blobs.get(hash)).toString('utf8'))
      } catch {
        continue // Unreadable or not a tree: nothing more to mark down here.
      }
      for (const item of node.e) reachable.add(item.h)
      if (node.p !== undefined) pending.push(node.p)
    }
  }
```

- [x] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run && npx tsc --noEmit && npx oxlint`

Expected: all pass. The existing test `'sweep GC removes unreachable stale objects, spares referenced and fresh ones'` must still pass — the broadened regex marks strictly more, and that test asserts a genuinely unreferenced object is removed, which stays true because its hash appears in no line.

- [x] **Step 5: Commit**

```bash
git add src/host/store.ts tests/store.spec.ts
git commit -m "Mark GC reachability through tree chains

A v3 envelope names only its leaf tree; every piece behind it is reachable
solely through parent pointers inside the object store. Broaden the line
scan to any sha256 (over-marking only spares objects) and walk each tree
chain transitively.

This must precede the first v3 write: a sweep that cannot see through a
tree would delete live pieces.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: The v3 envelope — write, read, and byte accounting

The core task. Writing without reading would leave the store producing data it cannot serve, and writing `zn` without teaching `logicalBytesOfLine` about it would make every v3 line count as line-bytes only and break the byte cap. All three land together.

**Files:**
- Modify: `src/shared/types.ts` (v3 envelope types; widen `entryFromEnvelope`)
- Modify: `src/host/store.ts` (append, `entryOfLine`, `logicalBytesOfLine`, `get`, reassembly, tree state)
- Test: `tests/store.spec.ts`

**Interfaces:**
- Consumes: `PutResult` (Task 1); `TreeEntry`, `TreeState`, `chooseTreeNode`, `encodeTree`, `resolveTree` (Task 2).
- Produces:
  - `const RECORD_SCHEMA_V3 = 3` and `interface CallEnvelopeV3` in `src/shared/types.ts`
  - `interface EnvelopeHead` — the scalar head `CallEnvelope` (v2) and `CallEnvelopeV3` share; `entryFromEnvelope(env: EnvelopeHead)` accepts both
  - `CallStore.append` writes v3 lines when `format` is `auto`
  - `CallStore.get` reassembles v3 records identically in shape to v1/v2

### `zn` semantics — read this before implementing

`zn` is **the compressed bytes this append materialized in the object store** — pieces, tree node, and response body for which `put()` reported `created: true`. It is *not* "what this record would cost unshared".

That is deliberate and it is what fixes the 12.4x over-count: a piece already on disk costs this session nothing more, so it bills nothing. A retry that re-sends an identical request materializes nothing and bills `zn: 0`. Summed across a file, `line bytes + Σ zn` tracks the session's real contribution to disk.

- [x] **Step 1: Add the v3 types**

In `src/shared/types.ts`, find `export interface CallEnvelope {`. Directly **above** it, insert the shared head and change `CallEnvelope` to extend it. Replace the whole `CallEnvelope` interface declaration line and its scalar fields with:

```ts
/**
 * The scalar head every envelope format carries: everything an index row
 * needs, with no reference to how the bodies are stored. v2 adds `refs`,
 * v3 adds `tree`/`resp`/`zn`.
 */
export interface EnvelopeHead {
  id: string
  sessionId: string
  purpose?: 'compaction' | 'session-title'
  provider: string
  model: string
  reasoningEffort?: string
  requestHash: string
  attempt: number
  timing: RecordedTiming
  status: CallStatus
  opts?: { temperature?: number; maxTokens?: number; stop?: string[] }
  sum: EnvelopeSum
}
```

Then make `CallEnvelope` extend it, keeping only its own fields:

```ts
/** One v2 envelope line: the scalar head plus inline blob references. */
export interface CallEnvelope extends EnvelopeHead {
  v: typeof RECORD_SCHEMA_V2
  refs: EnvelopeRef[]
}
```

(Delete the scalar fields that moved into `EnvelopeHead`; keep the existing doc comments by moving them onto the `EnvelopeHead` fields.)

Below `CallEnvelope`, add:

```ts
/** Wire schema version of a v3 envelope line (`{"v":3,...}`). */
export const RECORD_SCHEMA_V3 = 3

/**
 * One v3 envelope line: the scalar head plus a single tree hash naming the
 * request's piece list, the response body's hash, and the bytes this append
 * materialized in the object store.
 */
export interface CallEnvelopeV3 extends EnvelopeHead {
  v: typeof RECORD_SCHEMA_V3
  /** Hash of the tree object holding this call's ordered request pieces. */
  tree: string
  /** Hash of the response body blob; absent when the call never settled. */
  resp?: string
  /**
   * Compressed bytes of objects THIS append created. Not what the record
   * would cost unshared: a piece already on disk bills nothing, because it
   * added nothing to disk.
   */
  zn: number
}
```

Finally widen the projection — change its signature only, the body is unchanged:

```ts
export function entryFromEnvelope(env: EnvelopeHead): CallIndexEntry {
```

- [x] **Step 2: Write the failing tests**

Add to `tests/store.spec.ts`, inside the top-level `describe('CallStore', ...)` block, after the test named `'appends and reads back records losslessly'`:

```ts
  it('writes v3 envelopes that round-trip the whole record', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    const original = richRecord()
    await store.append(original)

    const line = (await readFile(join(directory, 'sess-1.jsonl'), 'utf8')).trim()
    const env = JSON.parse(line) as { v: number; tree?: string; refs?: unknown; zn?: number }
    expect(env.v).toBe(RECORD_SCHEMA_V3)
    expect(typeof env.tree).toBe('string')
    expect(env.refs).toBeUndefined() // the piece list moved into the tree
    expect(env.zn).toBeGreaterThan(0)
    expect(await store.get('sess-1', original.id)).toEqual(original)
  })

  it('keeps the envelope line flat as the conversation grows', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 500, maxFileBytes: 64 * 1024 * 1024 })
    const messages: CallRecord['request']['messages'] = []
    for (let turn = 1; turn <= 40; turn += 1) {
      messages.push({ role: 'user', content: [{ type: 'text', text: 'ask ' + String(turn) }] })
      messages.push({ role: 'assistant', content: [{ type: 'text', text: 'answer ' + String(turn) }] })
      await store.append(recordOf({
        id: 'c-' + String(turn),
        requestHash: 'h' + String(turn),
        request: { system: 'sys', messages: [...messages] },
      }))
    }
    const lines = (await readFile(join(directory, 'sess-1.jsonl'), 'utf8')).split('\n').filter(l => l.length > 0)
    expect(lines).toHaveLength(40)
    // v2 re-listed every hash, so line 40 was ~40x line 1. A tree hash is one
    // hash whatever the history length, so the line must stay flat.
    expect(Buffer.byteLength(lines[39])).toBeLessThan(Buffer.byteLength(lines[0]) * 2)
    // The last call still resolves its full 80-message history.
    const last = await store.get('sess-1', 'c-40')
    expect(last?.request.messages).toHaveLength(80)
    expect(last?.request.messages[0].content[0].text).toBe('ask 1')
    expect(last?.request.system).toBe('sys')
  })

  it('round-trips a compaction that replaced the message list', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    const grown: CallRecord['request']['messages'] = [
      { role: 'user', content: [{ type: 'text', text: 'one' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
      { role: 'user', content: [{ type: 'text', text: 'three' }] },
    ]
    await store.append(recordOf({ id: 'grown', request: { messages: grown } }))
    // Compaction rewrites history wholesale: a delta cannot express it, so
    // the writer must cut a keyframe and the read must still be exact.
    const compacted: CallRecord['request']['messages'] = [
      { role: 'user', content: [{ type: 'text', text: 'summary so far' }] },
    ]
    await store.append(recordOf({ id: 'compacted', requestHash: 'h2', purpose: 'compaction', request: { messages: compacted } }))

    expect((await store.get('sess-1', 'compacted'))?.request.messages).toEqual(compacted)
    expect((await store.get('sess-1', 'grown'))?.request.messages).toEqual(grown)
  })

  it('bills a retry nothing: an identical request materializes no new object', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    const first = recordOf({ id: 'try-1', attempt: 1 })
    await store.append(first)
    await store.append({ ...first, id: 'try-2', attempt: 2 })
    const lines = (await readFile(join(directory, 'sess-1.jsonl'), 'utf8')).split('\n').filter(l => l.length > 0)
    const envs = lines.map(line => JSON.parse(line) as { tree: string; zn: number })
    expect(envs[0].zn).toBeGreaterThan(0)
    // Same pieces, same tree, nothing new on disk.
    expect(envs[1].tree).toBe(envs[0].tree)
    expect(envs[1].zn).toBe(0)
  })

  it('degrades one unresolvable tree without losing the record metadata', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    await store.append(recordOf({ id: 'orphan' }))
    const env = JSON.parse((await readFile(join(directory, 'sess-1.jsonl'), 'utf8')).trim()) as { tree: string }
    await rm(join(directory, 'objects', env.tree.slice(0, 2), env.tree + '.drl'))

    const record = await store.get('sess-1', 'orphan')
    expect(record?.id).toBe('orphan')
    expect(record?.provider).toBe('p')
    expect(record?.status).toBe('ok')
    // The gap is stated, never implied by an empty conversation.
    expect(JSON.stringify(record?.request.messages)).toContain('unavailable')
  })
```

Add `RECORD_SCHEMA_V3` to the existing `../src/shared/types` import in that file, and `rm` to the existing `node:fs/promises` import.

- [x] **Step 3: Run the tests and watch them fail**

Run: `npx vitest run tests/store.spec.ts -t "v3 envelopes"`

Expected: FAIL with `expected 2 to be 3` — append still writes v2.

- [x] **Step 4: Implement the v3 write path**

In `src/host/store.ts`:

Add imports:

```ts
import { RECORD_SCHEMA, RECORD_SCHEMA_V2, RECORD_SCHEMA_V3, entryFromEnvelope, envelopeSumOf, toIndexEntry } from '../shared/types'
import type { CallEnvelope, CallEnvelopeV3, CallIndexEntry, CallIndexResponse, CallRecord, EnvelopeRef, RecordedMessage, RecordedRequest, RecordedResponse } from '../shared/types'
import { type TreeEntry, type TreeState, chooseTreeNode, encodeTree, resolveTree } from './tree'
```

Replace `splitPieces` with a request-only splitter (the response is no longer a tree entry):

```ts
/** One structural dedup piece hashed into the object store. */
interface Piece {
  kind: TreeEntry['k']
  json: string
}

/**
 * The request's dedup pieces in canonical tree order: the system prompt,
 * the ENTIRE tools array, then EACH message canonicalized whole. The
 * response is not a tree entry - it changes every call and rides the
 * envelope's `resp` hash instead, so retries share one tree.
 */
function requestPieces(record: CallRecord): Piece[] {
  const pieces: Piece[] = []
  if (record.request.system !== undefined) pieces.push({ kind: 's', json: JSON.stringify(record.request.system) })
  if (record.request.tools !== undefined) pieces.push({ kind: 't', json: JSON.stringify(record.request.tools) })
  for (const message of record.request.messages) pieces.push({ kind: 'm', json: JSON.stringify(message) })
  return pieces
}
```

**Keep `splitPieces`, `buildEnvelope` and `sealEnvelope`.** They are dead on the append path after this task, but `ensureV2Line` — the migrator — still calls them, and it does not become `ensureV3Line` until Task 5. Deleting them here would break migration and force you to skip tests. Task 5 deletes all three.

Add tree state to `CallStore`, next to the other caches:

```ts
  /** The tree each session last wrote, so the next append can delta onto it. */
  private readonly treeStates = new Map<string, TreeState>()
```

Bound it in `invalidateCaches` and on eviction:

```ts
  private invalidateCaches(sessionId: string): void {
    this.indexCache.delete(sessionId)
    this.logicalCache.delete(sessionId)
    // A rewritten or deleted file may have been the only thing keeping the
    // parent chain reachable: start the next append from a keyframe.
    this.treeStates.delete(sessionId)
  }
```

Add the sealing helper:

```ts
  /**
   * Bake one record's objects and build its v3 envelope, inside the caller's
   * serialized chain. Every referenced object is renamed into place before
   * this returns, so the envelope line never names an unbaked hash.
   */
  private async sealV3(record: CallRecord): Promise<CallEnvelopeV3> {
    const pieces = requestPieces(record)
    const entries: TreeEntry[] = []
    let zn = 0
    for (const piece of pieces) {
      const hash = hashOfContent(piece.json)
      const put = await this.blobs.put(hash, piece.json)
      if (put.created) zn += put.z
      entries.push({ k: piece.kind, h: hash })
    }

    const previous = this.treeStates.get(record.sessionId)
    const choice = chooseTreeNode(entries, previous)
    let treeHash: string
    let depth: number
    if (choice.kind === 'reuse') {
      treeHash = (previous as TreeState).hash
      depth = (previous as TreeState).depth
    } else {
      const json = encodeTree(choice.node)
      treeHash = hashOfContent(json)
      const put = await this.blobs.put(treeHash, json)
      if (put.created) zn += put.z
      depth = choice.depth
    }

    let resp: string | undefined
    if (record.response !== undefined) {
      const json = JSON.stringify(record.response)
      resp = hashOfContent(json)
      const put = await this.blobs.put(resp, json)
      if (put.created) zn += put.z
    }

    // Only remembered once every object landed; a failed bake leaves the
    // previous state in place and the next append deltas onto it.
    this.rememberTree(record.sessionId, { hash: treeHash, entries, depth })

    const request = record.request
    const opts = {
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
      ...(request.stop === undefined ? {} : { stop: request.stop }),
    }
    return {
      v: RECORD_SCHEMA_V3,
      id: record.id,
      sessionId: record.sessionId,
      ...record.purpose === undefined ? {} : { purpose: record.purpose },
      provider: record.provider,
      model: record.model,
      ...record.reasoningEffort === undefined ? {} : { reasoningEffort: record.reasoningEffort },
      requestHash: record.requestHash,
      attempt: record.attempt,
      timing: record.timing,
      status: record.status,
      ...(Object.keys(opts).length === 0 ? {} : { opts }),
      tree: treeHash,
      ...(resp === undefined ? {} : { resp }),
      zn,
      sum: envelopeSumOf(record),
    }
  }

  /** Remember one session's tree, evicting the least recent past the bound. */
  private rememberTree(sessionId: string, state: TreeState): void {
    this.treeStates.delete(sessionId)
    this.treeStates.set(sessionId, state)
    while (this.treeStates.size > 64) {
      const oldest = this.treeStates.keys().next().value
      if (oldest === undefined) break
      this.treeStates.delete(oldest)
    }
  }
```

Rewrite `append` to use it. Replace the whole method body with:

```ts
  append(record: CallRecord): Promise<void> {
    const sessionId = record.sessionId
    const path = this.pathOf(sessionId)
    return this.enqueue(sessionId, async () => {
      await this.ensureDirectory()
      const state = this.appendStateOf(sessionId)
      let line: string
      let incomingLogical: number
      if (this.v2Enabled) {
        const env = await this.sealV3(record)
        line = JSON.stringify(env) + '\n'
        incomingLogical = CallStore.lineBytes(line) + env.zn
      } else {
        line = JSON.stringify(record) + '\n'
        incomingLogical = CallStore.lineBytes(line)
      }
      try {
        if (state.poisoned) await this.repairTail(path, sessionId)
        const info = await stat(path).then(fresh => ({ mtimeMs: fresh.mtimeMs, size: fresh.size }), () => null)
        let attributed = info === null ? 0 : await this.attributedBytes(sessionId, path, info)
        const physicalOver = (info === null ? 0 : info.size) + CallStore.lineBytes(line) > this.config.maxFileBytes
        if (attributed + incomingLogical > this.config.maxFileBytes || physicalOver) {
          attributed = await this.trimForBytes(sessionId, path, incomingLogical)
        }
        await this.writeLine(path, line)
        state.poisoned = false
        await this.noteWritten(sessionId, path, attributed + incomingLogical)
      } catch (error) {
        state.poisoned = true
        throw error
      }
    })
  }
```

Note the hashing now happens **inside** the chain (it needs the previous tree state, which only the chain owns). That is a deliberate change from v2's comment about hashing outside the chain — update that comment.

- [x] **Step 5: Implement the v3 read path**

Add the line predicate next to `isV2Line`:

```ts
/** Whether a raw line is a v3 envelope (leading peek, mirrors the writer). */
function isV3Line(line: string): boolean {
  return line.startsWith('{"v":3')
}
```

In `entryOfLine`, add the v3 branch before the v2 one:

```ts
    if ((value as { v?: unknown }).v === RECORD_SCHEMA_V3) {
      const env = value as unknown as CallEnvelopeV3
      if (typeof env.id !== 'string' || env.sum === null || env.sum === undefined || typeof env.tree !== 'string') return undefined
      return entryFromEnvelope(env)
    }
```

In `logicalBytesOfLine`, add the v3 branch at the top:

```ts
function logicalBytesOfLine(line: string): number {
  const physical = Buffer.byteLength(line, 'utf8')
  if (isV3Line(line)) {
    try {
      const env = JSON.parse(line) as { zn?: unknown }
      // zn is what this append MATERIALIZED: exact, and never double-counted
      // across records that share a blob.
      return physical + (typeof env.zn === 'number' && env.zn >= 0 ? env.zn : 0)
    } catch {
      return physical
    }
  }
  if (!isV2Line(line)) return physical
  // ... existing v2 body unchanged
}
```

In `get`, add the v3 branch before the v2 one:

```ts
      if ((value as { v?: unknown }).v === RECORD_SCHEMA_V3) {
        const env = value as unknown as CallEnvelopeV3
        if (env.id !== callId || env.sum == null || typeof env.tree !== 'string') continue
        return await this.reassembleV3(env)
      }
```

Add the reassembly:

```ts
  /** Splice a v3 envelope's tree and response back into a v1-shaped record. */
  private async reassembleV3(env: CallEnvelopeV3): Promise<CallRecord> {
    const request = {} as RecordedRequest
    request.messages = []
    let entries: TreeEntry[] | null = null
    try {
      entries = await resolveTree(env.tree, hash => this.blobs.get(hash))
    } catch {
      entries = null
    }
    if (entries === null) {
      // A partial list would be wrong data. State the gap instead — every
      // scalar the envelope still knows survives in the record.
      request.messages = [{
        role: 'user',
        content: [{ type: 'text', text: `[request unavailable: tree ${env.tree} could not be resolved]` }],
      }]
    } else {
      const inflight = new Map<string, Promise<unknown>>()
      const slotFor = (hash: string): Promise<unknown> => {
        let pending = inflight.get(hash)
        if (pending === undefined) {
          pending = this.slotValue(hash)
          inflight.set(hash, pending)
        }
        return pending
      }
      const slots = await Promise.all(entries.map(async item => ({ kind: item.k, value: await slotFor(item.h) })))
      const messages: unknown[] = []
      for (const slot of slots) {
        if (slot.kind === 's') request.system = slot.value as string
        else if (slot.kind === 't') request.tools = slot.value as RecordedRequest['tools']
        else messages.push(slot.value)
      }
      request.messages = messages as RecordedMessage[]
    }
    const opts = env.opts ?? {}
    if (opts.temperature !== undefined) request.temperature = opts.temperature
    if (opts.maxTokens !== undefined) request.maxTokens = opts.maxTokens
    if (opts.stop !== undefined) request.stop = opts.stop
    const record = {
      schema: RECORD_SCHEMA,
      id: env.id,
      sessionId: env.sessionId,
      ...(env.purpose === undefined ? {} : { purpose: env.purpose }),
      provider: env.provider,
      model: env.model,
      ...(env.reasoningEffort === undefined ? {} : { reasoningEffort: env.reasoningEffort }),
      requestHash: env.requestHash,
      attempt: env.attempt,
      timing: env.timing,
      status: env.status,
      request,
    } as CallRecord
    if (env.resp !== undefined) {
      const value = await this.slotValue(env.resp)
      record.response = value as RecordedResponse
    }
    return record
  }
```

- [x] **Step 6: Update the existing v2-shaped assertions**

Run `grep -n '{"v":2' tests/store.spec.ts` and fix the byte-accounting helpers so they understand v3. Both sites (around lines 371 and 401) compute attributed bytes inline; each needs a v3 branch added **before** its v2 branch:

```ts
      if (line.startsWith('{"v":3')) {
        attributed += (JSON.parse(line) as { zn: number }).zn
      } else if (line.startsWith('{"v":2')) {
        for (const ref of JSON.parse(line).refs as { z: number }[]) attributed += ref.z
      }
```

The test around line 617 asserts a `format: 'v1'` store never produces v2 lines — extend it to v3 as well:

```ts
    expect(after.split('\n').filter(line => line.startsWith('{"v":2') || line.startsWith('{"v":3'))).toEqual([])
```

The migration tests around lines 636, 662 and 683 assert `RECORD_SCHEMA_V2` and must keep passing untouched — the migrator still emits v2 until Task 5. If one of them fails here, you deleted `buildEnvelope`/`sealEnvelope` against the instruction in Step 4; restore them.

The byte-cap test asserting `expect(logical).toBeLessThanOrEqual(900)` may now hold at a different number, because v3 bills materialized bytes rather than per-reference sizes. Run it, read the actual value, and set the bound to the smallest round number above it — then add a comment saying what the number means.

- [x] **Step 7: Run everything**

Run: `npx vitest run && npx tsc --noEmit && npx oxlint && npm run build`

Expected: all green, nothing skipped. The migrator still writes v2; only `append` writes v3.

- [x] **Step 8: Commit**

```bash
git add src/shared/types.ts src/host/store.ts tests/store.spec.ts
git commit -m "Write v3 envelopes: one tree hash instead of the whole piece list

A v2 line re-listed every piece hash of the conversation, so envelope bytes
grew as calls x messages. On a real store that made refs[] 97.6% of all
envelope bytes and the index 3.5x the content it indexed.

v3 carries one tree hash, one response hash, and zn — the bytes this append
actually materialized. The line stays flat however long the session runs.

zn also replaces the per-reference byte accounting that counted a shared
blob once per referencing record, which had been attributing 62.8 MB to
5.4 MB of real disk on the largest measured session.

The migrator still emits v2 and converts in the next commit.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Migrate v1 and v2 files to v3

**Files:**
- Modify: `src/host/store.ts` (`ensureV2Line` → `ensureV3Line`, `commitRewrite`, `fileHasLegacyLines`, `migrateFile`)
- Test: `tests/store.spec.ts`

**Interfaces:**
- Consumes: `sealV3`-style baking (Task 4), `chooseTreeNode`/`encodeTree` (Task 2).
- Produces: `CallStore.sweep` converts v1 and v2 lines to v3 within the per-cycle byte budget.

### How the conversion works

A **v2 line already carries its entry list** in `refs[]` — `s`/`t`/`m` entries become tree entries in the same order, and the `r` ref becomes `resp`. No blob reads are needed: the objects are already baked. Only the tree node is new.

A **v1 line** carries the bodies inline: split it with `requestPieces`, bake each piece and the response, then build the tree exactly as `sealV3` does.

Both run over the file **in order** through one shared `TreeState`, so a migrated file gets the same delta/keyframe compaction a freshly written one would — not a keyframe per line.

`zn` on a migrated line is whatever `put()` reported as created during that conversion. For a v2 file that is usually just the tree node, because the pieces are already on disk. That is correct: migrating adds only the tree.

- [x] **Step 1: Point the migration tests at v3 and add the v2→v3 test**

Change the three `RECORD_SCHEMA_V2` expectations around lines 636, 662 and 683 of `tests/store.spec.ts` to `RECORD_SCHEMA_V3`. Then add, after them:

```ts
  it('converts a v2 file to v3 without reading a single blob body', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    const original = richRecord()
    await store.append(original)
    // Rewrite the line back into v2 shape to stand in for a file written by
    // the previous release.
    const v3 = JSON.parse((await readFile(join(directory, 'sess-1.jsonl'), 'utf8')).trim()) as Record<string, unknown>
    const entries = await resolveTree(v3.tree as string, async hash => {
      const bucket = (hash as string).slice(0, 2)
      return readFile(join(directory, 'objects', bucket, hash + '.drl'))
        .then(frame => inflateRawSync(decodeFrame(frame).payload))
    })
    const refs = [
      ...entries.map(item => ({ k: item.k, h: item.h, z: 1 })),
      ...(v3.resp === undefined ? [] : [{ k: 'r', h: v3.resp as string, z: 1 }]),
    ]
    delete v3.tree; delete v3.resp; delete v3.zn
    await writeFile(join(directory, 'sess-1.jsonl'), JSON.stringify({ ...v3, v: 2, refs }) + '\n')

    await store.sweep()

    const migrated = (await readFile(join(directory, 'sess-1.jsonl'), 'utf8')).trim()
    expect(JSON.parse(migrated).v).toBe(RECORD_SCHEMA_V3)
    expect(await store.get('sess-1', original.id)).toEqual(original)
  })

  it('compacts a migrated file with deltas, not a keyframe per line', async () => {
    const directory = await tempDir()
    await mkdir(directory, { recursive: true })
    const messages: CallRecord['request']['messages'] = []
    const lines: string[] = []
    for (let turn = 1; turn <= 20; turn += 1) {
      messages.push({ role: 'user', content: [{ type: 'text', text: 'ask ' + String(turn) }] })
      lines.push(JSON.stringify(recordOf({
        id: 'c-' + String(turn),
        requestHash: 'h' + String(turn),
        request: { messages: [...messages] },
      })))
    }
    await writeFile(join(directory, 'sess-1.jsonl'), lines.join('\n') + '\n')
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 64 * 1024 * 1024 })

    await store.sweep()

    const converted = (await readFile(join(directory, 'sess-1.jsonl'), 'utf8')).split('\n').filter(l => l.length > 0)
    expect(converted).toHaveLength(20)
    for (const line of converted) expect(JSON.parse(line).v).toBe(RECORD_SCHEMA_V3)
    // A keyframe per line would make every tree object as large as its
    // history; deltas keep all but the first tiny.
    const trees = converted.map(line => (JSON.parse(line) as { tree: string }).tree)
    expect(new Set(trees).size).toBe(20)
    expect(await store.get('sess-1', 'c-20')).toBeDefined()
    expect((await store.get('sess-1', 'c-20'))?.request.messages).toHaveLength(20)
  })
```

Add `resolveTree` to the `../src/host/tree.ts` import and `decodeFrame` to the `../src/host/blob.ts` import; add `inflateRawSync` to the `node:zlib` import.

- [x] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/store.spec.ts -t "v3"`

Expected: the migration specs fail with `expected 2 to be 3` — the migrator still emits v2.

- [x] **Step 3: Convert the migrator**

Replace `ensureV2Line` with a stateful converter. It takes and mutates the running tree state so a whole file shares one chain.

Once it compiles, **delete `splitPieces`, `buildEnvelope` and `sealEnvelope`** — nothing writes v2 any more. `npx tsc --noEmit` and `npx oxlint` together will confirm nothing still references them.

Note the declaration of `entries` below: it is initialised to `[]` rather than `null`, because both branches that reach `chooseTreeNode` assign it and TypeScript cannot prove that on its own.

```ts
  /**
   * One line in v3 form, given the tree state the previous converted line
   * left behind. Existing v3 lines pass through (state advances so later
   * lines can delta onto them); v2 lines reuse their already-baked pieces;
   * v1 lines bake theirs. Foreign, unparsable, or unconvertible lines pass
   * through untouched rather than being dropped.
   */
  private async ensureV3Line(line: string, state: { previous: TreeState | undefined }): Promise<string> {
    if (!this.v2Enabled) return line
    let entries: TreeEntry[] = []
    let resp: string | undefined
    let zn = 0
    let head: Record<string, unknown> | null = null

    if (isV3Line(line)) {
      try {
        const env = JSON.parse(line) as CallEnvelopeV3
        const resolved = await resolveTree(env.tree, hash => this.blobs.get(hash))
        state.previous = { hash: env.tree, entries: resolved, depth: 0 }
      } catch {
        // Unresolvable: the next line starts a keyframe.
        state.previous = undefined
      }
      return line
    }

    if (isV2Line(line)) {
      let env: CallEnvelope
      try { env = JSON.parse(line) as CallEnvelope } catch { return line }
      if (!Array.isArray(env.refs)) return line
      entries = []
      for (const ref of env.refs) {
        if (ref.k === 'r') { resp = ref.h; continue }
        entries.push({ k: ref.k, h: ref.h })
      }
      const { v, refs, ...rest } = env as unknown as Record<string, unknown>
      void v; void refs
      head = rest
    } else {
      const record = legacyRecordOf(line)
      if (record === undefined) return line
      entries = []
      for (const piece of requestPieces(record)) {
        const hash = hashOfContent(piece.json)
        try {
          const put = await this.blobs.put(hash, piece.json)
          if (put.created) zn += put.z
        } catch {
          return line // A failed bake leaves the original line intact.
        }
        entries.push({ k: piece.kind, h: hash })
      }
      if (record.response !== undefined) {
        const json = JSON.stringify(record.response)
        resp = hashOfContent(json)
        try {
          const put = await this.blobs.put(resp, json)
          if (put.created) zn += put.z
        } catch {
          return line
        }
      }
      const request = record.request
      const opts = {
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
        ...(request.stop === undefined ? {} : { stop: request.stop }),
      }
      head = {
        id: record.id,
        sessionId: record.sessionId,
        ...record.purpose === undefined ? {} : { purpose: record.purpose },
        provider: record.provider,
        model: record.model,
        ...record.reasoningEffort === undefined ? {} : { reasoningEffort: record.reasoningEffort },
        requestHash: record.requestHash,
        attempt: record.attempt,
        timing: record.timing,
        status: record.status,
        ...(Object.keys(opts).length === 0 ? {} : { opts }),
        sum: envelopeSumOf(record),
      }
    }

    const choice = chooseTreeNode(entries, state.previous)
    let treeHash: string
    let depth: number
    if (choice.kind === 'reuse') {
      treeHash = (state.previous as TreeState).hash
      depth = (state.previous as TreeState).depth
    } else {
      const json = encodeTree(choice.node)
      treeHash = hashOfContent(json)
      try {
        const put = await this.blobs.put(treeHash, json)
        if (put.created) zn += put.z
      } catch {
        return line
      }
      depth = choice.depth
    }
    state.previous = { hash: treeHash, entries, depth }

    const { sum, ...scalars } = head as { sum: unknown } & Record<string, unknown>
    return JSON.stringify({
      v: RECORD_SCHEMA_V3,
      ...scalars,
      tree: treeHash,
      ...(resp === undefined ? {} : { resp }),
      zn,
      sum,
    })
  }
```

Update `commitRewrite` and `migrateFile` to thread the state:

```ts
  private async commitRewrite(sessionId: string, path: string, keptLines: string[]): Promise<number> {
    let keptLogical = 0
    const converted: string[] = []
    const state: { previous: TreeState | undefined } = { previous: undefined }
    for (const line of keptLines) {
      const upgraded = await this.ensureV3Line(line, state)
      converted.push(upgraded)
      keptLogical += logicalBytesOfLine(upgraded)
    }
    // ... rest unchanged
  }
```

`migrateFile` gets the same `state` object and calls `ensureV3Line(line, state)`. **It returns `Promise<boolean>`** — whether it changed anything — and `sweep` counts that into `status.migratedFiles`. Preserve that return; do not narrow it to `void`.

`fileHasLegacyLines` must now also treat v2 as legacy:

```ts
  /** Does any complete line still hold a v1 record or a v2 envelope? */
  private async fileHasLegacyLines(path: string): Promise<boolean> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      return false
    }
    for (const line of completeLines(text)) {
      if (line.startsWith('{"schema":') || isV2Line(line)) return true
    }
    return false
  }
```

In `migrateFile`, the `changed` detection must also treat a v2 line as convertible — replace its skip condition:

```ts
        if (isV3Line(line) || (!isV2Line(line) && legacyRecordOf(line) === undefined)) {
          converted.push(await this.ensureV3Line(line, state))
          continue
        }
```

(Passing v3 lines through `ensureV3Line` is what advances the chain state.)

- [x] **Step 4: Run everything**

Run: `npx vitest run && npx tsc --noEmit && npx oxlint && npm run build`

Expected: all green, no skipped tests.

- [x] **Step 5: Commit**

```bash
git add src/host/store.ts tests/store.spec.ts
git commit -m "Migrate v1 and v2 files to v3 envelopes

A v2 line already names its pieces, so conversion needs no blob reads at
all: its refs become tree entries and its r ref becomes resp. v1 lines bake
their pieces first. Both run through one shared tree state per file, so a
migrated file gets the same delta chain a freshly written one would rather
than a keyframe per line.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Cleanups and documentation

The small findings from the review, plus the docs that now describe a format that no longer exists.

**Files:**
- Modify: `src/shared/types.ts` (drop `responseBlockKinds`)
- Modify: `src/host/store.ts` (`listIndex` tail slice)
- Modify: `src/wire/index.ts` (`detectProtocol` default)
- Modify: `README.md`, `DESIGN-v2-persistence.md`
- Test: `tests/store.spec.ts`, `tests/wire.spec.ts`, and every spec that sets `responseBlockKinds`

**Interfaces:**
- Consumes: everything above.
- Produces: `CallIndexEntry` no longer has `responseBlockKinds`; `EnvelopeSum` no longer has `blockKinds`.

- [x] **Step 1: Remove the dead index field**

`responseBlockKinds` is a required field on every index row, written into every envelope's `sum`, shipped on every 3-second poll — and read by nothing. `grep -rn "responseBlockKinds\|blockKinds" src/` returns only its own definition and construction.

Delete from `src/shared/types.ts`:
- `responseBlockKinds: string[]` from `CallIndexEntry`
- `blockKinds?: string[]` from `EnvelopeSum`
- the `const responseBlockKinds: string[] = []` loop in `toIndexEntry` and the field from its return
- `const blockKinds = record.response.blocks.map(...)` and the `blockKinds,` field in `envelopeSumOf`
- `responseBlockKinds: sum.blockKinds ?? [],` in `entryFromEnvelope`

Then remove every `responseBlockKinds: []` line from `tests/chart-demo.ssr.spec.ts`, `tests/chart-stats.spec.ts`, `tests/view.spec.ts`, and the assertion `expect(entry.responseBlockKinds).toEqual(['text'])` from `tests/store.spec.ts`.

Leave `requestChars` and `finishMessage` alone: both are cheap scalars, `requestChars` is a documented size proxy, and a future ledger column is a plausible consumer. Add a one-line comment on each noting no client reads it today.

Run `npx tsc --noEmit` — it will name every remaining site.

- [x] **Step 2: Slice the index page from the tail**

`listIndex` copies and reverses the entire entry array (up to `maxCallsPerSession`) on every request, three seconds apart, to serve at most `limit` rows. Replace it:

```ts
  async listIndex(sessionId: string, limit: number, offset: number): Promise<CallIndexResponse> {
    const entries = await this.entriesOf(sessionId)
    const total = entries.length
    // Newest-first paging without materializing a reversed copy of the whole
    // session: the requested window is a slice off the tail, reversed.
    const end = Math.max(total - offset, 0)
    const start = Math.max(end - limit, 0)
    const calls = entries.slice(start, end).reverse()
    return { calls, total, offset, limit }
  }
```

The existing paging tests must pass unchanged — if any fails, the arithmetic is wrong, not the test.

- [x] **Step 3: Fix the protocol default for plain OpenAI routes**

In `src/wire/index.ts`, `detectProtocol` sends `provider === 'openai'` to `openai-responses`. A plain OpenAI route usually speaks ChatCompletion, so the first view is the wrong one. Change:

```ts
  if (provider.includes('codex') || provider.includes('responses') || model.includes('gpt-5-codex')) {
    return 'openai-responses'
  }
  return 'openai-completions'
```

(Delete the `provider.includes('gpt') || provider === 'openai'` branch entirely.)

Add to `tests/wire.spec.ts`, in whichever describe block covers `detectProtocol`:

```ts
  it('defaults a plain openai route to ChatCompletion, not Responses', () => {
    expect(detectProtocol({ provider: 'openai', model: 'gpt-4o' } as CallRecord)).toBe('openai-completions')
    expect(detectProtocol({ provider: 'openai-codex', model: 'gpt-5-codex' } as CallRecord)).toBe('openai-responses')
    expect(detectProtocol({ provider: 'anthropic', model: 'claude-opus-4' } as CallRecord)).toBe('anthropic-messages')
  })
```

Write this test **first** and watch the first assertion fail with `expected 'openai-responses' to be 'openai-completions'`.

- [x] **Step 4: Update the documentation**

In `README.md`, replace the whole **Storage** bullet under "How it works" with a v3 description covering: one JSONL line per settled attempt; each line a v3 envelope carrying one tree hash, the response hash, and the bytes that append materialized; trees living in the content-addressed object store as keyframe-plus-delta chains; the line staying flat however long the session runs; v1 and v2 files staying readable forever and migrating lazily within a per-cycle byte budget; the daily transitive GC; and `format: 'v1'` as the kill switch.

Update the `maxFileBytes` row of the config table — it no longer over-counts:

```
| `maxFileBytes` | `134217728` | per-session cap on envelope-line bytes plus the compressed bytes each append materialized in the object store. A piece already on disk bills nothing, so this tracks the session's real contribution to disk; oldest records are trimmed first |
```

Delete the sentence added earlier about budgeting 3-4x for cluster overhead only if measurements after this change no longer support it — otherwise keep it, since small objects still occupy a cluster each.

Rename `DESIGN-v2-persistence.md` to `DESIGN-persistence.md` (`git mv`), and add a `## v3: tree objects` section at its end explaining the change and why `refs[]` had to go. Update the README's reference to the old filename if one exists (`grep -rn "DESIGN-v2-persistence" .` excluding `node_modules`).

- [x] **Step 5: Run the full verification**

Run: `npx vitest run && npx tsc --noEmit && npx oxlint && npm run build && npm pack --dry-run`

Expected: all green.

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "Drop the dead index field, page from the tail, fix the OpenAI default

responseBlockKinds was required on every index row, written into every
envelope sum and shipped on every three-second poll, and read by nothing.

listIndex reversed a copy of the whole session to serve at most `limit`
rows; slice the tail instead.

detectProtocol sent a plain openai route to the Responses view, which is
not what such a route usually speaks.

Docs now describe v3.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Final verification (run before handing back)

```bash
npx tsc --noEmit
npx oxlint
npx vitest run
npx vitest run --coverage
npm run build
npm pack --dry-run
git log --oneline -6
git status --short
```

All must be clean. `host/` statement coverage must not fall below **87%** (its value before this work); `src/host/tree.ts` should land above 90% given the spec file written in Task 2.

## What is explicitly NOT in scope

- **Changing the object framing or hash length.** Truncated hashes were considered and rejected: a collision would silently serve wrong content, which this codebase's blob layer exists to make impossible.
- **`store.get()` reading the whole session file.** v3 shrinks the file roughly 50x, which takes the measured 9 ms scan to well under a millisecond. Revisit only if measurement says otherwise.
- **Client UI test coverage** (`view.tsx` 19%, `detail.tsx` 0%). Needs a jsdom lane; separate piece of work.
- **Raising `engines.node` past 20** or dropping shipped sourcemaps. Both are the maintainer's call, not this plan's.
