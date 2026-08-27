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
 * Logical bytes = envelope line bytes + Σ refs[].z over kept envelopes,
 * counted once per referencing envelope (a documented upper bound when
 * blobs are shared). For pure-v1 files the measure degenerates to physical
 * bytes.
 *
 * V2 format (DESIGN-v2-persistence.md): each fresh line is a small
 * envelope `{"v":2,...}` carrying inline scalars plus `refs[]` — sha256
 * references into the global content-addressed object store under
 * `<dir>/objects/<2hex>/<sha256>.drl`. Blobs are uploaded INSIDE the same
 * serialized chain BEFORE the envelope line lands, so a persisted line
 * references only already-renamed objects. V1 lines stay first-class:
 * `entryOfLine` branches on a leading peek, and every trim/sweep rewrite
 * converts surviving lines to v2 (lazy migration riding the trims).
 * `format: 'v1'` freezes the legacy behavior byte-for-byte.
 *
 * Retention: files older than `retentionDays` are deleted on boot and on a
 * daily sweep; oversized ones trimmed to the newest records. The sweep also
 * runs the mark-sweep GC over the object store (reachable hashes extracted
 * from the live files it reads anyway; unreachable objects past a grace
 * floor reclaimed, tmp debris always) and migrates not-yet-v2 files
 * newest-first up to a per-cycle byte budget. All IO is fail-soft — a
 * store error never breaks a model call.
 *
 * @module dsh-request-log/host/store
 */

import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CallEnvelope, CallEnvelopeV3, CallIndexEntry, CallIndexResponse, CallRecord, RecordedMessage, RecordedRequest, RecordedResponse } from '../shared/types'
import { RECORD_SCHEMA, RECORD_SCHEMA_V2, RECORD_SCHEMA_V3, entryFromEnvelope, envelopeSumOf, toIndexEntry } from '../shared/types'
import { BlobStore, hashOfContent } from './blob'
import { type TreeEntry, type TreeState, chooseTreeNode, decodeTree, encodeTree, resolveTree } from './tree'

