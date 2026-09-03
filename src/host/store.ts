/**
 * The persistence unit: one append-only JSONL file per session under
 * `$DSH_HOME/request-log/`, written when an attempt settles.
 *
 * Read path: the projected index (per-file) is cached keyed on the file's
 * (mtime, size) — appends always grow the file and trims rewrite it, so a
 * stat miss reliably invalidates. The 3s UI poll therefore costs a stat,
 * not a full re-parse. Detail reads scan lines by id substring and parse
 * only the matching line.
 *
 * Write path: appends to one session file are SERIALIZED (a per-file
 * promise chain), so a torn partial write left by a failure (ENOSPC) is
 * repaired — truncated back to the last complete line — before the next
 * append, instead of fusing with it into permanently unparsable lines.
 * Each file is bounded in LOGICAL stored bytes (`maxFileBytes`): an append
 * that would cross the bound first trims the oldest records that make room.
 * Logical bytes = envelope line bytes + `zn` (v3: exactly the compressed
 * bytes each append materialized; v2 lines keep the documented per-reference
 * Σ refs[].z over-estimate until they migrate). For pure-v1 files the
 * measure degenerates to physical bytes.
 *
 * V3 format (DESIGN-persistence.md §10): each fresh line is a small envelope
 * `{"v":3,...}` carrying inline scalars, ONE `tree` hash naming the whole
 * ordered request piece list, the response body's hash (`resp`), and `zn`.
 * Piece bodies and tree nodes live in the global content-addressed object
 * store under `<dir>/objects/<2hex>/<sha256>.drl`; a tree is a keyframe or a
 * delta chained by parent pointer (see ./tree.ts), so the line stays flat
 * however long the session runs. Every object is uploaded INSIDE the same
 * serialized chain BEFORE the envelope line lands, so a persisted line
 * references only already-renamed objects. V1 and V2 lines stay first-class
 * readers forever: `entryOfLine` branches on a leading peek, and every
 * trim/sweep rewrite converts surviving lines to v3 (lazy migration riding
 * the trims). `format: 'v1'` freezes the legacy behavior byte-for-byte.
 *
 * Retention: files older than `retentionDays` are deleted on boot and on a
 * daily sweep (`'never'` keeps every file, whatever its age); oversized ones
 * trimmed to the newest records. The sweep also
 * runs the mark-sweep GC over the object store (reachable hashes extracted
 * from the live files it reads anyway, then expanded transitively through
 * tree chains; unreachable objects and staging debris past a grace floor
 * reclaimed), packs the cold reachable objects into solid blocks in
 * chronological order (neighbouring calls are near-duplicates and compress
 * together) up to its own per-cycle budget, and migrates v1/v2 files
 * newest-first up to a per-cycle byte budget, deprioritizing files that
 * failed to convert so one stubborn file cannot hold the budget. All IO is
 * fail-soft — a store error never breaks a model call.
 *
 * @module dsh-request-log/host/store
 */

import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CallEnvelope, CallEnvelopeV3, CallIndexEntry, CallIndexResponse, CallRecord, RecordedMessage, RecordedRequest, RecordedResponse } from '../shared/types'
import { RECORD_SCHEMA, RECORD_SCHEMA_V2, RECORD_SCHEMA_V3, entryFromEnvelope, envelopeSumOf, toIndexEntry } from '../shared/types'
import { BlobStore, DEFAULT_GC_GRACE_MS, hashOfContent } from './blob'
import { errorTextOf } from './errtext'
import { PackStore } from './pack'
import { type TreeEntry, type TreeState, chooseTreeNode, decodeTree, encodeTree, isEntryHash, resolveTree } from './tree'

