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
 * Retention: files older than `retentionDays` are deleted on boot and on a
 * daily sweep; each file is trimmed to the newest `maxCallsPerSession` lines
 * (counted raw — no JSON parse) when it exceeds the cap. All IO is fail-soft
 * — a store error never breaks a model call.
 *
 * @module dsh-request-log/host/store
 */

import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CallIndexEntry, CallIndexResponse, CallRecord } from '../shared/types'
import { RECORD_SCHEMA, toIndexEntry } from '../shared/types'

export interface StoreConfig {
  /** Root directory holding the per-session JSONL files. */
  directory: string
  /** Delete session files whose last write is older than this many days. */
  retentionDays: number
  /** Per-session cap on kept call records (newest kept). */
  maxCallsPerSession: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Cached projected index for one session file, valid while (mtime, size) hold. */
interface IndexCacheEntry {
  mtimeMs: number
  size: number
  /** Chronological (file order) index entries. */
  entries: CallIndexEntry[]
}

/** Sanitize a session id into one safe path segment (ids are uuid-like already). */
function fileNameOf(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_')
  return `${safe}.jsonl`
}

/** Parse one JSONL line into a record of the schema this build understands. */
function parseLine(line: string): CallRecord | undefined {
  if (line.length === 0) return undefined
  try {
    const value = JSON.parse(line) as CallRecord
    if (value.schema !== RECORD_SCHEMA) return undefined
    return value
  } catch {
    return undefined
  }
}

export class CallStore {
  /** Bounded index cache: insertion-order eviction is enough (poll locality). */
  private readonly indexCache = new Map<string, IndexCacheEntry>()
  private mkdirPromise: Promise<void> | undefined

  constructor(private readonly config: StoreConfig) {}

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

  /** Append one settled attempt to its session file, creating the directory. */
  async append(record: CallRecord): Promise<void> {
    await this.ensureDirectory()
    await appendFile(this.pathOf(record.sessionId), `${JSON.stringify(record)}\n`, 'utf8')
  }

  private async readAll(sessionId: string): Promise<CallRecord[]> {
    let text: string
    try {
      text = await readFile(this.pathOf(sessionId), 'utf8')
    } catch {
      return []
    }
    const records: CallRecord[] = []
    for (const line of text.split('\n')) {
      const record = parseLine(line)
      if (record !== undefined) records.push(record)
    }
    return records
  }

  /**
   * Chronological index entries for one session, served from the (mtime, size)
   * cache when the file is unchanged since the last projection.
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
    const entries = (await this.readAll(sessionId)).map(toIndexEntry)
    if (this.indexCache.size >= 16 && !this.indexCache.has(sessionId)) {
      const oldest = this.indexCache.keys().next().value
      if (oldest !== undefined) this.indexCache.delete(oldest)
    }
    this.indexCache.set(sessionId, { mtimeMs: info.mtimeMs, size: info.size, entries })
    return entries
  }

  /**
   * Newest-first index page for one session.
   * @param sessionId - owning session (`_` for unattributed calls).
   * @param limit - page size.
   * @param offset - rows to skip from the newest end.
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
    // Serialized ids sit in every record's second-ish field: a substring
    // prefilter skips JSON.parse for all non-matching lines.
    const needle = `"id":${JSON.stringify(callId)}`
    for (const line of text.split('\n')) {
      if (line.length === 0 || !line.includes(needle)) continue
      const record = parseLine(line)
      if (record !== undefined && record.id === callId) return record
    }
    return undefined
  }

  /**
   * Enforce retention: delete stale session files, trim oversized ones.
   * Returns the disposal counts (for the health log).
   */
  async sweep(now: number = Date.now()): Promise<{ deletedFiles: number; trimmedFiles: number }> {
    let deletedFiles = 0
    let trimmedFiles = 0
    let names: string[]
    try {
      names = await readdir(this.config.directory)
    } catch {
      return { deletedFiles, trimmedFiles }
    }
    const cutoff = now - this.config.retentionDays * DAY_MS
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const path = join(this.config.directory, name)
      const sessionId = name.replace(/\.jsonl$/, '')
      try {
        const info = await stat(path)
        if (info.mtimeMs < cutoff) {
          await rm(path)
          this.indexCache.delete(sessionId)
          deletedFiles += 1
          continue
        }
        // Line counting needs no parsing: the cap is about file growth, and
        // invalid lines are filtered by the read path regardless.
        const text = await readFile(path, 'utf8')
        const lines = text.split('\n')
        while (lines.length > 0 && lines[lines.length - 1].length === 0) lines.pop()
        if (lines.length > this.config.maxCallsPerSession) {
          const kept = lines.slice(lines.length - this.config.maxCallsPerSession)
          const temp = `${path}.tmp`
          await writeFile(temp, kept.join('\n') + '\n', 'utf8')
          await rename(temp, path)
          this.indexCache.delete(sessionId)
          trimmedFiles += 1
        }
      } catch {
        // One unreadable file never blocks the sweep of the others.
      }
    }
    return { deletedFiles, trimmedFiles }
  }
}
