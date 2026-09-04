/**
 * Pure chart data shaping: CallIndexEntry[] → plottable metric groups.
 *
 * Semantics pinned against the host half (see shared/types and the wire
 * renderers): neutral inputTokens is UNCACHED input only, so
 *   billed = inputTokens + cacheReadTokens + cacheWriteTokens
 * and hit rate = cacheRead / billed. Missing usage (error / aborted / never
 * reported) yields null points — real gaps, never fabricated zeros; 0% IS
 * data and plots as zero.
 *
 * No React, no DOM, no formatting — tests run this under plain Node.
 *
 * @module dsh-request-log/client/chart-stats
 */

import type { CallIndexEntry } from '../shared/types'
import { speedReading } from './data'
import type { XYPoint } from './chart-scale'

export interface SeriesPoint extends XYPoint {
  /**
   * Speed-only: the value falls back to output ÷ TOTAL duration because the
   * stream phase was unmeasurable (< STREAM_FLOOR_MS) or its rate exceeded
   * SPEED_CEILING_TPS — buffered / coarse-flush responses where TTFT ≈
   * total. Tagged so tooltips can mark it approximate (≈) instead of
   * punching another hole into a third of the chart.
   */
  approx?: boolean
}

/** One named polyline inside a metric group. */
export interface MetricSeries {
  /** Stable series id ('in' | 'cacheRead' | …). */
  key: string
  /** Dict key carrying the display label (stats stays i18n-free). */
  labelKey: string
  colorRole: 'brand' | 'success' | 'warn' | 'error' | 'neutral' | 'reasoning'
  /** Ascending by x; y === null marks a gap slot. */
  points: SeriesPoint[]
}

export type MetricGroupKey = 'hitrate' | 'tokens' | 'latency' | 'speed'

export interface MetricGroup {
  key: MetricGroupKey
  labelKey: string
  unit: 'percent' | 'tokens' | 'ms' | 'tokps'
  /** Hit-rate group: fixed [0,100] axis, ticks every 25, never auto-scaled. */
  percentAxis?: boolean
  /** Token group: legend chips may stack the lines per slot (see stackSerieses). */
  stackOrder?: string[]
  /** Token group: offers the cumulative (running-total) mode — see cumulateSerieses. */
  cumulable?: boolean
  series: MetricSeries[]
}

export interface ChartModel {
  groups: MetricGroup[]
  xMode: XMode
  /** At least one finite value anywhere — false renders the empty state. */
  hasData: boolean
  /** Ordinary calls that produced the per-step slots. */
  callCount: number
  /** Auxiliary calls excluded from the per-step series (kept in totals). */
  excludedAux: number
}

export type XMode = 'step' | 'time'

export interface ChartOptions {
  /**
   * Auxiliary calls (compaction / session-title): excluded in step mode by
   * default (they carry no step) and included in time mode when 'include'.
   */
  auxCalls?: 'exclude' | 'include'
}

const HIT_RATE_GROUP: MetricGroup = {
  key: 'hitrate',
  labelKey: 'groupHitRate',
  unit: 'percent',
  percentAxis: true,
  series: [{
    key: 'hitRate',
    labelKey: 'sumHitRate',
    colorRole: 'success',
    points: [],
  }],
}

const TOKENS_GROUP: MetricGroup = {
  key: 'tokens',
  labelKey: 'groupTokens',
  unit: 'tokens',
  // The output band decomposes: reasoning + answer, stacked adjacently, so
  // the two layers always sum to the reported output and the stack top stays
  // billed + output — the decomposition adds visibility, never tokens.
  stackOrder: ['in', 'cacheRead', 'cacheWrite', 'reasoning', 'out'],
  cumulable: true,
  series: [
    { key: 'in', labelKey: 'colIn', colorRole: 'brand', points: [] },
    { key: 'cacheRead', labelKey: 'colCacheRead', colorRole: 'success', points: [] },
    { key: 'cacheWrite', labelKey: 'colCacheWrite', colorRole: 'warn', points: [] },
    { key: 'reasoning', labelKey: 'colReasoning', colorRole: 'reasoning', points: [] },
    { key: 'out', labelKey: 'colAnswer', colorRole: 'neutral', points: [] },
  ],
}

const LATENCY_GROUP: MetricGroup = {
  key: 'latency',
  labelKey: 'groupLatency',
  unit: 'ms',
  series: [
    { key: 'duration', labelKey: 'totalTime', colorRole: 'brand', points: [] },
    { key: 'ttfb', labelKey: 'ttft', colorRole: 'warn', points: [] },
  ],
}

