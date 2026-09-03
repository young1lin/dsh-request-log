/**
 * Formatting helpers: duration/token/rate/percentage branches and the
 * time formatters' undefined handling.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SPEED_CEILING_TPS,
  STREAM_FLOOR_MS,
  ApiError,
  fetchCall,
  fetchCalls,
  formatDateTime,
  formatAxisTime,
  formatBytes,
  formatDuration,
  formatPct,
  formatTime,
  formatTps,
  formatToolDispatches,
  formatTokens,
  speedReading,
} from '../src/client/data.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

const DASH = '\u2013'

describe('fetch layer', () => {
  it('encodes session and call ids into the request path', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
      calls.push(String(input))
      return new Response(JSON.stringify({ calls: [], total: 0, offset: 0, limit: 0 }), { status: 200 })
    })
    await fetchCalls('a b/c', 10, 5)
    await fetchCall('x y', 'id/1')
    expect(calls).toEqual([
      '/dsh-request-log/sessions/a%20b%2Fc/calls?limit=10&offset=5',
      '/dsh-request-log/sessions/x%20y/calls/id%2F1',
    ])
  })

  it('raises ApiError with the HTTP status and parses success bodies', async () => {
    vi.stubGlobal('fetch', async (): Promise<Response> => new Response('nope', { status: 503 }))
    const error = (await fetchCalls('s', 1, 0).catch(cause => cause as ApiError)) as ApiError
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(503)
    expect(error.message).toBe('HTTP 503')

    vi.stubGlobal('fetch', async (): Promise<Response> =>
      new Response(JSON.stringify({ id: 'c1' }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const record = await fetchCall('s', 'c1')
    expect(record.id).toBe('c1')
  })
})

describe('formatDuration', () => {
  it('renders sub-second as rounded milliseconds', () => {
    expect(formatDuration(950)).toBe('950ms')
    expect(formatDuration(0)).toBe('0ms')
  })
  it('renders seconds with two decimals under 10s and one under 60s', () => {
    expect(formatDuration(1_500)).toBe('1.50s')
    expect(formatDuration(15_000)).toBe('15.0s')
  })
  it('renders minutes and seconds above a minute', () => {
    expect(formatDuration(60_000)).toBe('1m0s')
    expect(formatDuration(125_000)).toBe('2m5s')
  })
  it('dashes when unknown', () => {
    expect(formatDuration(undefined)).toBe(DASH)
  })
})

describe('formatTokens', () => {
  it('keeps small counts plain', () => {
    expect(formatTokens(9_999)).toBe('9999')
    expect(formatTokens(0)).toBe('0')
  })
  it('compacts to k and M', () => {
    expect(formatTokens(10_000)).toBe('10.0k')
    expect(formatTokens(1_500_000)).toBe('1.50M')
  })
  it('dashes when unknown', () => {
    expect(formatTokens(undefined)).toBe(DASH)
  })
})

describe('speedReading', () => {
  it('is exact over the stream phase while measurable and plausible', () => {
    // stream = 2_000 − 500 = 1_500ms ≥ floor → 300 ÷ 1.5s = 200 t/s.
    expect(speedReading(300, 2_000, 500)).toEqual({ tokensPerSecond: 200, approx: false })
    // Boundary rates stay exact at the ceiling itself.
    expect(speedReading(SPEED_CEILING_TPS, 1_200, 200)).toEqual({ tokensPerSecond: SPEED_CEILING_TPS, approx: false })
    // A missing ttfb cannot carve out a phase at all.
    expect(speedReading(300, 2_000, undefined)).toEqual({ tokensPerSecond: 150, approx: true })
  })
  it('falls back to the whole call below the stream floor, marked approx', () => {
    // stream = floor − 1 < 200ms: output ÷ total, TTFT included (≈).
    const streamMs = STREAM_FLOOR_MS - 1
    expect(speedReading(99, 1_000, 1_000 - streamMs)).toEqual({ tokensPerSecond: 99, approx: true })
  })
  it('downgrades implausibly fast exact-phase rates to the whole call', () => {
    // stream = 300ms (above the floor) carrying 3_000 tokens = 10_000 t/s —
    // over the ceiling, so the coarse-flush phase counts as unmeasured.
    expect(speedReading(3_000, 2_000, 1_700)).toEqual({ tokensPerSecond: 1_500, approx: true })
  })
  it('yields null for unknown output or a non-positive duration', () => {
    expect(speedReading(undefined, 1_000, 10)).toBeNull()
    expect(speedReading(100, undefined, 10)).toBeNull()
    expect(speedReading(100, 0, 0)).toBeNull()
  })
  it('keeps a zero-token stream as exact zero data, not a gap', () => {
    expect(speedReading(0, 2_000, 500)).toEqual({ tokensPerSecond: 0, approx: false })
  })
})

describe('formatTps', () => {
  it('dashes for non-finite rates', () => {
    expect(formatTps(Number.NaN)).toBe(DASH)
  })
  it('scales precision with magnitude', () => {
    expect(formatTps(100)).toBe('100 t/s')
    expect(formatTps(15)).toBe('15.0 t/s')
    expect(formatTps(1.5)).toBe('1.50 t/s')
  })
})

describe('formatPct', () => {
  it('dashes for unknown or zero bases', () => {
    expect(formatPct(undefined, 100)).toBe(DASH)
    expect(formatPct(10, undefined)).toBe(DASH)
    expect(formatPct(10, 0)).toBe(DASH)
  })
  it('renders one decimal', () => {
    expect(formatPct(25, 100)).toBe('25.0%')
    expect(formatPct(1, 3)).toBe('33.3%')
  })
})

describe('formatTime / formatDateTime', () => {
  it('renders local HH:MM:SS', () => {
    const ms = 1_700_000_000_000
    const date = new Date(ms)
    const pad = (n: number): string => String(n).padStart(2, '0')
    const expected = pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    expect(formatTime(ms)).toBe(expected)
  })
  it('renders the full local date-time', () => {
    const ms = 1_700_000_000_000
    expect(formatDateTime(ms)).toBe(new Date(ms).toLocaleString())
  })
  it('dashes when unknown', () => {
    expect(formatTime(undefined)).toBe(DASH)
    expect(formatDateTime(undefined)).toBe(DASH)
  })
})

describe('formatToolDispatches', () => {
  it('renders empty for undefined or empty input', () => {
    expect(formatToolDispatches(undefined)).toBe('')
    expect(formatToolDispatches([])).toBe('')
  })
  it('renders single calls bare and repeats with a multiplier', () => {
    expect(formatToolDispatches([{ name: 'read', count: 1 }])).toBe('read')
    expect(formatToolDispatches([{ name: 'read', count: 1 }, { name: 'pwsh', count: 2 }])).toBe('read · pwsh ×2')
  })
})

describe('formatBytes', () => {
  it('scales from bytes through MB, keeping small figures exact', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(812)).toBe('812 B')
    // A round KiB reads as 1.0 KB, never as 1024 B.
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(390 * 1024)).toBe('390.0 KB')
    expect(formatBytes(3_000_000)).toBe('2.86 MB')
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.00 GB')
  })

  it('renders an absent figure as a dash rather than 0 B', () => {
    // 0 B is a claim (nothing stored); undefined is an absence (old server).
    expect(formatBytes(undefined)).toBe(DASH)
  })
})

describe('formatAxisTime', () => {
  const at = (mo: number, d: number, h: number, mi: number) => new Date(2025, mo, d, h, mi).getTime()

  it('reads as a clock within one day', () => {
    expect(formatAxisTime(at(0, 1, 9, 5), false)).toBe('09:05')
    expect(formatAxisTime(at(0, 1, 17, 44), false)).toBe('17:44')
  })

  it('carries the date once the span crosses one', () => {
    // Several real sessions run across a week: bare HH:MM would repeat 09:00
    // four times down the axis with nothing to tell the days apart.
    expect(formatAxisTime(at(8, 3, 9, 0), true)).toBe('09-03 09:00')
  })

  it('renders an absent time as a dash', () => {
    expect(formatAxisTime(undefined, false)).toBe(DASH)
  })
})
