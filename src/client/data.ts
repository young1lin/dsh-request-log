/**
 * The client data plane: same-origin fetch against the Host half's read API,
 * with light polling while the session is running.
 */

import type { CallIndexResponse, CallRecord, ToolDispatch } from '../shared/types'

const PREFIX = '/dsh-request-log'

/** Render a dispatch breakdown for tooltips: `pwsh ×2 · read`; empty input renders ''. */
export function formatToolDispatches(dispatches: ToolDispatch[] | undefined): string {
  if (dispatches === undefined || dispatches.length === 0) return ''
  return dispatches.map(({ name, count }) => count === 1 ? name : name + ' ×' + String(count)).join(' · ')
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' }, ...signal === undefined ? {} : { signal } })
  if (!response.ok) {
    throw new ApiError(response.status, 'HTTP ' + String(response.status))
  }
  return await response.json() as T
}

export function fetchCalls(sessionId: string, limit: number, offset: number, signal?: AbortSignal): Promise<CallIndexResponse> {
  const path = PREFIX + '/sessions/' + encodeURIComponent(sessionId) + '/calls?limit=' + String(limit) + '&offset=' + String(offset)
  return getJson(path, signal)
}

export function fetchCall(sessionId: string, callId: string, signal?: AbortSignal): Promise<CallRecord> {
  const path = PREFIX + '/sessions/' + encodeURIComponent(sessionId) + '/calls/' + encodeURIComponent(callId)
  return getJson(path, signal)
}

/** Format an epoch-milliseconds timestamp as a local HH:MM:SS string. */
export function formatTime(ms: number | undefined): string {
  if (ms === undefined) return '\u2013'
  const date = new Date(ms)
  const pad = (n: number): string => (n < 10 ? '0' + String(n) : String(n))
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
}

/**
 * Full local date-time (tooltip / detail view — unambiguous across days).
 * Fixed shape rather than toLocaleString(): the ledger renders HH:MM:SS and
 * the chart axis MM-DD HH:MM, so a locale-shaped '2026/9/3 16:00:04' made
 * three unrelated renderings of one instant. Same separators, same order,
 * same local zone — the three now read as one family, longest to shortest.
 */
export function formatDateTime(ms: number | undefined): string {
  if (ms === undefined) return '\u2013'
  const date = new Date(ms)
  const pad = (n: number): string => (n < 10 ? '0' + String(n) : String(n))
  return String(date.getFullYear()) + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
}

/**
 * Three significant figures — the precision every reading in this UI settles
 * on. formatDuration and formatTps already spelled this ladder out inline
 * (5.44s / 16.3s / 103 t/s); formatTokens, formatBytes and formatPct had
 * drifted off it in both directions, printing 1000.0k, 856.07 MB and 100.0%.
 * One helper, so the rule cannot drift again.
 */
function sig3(n: number): string {
  if (n >= 100) return n.toFixed(0)
  if (n >= 10) return n.toFixed(1)
  return n.toFixed(2)
}

/** Format a duration in milliseconds: sub-second stays ms, seconds get two decimals under 10s. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '\u2013'
  if (ms < 1000) return String(Math.round(ms)) + 'ms'
  if (ms < 10_000) return (ms / 1000).toFixed(2) + 's'
  if (ms < 60_000) return (ms / 1000).toFixed(1) + 's'
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return String(minutes) + 'm' + String(seconds) + 's'
}

/**
 * Compact token count. Exact below 10k (a ledger column wants the real number
 * there), then three significant figures per rung. A mantissa that ROUNDS up
 * past its own unit is promoted rather than printed: 999_999 is 999.999k,
 * which would otherwise read back as the nonsense '1000.0k'.
 */
export function formatTokens(n: number | undefined): string {
  if (n === undefined) return '\u2013'
  if (n < 10_000) return String(n)
  const thousands = sig3(n / 1000)
  if (Number(thousands) < 1000) return thousands + 'k'
  return sig3(n / 1_000_000) + 'M'
}

/**
 * Split a formatted measure into its number and trailing unit, so the summary
 * strip can set `MB` smaller than the `2.86` it qualifies. Only a
 * SPACE-separated unit splits: formatTokens glues its suffix on ('311.9k'),
 * where the k is part of how the number reads and must not shrink.
 */
