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

describe('tokens reasoning decomposition', () => {
  it('splits the output band into reasoning + answer, keeping the stack sum invariant', () => {
    // step 1: out 10 of which 4 reasoning → answer 6; step 2: out 7, none reported.
    const group = buildChartModel([
      entryOf({ id: 'a', step: 1, usage: { inputTokens: 10, outputTokens: 10, reasoningTokens: 4 } }),
      entryOf({ id: 'b', step: 2, usage: usage(100, 0, undefined, 7) }),
    ], 'step').groups.find(g => g.key === 'tokens')!
    const byKey = new Map(group.series.map(s => [s.key, s]))
    // Unreported reasoning is a REAL zero band, not a gap.
    expect(byKey.get('reasoning')!.points.map(p => p.y)).toEqual([4, 0])
    expect(byKey.get('out')!.points.map(p => p.y)).toEqual([6, 7])
    // The decomposition sits inside the old output band: the stacked top of
    // step 1 is still billed + OUTPUT (10 + 10), not billed + output + reasoning.
    const stacked = stackSerieses(group)
    const top = stacked[stacked.length - 1]!
    expect(top.key).toBe('out')
    expect(top.points[0]!.y).toBe(20)
    expect(top.points[1]!.y).toBe(107)
  })

  it('clamps reasoning to the reported output, so answer never goes negative', () => {
    // Wire semantics say reasoning ⊆ output; a provider violating that must
    // not produce a negative answer layer — reasoning caps at output.
    const group = buildChartModel([
      entryOf({ id: 'weird', step: 1, usage: { inputTokens: 5, outputTokens: 3, reasoningTokens: 9 } }),
    ], 'step').groups.find(g => g.key === 'tokens')!
    const byKey = new Map(group.series.map(s => [s.key, s]))
    expect(byKey.get('reasoning')!.points[0]!.y).toBe(3)
    expect(byKey.get('out')!.points[0]!.y).toBe(0)
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

describe('buildChartModel time mode', () => {
  const at = (h: number, m: number, s = 0) => new Date(2025, 0, 1, h, m, s).getTime()

  it('slots by wall-clock start, so idle gaps become real distance on the axis', () => {
    const model = buildChartModel([
      entryOf({ id: 'a', step: 1, startedAt: at(9, 0), usage: usage(100, 0, 0, 10) }),
      entryOf({ id: 'b', step: 2, startedAt: at(9, 1), usage: usage(200, 0, 0, 20) }),
      // ...then an hour of nothing.
      entryOf({ id: 'c', step: 3, startedAt: at(10, 30), usage: usage(300, 0, 0, 30) }),
    ], 'time')

    expect(model.xMode).toBe('time')
    const out = model.groups.find(g => g.key === 'tokens')!.series.find(s => s.key === 'out')!
    expect(out.points.map(p => p.x)).toEqual([at(9, 0), at(9, 1), at(10, 30)])
    // The 89-minute void between b and c is 89 minutes of x, not one slot.
    expect(out.points[2]!.x - out.points[1]!.x).toBe(89 * 60_000)
  })

  it('plots each retry attempt separately — in time a retry IS another request', () => {
    // Step mode collapses these two into one slot; time mode must not, or the
    // chart would claim nothing happened during the retry.
    const calls = [
      entryOf({ id: 'r1', step: 1, requestHash: 'H', attempt: 1, startedAt: at(9, 0), status: 'error' }),
      entryOf({ id: 'r2', step: 1, requestHash: 'H', attempt: 2, startedAt: at(9, 2), usage: usage(50, 0, 0, 5) }),
    ]
    const timed = buildChartModel(calls, 'time')
    const stepped = buildChartModel(calls, 'step')

    const outOf = (m: typeof timed) => m.groups.find(g => g.key === 'tokens')!.series.find(s => s.key === 'out')!
    expect(outOf(timed).points.map(p => p.x)).toEqual([at(9, 0), at(9, 2)])
    expect(outOf(stepped).points).toHaveLength(1)
  })

  it('admits auxiliary calls when asked, and then excludes nothing', () => {
    const calls = [
      entryOf({ id: 'turn', step: 1, startedAt: at(9, 0), usage: usage(100, 0, 0, 10) }),
      entryOf({ id: 'compact', purpose: 'compaction', startedAt: at(9, 5), usage: usage(900, 0, 0, 90) }),
      entryOf({ id: 'title', purpose: 'session-title', startedAt: at(9, 6), usage: usage(20, 0, 0, 2) }),
    ]
    const included = buildChartModel(calls, 'time', { auxCalls: 'include' })
    expect(included.callCount).toBe(3)
    // Nothing sits off the axis, so the ⓘ badge has nothing to report.
    expect(included.excludedAux).toBe(0)

    // Left out, they simply do not plot.
    expect(buildChartModel(calls, 'time').callCount).toBe(1)
  })

  it('still reports steps excluded from the NUMBERED axis in step mode', () => {
    const model = buildChartModel([
      entryOf({ id: 'turn', step: 1, startedAt: at(9, 0), usage: usage(100) }),
      entryOf({ id: 'compact', purpose: 'compaction', startedAt: at(9, 5), usage: usage(900) }),
    ], 'step')
    expect(model.excludedAux).toBe(1)
    expect(model.callCount).toBe(1)
  })

  it('orders slots chronologically even when handed calls out of order', () => {
    const model = buildChartModel([
      entryOf({ id: 'late', step: 2, startedAt: at(11, 0), usage: usage(1) }),
      entryOf({ id: 'early', step: 1, startedAt: at(9, 0), usage: usage(2) }),
    ], 'time')
    const xs = model.groups[0]!.series[0]!.points.map(p => p.x)
    expect(xs).toEqual([at(9, 0), at(11, 0)])
  })

  it('accumulates cumulative totals across time slots, gaps carrying forward', () => {
    const model = buildChartModel([
      entryOf({ id: 'a', step: 1, startedAt: at(9, 0), usage: usage(100, 0, 0, 10) }),
      entryOf({ id: 'b', step: 2, startedAt: at(9, 30), status: 'error' }),
      entryOf({ id: 'c', step: 3, startedAt: at(10, 0), usage: usage(300, 0, 0, 30) }),
    ], 'time')
    const tokens = model.groups.find(g => g.key === 'tokens')!
    const out = cumulateSerieses(tokens).find(s => s.key === 'out')!
    // The error step reported nothing: the running total carries, never dips.
    expect(out.points.map(p => p.y)).toEqual([10, 10, 40])
  })
})
