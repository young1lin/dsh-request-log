/**
 * Pure chart geometry: nice 1/2/5 tick scales, extents, gap-run splitting,
 * LTTB downsampling, nearest-index search, and a NaN-safe linear mapper.
 *
 * No DOM, no React, no formatters — everything here is plain math so vitest
 * exercises it directly under Node (see tests/chart-scale.spec.ts).
 *
 * @module dsh-request-log/client/chart-scale
 */

/** One plotted sample; `y === null` means "this slot has no value" (a gap). */
export interface XYPoint {
  x: number
  y: number | null
}

/** Smallest 1/2/5 × 10^k value ≥ `v` (`v <= 0` maps to 1). Axis tops anchor here. */
export function niceCeil(v: number): number {
  if (!(v > 0) || !Number.isFinite(v)) return 1
  const exp = Math.floor(Math.log10(v))
  const base = Math.pow(10, exp)
  const mantissa = v / base
  const nice = mantissa <= 1 ? 1 : mantissa <= 2 ? 2 : mantissa <= 5 ? 5 : 10
  return nice * base
}

/** Snap a candidate onto the 1/2/5 grid ×10^k at least as large as itself. */
function niceStep(step0: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(step0)))
  const norm = step0 / mag
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return mult * mag
}

/** Defeat binary float dust: 0.30000000000000004 ticks become 0.3. */
function tidy(v: number): number {
  const rounded = Math.round(v)
  return Math.abs(v - rounded) < 1e-9 ? rounded : Number(v.toPrecision(12))
}

/**
 * Ascending nice ticks COVERING `[lo, hi]`: steps drawn from {1,2,5}·10^k,
 * roughly `target` ticks; the first tick sits at or below `lo`, the last at
 * or above `hi` (an axis may always show a little context).
 */
export function niceTicks(lo: number, hi: number, target = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return []
  if (!(hi > lo)) return [tidy(lo)]
  const step = niceStep((hi - lo) / Math.max(1, target))
  const ticks: number[] = []
  for (let v = Math.floor(lo / step) * step; ; v += step) {
    ticks.push(tidy(v))
    if (v >= hi) break
  }
  return ticks
}

/** Integer-only ticks for step-numbered x axes; every step while few, nice ones later. */
export function intTicks(from: number, to: number, target = 10): number[] {
  if (!(to > from)) return [Math.round(from)]
  if (to - from <= target) {
    const ticks: number[] = []
    for (let i = Math.round(from); i <= Math.round(to); i += 1) ticks.push(i)
    return ticks
  }
  const ticks = niceTicks(from, to, Math.min(target, 8)).filter(v => Number.isInteger(v))
  return ticks.length > 0 ? ticks : [Math.round(from), Math.round(to)]
}

/**
 * Time ticks for epoch-ms x axes: pick the coarsest cadence yielding ≤ ~7
 * ticks. Returns raw times — callers format (data.ts owns formatting).
 *
 * The ladder starts at 1s because a burst of calls inside a few seconds is a
 * real shape once x is the clock, and reaches a day for sessions that span
 * one.
 */
const DAY_MS = 86_400_000
const TIME_CADENCES = [
  1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000,
  600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 10_800_000, 21_600_000,
  43_200_000, DAY_MS,
]

/**
 * Ticks land on LOCAL wall-clock boundaries, never on epoch multiples: a
 * reader at UTC+8 whose daily ticks sat on UTC midnight would see a "day"
 * boundary drawn through 08:00, mid-morning.
 *
 * Sub-day cadences all divide a local day evenly, so shifting into local
 * space, aligning there, and shifting back is exact. Day-or-longer cadences
 * step by calendar DATE instead, because a DST changeover day is 23 or 25
 * hours long and adding 86_400_000 would walk the ticks off midnight.
 */