const SPEED_GROUP: MetricGroup = {
  key: 'speed',
  labelKey: 'groupSpeed',
  unit: 'tokps',
  series: [{ key: 'speed', labelKey: 'colSpeed', colorRole: 'brand', points: [] }],
}

/** Billed input of one usage record (the hit-rate denominator). */
function billedOf(usage: NonNullable<CallIndexEntry['usage']>): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

function readValue(entry: CallIndexEntry, group: MetricGroupKey, seriesKey: string): number | null {
  const usage = entry.usage
  switch (group) {
    case 'hitrate': {
      if (usage === undefined) return null
      const billed = billedOf(usage)
      if (billed <= 0 || usage.cacheReadTokens === undefined) return null
      return (usage.cacheReadTokens / billed) * 100
    }
    case 'tokens':
      if (usage === undefined) return null
      switch (seriesKey) {
        case 'in': return usage.inputTokens
        case 'cacheRead': return usage.cacheReadTokens ?? 0
        case 'cacheWrite': return usage.cacheWriteTokens ?? 0
        // Wire semantics (both providers): reasoning ⊆ output. Unreported
        // reasoning is a REAL zero-height band, not a gap — the model answered
        // without thinking. A provider overshooting output is clamped so the
        // two layers sum to the reported output, never past it.
        case 'reasoning': return Math.min(usage.reasoningTokens ?? 0, usage.outputTokens)
        case 'out': return Math.max(0, usage.outputTokens - (usage.reasoningTokens ?? 0))
        default: return null
      }
    case 'latency':
      return seriesKey === 'duration' ? entry.durationMs ?? null : entry.ttfbMs ?? null
    case 'speed': {
      if (usage === undefined) return null
      // Precise: output ÷ stream phase while that phase is long enough to
      // time AND the rate is plausible. Buffered flushes (TTFT ≈ total) and
      // implausibly fast coarse flushes fall back to the whole-call duration
      // as an APPROXIMATION — speedApproxOf tags those points (≈) so nothing
      // poses as an exact measure.
      const reading = speedReading(usage.outputTokens, entry.durationMs, entry.ttfbMs)
      return reading === null ? null : reading.tokensPerSecond
    }
    default:
      return null
  }
}

/** True when the entry's speed value rides the whole-call fallback (≈). */
function speedApproxOf(entry: CallIndexEntry): boolean {
  const usage = entry.usage
  if (usage === undefined) return false
  const reading = speedReading(usage.outputTokens, entry.durationMs, entry.ttfbMs)
  return reading !== null && reading.approx
}

/**
 * Collapse one step's entries to the single entry whose values plot:
 * prefer the highest attempt that carries usage (retries supersede their
 * failed head attempt, which usually reports no usage at all).
 */
function collapseStep(entries: CallIndexEntry[]): CallIndexEntry {
  let best = entries[0]!
  for (let i = 1; i < entries.length; i += 1) {
    const candidate = entries[i]!
    if ((best.usage === undefined && candidate.usage !== undefined)
      || candidate.attempt > best.attempt) best = candidate
  }
  return best
}

