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
import type { MetricGroupKey, XMode } from './chart-stats'
import { BUCKET_MAX_MINUTES, BUCKET_MIN_MINUTES } from './chart-buckets'

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

/** 统计 panel reading position: open?, active metric group, x axis, window. */
export interface ChartsPrefs {
  open: boolean
  group: MetricGroupKey
  /**
   * Which x axis the panel draws: wall-clock time (the default — it answers
   * "when did I ask for what") or the numbered conversation step.
   */
  xMode: XMode
  /**
   * Width of one token column on the clock axis, in minutes. Token columns
   * there are per-window SUMS ("how much between 14:00 and 14:05"), so the
   * window is what the column measures; the other groups draw lines and never
   * read this.
   */
  bucketMinutes: number
}

export interface ViewMemory {
  selected: SelectedCall | null
  auto: boolean
  /** Model filter chip in force, or null for "all models". */
  model: string | null
  detail: DetailPrefs
  charts: ChartsPrefs
}

/**
 * The refresh probe's page: how many of the NEWEST calls a 3s poll re-reads
 * and splices in. The ledger itself loads the whole session — this is the
 * tail the poll has to look at to notice a new one, never a window the
 * reader can see the edge of.
 */
export const PAGE_SIZE = 100

/** In-page sessions kept; the least recently touched fall off first. */
const MAX_MEMORY_SESSIONS = 8

const STORAGE_PREFIX = 'dsh-request-log:view:'
const VALID_FORMATS: readonly string[] = ['neutral', ...WIRE_PROTOCOLS.map(entry => entry.id)]

const memory = new Map<string, ViewMemory>()

const VALID_GROUPS: readonly MetricGroupKey[] = ['hitrate', 'tokens', 'latency', 'speed']
const VALID_X_MODES: readonly XMode[] = ['time', 'step']

/** A stored window width, or the fallback when it is not a usable one. */
function coerceBucketMinutes(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isInteger(raw)
    && raw >= BUCKET_MIN_MINUTES && raw <= BUCKET_MAX_MINUTES
    ? raw
    : fallback
}

export function freshViewMemory(): ViewMemory {
  return {
    selected: null,
    auto: true,
    model: null,
    detail: { side: 'request', format: null },
    charts: { open: true, group: 'hitrate', xMode: 'time', bucketMinutes: 5 },
  }
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
        ...typeof candidate.step === 'number' && Number.isInteger(candidate.step) && candidate.step >= 1
          ? { step: candidate.step }
          : {},
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

  // An empty string is not the name of a model — it is what a cleared chip
  // would serialize to, and it must read back as "all".
  const model = typeof record.model === 'string' && record.model !== '' ? record.model : null

  const chartsRaw = typeof record.charts === 'object' && record.charts !== null
    ? record.charts as Record<string, unknown>
    : {}
  const groupRaw = chartsRaw.group
  const charts: ChartsPrefs = {
    open: typeof chartsRaw.open === 'boolean' ? chartsRaw.open : fresh.charts.open,
    group: VALID_GROUPS.includes(groupRaw as MetricGroupKey)
      ? groupRaw as MetricGroupKey
      : fresh.charts.group,
    // A memory written by <=0.1.4 can name the retired 'bucket' axis — the
    // by-window reading is now what the clock axis already does, so that
    // memory degrades to the default like any other unknown value, and the
    // retired toggles simply are not read.
    xMode: VALID_X_MODES.includes(chartsRaw.xMode as XMode)
      ? chartsRaw.xMode as XMode
      : fresh.charts.xMode,
    // Untrusted stored JSON: a window must be a whole number of minutes
    // inside the range the control offers, or it is not a window.
    bucketMinutes: coerceBucketMinutes(chartsRaw.bucketMinutes, fresh.charts.bucketMinutes),
  }

  return {
    selected,
    auto: typeof record.auto === 'boolean' ? record.auto : fresh.auto,
    model,
    detail: { side, format },
    charts,
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
    auto: entry.auto,
    model: entry.model,
    detail: { ...entry.detail },
    charts: { ...entry.charts },
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
    auto: patch.auto !== undefined ? patch.auto : entry.auto,
    model: patch.model !== undefined ? patch.model : entry.model,
    detail: patch.detail !== undefined ? patch.detail : entry.detail,
    charts:
      patch.charts !== undefined
        ? { ...entry.charts, ...patch.charts }
        : entry.charts,
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
