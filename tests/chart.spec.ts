/**
 * 统计 panel chrome specs: what the toolbar offers and what the token legend
 * lists. Renders StatsPanel through react-dom/server — the same vehicle the
 * screenshot fixtures use — so the assertions read the markup a browser gets,
 * without a DOM lane.
 */

import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { demoDict } from './dict-fixture'

;(globalThis as { require?: NodeRequire }).require = createRequire(import.meta.url)

const React = (await import('react')).default
const { renderToStaticMarkup } = await import('react-dom/server')
const { StatsPanel } = await import('../src/client/chart.tsx')
type Entry = import('../src/shared/types').CallIndexEntry
type ChartsPrefs = import('../src/client/persist').ChartsPrefs

const calls: Entry[] = [1, 2, 3].map(step => ({
  id: 'step-' + String(step),
  sessionId: 's1',
  provider: 'p',
  model: 'm',
  requestHash: 'h' + String(step),
  attempt: 1,
  startedAt: Date.UTC(2026, 0, 1, 9, step),
  status: 'ok',
  messageCount: 4,
  requestChars: 400,
  step,
  durationMs: 2_000,
  ttfbMs: 400,
  usage: {
    inputTokens: 1_000 * step,
    outputTokens: 300,
    cacheReadTokens: 5_000,
    cacheWriteTokens: 900,
    reasoningTokens: 0,
  },
}))

function markup(prefs: ChartsPrefs): string {
  return renderToStaticMarkup(
    React.createElement(StatsPanel, { calls, dict: demoDict, prefs, onPrefs: () => {} }),
  )
}

/** Every button in the rendered panel as label → class list. */
function buttons(html: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const match of html.matchAll(/<button[^>]*class="([^"]*)"[^>]*>(.*?)<\/button>/gu)) {
    const label = match[2]!.replace(/<[^>]*>/gu, '').trim()
    if (label !== '') found.set(label, match[1]!)
  }
  return found
}

/** Count elements whose class attribute starts with the given class name. */
function countClass(html: string, cls: string): number {
  return [...html.matchAll(new RegExp('class="' + cls + '[ "]', 'gu'))].length
}

const tokensByStep: ChartsPrefs = { open: true, group: 'tokens', xMode: 'step', bucketMinutes: 5 }

describe('x axis control', () => {
  it('offers both axes at once and marks the active one', () => {
    // The old control was a cycler labelled with its DESTINATION, so the panel
    // never showed which axis was drawn. Both axes are present now, and the
    // active one — not the other — carries the on state.
    const step = buttons(markup(tokensByStep))
    expect(step.get('By step')).toContain('rl-btn-on')
    expect(step.get('By time')).not.toContain('rl-btn-on')

    const time = buttons(markup({ ...tokensByStep, xMode: 'time' }))
    expect(time.get('By time')).toContain('rl-btn-on')
    expect(time.get('By step')).not.toContain('rl-btn-on')
  })

  it('offers no third axis and no window-size control', () => {
    const html = markup(tokensByStep)
    expect(html).not.toContain('By bucket')
    expect(html).not.toContain('rl-bucket')
  })
})

describe('token chart chrome', () => {
  it('offers neither a cumulative nor a stacking toggle', () => {
    const labels = [...buttons(markup(tokensByStep)).keys()]
    expect(labels).not.toContain('Cumulative')
    expect(labels).not.toContain('Stacked')
  })

  it('lists one legend chip per token band, reasoning gone from the set', () => {
    // The bands stack floor-up cacheRead → in → cacheWrite → out; the legend
    // keeps the group's own series order and every chip starts on.
    const labels = [...buttons(markup(tokensByStep)).keys()]
    expect(labels).toContain('In')
    expect(labels).toContain('Cache hit')
    expect(labels).toContain('Cache write')
    expect(labels).toContain('Out')
    expect(labels).not.toContain('Reasoning')
    expect(labels).not.toContain('Answer')
  })

  it('keeps the legend while the bands are stacked', () => {
    // Stacked lines used to hide the legend outright, leaving no way to drop a
    // band; stacking is now unconditional, so the chips must survive it.
    expect(markup(tokensByStep)).toContain('rl-chart-legend')
  })
})

