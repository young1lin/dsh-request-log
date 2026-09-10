/**
 * The bilingual dictionary reduced to what the chart and ledger specs need:
 * every key present (ViewDict is exhaustive), only the strings a spec
 * asserts on carrying real text. Not a *.spec.ts, so vitest never collects
 * it as a suite — it is a fixture two specs share.
 */

import type { ViewDict } from '../src/client/dict'

export const demoDict: ViewDict = {
  tab: 'Requests', empty: '', emptyHint: '', error: '', retry: '',
  stepHint: '', stale: '', refresh: 'Refresh', refreshHint: '', auto: 'Auto', autoHint: '',
  time: 'Time', model: 'Model', modelAll: 'All models', modelFilterHint: '', ttft: 'TTFT', totalTime: 'Total',
  colSpeed: 'Speed', speedHint: '', colBilledInput: 'Total in', colIn: 'In',
  colCacheRead: 'Cache hit', hitRateHint: '', colHitRate: 'Hit %',
  colCacheWrite: 'Cache write', colOut: 'Out',
  size: 'Msg/Calls', sizeHint: '',
  retryOf: '', sumCalls: 'Calls', sumCallsOf: 'of {total} calls',
  sumFailed: 'Failed', sumFailedHint: '{errors} errors · {aborts} aborted',
  sumRetried: 'Retried', sumRetriedHint: '',
  sumBilledInput: 'Total in', sumBilledInputHint: '',
  sumInput: 'Input', sumUncached: 'uncached', sumCached: 'cached', sumWritten: 'written', sumHitRate: 'Hit rate',
  sumCacheWrite: 'Cache write', sumOutput: 'Output',
  sumStorage: 'Disk added', sumStorageHint: '', sumStoragePath: '', backToTop: '', toLatest: '',
  charts: {
    toggle: 'Charts', toggleHint: '',
    groupHitRate: 'Hit rate', groupTokens: 'Tokens', groupLatency: 'Latency', groupSpeed: 'Speed',
    xAxisTime: 'By time', xAxisStep: 'By step', xAxisHint: '',
    bucketSize: 'Window', bucketHint: '', bucketCustom: 'Custom minutes',
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
