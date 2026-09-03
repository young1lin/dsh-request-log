/**
 * UI dictionary shapes shared by the list view and the detail viewer.
 */

/** Tiny {placeholder} interpolation shared by the list and detail views. */
export function interp(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? ''))
}

export interface DetailDict {
  back: string
  /** Label of the step row in the call card; {n} = step number. */
  step: string
  timingCard: string
  startedAt: string
  waitPhase: string
  waitHint: string
  streamPhase: string
  streamHint: string
  totalPhase: string
  usageCard: string
  usageNone: string
  input: string
  cacheRead: string
  cacheWrite: string
  output: string
  reasoning: string
  hitRate: string
  billedInput: string
  outSpeed: string
  outSpeedHint: string
  callCard: string
  provider: string
  model: string
  effort: string
  attempt: string
  retryOf: string
  finish: string
  size: string
  msgs: string
  callsLabel: string
  /** Tooltip on the size row: what the tool-call count counts. */
  callsHint: string
  request: string
  response: string
  neutral: string
  reconstructed: string
  expandAll: string
  expandHint: string
  collapseAll: string
  collapseHint: string
  chainOn: string
  chainOff: string
  copy: string
  copied: string
  /** Copy-button label after a failed clipboard write. */
  copyFailed: string
  loadError: string
  /** JSON tree strings (see ./json JsonLabels). */
  jsonCollapse: string
  jsonExpand: string
  jsonChars: string
  jsonViewAsJson: string
  jsonViewAsText: string
  jsonViewAsJsonTitle: string
  jsonViewAsTextTitle: string
  jsonCollapseStringTitle: string
  jsonOpenString: string
  jsonOpenStringTitle: string
  jsonChip: string
  jsonTruncated: string
  jsonItems: string
  jsonKeys: string
  jsonNodeBudget: string
  /** Depth-cap hint of the JSON tree; {count} = the depth cap. */
  jsonDepthBudget: string
  /** Title shown when a render crash was caught by the boundary. */
  renderError: string
  /** Retry button of the render-crash fallback. */
  renderRetry: string
}

/** 统计 panel strings: metric-group tabs, states, legend helpers. */
export interface ChartsDict {
  /** Head-actions toggle label. */
  toggle: string
  toggleHint: string
  /** Metric-group tab labels. */
  groupHitRate: string
  groupTokens: string
  groupLatency: string
  groupSpeed: string
  /** Token-group stack toggle + its tooltip. */
  stacks: string
  stacksHint: string
  /** Token-group cumulative (running-total) toggle + its tooltip. */
  cumulative: string
  cumulativeHint: string
  /** Shown when no plotted value exists anywhere. */
  emptyTitle: string
  emptyHint: string
  /** A group exists but every point is null (metric never reported). */
  allNull: string
  /** Tooltip for ≈-tagged speed points: what the approximation covers. */
  speedApproxHint: string
  /** Short badge + tooltip about auxiliary calls off the step axis. */
  excludedShort: string
  excludedHint: string
}

export interface ViewDict {
  tab: string
  empty: string
  emptyHint: string
  error: string
  retry: string
  /** Tooltip: what the #N step badge on a row means. */
  stepHint: string
  /** Banner shown when the last refresh failed but stale data is kept. */
  stale: string
  refresh: string
  auto: string
  calls: string
  time: string
  model: string
  ttft: string
  totalTime: string
  colSpeed: string
  speedHint: string
  colBilledInput: string
  colIn: string
  colCacheRead: string
  hitRateHint: string
  colHitRate: string
  colCacheWrite: string
  colOut: string
  size: string
  sizeHint: string
  retryOf: string
  sumCalls: string
  sumBilledInput: string
  /** Tooltip: what the billed-input total counts. */
  sumBilledInputHint: string
  sumInput: string
  sumCacheRead: string
  sumHitRate: string
  sumCacheWrite: string
  sumOutput: string
  /** Label of the disk-footprint stat. Says ADDED, never total — see sumStorageHint. */
  sumStorage: string
  /**
   * Tooltip behind {@link sumStorage}: {envelope}, {objects}, {pct}, {cap}.
   * Must keep saying that the figure is MARGINAL — a piece already stored
   * bills nothing — or readers will read it as the transcript's weight.
   */
  sumStorageHint: string
  /** Load-older button label; {count} = entries not yet loaded. */
  loadMore: string
  charts: ChartsDict
  detail: DetailDict
}
