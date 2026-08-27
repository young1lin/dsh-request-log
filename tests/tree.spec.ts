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
  type TreeNode,
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
    const node: TreeNode = { t: TREE_SCHEMA, e: [entry('s', 'sys'), entry('m', 'm1')] }
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
