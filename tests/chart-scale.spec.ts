/**
 * Pure geometry specs: nice ticks, gap-run splitting, LTTB extremes,
 * nearest-index snapping, NaN-safe linear mapping.
 */

import { describe, expect, it } from 'vitest'
import {
  extentOf,
  intTicks,
  linear,
  lttbDecimate,
  nearestIndex,
  niceCeil,
  niceTicks,
  padDomain,
  splitRuns,
  timeTicks,
} from '../src/client/chart-scale'

const pt = (x: number, y: number | null) => ({ x, y })

describe('niceCeil', () => {
  it('snaps to the 1/2/5 grid', () => {
    expect(niceCeil(0.3)).toBe(0.5)
    expect(niceCeil(1)).toBe(1)
    expect(niceCeil(2.1)).toBe(5)
    expect(niceCeil(6)).toBe(10)
    expect(niceCeil(9_999)).toBe(10_000)
    expect(niceCeil(0)).toBe(1)
    expect(niceCeil(-5)).toBe(1)
    expect(niceCeil(Number.NaN)).toBe(1)
  })
})

describe('niceTicks', () => {
  it('covers the domain with ascending multiples of one step', () => {
    const ticks = niceTicks(0, 100, 5)
    expect(ticks[0]).toBeLessThanOrEqual(0)
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(100)
    expect(ticks).toEqual([...new Set(ticks)].sort((a, b) => a - b))
    const diffs = ticks.slice(1).map((v, i) => v - ticks[i]!)
    for (const diff of diffs) expect(Math.abs(diff - diffs[0]!)).toBeLessThan(1e-9)
  })
  it('is monotonic and tidy across random domains', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const lo = Math.sin(seed) * 5000
      const hi = lo + Math.abs(Math.cos(seed)) * 9000 + 1
      const ticks = niceTicks(lo, hi, 4 + (seed % 4))
      expect(ticks.length).toBeGreaterThanOrEqual(2)
      for (let i = 1; i < ticks.length; i += 1) expect(ticks[i]!).toBeGreaterThan(ticks[i - 1]!)
      expect(ticks[0]!).toBeLessThanOrEqual(lo + 1e-9)
      expect(ticks[ticks.length - 1]!).toBeGreaterThanOrEqual(hi - 1e-9)
    }
  })
})

describe('intTicks / timeTicks', () => {
  it('gives every step while the span is small', () => {
    expect(intTicks(1, 4)).toEqual([1, 2, 3, 4])
  })
  it('falls back to nice integer intervals later', () => {
    const ticks = intTicks(0, 100, 8)
    expect(ticks.length).toBeGreaterThan(1)
    for (const tick of ticks) expect(Number.isInteger(tick)).toBe(true)
  })
  it('paces long spans onto second-family cadences', () => {
    const t0 = Date.UTC(2025, 0, 1, 12, 0, 0)
    const ticks = timeTicks(t0, t0 + 30 * 60_000)
    expect(ticks.length).toBeGreaterThanOrEqual(2)
    expect(ticks.length).toBeLessThanOrEqual(7)
    expect((ticks[1]! - ticks[0]!) % 60_000).toBe(0)
  })

  it('anchors ticks to LOCAL wall-clock boundaries, not UTC epoch multiples', () => {
    // A three-day span ticks daily. Epoch-multiple alignment would land these
    // on UTC midnight — 08:00 for a UTC+8 reader — labelling a "day" boundary
    // in the middle of a working morning.
    const start = new Date(2025, 0, 1, 9, 30, 0).getTime()
    const ticks = timeTicks(start, start + 6 * 86_400_000)
    expect(ticks.length).toBeGreaterThanOrEqual(2)
    for (const tick of ticks) {
      const at = new Date(tick)
      expect(at.getHours()).toBe(0)
      expect(at.getMinutes()).toBe(0)
    }
  })

  it('anchors a half-day cadence on local midnight and local noon', () => {
    const start = new Date(2025, 0, 1, 9, 30, 0).getTime()
    for (const tick of timeTicks(start, start + 3 * 86_400_000)) {
      const at = new Date(tick)
      expect([0, 12]).toContain(at.getHours())
      expect(at.getMinutes()).toBe(0)
    }
  })

  it('anchors an hourly cadence on the local hour', () => {
    const start = new Date(2025, 0, 1, 9, 37, 12).getTime()
    const ticks = timeTicks(start, start + 6 * 3_600_000)
    for (const tick of ticks) {
      const at = new Date(tick)
      expect(at.getMinutes()).toBe(0)
      expect(at.getSeconds()).toBe(0)
    }
  })

  it('resolves a burst that lasts seconds instead of collapsing to one tick', () => {
    // Ten calls inside 20s is a real shape on a time axis; a 10s floor gave
    // such a span two ticks and no readable structure.
    const start = new Date(2025, 0, 1, 9, 0, 0).getTime()
    const ticks = timeTicks(start, start + 20_000)
    expect(ticks.length).toBeGreaterThanOrEqual(3)
    expect(ticks.length).toBeLessThanOrEqual(7)
  })

  it('keeps every tick inside the requested span', () => {
    const start = new Date(2025, 5, 10, 14, 3, 7).getTime()
    const end = start + 47 * 60_000
    for (const tick of timeTicks(start, end)) {
      expect(tick).toBeGreaterThanOrEqual(start)
      expect(tick).toBeLessThanOrEqual(end)
    }
  })
})