export function timeTicks(fromMs: number, toMs: number): number[] {
  if (!(toMs > fromMs)) return [fromMs]
  const span = toMs - fromMs
  let cadence = TIME_CADENCES[TIME_CADENCES.length - 1] ?? DAY_MS
  for (const candidate of TIME_CADENCES) {
    if (span / candidate <= 7) {
      cadence = candidate
      break
    }
  }
  const ticks: number[] = []
  if (cadence >= DAY_MS) {
    const days = Math.max(1, Math.round(cadence / DAY_MS))
    const at = new Date(fromMs)
    const cursor = new Date(at.getFullYear(), at.getMonth(), at.getDate())
    if (cursor.getTime() < fromMs) cursor.setDate(cursor.getDate() + days)
    while (cursor.getTime() <= toMs) {
      ticks.push(cursor.getTime())
      cursor.setDate(cursor.getDate() + days)
    }
  } else {
    const offsetMs = new Date(fromMs).getTimezoneOffset() * 60_000
    for (let t = Math.ceil((fromMs - offsetMs) / cadence) * cadence + offsetMs; t <= toMs; t += cadence) {
      ticks.push(t)
    }
  }
  return ticks.length > 0 ? ticks : [fromMs]
}

/** Finite-only [min, max] over every point of every series; null when nothing plots. */
export function extentOf(series: readonly XYPoint[][]): [number, number] | null {
  let min = Infinity
  let max = -Infinity
  for (const points of series) {
    for (const p of points) {
      if (p.y === null || !Number.isFinite(p.y)) continue
      if (p.y < min) min = p.y
      if (p.y > max) max = p.y
    }
  }
  return Number.isFinite(min) ? [min, max] : null
}

/** Finite-only [min, max] of x over all points; null for no points. */
export function extentXOf(series: readonly XYPoint[][]): [number, number] | null {
  let min = Infinity
  let max = -Infinity
  for (const points of series) {
    for (const p of points) {
      if (!Number.isFinite(p.x)) continue
      if (p.x < min) min = p.x
      if (p.x > max) max = p.x
    }
  }
  return Number.isFinite(min) ? [min, max] : null
}

/**
 * Split one series into maximal contiguous non-null runs — the GAP policy
 * primitive: error/no-usage/in-flight slots break the polyline instead of
 * being skipped (skipping would compress later samples and fake trends).
 * A length-1 run is a lone isolated point the renderer shows as a dot.
 */
export function splitRuns<T extends XYPoint>(points: readonly T[]): T[][] {
  const runs: T[][] = []
  let current: T[] = []
  for (const p of points) {
    if (p.y === null || !Number.isFinite(p.y)) {
      if (current.length > 0) runs.push(current)
      current = []
      continue
    }
    current.push(p)
  }
  if (current.length > 0) runs.push(current)
  return runs
}

type XYLike = {
  x: number
  y: number | null
}

/**
 * Largest-triangle-three-buckets decimation for drawing only (tooltips read
 * the ORIGINAL values through the kept points). Endpoints survive, and a
 * force-include pass adds back the original global min/max so spikes never
 * visually vanish. Input must be ascending by x; nulls pass through as gaps.
 */
