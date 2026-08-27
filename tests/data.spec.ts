/**
 * Formatting helpers: duration/token/rate/percentage branches and the
 * time formatters' undefined handling.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  STREAM_FLOOR_MS,
  ApiError,
  fetchCall,
  fetchCalls,
  formatDateTime,
  formatDuration,
  formatPct,
  formatTime,
  formatTokPerSec,
  formatToolDispatches,
  formatTokens,
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

describe('formatTokPerSec', () => {
  it('dashes for unknown inputs and unmeasurably short streams', () => {
    expect(formatTokPerSec(undefined, 1_000)).toBe(DASH)
    expect(formatTokPerSec(100, undefined)).toBe(DASH)
    expect(formatTokPerSec(100, STREAM_FLOOR_MS - 1)).toBe(DASH)
  })
  it('scales precision with magnitude', () => {
    expect(formatTokPerSec(100, 1_000)).toBe('100 t/s')
    expect(formatTokPerSec(15, 1_000)).toBe('15.0 t/s')
    expect(formatTokPerSec(1.5, 1_000)).toBe('1.50 t/s')
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