describe('extentOf', () => {
  it('ignores nulls and non-finite values', () => {
    expect(extentOf([[pt(0, null), pt(1, 5), pt(2, Number.NaN), pt(3, 9)]])).toEqual([5, 9])
    expect(extentOf([[pt(0, null)]])).toBeNull()
    expect(extentOf([])).toBeNull()
  })
})

describe('splitRuns', () => {
  it('splits at gaps and keeps isolated points as runs', () => {
    const runs = splitRuns([pt(0, 1), pt(1, 2), pt(2, null), pt(3, null), pt(4, 5), pt(5, null), pt(6, 7)])
    expect(runs).toEqual([[pt(0, 1), pt(1, 2)], [pt(4, 5)], [pt(6, 7)]])
  })
  it('handles leading/trailing nulls and all-null input', () => {
    expect(splitRuns([pt(0, null), pt(1, 1), pt(2, null)])).toEqual([[pt(1, 1)]])
    expect(splitRuns([pt(0, null), pt(1, null)])).toEqual([])
  })
})

describe('lttbDecimate', () => {
  it('keeps endpoints and global extremes of a spiked series', () => {
    const points = Array.from({ length: 400 }, (_, i) =>
      pt(i, 10 + Math.sin(i / 20) * 3))
    points[213] = pt(213, 90)
    points[350] = pt(350, 0.5)
    const out = lttbDecimate(points, 60)
    expect(out.length).toBeLessThanOrEqual(64)
    expect(out.some(p => p.y !== null && p.y >= 89)).toBe(true)
    expect(out.some(p => p.y !== null && p.y <= 1)).toBe(true)
    expect(out[0]!.x).toBe(0)
    expect(out[out.length - 1]!.x).toBe(399)
  })
  it('passes short inputs through unchanged', () => {
    const points = [pt(0, 1), pt(1, 2)]
    expect(lttbDecimate(points, 60)).toEqual(points)
  })
})

describe('nearestIndex', () => {
  it('snaps to the closer neighbor across the midpoint', () => {
    expect(nearestIndex([1, 3, 5], 3.9)).toBe(1)
    expect(nearestIndex([1, 3, 5], 4.1)).toBe(2)
    expect(nearestIndex([10], 0)).toBe(0)
    expect(nearestIndex([], 5)).toBe(-1)
  })
})

describe('linear', () => {
  it('maps linearly and propagates non-finite input', () => {
    const map = linear([0, 10], [100, 200])
    expect(map(5)).toBe(150)
    expect(map(Number.NaN)).toBeNaN()
    expect(map(Infinity)).toBeNaN()
  })
  it('centers a degenerate domain at the range midpoint', () => {
    const map = linear([3, 3], [0, 100])
    expect(map(3)).toBe(50)
    expect(map(4)).toBeNaN()
  })
})

describe('padDomain', () => {
  it('spans a single point symmetrically', () => {
    expect(padDomain(7, 7, 'span')).toEqual([6.5, 7.5])
  })
  it('doubles a flat value for air', () => {
    expect(padDomain(40, 40, 'flat')).toEqual([0, 80])
    expect(padDomain(0, 0, 'flat')).toEqual([0, 1])
  })
})