export function lttbDecimate<T extends XYLike>(points: T[], buckets: number): T[] {
  const n = points.length
  if (buckets < 3 || n <= buckets + 2) return points.slice()
  const keptIndexes: number[] = [0]
  const sampled = n - 2
  const every = sampled / (buckets - 2)
  let a = 0
  for (let i = 0; i < buckets - 2; i += 1) {
    const areaOffset = Math.floor((i + 1) * every) + 1
    const rangeOff = Math.min(Math.floor((i + 2) * every) + 1, n - 1)
    // Average y of the NEXT bucket (finite ys only; all-null averages to NaN).
    let avgX = 0
    let avgY = 0
    let count = 0
    const rangeEnd = Math.min(rangeOff, n)
    for (let j = areaOffset; j < rangeEnd; j += 1) {
      const y = points[j]?.y
      if (y === null || y === undefined || !Number.isFinite(y)) continue
      avgX += points[j]!.x
      avgY += y
      count += 1
    }
    avgX /= Math.max(count, 1)
    avgY /= Math.max(count, 1)
    // Search the CURRENT bucket for the largest triangle against point a.
    const bucketStart = Math.max(Math.floor(i * every) + 1, 1)
    let bestIdx = bucketStart
    let bestArea = -Infinity
    const ax = points[a]?.x ?? 0
    const ayRaw = points[a]?.y
    const ay = ayRaw === null || ayRaw === undefined || !Number.isFinite(ayRaw) ? 0 : ayRaw
    for (let j = bucketStart; j < areaOffset; j += 1) {
      const p = points[j]
      if (p === undefined) continue
      const py = p.y === null || !Number.isFinite(p.y) ? NaN : p.y
      const area = count === 0 && !Number.isFinite(py)
        ? -1 // a fully-empty next bucket keeps the first slot deterministically
        : Math.abs((ax - avgX) * (py - ay) - (ax - p.x) * (avgY - ay)) * 0.5
      if (Number.isFinite(area) && area > bestArea) {
        bestArea = area
        bestIdx = j
      }
    }
    keptIndexes.push(bestIdx)
    a = bestIdx
  }
  keptIndexes.push(n - 1)
  // Force-include the original extremes so tall spikes cannot disappear.
  let minY = Infinity
  let maxY = -Infinity
  let minIdx = -1
  let maxIdx = -1
  for (let i = 0; i < n; i += 1) {
    const y = points[i]?.y
    if (y === null || y === undefined || !Number.isFinite(y)) continue
    if (y < minY) {
      minY = y
      minIdx = i
    }
    if (y > maxY) {
      maxY = y
      maxIdx = i
    }
  }
  if (minIdx >= 0) keptIndexes.push(minIdx)
  if (maxIdx >= 0) keptIndexes.push(maxIdx)
  const unique = [...new Set(keptIndexes)].sort((x, z) => x - z)
  return unique.map(idx => points[idx]!)
}

/** Index of the closest entry in an ascending array (binary search + tiebreak). */
export function nearestIndex(xs: readonly number[], v: number): number {
  if (xs.length === 0) return -1
  let lo = 0
  let hi = xs.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    const value = xs[mid] ?? v
    if (value < v) lo = mid
    else hi = mid
  }
  const a = xs[lo] ?? v
  const b = xs[hi] ?? v
  return Math.abs(a - v) <= Math.abs(b - v) ? lo : hi
}

/**
 * Linear domain→range mapper. NaN/Infinity IN propagates out (the renderer
 * skips non-finite coordinates rather than letting them poison a path).
 * A degenerate domain maps its single value to the range midpoint.
 */
export function linear(domain: readonly [number, number], range: readonly [number, number]): (v: number) => number {
  const [d0, d1] = domain
  const [r0, r1] = range
  if (d1 <= d0) {
    const mid = (r0 + r1) / 2
    return v => (Number.isFinite(v) && v === d0 ? mid : NaN)
  }
  const scale = (r1 - r0) / (d1 - d0)
  return v => Number.isFinite(v) ? r0 + (v - d0) * scale : Number.NaN
}

/** Fill [lo, hi] while degenerate so a padded domain never divides by zero. */
export function padDomain(min: number, max: number, mode: 'span' | 'flat'): [number, number] {
  if (Number.isFinite(min) && Number.isFinite(max) && max > min) return [min, max]
  if (mode === 'span') {
    if (Number.isFinite(min) && Number.isFinite(max)) return [min - 0.5, max + 0.5]
    if (Number.isFinite(min)) return [min - 0.5, min + 0.5]
    if (Number.isFinite(max)) return [max - 0.5, max + 0.5]
    return [-1, 1]
  }
  // Flat single-value series: give it air so the dot does not hug the edge.
  const v = Number.isFinite(min) ? min : 1
  return [0, v > 0 ? v * 2 : 1]
}