export interface StoreConfig {
  /** Root directory holding the per-session JSONL files. */
  directory: string
  /** Delete session files whose last write is older than this many days. */
  retentionDays: number | 'never'
  /** Per-session cap on kept call records (newest kept). */
  maxCallsPerSession: number
  /** Per-session cap on LOGICAL stored bytes (oldest records trimmed first). */
  maxFileBytes: number
  /**
   * Persistence format: 'auto' writes v2 envelopes + content-addressed
   * objects and lazily converts old files; 'v1' freezes the legacy behavior
   * byte-for-byte (kill switch). Default 'auto'.
   */
  format?: 'v1' | 'auto'
  /**
   * Source bytes of legacy JSONL the lazy migrator may convert per sweep
   * cycle. The work is bounded so a sweep never stalls the process, but the
   * budget must outpace retention: a one-file-per-cycle migrator lets a
   * backlog expire unconverted, so the dedup win would only ever apply to
   * sessions written after the upgrade.
   */
  migrationBudgetBytes?: number
  /**
   * Whether the sweep packs cold reachable objects into solid blocks. `off`
   * stops writing NEW packs — existing packs stay readable (and are gradually
   * unpacked again), so flipping the switch off never hides an already-packed
   * record. Default 'auto'.
   */
  pack?: 'auto' | 'off'
  /** Raw bytes per solid block the packer cuts. */
  packBlockBytes?: number
  /** Raw bytes one sweep cycle may move into packs. */
  packBudgetBytes?: number
  /** Below this share of still-reachable entries, a pack is worth rewriting. */
  repackLiveRatio?: number
  /** Raw bytes one repack holds in memory before flushing them to the pack. */
  repackChunkBytes?: number
  /** Rewriting anything smaller costs more IO than the space it reclaims. */
  repackMinBytes?: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Default per-cycle migration budget: a ~700 MB backlog converts in under a fortnight. */
export const DEFAULT_MIGRATION_BUDGET_BYTES = 64 * 1024 * 1024

/** Raw bytes per solid block: 1 MiB measured best on tail latency (p90 12.2 ms). */
export const DEFAULT_PACK_BLOCK_BYTES = 1024 * 1024
/** Raw bytes one sweep may move into packs, mirroring the migration budget. */
export const DEFAULT_PACK_BUDGET_BYTES = 64 * 1024 * 1024
/** Below this share of still-reachable entries, a pack is worth rewriting. */
export const DEFAULT_REPACK_LIVE_RATIO = 0.5
/** Rewriting anything smaller costs more IO than the space it reclaims. */
export const DEFAULT_REPACK_MIN_BYTES = 8 * 1024 * 1024
/** Raw bytes a repack holds at once: a pack's survivors can be far larger. */
export const DEFAULT_REPACK_CHUNK_BYTES = 8 * 1024 * 1024

/** Win32 reserved device names: the OS ignores the extension, so "NUL.jsonl" would target the device. */
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/**
 * Any sha256 appearing in a line: v2 `refs[].h`, a v3 `tree` or `resp`.
 * Over-marking only spares an object from GC; under-marking deletes live
 * data, so this is deliberately broad.
 */
const REACHABLE_HASH = /[0-9a-f]{64}/g

/** Tree hashes specifically: only these get walked for transitive marks. */
const REACHABLE_TREE = /"tree":"([0-9a-f]{64})"/g

/** Sanitize a session id into one safe path segment (ids are uuid-like already). */
export function fileNameOf(sessionId: string): string {
  let safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_')
  // A trailing dot is dropped by Win32 semantics — strip it so the name round-trips.
  safe = safe.replace(/\.+$/, '') || '_'
  if (RESERVED_DEVICE_NAME.test(safe)) safe = '_' + safe
  return `${safe}.jsonl`
}

/** Serialized write state for one session file. */
interface AppendState {
  /** Tail of the per-file chain; every mutation of the file rides it. */
  queue: Promise<void>
  /** A previous append failed — the tail may be torn and needs repair first. */
  poisoned: boolean
}

/** Cached projected index for one session file, valid while (mtime, size) hold. */
interface IndexCacheEntry {
  mtimeMs: number
  size: number
  /** Chronological (file order) index entries. */
  entries: CallIndexEntry[]
  /**
   * Byte offset where complete parsed lines end: appends after this offset
   * can be parsed incrementally instead of re-reading the whole file.
   */
  parsedBytes: number
  /**
   * Attributed bytes of exactly the lines in {@link entries}. Accumulated
   * beside them so the incremental tail parse carries it too: publishing the
   * footprint costs the poll no extra read.
   */
  footprint: LineFootprint
}

/** Validated logical-bytes marker, bound to the file state it was counted at. */
interface LogicalMarker {
  mtimeMs: number
  size: number
  bytes: number
}

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

/** Coarse sweep phases, published live while a cycle is in flight. */
export type SweepPhase = 'retention' | 'gc' | 'pack' | 'repack' | 'unpack' | 'migration' | 'done'

/**
 * The latest sweep cycle's observable outcome, published for /health. While
 * `running` is true the numbers are partial progress — a flag stuck past
 * minutes means a hung cycle; `error` carries the most recent failure a
 * fail-soft stage swallowed, so a no-op cycle explains itself instead of
 * looking like "nothing to do".
 */
export interface SweepStatus {
  /** Cycle start (epoch ms). */
  startedAt: number
  /** True while the cycle is in flight. */
  running: boolean
  /** Current (or final) phase of the cycle. */
  phase: SweepPhase
  /** Cycle end (epoch ms); absent while running. */
  finishedAt?: number
  /** Wall-clock duration (ms); absent while running. */
  durationMs?: number
  /** Session files walked by the retention pass. */
  filesSeen: number
  deletedFiles: number
  trimmedFiles: number
  /** Files the migrator scanned that still held legacy lines. */
  migrationCandidates: number
  migratedFiles: number
  removedObjects: number
  removedTemp: number
  /** Loose objects moved into packs by the pack phase. */
  packedObjects: number
  /** Raw loose bytes those packed objects represented. */
  packedBytes: number
  /** Mostly-dead packs rewritten: survivors moved on, the old file retired. */
  repackedPacks: number
  /** Packed objects materialized loose again by the unpack phase. */
  unpackedObjects: number
  /**
   * Whether the mark phase read every session file to the end. False means
   * the reachable set is partial, so the reclaiming phases stood down.
   */
  markComplete: boolean
  /** Most recent swallowed stage failure, as "<stage>: <message>". */
  error?: string
}

/**
 * Stamp logical-call steps onto a chronological entry list (see
 * {@link CallIndexEntry.step}). Ordinary calls consume a step each — attempt 1
 * opens a new one, retries share the step they retry — while auxiliary calls
 * (compaction / session-title) carry no step and consume none. A retry whose
 * chain head was trimmed away still gets the step it opens at the window's
 * head, so the numbering stays strictly increasing and gap-free.
 */
export function assignSteps(entries: CallIndexEntry[]): CallIndexEntry[] {
  let step = 0
  for (const entry of entries) {
    if (entry.purpose !== undefined) continue
    if (entry.attempt === 1 || step === 0) step += 1
    entry.step = step
  }
  return entries
}

/**
 * The order objects are packed in, and the reason packing is worth doing:
 * consecutive calls re-send nearly the same conversation, so neighbouring
 * objects are near-duplicates and compress together. Measured on a real
 * store in 4 MiB blocks, chronological order packs to 6.20 MB where hash
 * order needs 9.72 MB — a 36 % swing that repacking must not throw away.
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

/** Slice file text down to its complete lines (torn tail dropped). */
function completeLines(text: string): string[] {
  const end = text.endsWith('\n') ? text.length : Math.max(text.lastIndexOf('\n') + 1, 0)
  const lines = text.slice(0, end).split('\n')
  while (lines.length > 0 && lines[lines.length - 1].length === 0) lines.pop()
  return lines
}

/**
 * A line's call start time, the chronological key the packer orders on. A
 * line that will not say (foreign, damaged) yields 0: sorting it first only
 * risks packing a still-live object early, which the grace floor already
 * covers — the order is a compression hint, never a correctness input.
 */
function envelopeStartedAt(line: string): number {
  try {
    const timing = (JSON.parse(line) as { timing?: { startedAt?: unknown } }).timing
    const at = timing?.startedAt
    return typeof at === 'number' && Number.isFinite(at) ? at : 0
  } catch {
    return 0
  }
}

/** Parse one JSONL line into a legacy v1 record of the schema this build understands. */
function legacyRecordOf(line: string): CallRecord | undefined {
  if (line.length === 0) return undefined
  try {
    const value = JSON.parse(line) as CallRecord
    if (value.schema !== RECORD_SCHEMA) return undefined
    return value
  } catch {
    return undefined
  }
}

/** Whether a raw line is already a v2 envelope (leading peek, mirrors the writer). */
function isV2Line(line: string): boolean {
  return line.startsWith('{"v":2')
}

/** Whether a raw line is a v3 envelope (leading peek, mirrors the writer). */
function isV3Line(line: string): boolean {
  return line.startsWith('{"v":3')
}

/**
 * Per-line index projection: a v2 envelope projects PURELY from the line
 * (zero blob IO — the precomputed sum mirrors toIndexEntry); a v1 record
 * traverses the embedded bodies. Corrupt / foreign lines fail soft to
 * undefined (spec-pinned behavior).
 */
function entryOfLine(line: string): CallIndexEntry | undefined {
  if (line.length === 0) return undefined
  try {
    const value: unknown = JSON.parse(line)
    if (value === null || typeof value !== 'object') return undefined
    if ((value as { v?: unknown }).v === RECORD_SCHEMA_V3) {
      const env = value as unknown as CallEnvelopeV3
      if (typeof env.id !== 'string' || env.sum === null || env.sum === undefined || typeof env.tree !== 'string') return undefined
      return entryFromEnvelope(env)
    }
    if ((value as { v?: unknown }).v === RECORD_SCHEMA_V2) {
      const env = value as unknown as CallEnvelope
      if (typeof env.id !== 'string' || env.sum === null || env.sum === undefined || !Array.isArray(env.refs)) return undefined
      return entryFromEnvelope(env)
    }
    if ((value as { schema?: unknown }).schema === RECORD_SCHEMA) return toIndexEntry(value as CallRecord)
  } catch {
    return undefined
  }
  return undefined
}

/** The two halves of what one line attributes to its session. */
export interface LineFootprint {
  /** The envelope line's own bytes — what sits in the `.jsonl`. */
  envelope: number
  /** Compressed object bytes this line's append materialized. */
  object: number
}

/**
 * Split one KEPT line into the bytes it attributes to its session: the line
 * itself, plus the compressed object bytes its append materialized (counted
 * once per referencing envelope). Legacy full-body lines carry their content
 * inline, so they attribute nothing to the object half.
 *
 * The primitive behind both the `maxFileBytes` cap and the footprint the read
 * API publishes — one accounting, so what the UI shows is exactly what the cap
 * bills. Unparsable input degrades to its physical size, never to a throw:
 * this runs on the sweep's trim path, where a torn line must not be fatal.
 */
export function footprintOfLine(line: string): LineFootprint {
  const envelope = Buffer.byteLength(line, 'utf8')
  if (isV3Line(line)) {
    try {
      const env = JSON.parse(line) as { zn?: unknown }
      // zn is what this append MATERIALIZED: exact, and never double-counted
      // across records that share a blob.
      return { envelope, object: typeof env.zn === 'number' && env.zn >= 0 ? env.zn : 0 }
    } catch {
      return { envelope, object: 0 }
    }
  }
  if (!isV2Line(line)) return { envelope, object: 0 }
  try {
    const env = JSON.parse(line) as { refs?: { z?: unknown }[] }
    let object = 0
    if (Array.isArray(env.refs)) {
      for (const ref of env.refs) {
        if (ref !== null && typeof ref === 'object' && typeof ref.z === 'number') object += ref.z
      }
    }
    return { envelope, object }
  } catch {
    return { envelope, object: 0 }
  }
}

/**
 * Logical bytes one KEPT line attributes to its session: the line itself plus
 * its referenced compressed sizes (once per referencing envelope). Legacy
 * lines attribute their raw size.
 */
function logicalBytesOfLine(line: string): number {
  const { envelope, object } = footprintOfLine(line)
  return envelope + object
}

/** Index entries of a run of complete lines, with what they attribute. */
interface ParsedLines {
  entries: CallIndexEntry[]
  footprint: LineFootprint
}

/**
 * Project a run of COMPLETE lines into index entries and their attributed
 * bytes in one pass. Both readers share it so the footprint rides the
 * incremental tail parse: a poll on a grown file tallies only the new lines,
 * never a re-scan of the whole session.
 *
 * A line that yields no entry (blank, or unparsable) attributes nothing —
 * the tally must describe exactly the rows the page reports.
 */
function projectLines(text: string): ParsedLines {
  const entries: CallIndexEntry[] = []
  const footprint: LineFootprint = { envelope: 0, object: 0 }
  for (const line of text.split('\n')) {
    const entry = entryOfLine(line)
    if (entry === undefined) continue
    entries.push(entry)
    const { envelope, object } = footprintOfLine(line)
    // The newline every record is written with belongs to the line it ends.
    footprint.envelope += envelope + 1
    footprint.object += object
  }
  return { entries, footprint }
}

export class CallStore {
  /** Bounded index cache: insertion-order eviction is enough (poll locality). */
  private readonly indexCache = new Map<string, IndexCacheEntry>()
  /**
   * Per-session write serialization: keyed by session id. PROCESS-LOCAL: two
   * host processes sharing one directory (two `dsh web` instances on one
   * DSH_HOME) get no cross-process locking — a trim's read-modify-write in
   * one can interleave with an append in the other and lose records, and
   * both stage rewrites through the same fixed `<file>.jsonl.tmp` name. One
   * dsh-request-log writer per data directory is a deployment invariant.
   */
  private readonly appends = new Map<string, AppendState>()
  /** Logical attributed bytes per session, validated against its (mtime, size). */
  private readonly logicalCache = new Map<string, LogicalMarker>()
  /** The tree each session last wrote, so the next append can delta onto it. */
  private readonly treeStates = new Map<string, TreeState>()
  private readonly blobs: BlobStore
  /** Solid-block packs beside the loose store; read even when packing is off. */
  private readonly packs: PackStore
  /** False only for `pack: 'off'`: the sweep stops WRITING packs, never reading. */
  private readonly packingEnabled: boolean
  private mkdirPromise: Promise<void> | undefined
  private sweepStatus: SweepStatus | undefined
  /** Consecutive failed migration attempts per session; drives the retry order. */
  private readonly migrationFailures = new Map<string, number>()
  /** Error sink of the in-flight sweep cycle (absent outside a sweep). */
  private sweepErrorSink: ((stage: string, error: unknown) => void) | undefined

