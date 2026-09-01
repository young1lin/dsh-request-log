/**
 * Chart data-shaping specs: hit-rate semantics against the disjoint neutral
 * usage counts, retry collapse, auxiliary exclusion, stacking order.
 */

import { describe, expect, it } from 'vitest'
import { buildChartModel, cumulateSerieses, stackSerieses } from '../src/client/chart-stats'
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
    const slow = entryOf({ id: 's', step: 2, durationMs: 2_000, ttfbMs: 600, usage: usage(10, undefined, undefined, 350) })
    const model = buildChartModel([fast, slow], 'step')
    const speed = model.groups.find(group => group.key === 'speed')!.series[0]!
    // Sub-floor stream phase no longer punches a hole: the point falls back
    // to output ÷ total duration and is TAGGED approximate (≈).
    expect(speed.points[0]!.y).not.toBeNull()
    expect(speed.points[0]!.approx).toBe(true)
    expect(speed.points[0]!.y!).toBeCloseTo(99 / 0.15, 5)
    // Measurable (and plausibly fast) stream phases stay exact (no tag).
    expect(speed.points[1]!.y).toBeCloseTo(350 / 1.4, 5)
    expect(speed.points[1]!.approx).toBeUndefined()
    const latency = model.groups.find(group => group.key === 'latency')!
    expect(latency.series.map(series => series.points[1]!.y)).toEqual([2_000, 600])
  })

  it('downgrades an above-ceiling exact-phase rate to the whole-call approximation', () => {
    // Stream phase 300ms (≥ floor) carrying 2_000 tokens = ~6_667 t/s — over
    // SPEED_CEILING_TPS, so the coarse flush counts as unmeasured: the point
    // falls back to output ÷ total (≈), exactly like a sub-floor flush.
    const burst = entryOf({ id: 'b', step: 1, durationMs: 2_000, ttfbMs: 1_700, usage: usage(10, undefined, undefined, 2_000) })
    const model = buildChartModel([burst], 'step')
    const speed = model.groups.find(group => group.key === 'speed')!.series[0]!
    expect(speed.points[0]!.y).toBeCloseTo(2_000 / 2, 5)
    expect(speed.points[0]!.approx).toBe(true)
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

describe('cumulateSerieses', () => {
  function tokenGroup() {
    // step 1: in 10 / cacheRead 20 / cacheWrite 5 / out 3
    // step 2: in 100 / out 7   step 3: ERROR (no usage at all).
    return buildChartModel([
      entryOf({ id: 'a', step: 1, usage: usage(10, 20, 5, 3) }),
      entryOf({ id: 'b', step: 2, usage: usage(100, 0, undefined, 7) }),
      entryOf({ id: 'err', step: 3, status: 'error' }),
    ], 'step').groups.find(group => group.key === 'tokens')!
  }

  it('turns each series into a running total across steps', () => {
    const byKey = new Map(cumulateSerieses(tokenGroup()).map(s => [s.key, s]))
    expect(byKey.get('in')!.points.map(p => p.y)).toEqual([10, 110, 110])
    expect(byKey.get('out')!.points.map(p => p.y)).toEqual([3, 10, 10])
  })

  it('carries the total forward over a usage-less slot instead of drawing a gap', () => {
    // Step 3 errored: nothing was added, so the running total genuinely stands.
    const inputs = cumulateSerieses(tokenGroup()).find(s => s.key === 'in')!
    expect(inputs.points[2]!.y).toBe(110)
  })

  it('keeps LEADING slots gap — no invented zero start', () => {
    const group = buildChartModel([
      entryOf({ id: 'err', step: 1, status: 'error' }),
      entryOf({ id: 'ok', step: 2, usage: usage(10) }),
    ], 'step').groups.find(g => g.key === 'tokens')!
    const inputs = cumulateSerieses(group).find(s => s.key === 'in')!
    expect(inputs.points.map(p => p.y)).toEqual([null, 10])
  })

  it('stacks on top of cumulated layers into a grand cumulative total', () => {
    const cumulated = cumulateSerieses(tokenGroup())
    const stacked = stackSerieses({ ...tokenGroup(), series: cumulated })
    const byKey = new Map(stacked.map(s => [s.key, s]))
    // The out layer tops at the grand cumulative total: 38 = 10+20+5+3,
    // 145 = (10+100)+(20+0)+(5+0)+(3+7), then flat 145 over the error slot.
    expect(byKey.get('out')!.points.map(p => p.y)).toEqual([38, 145, 145])
    expect(byKey.get('in')!.points.map(p => p.y)).toEqual([10, 110, 110])
  })
})