export function splitMeasure(text: string): { value: string; unit?: string } {
  const at = text.lastIndexOf(' ')
  if (at <= 0 || at === text.length - 1) return { value: text }
  return { value: text.slice(0, at), unit: text.slice(at + 1) }
}

/**
 * An x-axis label for the time-based chart axis. `HH:MM` reads as a clock
 * within a single day; once the plotted span crosses one, the date leads,
 * because a bare `09:00` repeated down a week-long axis names nothing.
 */
export function formatAxisTime(ms: number | undefined, withDate: boolean): string {
  if (ms === undefined) return '–'
  const at = new Date(ms)
  const pad = (n: number): string => (n < 10 ? '0' + String(n) : String(n))
  const clock = pad(at.getHours()) + ':' + pad(at.getMinutes())
  return withDate ? pad(at.getMonth() + 1) + '-' + pad(at.getDate()) + ' ' + clock : clock
}

/**
 * Format a byte count for the summary strip. Binary units (the store's caps
 * are powers of two), two significant decimals from MB up so a session's
 * figure moves visibly between polls instead of sitting on a rounded integer.
 *
 * `undefined` renders as a dash, never as `0 B`: a zero is a claim that
 * nothing was stored, while an absence means a server too old to report it.
 */
export function formatBytes(n: number | undefined): string {
  if (n === undefined) return '–'
  if (n < 1024) return String(n) + ' B'
  const kib = sig3(n / 1024)
  if (Number(kib) < 1024) return kib + ' KB'
  const mib = sig3(n / (1024 * 1024))
  if (Number(mib) < 1024) return mib + ' MB'
  return sig3(n / (1024 * 1024 * 1024)) + ' GB'
}

/**
 * A stream phase shorter than STREAM_FLOOR_MS is not measurable: some
 * adapters flush the whole response at once (buffered SSE / post-reasoning
 * body), and dividing by ~0ms yields absurd rates.
 */
export const STREAM_FLOOR_MS = 200

/**
 * No real provider decodes this fast. An exact-phase rate above the ceiling
 * means the "stream" was a few coarse flushes (multi-chunk buffering), not
 * incremental decode — the phase counts as unmeasured and the reading falls
 * back to the whole call.
 */
export const SPEED_CEILING_TPS = 500

/** One call's output speed; `approx` marks the whole-call fallback (≈). */
export interface SpeedReading {
  tokensPerSecond: number
  approx: boolean
}

/**
 * Output speed of one call from its timing pair (durationMs = whole call,
 * ttfbMs = first chunk). Exact = output ÷ stream phase (TTFT excluded) while
 * that phase runs at least STREAM_FLOOR_MS AND the rate stays at or under
 * SPEED_CEILING_TPS; otherwise output ÷ whole call, marked approximate — for
 * a buffered flush the wait WAS the generation, so the whole-call rate is
 * the honest estimate rather than a fabricated precision.
 * Unreported output or a non-positive duration yields null.
 */
export function speedReading(
  outputTokens: number | undefined,
  durationMs: number | undefined,
  ttfbMs: number | undefined,
): SpeedReading | null {
  if (outputTokens === undefined || durationMs === undefined || durationMs <= 0) return null
  if (ttfbMs !== undefined) {
    const streamMs = durationMs - ttfbMs
    if (streamMs >= STREAM_FLOOR_MS) {
      const exact = outputTokens / (streamMs / 1000)
      if (exact <= SPEED_CEILING_TPS) return { tokensPerSecond: exact, approx: false }
    }
  }
  return { tokensPerSecond: outputTokens / (durationMs / 1000), approx: true }
}

/** Compact tokens-per-second text; precision scales with magnitude. */
export function formatTps(rate: number): string {
  if (!Number.isFinite(rate)) return '\u2013'
  return sig3(rate) + ' t/s'
}

/**
 * Percentage (0–100) at three significant figures; '\u2013' when the base is
 * zero/unknown. A flat one decimal claimed a fourth digit at the top of a
 * scale that only has three: a fully cached turn read '100.0%'.
 */
export function formatPct(part: number | undefined, base: number | undefined): string {
  if (part === undefined || base === undefined || base <= 0) return '\u2013'
  return sig3((part / base) * 100) + '%'
}