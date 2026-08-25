/**
 * The client data plane: same-origin fetch against the Host half's read API,
 * with light polling while the session is running.
 */

import type { CallIndexResponse, CallRecord } from '../shared/types'

const PREFIX = '/dsh-request-log'

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } })
  if (!response.ok) {
    throw new ApiError(response.status, 'HTTP ' + String(response.status))
  }
  return await response.json() as T
}

export function fetchHealth(): Promise<{ ok: true; version: string }> {
  return getJson(PREFIX + '/health')
}

export function fetchCalls(sessionId: string, limit: number, offset: number): Promise<CallIndexResponse> {
  const path = PREFIX + '/sessions/' + encodeURIComponent(sessionId) + '/calls?limit=' + String(limit) + '&offset=' + String(offset)
  return getJson(path)
}

export function fetchCall(sessionId: string, callId: string): Promise<CallRecord> {
  const path = PREFIX + '/sessions/' + encodeURIComponent(sessionId) + '/calls/' + encodeURIComponent(callId)
  return getJson(path)
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
 * Tokens-per-second over a millisecond span. A stream phase shorter than
 * STREAM_FLOOR_MS is not measurable: some adapters flush the whole response
 * at once (buffered SSE / post-reasoning body), and dividing by ~0ms yields
 * absurd rates — those show '\u2013' instead of a misleading number.
 */
export const STREAM_FLOOR_MS = 200

export function formatTokPerSec(tokens: number | undefined, ms: number | undefined): string {
  if (tokens === undefined || ms === undefined || ms < STREAM_FLOOR_MS) return '\u2013'
  const rate = tokens / (ms / 1000)
  if (rate >= 100) return rate.toFixed(0) + ' t/s'
  if (rate >= 10) return rate.toFixed(1) + ' t/s'
  return rate.toFixed(2) + ' t/s'
}

/** Percentage (0–100) with one decimal; '\u2013' when the base is zero/unknown. */
export function formatPct(part: number | undefined, base: number | undefined): string {
  if (part === undefined || base === undefined || base <= 0) return '\u2013'
  return ((part / base) * 100).toFixed(1) + '%'
}