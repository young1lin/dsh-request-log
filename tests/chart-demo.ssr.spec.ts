/**
 * Screenshot-fixture generator (not an assertion spec): renders StatsPanel
 * through react-dom/server for every metric group over deterministic mock
 * data, writing standalone HTML files under .tmp/ for headless-Chrome
 * screenshots. Skipped assertions; generation only.
 */

import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'vitest'

;(globalThis as { require?: NodeRequire }).require = createRequire(import.meta.url)

const React = (await import('react')).default
const { renderToStaticMarkup } = await import('react-dom/server')
const { StatsPanel } = await import('../src/client/chart.tsx')
type Entry = import('../src/shared/types').CallIndexEntry
type Dict = import('../src/client/dict').ViewDict

let fixtureSeq = 0

function entryOf(overrides: Partial<Entry>): Entry {
  return {
    sessionId: 's1',
    provider: 'zai-coding-cn',
    model: 'glm-5.3',
    requestHash: 'h' + String(Math.random()),
    attempt: 1,
    startedAt: Date.now(),
    status: 'ok',
    messageCount: 10,
    requestChars: 4_000,
    id: 'fixture-' + String(++fixtureSeq),
    ...overrides,
  }
}

/** Deterministic pseudo-random so fixtures are reproducible. */
function lcg(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1_102_352_457 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
}

const rand = lcg(42)
const BASE = Date.UTC(2025, 5, 1, 9, 0, 0)

// 48 steps: cold-start step 1, warm plateau, occasional errors/retries,
// compaction resets at 23 (cache drops), gradual drift afterwards.
const calls: Entry[] = []
let contextTokens = 12_000
for (let step = 1; step <= 48; step += 1) {
  contextTokens += Math.round(800 + rand() * 4_000)
  const errored = step === 7 || step === 19
  const compacted = step === 23 || step === 40
  if (compacted) contextTokens = 14_000 + Math.round(rand() * 3_000)
  const usage = errored
    ? undefined
    : {
        inputTokens: Math.round(contextTokens * (0.06 + rand() * 0.04)),
        outputTokens: Math.round(300 + rand() * 1_600),
        cacheReadTokens: Math.round(contextTokens * (compacted ? rand() * 0.15 : step === 1 ? 0 : 0.82 + rand() * 0.15)),
        ...(rand() > 0.75 ? { cacheWriteTokens: Math.round(500 + rand() * 4_000) } : {}),
      }
  calls.push(entryOf({
    id: 'call-' + String(step),
    step,
    requestHash: 'hash-' + String(step),
    startedAt: BASE + step * 95_000 + Math.round(rand() * 30_000),
    status: errored ? 'error' : 'ok',
    finishKind: errored ? 'error' : rand() > 0.5 ? 'tool-calls' : 'stop',
    durationMs: Math.round(1_400 + rand() * 22_000),
    ttfbMs: Math.round(700 + rand() * 4_200),
    messageCount: step * 2,
    toolCalls: errored ? undefined : Math.max(1, Math.round(rand() * 4)),
    usage,
  }))
}
calls.push(entryOf({ id: 'title-aux', purpose: 'session-title', status: 'ok', messageCount: 2 }))
calls.push(entryOf({
  id: 'compact-aux', purpose: 'compaction', status: 'ok', messageCount: 60,
  startedAt: BASE + 23 * 90_000, durationMs: 48_000, ttfbMs: 900,
  usage: { inputTokens: 61_000, outputTokens: 3_100 },
}))

const dict: Dict = {
  tab: 'Requests', empty: '', emptyHint: '', error: '', retry: '',
  stepHint: '', stale: '', refresh: 'Refresh', auto: 'Auto', calls: 'Provider calls',
  time: 'Time', model: 'Model', ttft: 'TTFT', totalTime: 'Total',
  colSpeed: 'Speed', speedHint: '', colBilledInput: 'Total in', colIn: 'In',
  colCacheRead: 'Cache hit', hitRateHint: '', colHitRate: 'Hit %',
  colCacheWrite: 'Cache write', colOut: 'Out', size: 'Msg/Calls', sizeHint: '',
  retryOf: '', sumCalls: 'Calls', sumBilledInput: 'Total in', sumBilledInputHint: '',
  sumInput: 'Input', sumCacheRead: 'Cache hit', sumHitRate: 'Hit rate',
  sumCacheWrite: 'Cache write', sumOutput: 'Output',
  sumStorage: 'Disk added', sumStorageHint: '', loadMore: '',
  charts: {
    toggle: 'Charts', toggleHint: '',
    groupHitRate: 'Hit rate', groupTokens: 'Tokens', groupLatency: 'Latency', groupSpeed: 'Speed',
    stacks: 'Stacked', stacksHint: '',
    cumulative: 'Cumulative', cumulativeHint: '',
    xAxisToStep: 'By step', xAxisToTime: 'By time', xAxisHint: '',
    emptyTitle: 'Nothing to plot yet', emptyHint: '', allNull: '',
    speedApproxHint: 'Approximate.',
    excludedShort: '{count} aux',
    excludedHint: '{count} auxiliary calls are not on the numbered step axis.',
  },
  detail: {
    back: '', step: '', timingCard: '', startedAt: '', waitPhase: '', waitHint: '',
    streamPhase: '', streamHint: '', totalPhase: '', usageCard: '', usageNone: '',
    input: '', cacheRead: '', cacheWrite: '', output: '', reasoning: '', hitRate: '',
    billedInput: '', outSpeed: '', outSpeedHint: '', callCard: '', provider: '', model: '',
    effort: '', attempt: '', retryOf: '', finish: '', size: '', msgs: '', callsLabel: '',
    callsHint: '', request: '', response: '', neutral: '', reconstructed: '',
    expandAll: '', expandHint: '', collapseAll: '', collapseHint: '',
    chainOn: '', chainOff: '', copy: '', copied: '', copyFailed: '', loadError: '',
    jsonCollapse: '', jsonExpand: '', jsonChars: '', jsonViewAsJson: '', jsonViewAsText: '',
    jsonViewAsJsonTitle: '', jsonViewAsTextTitle: '', jsonCollapseStringTitle: '',
    jsonOpenString: '', jsonOpenStringTitle: '', jsonChip: '', jsonTruncated: '',
    jsonItems: '', jsonKeys: '', jsonNodeBudget: '', jsonDepthBudget: '',
    renderError: '', renderRetry: '',
  },
}

