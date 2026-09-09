/**
 * Token usage bucketed by wall-clock window: how much was burned between
 * 14:00 and 14:05, not how much had accumulated by step N.
 *
 * A bucket is a SUM over the calls that started inside it, which is why it
 * treats an unreported call as a zero contribution rather than as the gap a
 * per-call series draws. A window in which one call failed did still consume
 * what its neighbours consumed; only a window with no calls at all is empty,
 * and it renders as an empty bucket, because an idle hour must look idle.
 *
 * No React, no DOM — tests run this under plain Node.
 *
 * @module dsh-request-log/client/chart-buckets
 */

import type { CallIndexEntry } from '../shared/types'
import { TOKENS_STACK_ORDER } from './chart-stats'
import type { ChartSlot, MetricGroup } from './chart-stats'

/** Bucket sizes offered as chips, in minutes; any other value is custom. */
export const BUCKET_PRESETS: readonly number[] = [1, 5, 10, 30]

/** Smallest and largest custom bucket the control accepts, in minutes. */
export const BUCKET_MIN_MINUTES = 1
export const BUCKET_MAX_MINUTES = 1440

/**
 * Start of the window `startedAt` falls in, anchored to a local midnight so
 * buckets land on wall-clock boundaries in every zone — flooring against the
 * epoch would drift by 30 minutes in a half-hour offset.
 */
export function bucketStartOf(startedAt: number, bucketMs: number, anchor: number): number {
  return anchor + Math.floor((startedAt - anchor) / bucketMs) * bucketMs
}

/** Local midnight of the day `ms` falls on. */
function localMidnight(ms: number): number {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export function bucketTokens(
  calls: readonly CallIndexEntry[],
  bucketMinutes: number,
): { group: MetricGroup; slots: ChartSlot[] } {
  const group: MetricGroup = {
    key: 'tokens',
    labelKey: 'groupTokens',
    unit: 'tokens',
    // The shared token stack order — the buckets must not invent a second
    // one (same session, same reader, one meaning for the green band).
    stackOrder: TOKENS_STACK_ORDER,
    bucketable: true,
    series: TOKENS_STACK_ORDER.map(key => ({
      key,
      labelKey: key === 'in' ? 'colIn'
        : key === 'cacheRead' ? 'colCacheRead'
          : key === 'cacheWrite' ? 'colCacheWrite'
            : key === 'reasoning' ? 'colReasoning'
              : 'colAnswer',
      colorRole: key === 'in' ? 'brand'
        : key === 'cacheRead' ? 'success'
          : key === 'cacheWrite' ? 'warn'
            : key === 'reasoning' ? 'reasoning'
              : 'neutral',
      points: [],
    })),
  }
  if (calls.length === 0) return { group, slots: [] }

  const bucketMs = Math.max(BUCKET_MIN_MINUTES, Math.min(BUCKET_MAX_MINUTES, bucketMinutes)) * 60_000
  const times = calls.map(call => call.startedAt)
  const anchor = localMidnight(Math.min(...times))
  const first = bucketStartOf(Math.min(...times), bucketMs, anchor)
  const last = bucketStartOf(Math.max(...times), bucketMs, anchor)

  const sums = new Map<number, Record<string, number>>()
  for (let start = first; start <= last; start += bucketMs) {
    sums.set(start, { cacheRead: 0, in: 0, cacheWrite: 0, reasoning: 0, out: 0 })
  }
  // A representative call per bucket, so clicking a bar still locates a row.
  const representative = new Map<number, CallIndexEntry>()
  for (const call of calls) {
    const start = bucketStartOf(call.startedAt, bucketMs, anchor)
    const bucket = sums.get(start)
    if (bucket === undefined) continue
    if (!representative.has(start)) representative.set(start, call)
    const usage = call.usage
    if (usage === undefined) continue
    const reasoning = usage.reasoningTokens ?? 0
    bucket.cacheRead += usage.cacheReadTokens ?? 0
    bucket.in += usage.inputTokens
    bucket.cacheWrite += usage.cacheWriteTokens ?? 0
    bucket.reasoning += reasoning
    // The answer band is what is left of the reported output once reasoning
    // is taken out, never a second count of it.
    bucket.out += Math.max(0, usage.outputTokens - reasoning)
  }

  const slots: ChartSlot[] = []
  for (let start = first; start <= last; start += bucketMs) {
    const bucket = sums.get(start)!
    const sample = representative.get(start)
    slots.push({
      x: start,
      startedAt: start,
      callId: sample?.id ?? '',
      ...(sample?.purpose === undefined ? {} : { purpose: sample.purpose }),
    })
    for (const series of group.series) series.points.push({ x: start, y: bucket[series.key]! })
  }
  return { group, slots }
}
