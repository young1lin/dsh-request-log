import { describe, expect, it } from 'vitest'
import { BUCKET_PRESETS, bucketTokens } from '../src/client/chart-buckets.ts'
import { TOKENS_STACK_ORDER } from '../src/client/chart-stats.ts'
import type { CallIndexEntry } from '../src/shared/types'

const at = (clock: string): number => new Date('2026-09-09T' + clock).getTime()

function call(clock: string, usage: Partial<CallIndexEntry['usage']> & { inputTokens: number; outputTokens: number }): CallIndexEntry {
  return {
    id: 'c' + clock, sessionId: 's', provider: 'p', model: 'm',
    requestHash: 'h' + clock, attempt: 1, startedAt: at(clock),
    status: 'ok', messageCount: 1, requestChars: 0,
    usage: usage as CallIndexEntry['usage'],
  }
}

describe('bucketTokens', () => {
  it('sums each window and keeps the specified bottom-to-top order', () => {
    const { group } = bucketTokens([
      call('10:00:10', { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 5, reasoningTokens: 4 }),
      call('10:03:00', { inputTokens: 50, outputTokens: 20 }),
    ], 5)
    // Identity, not just equality: the bucket group and the shipped token
    // group read ONE shared constant, so the two orders cannot drift apart.
    expect(group.stackOrder).toBe(TOKENS_STACK_ORDER)
    const y = (key: string): (number | null)[] =>
      group.series.find(series => series.key === key)!.points.map(point => point.y)
    // Both calls land in the 10:00-10:05 window.
    expect(y('in')).toEqual([150])
    expect(y('cacheRead')).toEqual([900])
    expect(y('cacheWrite')).toEqual([5])
    // Output decomposes: reasoning + answer always sums to reported output.
    expect(y('reasoning')).toEqual([4])
    expect(y('out')).toEqual([26])
  })

  it('renders an idle window as an empty bucket, not as a missing one', () => {
    const { group } = bucketTokens([
      call('10:00:00', { inputTokens: 10, outputTokens: 1 }),
      call('10:20:00', { inputTokens: 20, outputTokens: 2 }),
    ], 5)
    const input = group.series.find(series => series.key === 'in')!
    // 10:00, 10:05, 10:10, 10:15, 10:20 — the three idle windows are real
    // zeroes, because an idle stretch must look idle.
    expect(input.points.map(point => point.y)).toEqual([10, 0, 0, 0, 20])
  })

  it('aligns buckets to local wall-clock boundaries', () => {
    const { slots } = bucketTokens([call('10:07:30', { inputTokens: 1, outputTokens: 1 })], 5)
    expect(new Date(slots[0]!.startedAt).getMinutes()).toBe(5)
  })

  it('counts a call that reported no usage as contributing nothing', () => {
    const errored = call('10:00:00', { inputTokens: 0, outputTokens: 0 })
    delete (errored as { usage?: unknown }).usage
    const { group } = bucketTokens([errored], 5)
    // A bucket is a SUM: an unreported call adds zero. It must not punch a
    // gap the way a per-call series does, or the window would read as
    // "no data" when what happened was "one call failed".
    expect(group.series.find(series => series.key === 'in')!.points.map(point => point.y)).toEqual([0])
  })

  it('offers the presets the UI shows', () => {
    expect(BUCKET_PRESETS).toEqual([1, 5, 10, 30])
  })

  it('returns nothing for an empty window', () => {
    expect(bucketTokens([], 5).slots).toEqual([])
  })
})
