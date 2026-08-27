/**
 * LOCAL integration probe (skips silently when the plugin server isn't
 * running): pulls the real newest ledger page for one recorded session and
 * pushes it through buildChartModel to prove real-world record shapes —
 * missing usage across providers, retries, long gaps — produce finite,
 * well-formed series. Skipped by design in CI.
 */

import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

;(globalThis as { require?: NodeRequire }).require = createRequire(import.meta.url)

const { buildChartModel } = await import('../src/client/chart-stats')
import type { CallIndexResponse } from '../src/shared/types'

const BASE = process.env.DRL_PROBE_BASE ?? 'http://127.0.0.1:3080/dsh-request-log'
// A locally recorded session id with dozens of mixed-provider calls. Pass your
// own via DRL_PROBE_SESSION; without it this probe skips silently.
const SESSION = process.env.DRL_PROBE_SESSION

describe('chart-stats over live local data', () => {
  it('models the real ledger without NaN or crashes', async () => {
    if (!SESSION) return // no probe target configured
    let page: CallIndexResponse
    try {
      const response = await fetch(BASE + '/sessions/' + SESSION + '/calls?limit=2000&offset=0', {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) throw new Error('HTTP ' + String(response.status))
      page = await response.json() as CallIndexResponse
    } catch {
      // Server not up (CI) — this probe simply means nothing there.
      return
    }
    expect(page.calls.length).toBeGreaterThan(10)
    const chronological = page.calls.slice().reverse()
    const model = buildChartModel(chronological, 'step')
    expect(model.callCount).toBeGreaterThan(5)
    for (const group of model.groups) {
      for (const series of group.series) {
        for (const p of series.points) {
          if (p.y === null) continue
          expect(Number.isFinite(p.y)).toBe(true)
          expect(p.y).toBeLessThan(Number.MAX_SAFE_INTEGER)
        }
      }
    }
    const hit = model.groups.find(group => group.key === 'hitrate')!.series[0]!
    const numeric = hit.points.filter(p => p.y !== null)
    expect(numeric.length).toBeGreaterThan(0)
    for (const p of numeric) expect(p.y!).toBeGreaterThanOrEqual(0)
    for (const p of numeric) expect(p.y!).toBeLessThanOrEqual(100)
  })
})