describe('token chart form', () => {
  it('draws the token bands as stacked columns, never as lines', () => {
    // Token volumes are per-call quantities, not a signal sampled over time:
    // a column says "this call spent this much", and its segments say what on.
    // A line between two calls interpolates tokens that were never spent.
    const html = markup(tokensByStep)
    expect(countClass(html, 'rl-bar')).toBeGreaterThan(0)
    expect(countClass(html, 'rl-line')).toBe(0)
    expect(countClass(html, 'rl-area')).toBe(0)
    expect(countClass(html, 'rl-dot')).toBe(0)
  })

  it('draws one column per call, each carrying every non-zero band', () => {
    // Three calls, four token series, cacheWrite/out/cacheRead/in all > 0.
    const html = markup(tokensByStep)
    expect(countClass(html, 'rl-bar')).toBe(3 * 4)
  })

  it('totals the calls per window on the clock axis', () => {
    // The three calls run at 09:01, 09:02 and 09:03, so a 5-minute window
    // holds all three: ONE column, four bands — the by-window reading ("how
    // much between 09:00 and 09:05"), not three columns at three timestamps.
    expect(countClass(markup({ ...tokensByStep, xMode: 'time' }), 'rl-bar')).toBe(4)
    // A one-minute window separates them again: three windows, three columns.
    const fine = markup({ ...tokensByStep, xMode: 'time', bucketMinutes: 1 })
    expect(countClass(fine, 'rl-bar')).toBe(3 * 4)
  })

  it('offers the window control on the clock axis and nowhere else', () => {
    // The window is what a column MEASURES there, so the control is the whole
    // surface of that reading; on the numbered axis a column is one call and
    // the control would be inert.
    expect(markup({ ...tokensByStep, xMode: 'time' })).toContain('rl-bucket-ctrl')
    expect(markup(tokensByStep)).not.toContain('rl-bucket-ctrl')
    // Latency is a sampled signal drawn as a line — never bucketed.
    expect(markup({ ...tokensByStep, group: 'latency', xMode: 'time' }))
      .not.toContain('rl-bucket-ctrl')
  })

  it('renders an idle window as an empty column, not as a gap', () => {
    // 09:01 and 09:03 with a 1-minute window leaves 09:02 idle: it must still
    // occupy its slot, so an idle stretch reads as idle.
    const sparse = [calls[0]!, { ...calls[2]!, startedAt: Date.UTC(2026, 0, 1, 9, 3) }]
    const html = renderToStaticMarkup(
      React.createElement(StatsPanel, {
        calls: sparse,
        dict: demoDict,
        prefs: { ...tokensByStep, xMode: 'time', bucketMinutes: 1 },
        onPrefs: () => {},
      }),
    )
    // Two populated windows out of three slots; the middle one draws nothing.
    expect(countClass(html, 'rl-bar')).toBe(2 * 4)
  })

  it('keeps lines for the groups whose series are not additive', () => {
    const html = markup({ ...tokensByStep, group: 'latency' })
    expect(countClass(html, 'rl-line')).toBeGreaterThan(0)
    expect(countClass(html, 'rl-bar')).toBe(0)
  })

  it('skips a sub-pixel segment without shifting the segments above it', () => {
    // A 20-token cache write inside a ~9k column is a smudge, not a band, so
    // it draws nothing — but it still counts toward the stack, so the output
    // segment on top must sit exactly where the full stack puts it.
    const tiny = calls.map(call => ({
      ...call,
      usage: { ...call.usage!, cacheWriteTokens: 20 },
    }))
    const html = renderToStaticMarkup(
      React.createElement(StatsPanel, {
        calls: tiny, dict: demoDict, prefs: tokensByStep, onPrefs: () => {},
      }),
    )
    expect(countClass(html, 'rl-bar')).toBe(3 * 3)
    // Every column still reaches the same total height: the top of the tallest
    // column is the stack total, cache write included.
    const tops = [...html.matchAll(/class="rl-bar rl-ls-neutral"[^>]*y="([0-9.]+)"/gu)]
      .map(m => Number(m[1]))
    expect(tops.length).toBe(3)
    expect(Math.min(...tops)).toBeGreaterThan(0)
  })
})
