/**
 * Per-session view memory — what lets the Requests tab come back to what the
 * reader was looking at.
 *
 * The host's conversation view ring renders ONLY the active tab
 * (renderSlot('conversation.view', ..., { only: active.id })): clicking Chat
 * unmounts this view — and every useState inside it — so a naive
 * implementation always reopens on the list. The pieces the reader expects to
 * find again therefore live HERE, outside the component, keyed by session id:
 *
 *   - selected  — the open call detail (with its chained-prev id, if known)
 *   - detail    — the reading position: request/response side + wire format
 *   - limit     — how many older calls "Load older" had paged in
 *   - auto      — the Auto-refresh toggle
 *
 * An in-page Map survives tab switches (the page itself stays alive); a
 * sessionStorage write-through additionally survives a page refresh. Both
 * layers are fail-soft — storage errors, quota, and corrupted payloads
 * degrade to defaults, never to a crash — and stored JSON is coerced field by
 * field, never trusted.
 *
 * @module dsh-request-log/client/persist
 */

import { WIRE_PROTOCOLS, type WireProtocol } from '../wire'

export type DetailSide = 'request' | 'response'

/** 'neutral' or one of the reconstructed wire protocols; null = auto-detect. */
export type DetailFormat = 'neutral' | WireProtocol

export interface DetailPrefs {
  side: DetailSide
  format: DetailFormat | null
}

/** The call whose detail view is open, plus its chained predecessor if known. */
export interface SelectedCall {
  id: string
  prevId?: string
  /** Conversation-loop step of this call (from the index), when it has one. */
  step?: number
}

export interface ViewMemory {
  selected: SelectedCall | null
  /** How many of the newest calls the ledger window covers. */
  limit: number
  auto: boolean
  detail: DetailPrefs
}

/** Ledger page size: how many of the newest calls a fresh view loads. */
export const PAGE_SIZE = 100

/** In-page sessions kept; the least recently touched fall off first. */
const MAX_MEMORY_SESSIONS = 8

const STORAGE_PREFIX = 'dsh-request-log:view:'
const VALID_FORMATS: readonly string[] = ['neutral', ...WIRE_PROTOCOLS.map(entry => entry.id)]

const memory = new Map<string, ViewMemory>()

export function freshViewMemory(): ViewMemory {
  return { selected: null, limit: PAGE_SIZE, auto: true, detail: { side: 'request', format: null } }
}

function sessionStorageOrNull(): Storage | null {
  try {
    if (typeof sessionStorage === 'undefined') return null
    return sessionStorage
  } catch {
    // Some embedded contexts throw on the global itself.
    return null
  }
}

function readRaw(sessionId: string): unknown {
  const store = sessionStorageOrNull()
  if (store === null) return null
  try {
    const text = store.getItem(STORAGE_PREFIX + sessionId)
    return text === null ? null : JSON.parse(text) as unknown
  } catch {
    // Corrupted payload — fall through to defaults.
    return null
  }
}

function writeRaw(sessionId: string, value: ViewMemory): void {
  const store = sessionStorageOrNull()
  if (store === null) return
  try {
    store.setItem(STORAGE_PREFIX + sessionId, JSON.stringify(value))
  } catch {
    // Quota / privacy mode — the in-page Map still holds the state.
  }
}

/** Narrowly coerce untrusted stored JSON; any invalid field falls back. */
function coerceMemory(raw: unknown): ViewMemory | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const detailRaw = record.detail
  const detail = typeof detailRaw === 'object' && detailRaw !== null
    ? detailRaw as Record<string, unknown>
    : {}
  const fresh = freshViewMemory()

  let selected: SelectedCall | null = null
  const selectedRaw = record.selected
  if (typeof selectedRaw === 'object' && selectedRaw !== null) {
    const candidate = selectedRaw as Record<string, unknown>
    if (typeof candidate.id === 'string' && candidate.id !== '') {
      selected = {
        id: candidate.id,
        ...typeof candidate.prevId === 'string' && candidate.prevId !== '' ? { prevId: candidate.prevId } : {},
      }
    }
  }

  const side: DetailSide =
    detail.side === 'response' ? 'response'
      : detail.side === 'request' ? 'request'
        : fresh.detail.side
  const formatRaw = detail.format
  const format: DetailFormat | null =
    formatRaw === null ? null
      : typeof formatRaw === 'string' && VALID_FORMATS.includes(formatRaw) ? formatRaw as DetailFormat
        : fresh.detail.format

  const limit = typeof record.limit === 'number' && Number.isInteger(record.limit)
    && record.limit >= fresh.limit && record.limit <= 1_000_000
    ? record.limit
    : fresh.limit

  return {
    selected,
    limit,
    auto: typeof record.auto === 'boolean' ? record.auto : fresh.auto,
    detail: { side, format },
  }
}

function ensureEntry(sessionId: string): ViewMemory {
  const cached = memory.get(sessionId)
  if (cached !== undefined) return cached
  const loaded = coerceMemory(readRaw(sessionId)) ?? freshViewMemory()
  memory.set(sessionId, loaded)
  return loaded
}

/** The session's remembered view state (a copy); defaults when nothing valid is stored. */
export function loadViewMemory(sessionId: string): ViewMemory {
  const entry = ensureEntry(sessionId)
  return {
    selected: entry.selected === null ? null : { ...entry.selected },
    limit: entry.limit,
    auto: entry.auto,
    detail: { ...entry.detail },
  }
}

/**
 * Merge a patch into the session's memory and write both layers through.
 * A detail patch replaces the prefs whole — both fields ride together.
 */
export function updateViewMemory(sessionId: string, patch: Partial<ViewMemory>): void {
  const entry = ensureEntry(sessionId)
  const next: ViewMemory = {
    selected: patch.selected !== undefined ? patch.selected : entry.selected,
    limit: patch.limit !== undefined ? patch.limit : entry.limit,
    auto: patch.auto !== undefined ? patch.auto : entry.auto,
    detail: patch.detail !== undefined ? patch.detail : entry.detail,
  }
  // Delete-then-set bumps the session to the most-recent end of the Map's
  // insertion order — the poor man's LRU the cap below trims from the front.
  memory.delete(sessionId)
  memory.set(sessionId, next)
  if (memory.size > MAX_MEMORY_SESSIONS) {
    const oldest = memory.keys().next()
    if (!oldest.done) memory.delete(oldest.value)
  }
  writeRaw(sessionId, next)
}

/**
 * Forget one session (or all): the next open starts from defaults. A
 * single-session clear removes ONLY that session's key — other sessions'
 * view memory survives.
 */
export function clearViewMemory(sessionId?: string): void {
  if (sessionId === undefined) {
    memory.clear()
  } else {
    memory.delete(sessionId)
  }
  const store = sessionStorageOrNull()
  if (store === null) return
  try {
    if (sessionId === undefined) {
      const doomed: string[] = []
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i)
        if (key !== null && key.startsWith(STORAGE_PREFIX)) doomed.push(key)
      }
      for (const key of doomed) store.removeItem(key)
    } else {
      store.removeItem(STORAGE_PREFIX + sessionId)
    }
  } catch {
    // Read-only storage — nothing to forget.
  }
}