const css = readFileSync(join(import.meta.dirname, '..', 'src', 'client', 'styles.css'), 'utf8')

function page(title: string, inner: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title><style>',
    ':root { color-scheme: dark;',
    '--dsw-alias-bg-layer-1:#141a24;--dsw-alias-bg-layer-2:#1b2431;',
    '--dsw-alias-border-l1:#28344a;--dsw-alias-border-l2:#3c4c6e;',
    '--dsw-alias-label-primary:#e8edf6;--dsw-alias-label-secondary:#aab6cc;',
    '--dsw-alias-label-tertiary:#66738f;--dsw-alias-label-foreground:#ffffff;',
    '--dsw-alias-label-primary-bluish:#7fb2ff;',
    '--dsw-alias-state-success-primary:#39c98e;--dsw-alias-state-success-secondary:#2ba374;',
    '--dsw-alias-state-warn-primary:#e6b450;--dsw-alias-state-warn-label:#e6b450;',
    '--dsw-alias-state-error-primary:#f26d78;--dsw-alias-state-business-primary:#5ac8fa;',
    '--dsw-alias-brand-text:#e8edf6;--dsw-alias-brand-primary:#4f8ff7;',
    '--dsw-alias-button-primary-fill:#24304a;',
    '--dsw-alias-interactive-bg-hover:#222c3f;--dsw-alias-interactive-bg-active:#28334a;',
    '}',
    'body{margin:0;background:var(--dsw-alias-bg-layer-1);font-family:system-ui,sans-serif;}',
    css,
    '</style></head><body>',
    '<div style="max-width:820px;margin:16px auto;padding-bottom:24px;">',
    '<h3 style="color:var(--dsw-alias-label-secondary);font-weight:500;font-size:13px;">' + title + '</h3>',
    '<div class="rl-root" style="min-height:auto;display:block;">' + inner + '</div>',
    '</div></body></html>',
  ].join('')
}

describe('stats panel screenshot fixtures', () => {
  it('renders every metric group to .tmp/*.html', () => {
    mkdirSync('.tmp', { recursive: true })
    const variants: { name: string; prefs: import('../src/client/persist').ChartsPrefs }[] = [
      { name: 'hitrate', prefs: { open: true, group: 'hitrate', stacks: false, cumulative: true, xMode: 'step' } },
      { name: 'tokens-lines', prefs: { open: true, group: 'tokens', stacks: false, cumulative: false, xMode: 'step' } },
      { name: 'tokens-cumulative', prefs: { open: true, group: 'tokens', stacks: false, cumulative: true, xMode: 'step' } },
      { name: 'tokens-cumulative-stacked', prefs: { open: true, group: 'tokens', stacks: true, cumulative: true, xMode: 'step' } },
      { name: 'tokens-stacked', prefs: { open: true, group: 'tokens', stacks: true, cumulative: false, xMode: 'step' } },
      { name: 'latency', prefs: { open: true, group: 'latency', stacks: false, cumulative: true, xMode: 'step' } },
      { name: 'speed', prefs: { open: true, group: 'speed', stacks: false, cumulative: true, xMode: 'step' } },
      // The clock axis: idle gaps become distance, cumulative becomes an area.
      { name: 'time-hitrate', prefs: { open: true, group: 'hitrate', stacks: false, cumulative: true, xMode: 'time' } },
      { name: 'time-tokens-lines', prefs: { open: true, group: 'tokens', stacks: false, cumulative: false, xMode: 'time' } },
      { name: 'time-tokens-area', prefs: { open: true, group: 'tokens', stacks: false, cumulative: true, xMode: 'time' } },
      { name: 'time-latency', prefs: { open: true, group: 'latency', stacks: false, cumulative: true, xMode: 'time' } },
    ]
    for (const variant of variants) {
      const html = page(variant.name, renderToStaticMarkup(
        React.createElement(StatsPanel, { calls, dict, prefs: variant.prefs, onPrefs: () => {} }),
      ))
      writeFileSync('.tmp/demo-' + variant.name + '.html', html)
    }
  })
})