/** Build every metric group for one x mode out of the loaded ledger window. */
export function buildChartModel(calls: readonly CallIndexEntry[], xMode: XMode, options: ChartOptions = {}): ChartModel {
  // Oldest-first, defensively: the ledger holds chronological rows, but this
  // module refuses to depend on its callers.
  const chrono = calls.slice().sort((a, b) => a.startedAt - b.startedAt)
  // Auxiliary calls (compaction / session-title) carry no step, so the
  // numbered axis can never hold them; a time axis can, and a compaction is
  // usually the very thing that explains a hit-rate cliff. ONE list either
  // way — concatenating a second aux list onto an unfiltered `chrono` both
  // double-counted them and made 'exclude' a no-op in time mode.
  const includeAux = options.auxCalls === 'include'
  const plottable = xMode === 'time' && includeAux
    ? chrono
    : chrono.filter(call => call.purpose === undefined)

  // In step mode an entry WITHOUT a step (auxiliary or legacy pre-projection
  // rows) cannot join the numbered axis — those are the excluded ones.
  // Retries ARE plotted (their step collapses), so they never count here.
  let excludedAux = 0
  if (xMode === 'step') {
    for (const entry of chrono) {
      if (entry.purpose !== undefined || entry.step === undefined) excludedAux += 1
    }
  }

  // Slot the entries: one slot per step (retry-collapsed) or one per call.
  const slotKeys: number[] = []
  const slotEntries = new Map<number, CallIndexEntry[]>()
  for (const entry of plottable) {
    if (xMode === 'step' && entry.step === undefined) continue
    const key = xMode === 'step' ? entry.step! : entry.startedAt
    const bucket = slotEntries.get(key)
    if (bucket === undefined) {
      slotEntries.set(key, [entry])
      slotKeys.push(key)
    } else {
      bucket.push(entry)
    }
  }
  slotKeys.sort((a, b) => a - b)

  const groups = [HIT_RATE_GROUP, TOKENS_GROUP, LATENCY_GROUP, SPEED_GROUP].map(group => ({
    ...group,
    series: group.series.map(series => ({ ...series, points: [] as SeriesPoint[] })),
  })) as MetricGroup[]
  let hasData = false
  let plotted = 0
  for (const key of slotKeys) {
    const bucket = slotEntries.get(key) ?? []
    const collapsed = xMode === 'step' ? collapseStep(bucket) : bucket[bucket.length - 1]!
    plotted += 1
    for (const group of groups) {
      for (const series of group.series) {
        const y = readValue(collapsed, group.key, series.key)
        const finite = y !== null && Number.isFinite(y)
        if (finite) hasData = true
        // Speed approximation tag: measured over the WHOLE call when the
        // stream phase alone is too short to time or implausibly fast (see
        // SeriesPoint.approx / speedApproxOf).
        const approx = finite && group.key === 'speed' ? speedApproxOf(collapsed) : false
        series.points.push(approx && finite ? { x: key, y, approx: true } : { x: key, y })
      }
    }
  }
  return { groups, xMode, hasData, callCount: plotted, excludedAux }
}

/**
 * Per-slot stacking of the token group: at each x the layers pile up in
 * stackOrder (in + cacheRead + cacheWrite + out), missing fields counting as
 * 0, while a whole x with NO usage stays a stacked gap (every layer null
 * there). This stacks WITHIN a slot — it never accumulates across xs; for
 * that see cumulateSerieses.
 */
export function stackSerieses(group: MetricGroup): MetricSeries[] {
  const order = group.stackOrder ?? group.series.map(s => s.key)
  const layers = order.map(key => group.series.find(s => s.key === key)).filter(s => s !== undefined)
  const length = layers[0]?.points.length ?? 0
  const cumulative: number[][] = []
  let previous: number[] = Array.from({ length }, () => 0)
  for (const layer of layers) {
    const current: number[] = Array.from({ length }, () => Number.NaN)
    const totals: number[] = Array.from({ length }, () => Number.NaN)
    for (let i = 0; i < length; i += 1) {
      const y = layer.points[i]?.y
      if (y === null || y === undefined || !Number.isFinite(y)) {
        // A gap slot stays a gap only while EVERY layer lacks data here;
        // deeper layers see accumulated zeros otherwise.
        current[i] = NaN
        totals[i] = NaN
        continue
      }
      current[i] = previous[i]! + y
      totals[i] = previous[i]! + y
    }
    cumulative.push(current)
    // Next layer stacks on finite sums only.
    previous = previous.map((base, i) => Number.isFinite(totals[i]!) ? totals[i]! : base)
  }
  return layers.map((layer, index) => ({
    ...layer,
    points: cumulative[index]!.map((value, i) => ({
      x: layer.points[i]?.x ?? 0,
      y: Number.isFinite(value) ? value : null,
    })),
  }))
}

/**
 * Cumulative (running-total) mode — the Cursor-dashboard form: each point
 * becomes the sum of every value up to that slot, so the lines only climb.
 *
 * Semantics:
 *  - a slot WITH usage adds to the running total;
 *  - a slot WITHOUT usage (error / aborted / in-flight) CARRIES THE PREVIOUS
 *    TOTAL FORWARD — nothing was added, so the total genuinely stands; this
 *    is not a fabricated value the way a fake zero would be, and the
 *    per-step charts keep drawing real gaps there;
 *  - slots before the FIRST finite value stay gaps — no invented zero start.
 */
export function cumulateSerieses(group: MetricGroup): MetricSeries[] {
  return group.series.map(series => {
    let total: number | null = null
    return {
      ...series,
      points: series.points.map(point => {
        if (point.y !== null && Number.isFinite(point.y)) total = (total ?? 0) + point.y
        return { x: point.x, y: total === null ? null : total, ...(point.approx === true ? { approx: true } : {}) }
      }),
    }
  })
}
