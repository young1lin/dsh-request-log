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

/** Full local date-time (tooltip / detail view — unambiguous across days). */
export function formatDateTime(ms: number | undefined): string {
  if (ms === undefined) return '\u2013'
  return new Date(ms).toLocaleString()
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

/** Compact token count formatting. */
export function formatTokens(n: number | undefined): string {
  if (n === undefined) return '\u2013'
  if (n < 10_000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(1) + 'k'
  return (n / 1_000_000).toFixed(2) + 'M'
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
  if (rate >= 100) return rate.toFixed(0) + ' t/s'
  if (rate >= 10) return rate.toFixed(1) + ' t/s'
  return rate.toFixed(2) + ' t/s'
}

/** Percentage (0–100) with one decimal; '\u2013' when the base is zero/unknown. */
export function formatPct(part: number | undefined, base: number | undefined): string {
  if (part === undefined || base === undefined || base <= 0) return '\u2013'
  return ((part / base) * 100).toFixed(1) + '%'
}