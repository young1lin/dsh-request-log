/**
 * Chart data-shaping specs: hit-rate semantics against the disjoint neutral
 * usage counts, retry collapse, auxiliary exclusion, stacking order.
 */

import { describe, expect, it } from 'vitest'
import { buildChartModel, stackSerieses } from '../src/client/chart-stats'
import type { CallIndexEntry } from '../src/shared/types'

function entryOf(overrides: Partial<CallIndexEntry> & { id: string }): CallIndexEntry {
  return {
    sessionId: 's1',
    provider: 'p',
    model: 'm',
    requestHash: 'h',
    attempt: 1,
    startedAt: 1_000,
    status: 'ok',
    messageCount: 3,
    requestChars: 100,
    ...overrides,
  }
}

const usage = (input: number, read?: number, write?: number, out = 10) => ({
  inputTokens: input,
  outputTokens: out,
  ...(read === undefined ? {} : { cacheReadTokens: read }),
  ...(write === undefined ? {} : { cacheWriteTokens: write }),
})

describe('buildChartModel hitRate', () => {
  it('computes cacheRead / billed over DISJOINT neutral usage', () => {
    // billed = 100 in + 150 read + 50 write = 300 → 50%.
    const model = buildChartModel([
      entryOf({ id: 'a', step: 1, usage: usage(100, 150, 50) }),
      entryOf({ id: 'b', step: 2, usage: usage(200, 0, undefined, 5) }),
    ], 'step')
    const series = model.groups.find(group => group.key === 'hitrate')!.series[0]!
    expect(series.points.map(p => p.y)).toEqual([50, 0]) // 0% is DATA, not a gap
    expect(model.hasData).toBe(true)
  })

  it('yields null without usage or a zero denominator — never a fake percent', () => {
    const model = buildChartModel([
      entryOf({ id: 'err', step: 1, status: 'error' }),
      entryOf({ id: 'zero', step: 2, usage: usage(0, undefined, undefined, 7) }),
    ], 'step')
    const series = model.groups.find(group => group.key === 'hitrate')!.series[0]!
    expect(series.points.map(p => p.y)).toEqual([null, null])
  })
})

describe('buildChartModel slots', () => {
  it('collapses retries into their step preferring the attempt WITH usage', () => {
    const model = buildChartModel([
      entryOf({ id: 'head', step: 1, requestHash: 'A', attempt: 1, status: 'error' }),
      entryOf({ id: 'retry', step: 1, requestHash: 'A', attempt: 2, usage: usage(10, 30, undefined, 4) }),
    ], 'step')
    const tokens = model.groups.find(group => group.key === 'tokens')!
    const inputs = tokens.series.find(series => series.key === 'in')!
    expect(inputs.points).toHaveLength(1)
    expect(inputs.points[0]!.y).toBe(10)
    expect(model.callCount).toBe(1)
    expect(model.excludedAux).toBe(0)
  })

  it('excludes auxiliary calls from the step axis and reports them', () => {
    const model = buildChartModel([
      entryOf({ id: 'turn', step: 3, usage: usage(5) }),
      entryOf({ id: 'title', purpose: 'session-title' }),
      entryOf({ id: 'compact', purpose: 'compaction' }),
    ], 'step')
    expect(model.callCount).toBe(1)
    expect(model.excludedAux).toBe(2)
  })

  it('guards speed below the stream floor and maps latency phases', () => {
    const fast = entryOf({ id: 'f', step: 1, durationMs: 150, ttfbMs: 40, usage: usage(10, undefined, undefined, 99) })
    const slow = entryOf({ id: 's', step: 2, durationMs: 2_000, ttfbMs: 600, usage: usage(10, undefined, undefined, 700) })
    const model = buildChartModel([fast, slow], 'step')
    const speed = model.groups.find(group => group.key === 'speed')!.series[0]!
    // Sub-floor stream phase no longer punches a hole: the point falls back
    // to output ÷ total duration and is TAGGED approximate (≈).
    expect(speed.points[0]!.y).not.toBeNull()
    expect(speed.points[0]!.approx).toBe(true)
    expect(speed.points[0]!.y!).toBeCloseTo(99 / 0.15, 5)
    // Measurable stream phases stay exact (no tag).
    expect(speed.points[1]!.y).toBeCloseTo(700 / 1.4, 5)
    expect(speed.points[1]!.approx).toBeUndefined()
    const latency = model.groups.find(group => group.key === 'latency')!
    expect(latency.series.map(series => series.points[1]!.y)).toEqual([2_000, 600])
  })

  it('keeps true gaps when neither phase nor output exists', () => {
    const dead = entryOf({ id: 'x', step: 1, status: 'error' })
    const model = buildChartModel([dead], 'step')
    const speed = model.groups.find(group => group.key === 'speed')!.series[0]!
    expect(speed.points[0]!.y).toBeNull()
    expect(speed.points[0]!.approx).toBeUndefined()
  })

  it('sorts unsorted input defensively', () => {
    const model = buildChartModel([
      entryOf({ id: 'late', startedAt: 9_000, step: 2, usage: usage(1) }),
      entryOf({ id: 'early', startedAt: 1_000, step: 1, usage: usage(2) }),
    ], 'step')
    const inputs = model.groups.find(group => group.key === 'tokens')!.series.find(series => series.key === 'in')!
    expect(inputs.points.map(p => p.x)).toEqual([1, 2])
    expect(inputs.points.map(p => p.y)).toEqual([2, 1])
  })
})

describe('stackSerieses', () => {
  function tokenGroup(): ReturnType<typeof buildChartModel>['groups'][number] {
    return buildChartModel([
      entryOf({ id: 'a', step: 1, usage: usage(10, 20, 5, 3) }),
      entryOf({ id: 'b', step: 2, usage: usage(100, 0, undefined, 7) }),
    ], 'step').groups.find(group => group.key === 'tokens')!
  }

  it('cumulates in stackOrder while usage exists', () => {
    const stacked = stackSerieses(tokenGroup())
    const byKey = new Map(stacked.map(series => [series.key, series]))
    expect(byKey.get('cacheRead')!.points.map(p => p.y)).toEqual([30, 100]) // 10+20 · 100+0
    expect(byKey.get('cacheWrite')!.points.map(p => p.y)).toEqual([35, 100])
    expect(byKey.get('out')!.points.map(p => p.y)).toEqual([38, 107])
  })

  it('keeps a whole-slot gap when NO usage exists at that x', () => {
    const group = tokenGroup()
    for (const series of group.series) series.points.push({ x: 3, y: null })
    const stacked = stackSerieses(group)
    for (const series of stacked) expect(series.points[2]!.y).toBeNull()
  })
})
