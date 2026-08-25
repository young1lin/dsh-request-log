/**
 * UI dictionary shapes shared by the list view and the detail viewer.
 */

/** Tiny {placeholder} interpolation shared by the list and detail views. */
export function interp(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? ''))
}

export interface DetailDict {
  back: string
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
  toolsLabel: string
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
  loadError: string
}

export interface ViewDict {
  tab: string
  empty: string
  emptyHint: string
  error: string
  retry: string
  refresh: string
  auto: string
  calls: string
  time: string
  model: string
  ttft: string
  totalTime: string
  colSpeed: string
  speedHint: string
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
  sumInput: string
  sumCacheRead: string
  sumHitRate: string
  sumCacheWrite: string
  sumOutput: string
  /** Load-older button label; {count} = entries not yet loaded. */
  loadMore: string
  detail: DetailDict
}