export interface StoreConfig {
  /** Root directory holding the per-session JSONL files. */
  directory: string
  /** Delete session files whose last write is older than this many days. */
  retentionDays: number
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
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Default per-cycle migration budget: a ~700 MB backlog converts in under a fortnight. */
export const DEFAULT_MIGRATION_BUDGET_BYTES = 64 * 1024 * 1024

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
export type SweepPhase = 'retention' | 'gc' | 'migration' | 'done'

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

/** Slice file text down to its complete lines (torn tail dropped). */
function completeLines(text: string): string[] {
  const end = text.endsWith('\n') ? text.length : Math.max(text.lastIndexOf('\n') + 1, 0)
  const lines = text.slice(0, end).split('\n')
  while (lines.length > 0 && lines[lines.length - 1].length === 0) lines.pop()
  return lines
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

/**
 * Logical bytes one KEPT line attributes to its session: the line itself plus
 * its referenced compressed sizes (once per referencing envelope). Legacy
 * lines attribute their raw size.
 */
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
  try {
    const env = JSON.parse(line) as { refs?: { z?: unknown }[] }
    let total = physical
    if (Array.isArray(env.refs)) {
      for (const ref of env.refs) {
        if (ref !== null && typeof ref === 'object' && typeof ref.z === 'number') total += ref.z
      }
    }
    return total
  } catch {
    return physical
  }
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
  private mkdirPromise: Promise<void> | undefined
  private sweepStatus: SweepStatus | undefined
  /** Error sink of the in-flight sweep cycle (absent outside a sweep). */
  private sweepErrorSink: ((stage: string, error: unknown) => void) | undefined

  constructor(private readonly config: StoreConfig, blobStore?: BlobStore) {
    this.blobs = blobStore ?? new BlobStore({ directory: join(config.directory, 'objects') })
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

  private pathOf(sessionId: string): string {
    return join(this.config.directory, fileNameOf(sessionId))
  }

  /** Create the root directory once; a failed attempt is retried on the next append. */
  private ensureDirectory(): Promise<void> {
    if (this.mkdirPromise === undefined) {
      this.mkdirPromise = mkdir(this.config.directory, { recursive: true }).then(
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
    await writeFile(temp, text, 'utf8')
    await rename(temp, path)
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
    await appendFile(path, line, 'utf8')
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

  private async readAll(sessionId: string): Promise<{ entries: CallIndexEntry[]; parsedBytes: number }> {
    let text: string
    try {
      text = await readFile(this.pathOf(sessionId), 'utf8')
    } catch {
      return { entries: [], parsedBytes: 0 }
    }
    // Only complete lines count: a torn trailing write (no newline) is left
    // for a later pass so its completed form is parsed then.
    const completeEnd = text.endsWith('\n') ? text.length : Math.max(text.lastIndexOf('\n') + 1, 0)
    const complete = text.slice(0, completeEnd)
    const entries: CallIndexEntry[] = []
    for (const line of complete.split('\n')) {
      const entry = entryOfLine(line)
      if (entry !== undefined) entries.push(entry)
    }
    return { entries, parsedBytes: Buffer.byteLength(complete, 'utf8') }
  }

  /**
   * Parse only the bytes appended past `fromByte` (a prior pass's parsed
   * extent). A trailing chunk without its newline is a torn write — it stays
   * unparsed so the next pass retries it once complete. Returns null when the
   * file shrank or the offset no longer sits on a line boundary (a trim
   * rewrote the file): callers fall back to a full re-read.
   */
  private async readTail(sessionId: string, fromByte: number): Promise<{ entries: CallIndexEntry[]; parsedBytes: number } | null> {
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
        const entries: CallIndexEntry[] = []
        for (const line of complete.split('\n')) {
          const entry = entryOfLine(line)
          if (entry !== undefined) entries.push(entry)
        }
        return { entries, parsedBytes: fromByte + Buffer.byteLength(complete, 'utf8') }
      }
      const entries: CallIndexEntry[] = []
      for (const line of text.split('\n')) {
        const entry = entryOfLine(line)
        if (entry !== undefined) entries.push(entry)
      }
      return { entries, parsedBytes: size }
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
  private async entriesOf(sessionId: string): Promise<CallIndexEntry[]> {
    let info
    try {
      info = await stat(this.pathOf(sessionId))
    } catch {
      this.indexCache.delete(sessionId)
      return []
    }
    const cached = this.indexCache.get(sessionId)
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return cached.entries
    }
    let entries: CallIndexEntry[]
    let parsedBytes: number
    if (cached !== undefined && info.size > cached.parsedBytes) {
      const tail = await this.readTail(sessionId, cached.parsedBytes)
      if (tail !== null) {
        entries = [...cached.entries, ...tail.entries]
        parsedBytes = tail.parsedBytes
      } else {
        const full = await this.readAll(sessionId)
        entries = full.entries
        parsedBytes = full.parsedBytes
      }
    } else {
      const full = await this.readAll(sessionId)
      entries = full.entries
      parsedBytes = full.parsedBytes
    }
    assignSteps(entries)
    if (this.indexCache.size >= 16 && !this.indexCache.has(sessionId)) {
      const oldest = this.indexCache.keys().next().value
      if (oldest !== undefined) this.indexCache.delete(oldest)
    }
    this.indexCache.set(sessionId, { mtimeMs: info.mtimeMs, size: info.size, entries, parsedBytes })
    return entries
  }

  /**
   * Newest-first index page for one session.
   */
  async listIndex(sessionId: string, limit: number, offset: number): Promise<CallIndexResponse> {
    const entries = await this.entriesOf(sessionId)
    const newestFirst = entries.slice().reverse()
    return {
      calls: newestFirst.slice(offset, offset + limit),
      total: entries.length,
      offset,
      limit,
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
   * sweeps unreachable objects past a grace floor plus tmp debris, and the
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
    }
    this.sweepStatus = status
    const swallowed = (stage: string, error: unknown): void => {
      status.error = `${stage}: ${error instanceof Error ? error.message : String(error)}`
    }
    this.sweepErrorSink = swallowed
    try {
      let names: string[]
      try {
        names = await readdir(this.config.directory)
      } catch (error) {
        swallowed('scan directory', error)
        return { deletedFiles: 0, trimmedFiles: 0, migratedFiles: 0 }
      }
      const cutoff = now - this.config.retentionDays * DAY_MS
      const reachable = new Set<string>()
      const treeRoots = new Set<string>()
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
          // The GC mark phase rides reads this sweep performs anyway.
          if (this.v2Enabled) {
            for (const match of text.matchAll(REACHABLE_HASH)) reachable.add(match[0])
            for (const match of text.matchAll(REACHABLE_TREE)) treeRoots.add(match[1])
          }
          const lines = text.split('\n')
          while (lines.length > 0 && lines[lines.length - 1].length === 0) lines.pop()
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
        }
      }
      if (this.v2Enabled) {
        status.phase = 'gc'
        try {
          await this.markTreeChains(treeRoots, reachable)
        } catch (error) {
          swallowed('tree mark', error)
        }
        try {
          const gc = await this.blobs.gc(reachable, now)
          status.removedObjects = gc.removedObjects
          status.removedTemp = gc.removedTemp
        } catch (error) {
          // GC is best-effort; missed objects get reclaimed next cycle.
          swallowed('object gc', error)
        }
        status.phase = 'migration'
        // Newest first: a fresh session has the most retention life ahead of it,
        // so converting it buys the most stored-byte-days - and the oldest files
        // may not survive to the next cycle anyway.
        migrationCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
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
            wanted = false
          }
          if (!wanted) continue
          status.migrationCandidates += 1
          try {
            if (await this.migrateFile(candidate.sessionId, candidate.path)) status.migratedFiles += 1
          } catch (error) {
            // A stubborn conversion retries on the next daily cycle.
            swallowed(`migrate ${candidate.sessionId}`, error)
          }
          spent += candidate.size
        }
      }
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