  constructor(private readonly config: StoreConfig, blobStore?: BlobStore) {
    const objectsDir = join(config.directory, 'objects')
    // Built unconditionally: `pack: 'off'` must stop writing packs, never
    // reading them, or turning the switch off would hide every already-packed
    // record behind a store that no longer knows how to serve it.
    this.packs = new PackStore({
      directory: join(objectsDir, 'packs'),
      // A pack the store had to work around is a line on /health, not a shrug:
      // outside a sweep there is nowhere to put it, and inside one it is
      // exactly what explains a pack that went unrepacked or unretired.
      onError: (stage, error) => this.sweepErrorSink?.(stage, error),
    })
    this.packingEnabled = config.pack !== 'off'
    this.blobs = blobStore ?? new BlobStore({ directory: objectsDir, packs: this.packs })
  }

  /**
   * Whether v2 persistence is engaged (envelopes + object store + lazy
   * migration). `format: 'v1'` freezes legacy behavior instead.
   */
  private get v2Enabled(): boolean {
    return this.config.format !== 'v1'
  }

  /** The configured per-session cap — the API derives its page ceiling from it. */
  get maxCallsPerSession(): number {
    return this.config.maxCallsPerSession
  }

  /** The latest sweep cycle's status — live while running, served by /health. */
  get lastSweepStatus(): SweepStatus | undefined {
    return this.sweepStatus
  }

  /** Loose object census — exposed so specs can age objects deterministically. */
  objectCensusForTest(): Promise<{ hash: string; size: number; mtimeMs: number }[]> {
    return this.blobs.looseCensus()
  }

  private pathOf(sessionId: string): string {
    return join(this.config.directory, fileNameOf(sessionId))
  }

  /** Create the root directory once; a failed attempt is retried on the next append. */
  private ensureDirectory(): Promise<void> {
    if (this.mkdirPromise === undefined) {
      // Owner-only where the platform honors modes (POSIX): the directory
      // holds full conversation plaintext.
      this.mkdirPromise = mkdir(this.config.directory, { recursive: true, mode: 0o700 }).then(
        () => {},
        error => {
          this.mkdirPromise = undefined
          throw error
        },
      )
    }
    return this.mkdirPromise
  }

  private appendStateOf(sessionId: string): AppendState {
    let state = this.appends.get(sessionId)
    if (state === undefined) {
      state = { queue: Promise.resolve(), poisoned: false }
      this.appends.set(sessionId, state)
    }
    return state
  }

  /** Run a file mutation on the session's chain, keeping the chain alive after failures. */
  private enqueue<T>(sessionId: string, job: () => Promise<T>): Promise<T> {
    const state = this.appendStateOf(sessionId)
    const next = state.queue.then(job)
    state.queue = next.then(() => {}, () => {})
    return next
  }

