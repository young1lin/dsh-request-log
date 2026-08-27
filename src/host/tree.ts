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