  /** One line's on-disk bytes (every record is written with its newline). */
  private static lineBytes(line: string): number {
    return Buffer.byteLength(line, 'utf8')
  }

  private invalidateCaches(sessionId: string): void {
    this.indexCache.delete(sessionId)
    this.logicalCache.delete(sessionId)
    // A rewritten or deleted file may have been the only thing keeping the
    // parent chain reachable: start the next append from a keyframe.
    this.treeStates.delete(sessionId)
  }

  /**
   * Repair a possibly-torn tail: everything after the last complete line
   * (a partial write from a failed append) is truncated away so the next
   * record cannot fuse with it into an unparsable line.
   */
  private async repairTail(path: string, sessionId: string): Promise<void> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      return // No file — nothing torn.
    }
    if (text.endsWith('\n')) return
    const completeChars = Math.max(text.lastIndexOf('\n') + 1, 0)
    await truncate(path, Buffer.byteLength(text.slice(0, completeChars), 'utf8')).catch(() => {})
    this.invalidateCaches(sessionId)
  }

  /** Temp-in-same-dir rewrite then rename: atomic on Win32 (same volume). */
  private async atomicWriteText(path: string, text: string): Promise<void> {
    const temp = `${path}.tmp`
    try {
      await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 })
      await rename(temp, path)
    } finally {
      // A failed rename (e.g. the destination held open by a reader on
      // Windows) must not strand the staging file forever — the sweep only
      // ever scans *.jsonl, so nothing else would clean it. Mirrors the
      // staging discipline of blob.ts and pack.ts.
      await rm(temp, { force: true }).catch(() => {})
    }
  }

  /** Recount logical attributed bytes straight from file text (cold path). */
  private async rescanLogicalBytes(path: string): Promise<number> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      return 0
    }
    let total = 0
    for (const line of completeLines(text)) total += logicalBytesOfLine(line)
    return total
  }

  /** Attributed bytes for this exact file state; recounted when unmarked. */
  private async attributedBytes(sessionId: string, path: string, info: { mtimeMs: number; size: number }): Promise<number> {
    const cached = this.logicalCache.get(sessionId)
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.bytes
    return this.rescanLogicalBytes(path)
  }

  /** Refresh the logical marker after a successful write (a fresh stat is its key). */
  private async noteWritten(sessionId: string, path: string, bytes: number): Promise<void> {
    const info = await stat(path).then(fresh => ({ mtimeMs: fresh.mtimeMs, size: fresh.size }), () => null)
    if (info === null) {
      this.logicalCache.delete(sessionId)
      return
    }
    this.logicalCache.set(sessionId, { mtimeMs: info.mtimeMs, size: info.size, bytes })
  }

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
      // A v3 line passes through untouched, and its chain depth is not
      // recorded anywhere the line can tell us: claiming depth 0 would let a
      // later conversion delta onto an already-full chain and push the walk
      // past TREE_MAX_WALK, making that record unreadable. Reset instead —
      // the next line needing conversion cuts its own keyframe.
      state.previous = undefined
      return line
    }

    if (isV2Line(line)) {
      let env: CallEnvelope
      try { env = JSON.parse(line) as CallEnvelope } catch { return line }
      if (!Array.isArray(env.refs)) return line
      entries = []
      for (const ref of env.refs as unknown[]) {
        // Untrusted: the writer never emits a malformed ref, but a damaged
        // line reaching the tree encoder would be refused there and take the
        // whole conversion down. Pass this line through v2 instead — it stays
        // readable, and the next pass retries it.
        if (ref === null || typeof ref !== 'object') return line
        const { k, h } = ref as { k?: unknown; h?: unknown }
        if (!isEntryHash(h)) return line
        if (k === 'r') { resp = h; continue }
        if (k !== 's' && k !== 't' && k !== 'm') return line
        entries.push({ k, h })
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
        } catch (error) {
          // Fail-soft is the data-safety contract (the original line
          // survives), but not silent: an in-flight sweep publishes the bake
          // failure so /health can explain a file that never converts.
          this.sweepErrorSink?.('blob bake', error)
          return line
        }
        entries.push({ k: piece.kind, h: hash })
      }
      if (record.response !== undefined) {
        const json = JSON.stringify(record.response)
        resp = hashOfContent(json)
        try {
          const put = await this.blobs.put(resp, json)
          if (put.created) zn += put.z
        } catch (error) {
          this.sweepErrorSink?.('blob bake', error)
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
      } catch (error) {
        this.sweepErrorSink?.('blob bake', error)
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

  /**
   * Rewrite the file to exactly these kept lines (converting them to v2 when
   * migrating), atomically, and refresh both caches. Returns the new logical
   * attributed total.
   */
  private async commitRewrite(sessionId: string, path: string, keptLines: string[]): Promise<number> {
    let keptLogical = 0
    const converted: string[] = []
    const state: { previous: TreeState | undefined } = { previous: undefined }
    for (const line of keptLines) {
      const upgraded = await this.ensureV3Line(line, state)
      converted.push(upgraded)
      keptLogical += logicalBytesOfLine(upgraded)
    }
    const rewritten = converted.length > 0 ? converted.join('\n') + '\n' : ''
    await this.atomicWriteText(path, rewritten)
    const info = await stat(path).then(fresh => ({ mtimeMs: fresh.mtimeMs, size: fresh.size }), () => null)
    if (info === null) {
      this.invalidateCaches(sessionId)
    } else {
      this.logicalCache.set(sessionId, { mtimeMs: info.mtimeMs, size: info.size, bytes: keptLogical })
      this.indexCache.delete(sessionId)
    }
    return keptLogical
  }

  /**
   * Trim the session file under the LOGICAL byte cap so `incomingLogical`
   * more fit: keep the NEWEST lines whose attributed sizes stay within the
   * budget, rewriting atomically. Surviving v1 lines convert to v2 here.
   */
  private async trimForBytes(sessionId: string, path: string, incomingLogical: number): Promise<number> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      return 0
    }
    const lines = completeLines(text)
    const budget = this.config.maxFileBytes - incomingLogical
    const kept: string[] = []
    let keptBytes = 0
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const bytes = logicalBytesOfLine(lines[i])
      if (keptBytes + bytes > Math.max(budget, 0)) break
      kept.unshift(lines[i])
      keptBytes += bytes
    }
    return this.commitRewrite(sessionId, path, kept)
  }

  /** Line-count trim (sweep): keep the newest maxCallsPerSession records. */
  private async rewriteLineCapped(sessionId: string, path: string): Promise<void> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      return
    }
    const lines = completeLines(text)
    await this.commitRewrite(sessionId, path, lines.slice(lines.length - this.config.maxCallsPerSession))
  }

  /**
   * The physical append. Protected so tests can simulate a partial write
   * followed by a failure (the torn-tail repair scenario).
   */
  protected async writeLine(path: string, line: string): Promise<void> {
    await appendFile(path, line, { encoding: 'utf8', mode: 0o600 })
  }

  /**
   * Append one settled attempt to its session file, creating the directory.
   * Same-session appends are serialized; a byte-cap breach first trims the
   * oldest records; a torn tail left by a previous failure is repaired first.
   * V2 mode bakes every referenced object BEFORE the envelope line lands, all
   * inside this serialized chain.
   */
  append(record: CallRecord): Promise<void> {
    const sessionId = record.sessionId
    const path = this.pathOf(sessionId)
    return this.enqueue(sessionId, async () => {
      await this.ensureDirectory()
      const state = this.appendStateOf(sessionId)
      // Sealing runs INSIDE the chain: it needs the previous tree state,
      // which only the chain's serialized ownership makes safe to read.
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
        // The write may have landed partially: mark the file so the next
        // append repairs the tail instead of fusing with the torn line.
        state.poisoned = true
        throw error
      }
    })
  }

  private async readAll(sessionId: string): Promise<ParsedLines & { parsedBytes: number }> {
    let text: string
    try {
      text = await readFile(this.pathOf(sessionId), 'utf8')
    } catch {
      return { entries: [], footprint: { envelope: 0, object: 0 }, parsedBytes: 0 }
    }
    // Only complete lines count: a torn trailing write (no newline) is left
    // for a later pass so its completed form is parsed then.
    const completeEnd = text.endsWith('\n') ? text.length : Math.max(text.lastIndexOf('\n') + 1, 0)
    const complete = text.slice(0, completeEnd)
    return { ...projectLines(complete), parsedBytes: Buffer.byteLength(complete, 'utf8') }
  }

  /**
   * Parse only the bytes appended past `fromByte` (a prior pass's parsed
   * extent). A trailing chunk without its newline is a torn write — it stays
   * unparsed so the next pass retries it once complete. Returns null when the
   * file shrank or the offset no longer sits on a line boundary (a trim
   * rewrote the file): callers fall back to a full re-read.
   */
  private async readTail(sessionId: string, fromByte: number): Promise<(ParsedLines & { parsedBytes: number }) | null> {
    if (fromByte <= 0) return null
    const handle = await open(this.pathOf(sessionId), 'r').catch(() => null)
    if (handle === null) return null
    try {
      const { size } = await handle.stat()
      if (size < fromByte) return null
      const buffer = Buffer.alloc(size - fromByte)
      if (buffer.length > 0) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, fromByte)
        if (bytesRead !== buffer.length) return null
      }
      const text = buffer.toString('utf8')
      const lastNewline = text.lastIndexOf('\n')
      if (lastNewline !== text.length - 1) {
        // Torn trailing line: parse up to the last complete line only.
        const complete = lastNewline === -1 ? '' : text.slice(0, lastNewline + 1)
        return { ...projectLines(complete), parsedBytes: fromByte + Buffer.byteLength(complete, 'utf8') }
      }
      return { ...projectLines(text), parsedBytes: size }
    } finally {
      await handle.close().catch(() => {})
    }
  }

  /**
   * Chronological index entries for one session, served from the (mtime, size)
   * cache when the file is unchanged since the last projection. A grown file
   * parses only its appended tail — the 3s poll on a long session costs a
   * stat plus the new lines, never a re-parse of the whole history.
   */
  private async entriesOf(sessionId: string): Promise<ParsedLines> {
    let info
    try {
      info = await stat(this.pathOf(sessionId))
    } catch {
      this.indexCache.delete(sessionId)
      return { entries: [], footprint: { envelope: 0, object: 0 } }
    }
    const cached = this.indexCache.get(sessionId)
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return { entries: cached.entries, footprint: cached.footprint }
    }
    let entries: CallIndexEntry[]
    let footprint: LineFootprint
    let parsedBytes: number
    if (cached !== undefined && info.size > cached.parsedBytes) {
      const tail = await this.readTail(sessionId, cached.parsedBytes)
      if (tail !== null) {
        entries = [...cached.entries, ...tail.entries]
        footprint = {
          envelope: cached.footprint.envelope + tail.footprint.envelope,
          object: cached.footprint.object + tail.footprint.object,
        }
        parsedBytes = tail.parsedBytes
      } else {
        const full = await this.readAll(sessionId)
        entries = full.entries
        footprint = full.footprint
        parsedBytes = full.parsedBytes
      }
    } else {
      const full = await this.readAll(sessionId)
      entries = full.entries
      footprint = full.footprint
      parsedBytes = full.parsedBytes
    }
    assignSteps(entries)
    if (this.indexCache.size >= 16 && !this.indexCache.has(sessionId)) {
      const oldest = this.indexCache.keys().next().value
      if (oldest !== undefined) this.indexCache.delete(oldest)
    }
    this.indexCache.set(sessionId, { mtimeMs: info.mtimeMs, size: info.size, entries, parsedBytes, footprint })
    return { entries, footprint }
  }

  /**
   * Newest-first index page for one session.
   */
  async listIndex(sessionId: string, limit: number, offset: number): Promise<CallIndexResponse> {
    const { entries, footprint } = await this.entriesOf(sessionId)
    const total = entries.length
    // Newest-first paging without materializing a reversed copy of the whole
    // session: the requested window is a slice off the tail, reversed.
    const end = Math.max(total - offset, 0)
    const start = Math.max(end - limit, 0)
    const calls = entries.slice(start, end).reverse()
    return {
      calls,
      total,
      offset,
      limit,
      storage: {
        envelopeBytes: footprint.envelope,
        objectBytes: footprint.object,
        logicalBytes: footprint.envelope + footprint.object,
        maxFileBytes: this.config.maxFileBytes,
      },
    }
  }

  /** Fetch one full record by attempt id (parses only the matching line). */
  async get(sessionId: string, callId: string): Promise<CallRecord | undefined> {
    let text: string
    try {
      text = await readFile(this.pathOf(sessionId), 'utf8')
    } catch {
      return undefined
    }
    // Serialized ids sit in every line right after the version key (v2 keeps
    // that discipline deliberately): a substring prefilter skips JSON.parse
    // for all non-matching lines.
    const needle = `"id":${JSON.stringify(callId)}`
    for (const line of text.split('\n')) {
      if (line.length === 0 || !line.includes(needle)) continue
      let value: unknown
      try { value = JSON.parse(line) } catch { continue }
      if (value === null || typeof value !== 'object') continue
      if ((value as { v?: unknown }).v === RECORD_SCHEMA_V3) {
        const env = value as unknown as CallEnvelopeV3
        if (env.id !== callId || env.sum == null || typeof env.tree !== 'string') continue
        return await this.reassembleV3(env)
      }
      if ((value as { v?: unknown }).v === RECORD_SCHEMA_V2) {
        const env = value as unknown as CallEnvelope
        if (env.id !== callId || env.sum == null || !Array.isArray(env.refs)) continue
        // Fail-soft detail reassembly: unreadable blobs degrade ONLY their slot.
        return await this.reassembleRecord(env)
      }
      const record = value as CallRecord
      if ((record as { schema?: unknown }).schema === RECORD_SCHEMA && record.id === callId) return record
    }
    return undefined
  }

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

  /** One referenced blob's parsed value, or a fail-soft placeholder for the slot. */
  private async slotValue(hash: string): Promise<unknown> {
    try {
      const raw = await this.blobs.get(hash)
      return JSON.parse(raw.toString('utf8'))
    } catch {
      return { $unavailable: hash }
    }
  }

  /** Splice blobs back into a v1-shaped record so API payloads stay stable. */
  private async reassembleRecord(env: CallEnvelope): Promise<CallRecord> {
    // Shared hashes resolve once behind a single inflight promise.
    const inflight = new Map<string, Promise<unknown>>()
    const slotFor = (hash: string): Promise<unknown> => {
      let pending = inflight.get(hash)
      if (pending === undefined) {
        pending = this.slotValue(hash)
        inflight.set(hash, pending)
      }
      return pending
    }
    const slots = await Promise.all(env.refs.map(async ref => ({ kind: ref.k, value: await slotFor(ref.h) })))
    let system: unknown
    let tools: unknown
    let response: unknown
    const messages: unknown[] = []
    for (const slot of slots) {
      if (slot.kind === 's') system = slot.value
      else if (slot.kind === 't') tools = slot.value
      else if (slot.kind === 'r') response = slot.value
      else messages.push(slot.value)
    }
    const request = {} as RecordedRequest
    request.messages = messages as RecordedMessage[]
    if (system !== undefined) request.system = system as string
    if (tools !== undefined) request.tools = tools as RecordedRequest['tools']
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
    if (response !== undefined) record.response = response as RecordedResponse
    return record
  }

  /**
   * Enforce retention: delete stale session files, trim oversized ones.
   * Trims ride the per-file append chain, so a concurrent append can never
   * be lost to the rewrite window. The v2 object store rides the same pass:
   * reachable hashes are marked from the files read here anyway, then the GC
   * sweeps unreachable objects and staging debris past a grace floor, and the
   * migrator converts not-yet-v2 files newest-first until the per-cycle byte
   * budget is spent. Returns the disposal counts; the live cycle state is
   * published as {@link CallStore.lastSweepStatus} (for /health), where every
   * fail-soft stage reports what it swallowed instead of going silent.
   */
  async sweep(now: number = Date.now()): Promise<{ deletedFiles: number; trimmedFiles: number; migratedFiles: number }> {
    const status: SweepStatus = {
      startedAt: Date.now(),
      running: true,
      phase: 'retention',
      filesSeen: 0,
      deletedFiles: 0,
      trimmedFiles: 0,
      migrationCandidates: 0,
      migratedFiles: 0,
      removedObjects: 0,
      removedTemp: 0,
      packedObjects: 0,
      packedBytes: 0,
      repackedPacks: 0,
      unpackedObjects: 0,
      markComplete: true,
    }
    this.sweepStatus = status
    const swallowed = (stage: string, error: unknown): void => {
      // /health is readable by anyone past the fence: the error text keeps
      // its name/errno/shape but loses the absolute paths (and the username
      // inside them) that fs errors carry.
      status.error = `${stage}: ${errorTextOf(error)}`
    }
    this.sweepErrorSink = swallowed
    try {
      let names: string[]
      try {
        names = await readdir(this.config.directory)
      } catch (error) {
        // The directory is created by the first append, so a fresh install's
        // BOOT sweep legitimately finds nothing: that is an empty store, not a
        // failure, and publishing it would hang a false error on /health until
        // the next daily cycle. Anything else is real and belongs there.
        if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') swallowed('scan directory', error)
        status.phase = 'done'
        return { deletedFiles: 0, trimmedFiles: 0, migratedFiles: 0 }
      }
      // 'never' floors the cutoff below every possible mtime, so the branch
      // below is dead rather than accidentally-false on a NaN comparison.
      const cutoff = this.config.retentionDays === 'never'
        ? Number.NEGATIVE_INFINITY
        : now - this.config.retentionDays * DAY_MS
      const reachable = new Set<string>()
      const treeRoots = new Set<string>()
      // Any failure below leaves the reachable set partial; the reclaiming
      // phases must stand down rather than act on it.
      let markComplete = true
      /** One {at, hashes} row per envelope line, feeding the packer's order. */
      const orderLines: { at: number; hashes: string[] }[] = []
      const migrationCandidates: { sessionId: string; path: string; mtimeMs: number; size: number }[] = []
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue
        status.filesSeen += 1
        const path = join(this.config.directory, name)
        const sessionId = name.replace(/\.jsonl$/, '')
        try {
          const info = await stat(path)
          if (this.v2Enabled) migrationCandidates.push({ sessionId, path, mtimeMs: info.mtimeMs, size: info.size })
          if (info.mtimeMs < cutoff) {
            await rm(path)
            this.invalidateCaches(sessionId)
            status.deletedFiles += 1
            continue
          }
          // Line counting needs no parsing: the cap is about file growth, and
          // invalid lines are filtered by the read path regardless.
          const text = await readFile(path, 'utf8')
          const lines = text.split('\n')
          while (lines.length > 0 && lines[lines.length - 1].length === 0) lines.pop()
          // The GC mark phase rides reads this sweep performs anyway.
          if (this.v2Enabled) {
            for (const match of text.matchAll(REACHABLE_HASH)) reachable.add(match[0])
            for (const match of text.matchAll(REACHABLE_TREE)) treeRoots.add(match[1])
            // The packer's chronological order rides it too: one row per
            // envelope line, the same hashes the mark just swept out of it.
            for (const line of lines) {
              if (line.length === 0) continue
              const hashes = [...line.matchAll(REACHABLE_HASH)].map(match => match[0])
              if (hashes.length > 0) orderLines.push({ at: envelopeStartedAt(line), hashes })
            }
          }
          const overLines = lines.length > this.config.maxCallsPerSession
          const overBytes = info.size > this.config.maxFileBytes
          if (!overLines && !overBytes) continue
          // The trim rides the file's append chain and re-reads the file there:
          // a record appended between the sweep's read and the trim cannot be
          // lost to the rewrite window.
          await this.enqueue(sessionId, async () => {
            if (overLines) await this.rewriteLineCapped(sessionId, path)
            else await this.trimForBytes(sessionId, path, 0)
          })
          status.trimmedFiles += 1
        } catch (error) {
          // One unreadable file never blocks the sweep of the others.
          swallowed(`retention ${name}`, error)
          markComplete = false
        }
      }
      if (this.v2Enabled) {
        status.phase = 'gc'
        let treePieces = new Map<string, string[]>()
        try {
          treePieces = await this.markTreeChains(treeRoots, reachable)
        } catch (error) {
          swallowed('tree mark', error)
          markComplete = false
        }
        // A reachable set built from an incomplete read marks live objects as
        // garbage. Missing a cycle costs a day of disk; deleting a body costs
        // the record forever.
        if (markComplete) {
          try {
            const gc = await this.blobs.gc(reachable, now)
            status.removedObjects = gc.removedObjects
            status.removedTemp = gc.removedTemp
          } catch (error) {
            // GC is best-effort; missed objects get reclaimed next cycle.
            swallowed('object gc', error)
          }
        }
        // Chronological pack order from the rows the mark phase collected:
        // neighbouring calls re-send nearly the same conversation, so packing
        // in call order is what keeps neighbouring near-duplicates in one
        // block where they compress together.
        //
        // An envelope line names only its tree and its response body; the
        // message pieces - two thirds of the bytes - are named inside the tree
        // node. Expanding each tree hash into the pieces THAT node introduced
        // is what ranks them: first-occurrence wins in packingOrder, and a
        // node's own entries are exactly the pieces its call added.
        const order = packingOrder(orderLines.map(line => ({
          at: line.at,
          hashes: line.hashes.flatMap(hash => {
            const pieces = treePieces.get(hash)
            return pieces === undefined ? [hash] : [...pieces, hash]
          }),
        })))
        if (this.packingEnabled) {
          // Packing on a partial reachable set is a deletion in disguise —
          // the loose copy goes away — so the GC's guard covers it too.
          if (markComplete) {
            status.phase = 'pack'
            try {
              await this.packColdObjects(reachable, order, now, status)
            } catch (error) {
              // Packing is an optimization: a failure leaves everything loose.
              swallowed('pack', error)
            }
            status.phase = 'repack'
            try {
              await this.repackDeadPacks(reachable, now, status)
            } catch (error) {
              // A failed repack leaves the old pack serving every read.
              swallowed('repack', error)
            }
          }
        } else {
          // Unpacking is deliberately NOT gated on markComplete: it copies
          // bytes back and consults no reachability set at all, so the
          // rollback door stays open even on a store whose mark phase fails.
          status.phase = 'unpack'
          try {
            await this.unpackObjects(now, status)
          } catch (error) {
            // A failed unpack leaves the packs serving every read.
            swallowed('unpack', error)
          }
        }
        status.phase = 'migration'
        // Newest first: a fresh session has the most retention life ahead of it,
        // so converting it buys the most stored-byte-days - and the oldest files
        // may not survive to the next cycle anyway. But a file that FAILED to
        // convert still costs its full size against the budget (it was read,
        // and not charging it would let a directory of failures re-read
        // unboundedly every cycle), so a stubborn file at the head of the order
        // would take the whole budget forever and starve every other one.
        // Sorting failures last keeps it retrying without letting it monopolize.
        for (const key of this.migrationFailures.keys()) {
          if (!migrationCandidates.some(candidate => candidate.sessionId === key)) this.migrationFailures.delete(key)
        }
        const failures = (sessionId: string): number => this.migrationFailures.get(sessionId) ?? 0
        migrationCandidates.sort((a, b) => failures(a.sessionId) - failures(b.sessionId) || b.mtimeMs - a.mtimeMs)
        const budget = this.config.migrationBudgetBytes ?? DEFAULT_MIGRATION_BUDGET_BYTES
        let spent = 0
        for (const candidate of migrationCandidates) {
          // Checked BEFORE the conversion, so one file always makes progress
          // however large it is; the budget bounds the cycle, never starves it.
          if (spent >= budget) break
          let wanted = false
          try {
            wanted = await this.fileHasLegacyLines(candidate.path)
          } catch (error) {
            swallowed(`scan ${candidate.sessionId}`, error)
            this.migrationFailures.set(candidate.sessionId, failures(candidate.sessionId) + 1)
            continue
          }
          if (!wanted) {
            this.migrationFailures.delete(candidate.sessionId)
            continue
          }
          status.migrationCandidates += 1
          let converted = false
          try {
            converted = await this.migrateFile(candidate.sessionId, candidate.path)
          } catch (error) {
            // A stubborn conversion retries on the next daily cycle.
            swallowed(`migrate ${candidate.sessionId}`, error)
          }
          // Still wanted but nothing changed counts as a failure too: the
          // legacy lines it holds are ones this build cannot convert at all.
          if (converted) {
            status.migratedFiles += 1
            this.migrationFailures.delete(candidate.sessionId)
          } else {
            this.migrationFailures.set(candidate.sessionId, failures(candidate.sessionId) + 1)
          }
          spent += candidate.size
        }
      }
      status.markComplete = markComplete
      status.phase = 'done'
      return { deletedFiles: status.deletedFiles, trimmedFiles: status.trimmedFiles, migratedFiles: status.migratedFiles }
    } catch (error) {
      // Unreachable while every stage catches its own; the guard keeps a
      // future edit from reintroducing a silent whole-cycle loss.
      swallowed('sweep', error)
      status.phase = 'done'
      throw error
    } finally {
      this.sweepErrorSink = undefined
      status.running = false
      status.finishedAt = Date.now()
      status.durationMs = status.finishedAt - status.startedAt
    }
  }

  /**
   * Walk every tree chain rooted in `roots`, adding each node's own hash,
   * its parent, and its entries to `reachable`. A node that cannot be read
   * or parsed stops that branch: GC then only risks sparing objects, never
   * deleting live ones.
   *
   * Resolves to each visited node's own entry hashes, in node order. That is
   * the packer's ranking input: a call's message pieces are named INSIDE its
   * tree node and never in the envelope line, so without this they would all
   * tie for last and fall back to hash order.
   */
  private async markTreeChains(
    roots: ReadonlySet<string>,
    reachable: Set<string>,
  ): Promise<Map<string, string[]>> {
    const pending = [...roots]
    const visited = new Set<string>()
    const entriesOfNode = new Map<string, string[]>()
    while (pending.length > 0) {
      const hash = pending.pop() as string
      if (visited.has(hash)) continue
      visited.add(hash)
      reachable.add(hash)
      let raw: Buffer
      try {
        raw = await this.blobs.get(hash)
      } catch (error) {
        // Confirmed absent everywhere is a dead branch: stop marking down it.
        // Anything else — a locked or unreadable file, a failing disk — is
        // INCOMPLETE KNOWLEDGE, and this branch's pieces are named NOWHERE but
        // inside its nodes: rethrow so the sweep stands the reclaiming phases
        // down (markComplete: false) instead of GC'ing live data.
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') continue
        throw error
      }
      let node
      try {
        node = decodeTree(raw.toString('utf8'))
      } catch {
        continue // Confirmed not a tree: nothing more to mark down here.
      }
      const entries = node.e.map(item => item.h)
      for (const item of entries) reachable.add(item)
      entriesOfNode.set(hash, entries)
      if (node.p !== undefined) pending.push(node.p)
    }
    return entriesOfNode
  }

  /**
   * Move cold reachable loose objects into a pack, in chronological packing
   * order, then drop the loose copies. Durability before deletion is the
   * invariant: the loose files are unlinked only after {@link PackStore.append}
   * resolved (blocks fsynced AND an index naming them rewritten), so a crash
   * anywhere in here leaves at worst a duplicate, never a hole.
   */
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
      // At least one object always packs, however tight the budget: the cycle
      // must make progress, and the budget bounds it — never starves it.
      if (spent > 0 && spent >= budget) break
      const raw = await this.blobs.get(candidate.hash).catch(() => null)
      if (raw === null) continue
      objects.push({ hash: candidate.hash, raw })
      spent += raw.length
    }
    if (objects.length === 0) return

    const appended = await this.packs.append(objects, this.config.packBlockBytes ?? DEFAULT_PACK_BLOCK_BYTES)
    // The pack is durable and the index rebuilds from it, but "both durable"
    // is what the deletion below rests on — a silent index-write failure earns
    // a line on /health, not a shrug.
    if (!appended.indexWritten) {
      this.sweepErrorSink?.('pack index', new Error(`index for pack ${appended.id} did not persist; it will be rebuilt from the pack`))
    }
    // Only now: the blocks and an index naming them are both durable.
    for (const object of objects) {
      if (await this.blobs.dropLoose(object.hash)) status.packedObjects += 1
    }
    status.packedBytes += spent
  }

  /**
   * Packs are immutable, so space inside one is reclaimed by writing a new
   * pack holding only what is still reachable and retiring the old file.
   * Stored order is preserved on purpose: it is what the compression ratio
   * rests on, and a repack that reordered would inflate the store it was
   * called to shrink.
   */
  private async repackDeadPacks(reachable: ReadonlySet<string>, now: number, status: SweepStatus): Promise<void> {
    const ratio = this.config.repackLiveRatio ?? DEFAULT_REPACK_LIVE_RATIO
    const minBytes = this.config.repackMinBytes ?? DEFAULT_REPACK_MIN_BYTES
    for (const info of await this.packs.list()) {
      if (info.entryCount === 0) continue
      const hashes = await this.packs.entriesOf(info.id).catch(() => [] as string[])
      // entriesOf fails soft to [] — its index would not load. That is not
      // the empty pack the entryCount check above already skipped, and
      // repacking "nothing" would compute 0/0 = NaN, sail past the ratio, and
      // retire a pack full of objects nobody accounted for.
      if (hashes.length === 0) continue
      const live = hashes.filter(hash => reachable.has(hash))
      // The size floor keeps churn off tiny rewrites — but a dead-MAJORITY
      // pack holds trimmed records' content for as long as it lives, so a
      // small pack is still worth one rewrite once half its entries are
      // unreachable (large packs keep the configured ratio bar).
      if (info.bytes < minBytes
        ? live.length * 2 >= hashes.length
        : live.length / hashes.length >= ratio) continue

      // Presence first, bytes later. A 64 MiB pack decompresses to several
      // hundred MB, so holding every survivor at once to learn whether they
      // are all there would size this phase by the pack rather than by a
      // budget - and the answer costs only an index lookup each.
      let allPresent = true
      for (const hash of live) {
        if (!(await this.blobs.has(hash))) { allPresent = false; break }
      }
      // Could not account for them all: leave the pack exactly as it is.
      if (!allPresent) continue
      // Seal FIRST: without it the survivors could be appended to the very
      // pack about to be retired, and the retire would take them with it.
      this.packs.seal(info.id)

      const blockBytes = this.config.packBlockBytes ?? DEFAULT_PACK_BLOCK_BYTES
      const chunkBytes = this.config.repackChunkBytes ?? DEFAULT_REPACK_CHUNK_BYTES
      let chunk: { hash: string; raw: Buffer }[] = []
      let held = 0
      let unreadable = false
      const flush = async (): Promise<void> => {
        if (chunk.length === 0) return
        const appended = await this.packs.append(chunk, blockBytes)
        if (!appended.indexWritten) {
          this.sweepErrorSink?.('pack index', new Error(`index for pack ${appended.id} did not persist; it will be rebuilt from the pack`))
        }
        chunk = []
        held = 0
      }
      for (const hash of live) {
        const raw = await this.blobs.get(hash).catch(() => null)
        if (raw === null) { unreadable = true; break }
        chunk.push({ hash, raw })
        held += raw.length
        if (held >= chunkBytes) await flush()
      }
      // A survivor that vanished between the check and the read: the copies
      // already appended are duplicates, which the next cycle reclaims. The
      // old pack keeps serving, which is the half that must not be guessed at.
      if (unreadable) continue
      await flush()
      await this.packs.retire(info.id)
      status.repackedPacks += 1
    }
    await this.packs.reapRetired(now)
  }

  /**
   * The way back out. Packing changes only where bytes live, so undoing it is
   * a copy in the other direction — but a build that cannot read packs is a
   * build that would see every packed record as unavailable, so this exists
   * before anyone needs it, not after.
   */
  private async unpackObjects(now: number, status: SweepStatus): Promise<void> {
    const budget = this.config.packBudgetBytes ?? DEFAULT_PACK_BUDGET_BYTES
    let spent = 0
    for (const info of await this.packs.list()) {
      const hashes = await this.packs.entriesOf(info.id).catch(() => [] as string[])
      // A pack whose entries would not load is not an empty pack — which is
      // why the count comes from the index HEADER, not from this list:
      // retiring it would delete bytes nobody has even read. A genuinely
      // empty one (entryCount 0) falls through and retires as cleanup.
      if (hashes.length === 0 && info.entryCount > 0) continue
      let allLoose = true
      for (const hash of hashes) {
        if (spent >= budget) { allLoose = false; break }
        const raw = await this.packs.read(hash).catch(() => null)
        if (raw === null) {
          // An object this build could not read back is NOT loose, and
          // retiring the pack anyway would delete its only copy.
          allLoose = false
          continue
        }
        try {
          const result = await this.blobs.putLoose(hash, raw)
          if (result.created) status.unpackedObjects += 1
        } catch (error) {
          // One object that cannot be re-loosed (a hash mismatch, say) must
          // not wedge the whole rollback: the pack keeps serving it, and a
          // pack holding anything unwritable is never retired.
          this.sweepErrorSink?.('unpack object', error)
          allLoose = false
          continue
        }
        spent += raw.length
      }
      if (allLoose) await this.packs.retire(info.id)
    }
    await this.packs.reapRetired(now)
  }

  /**
   * Does any complete line still hold a v1 record or a v2 envelope? A read
   * failure PROPAGATES: the caller publishes it as the sweep's error, which is
   * the only way a file that can never convert becomes visible on /health.
   */
  private async fileHasLegacyLines(path: string): Promise<boolean> {
    const text = await readFile(path, 'utf8')
    for (const line of completeLines(text)) {
      if (line.startsWith('{"schema":') || isV2Line(line)) return true
    }
    return false
  }

  /**
   * Convert every parsable v1/v2 line of one file to a v3 envelope and rewrite
   * atomically (temp + rename commit point — a crash mid-conversion leaves
   * the original intact and the pass restarts deterministically). Idempotent:
   * nothing left to convert leaves the file untouched. Resolves to whether
   * the file was actually rewritten (the sweep's migratedFiles count).
   */
  private migrateFile(sessionId: string, path: string): Promise<boolean> {
    return this.enqueue(sessionId, async () => {
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch {
        return false
      }
      const lines = completeLines(text)
      const converted: string[] = []
      const state: { previous: TreeState | undefined } = { previous: undefined }
      let changed = false
      for (const line of lines) {
        if (isV3Line(line) || (!isV2Line(line) && legacyRecordOf(line) === undefined)) {
          // Passing v3 lines through ensureV3Line is what advances the chain
          // state so later lines can delta onto them.
          converted.push(await this.ensureV3Line(line, state))
          continue
        }
        const upgraded = await this.ensureV3Line(line, state)
        changed = changed || upgraded !== line
        converted.push(upgraded)
      }
      if (!changed) return false
      await this.atomicWriteText(path, converted.join('\n') + (converted.length > 0 ? '\n' : ''))
      this.invalidateCaches(sessionId)
      return true
    })
  }
}