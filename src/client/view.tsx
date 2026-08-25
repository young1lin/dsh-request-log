/**
 * The Requests tab body: session call summary, the call list with timing and
 * token columns, and drill-down into the detail viewer.
 */

import { React, h } from './react'
import type { CallIndexEntry } from '../shared/types'
import { ApiError, fetchCalls, formatDateTime, formatDuration, formatPct, formatTime, formatTokens, formatTokPerSec } from './data'
import { makeCallDetail } from './detail'
import { interp, type ViewDict } from './dict'

export interface DictSource {
  dictOf: () => ViewDict
  subscribe: (fn: () => void) => () => void
}

/** Re-render on locale change and read the active dictionary at render time. */
function useDict(source: DictSource): ViewDict {
  const [, force] = React.useState(0)
  React.useEffect(() => source.subscribe(() => { force(value => value + 1) }), [source])
  return source.dictOf()
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; calls: CallIndexEntry[]; total: number }

const PAGE_SIZE = 100

function StatusDot(props: { status: string }): React.ReactElement {
  const cls = props.status === 'ok' ? 'rl-dot-ok' : props.status === 'open' ? 'rl-dot-open' : 'rl-dot-bad'
  return h('span', { className: 'rl-dot ' + cls })
}

/**
 * The prior call of the same logical conversation (oldest-first list):
 * the nearest OLDER entry — a lower index — with a different request hash
 * (retries share one), the same purpose, and a successful finish — what the
 * Responses chained view reconstructs its delta against.
 */
function prevIdOf(calls: CallIndexEntry[], index: number): string | undefined {
  const current = calls[index]
  if (current === undefined) return undefined
  for (let j = index - 1; j >= 0; j -= 1) {
    const candidate = calls[j]
    if (candidate === undefined) continue
    if (candidate.requestHash === current.requestHash) continue
    if (candidate.purpose !== current.purpose) continue
    if (candidate.status !== 'ok') continue
    return candidate.id
  }
  return undefined
}

/** Sum the loaded window's usage into the overview card. */
function summarize(calls: CallIndexEntry[]): {
  count: number
  /** Billed input = uncached input + cache hits + cache writes, per call. */
  billed: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
} {
  let billed = 0
  let input = 0
  let cacheRead = 0
  let cacheWrite = 0
  let output = 0
  for (const call of calls) {
    const usage = call.usage
    if (usage === undefined) continue
    const read = usage.cacheReadTokens ?? 0
    const write = usage.cacheWriteTokens ?? 0
    input += usage.inputTokens ?? 0
    cacheRead += read
    cacheWrite += write
    billed += (usage.inputTokens ?? 0) + read + write
    output += usage.outputTokens ?? 0
  }
  return { count: calls.length, billed, input, cacheRead, cacheWrite, output }
}

function CallRow(props: {
  call: CallIndexEntry
  dict: ViewDict
  onOpen: () => void
}): React.ReactElement {
  const call = props.call
  const dict = props.dict
  const usage = call.usage
  const streamMs = call.durationMs !== undefined && call.ttfbMs !== undefined
    ? call.durationMs - call.ttfbMs
    : undefined
  const billed = usage === undefined
    ? undefined
    : usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  const DASH = '\u2013'
  const numCls = (text: string, extra?: string): string =>
    'rl-cell rl-c-num'
    + (extra === undefined ? '' : ' ' + extra)
    + (text === DASH ? ' rl-none' : '')
  const ttft = formatDuration(call.ttfbMs)
  const total = formatDuration(call.durationMs)
  const speed = formatTokPerSec(usage?.outputTokens, streamMs)
  const input = formatTokens(usage?.inputTokens)
  const hit = formatTokens(usage?.cacheReadTokens)
  const write = formatTokens(usage?.cacheWriteTokens)
  const out = formatTokens(usage?.outputTokens)
  return h('button', { className: 'rl-row', onClick: props.onOpen },
    h('span', {
      className: 'rl-cell rl-c-time',
      // HH:MM:SS alone is ambiguous across midnight; hover shows the date.
      title: formatDateTime(call.startedAt),
    }, formatTime(call.startedAt)),
    h('span', { className: 'rl-cell rl-c-model' },
      h(StatusDot, { status: call.status }),
      h('span', { className: 'rl-model-name', title: call.provider + ' · ' + call.model }, call.model),
      call.purpose !== undefined
        ? h('span', { className: 'rl-badge' }, call.purpose)
        : null,
      call.attempt > 1
        ? h('span', {
            className: 'rl-badge rl-badge-retry',
            title: dict.retryOf,
          }, '×' + String(call.attempt))
        : null),
    h('span', { className: numCls(ttft) }, ttft),
    h('span', { className: numCls(total) }, total),
    h('span', { className: numCls(speed), title: dict.speedHint }, speed),
    h('span', {
      className: numCls(input),
      // Uncached input; hover shows the call's billed input (the total the
      // provider actually counted against the context).
      title: dict.detail.billedInput + ': ' + (billed === undefined ? DASH : formatTokens(billed)),
    }, input),
    h('span', { className: numCls(hit, 'rl-td-hit') }, hit),
    h('span', {
      className: numCls(formatPct(usage?.cacheReadTokens, billed), 'rl-td-hit'),
      title: dict.hitRateHint,
    }, formatPct(usage?.cacheReadTokens, billed)),
    h('span', { className: numCls(write) }, write),
    h('span', { className: numCls(out, 'rl-td-out') }, out),
    h('span', {
      className: 'rl-cell rl-c-size',
      title: dict.sizeHint + (call.toolNames === undefined || call.toolNames.length === 0
        ? ''
        : ' · ' + call.toolNames.join(', ')),
    },
      String(call.messageCount) + '/' + String(call.toolCount)))
}

export function makeRequestLogView(source: DictSource): (props: { sessionId?: string }) => React.ReactElement {
  function RequestLogView(props: { sessionId?: string }): React.ReactElement {
    const dict = useDict(source)
    const CallDetail = React.useMemo(() => makeCallDetail(source), [source])
    const sessionId = props.sessionId
    const [state, setState] = React.useState<LoadState>({ kind: 'loading' })
    const [auto, setAuto] = React.useState(true)
    const [selected, setSelected] = React.useState<{ id: string; prevId?: string } | null>(null)
    const [tick, setTick] = React.useState(0)
    // How many of the newest calls the ledger shows; "Load older" grows it.
    // One fetch of `limit` newest entries keeps refresh simple and the whole
    // loaded window consistent (the server caps it at its own MAX_LIMIT).
    const [limit, setLimit] = React.useState(PAGE_SIZE)
    // Chronological ledger like the Trajectory tab: oldest first, the view
    // pinned to the newest call at the bottom until the user scrolls away.
    // The real scroller may be .rl-root itself OR a bounded ancestor pane
    // (the host slot decides), so pin whichever actually overflows.
    const scrollRef = React.useRef<HTMLDivElement | null>(null)
    const stickToBottom = React.useRef(true)
    const pinnedRef = React.useRef<HTMLElement | null>(null)
    const onScroll = React.useCallback((event?: { target?: EventTarget | null }): void => {
      const el = (event?.target ?? scrollRef.current) as HTMLElement | null
      if (el === null || el === undefined) return
      stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    }, [])
    React.useLayoutEffect(() => {
      if (state.kind !== 'ready') return
      const root = scrollRef.current
      if (root === null) return
      let node: HTMLElement | null = root
      let scroller: HTMLElement | null = null
      while (node !== null) {
        if (node.scrollHeight > node.clientHeight + 1) { scroller = node; break }
        node = node.parentElement
      }
      const target = scroller ?? root
      if (pinnedRef.current !== target) {
        if (pinnedRef.current !== null) pinnedRef.current.removeEventListener('scroll', onScroll)
        target.addEventListener('scroll', onScroll, { passive: true })
        pinnedRef.current = target
      }
      if (stickToBottom.current) target.scrollTop = target.scrollHeight
    }, [state, onScroll])
    React.useEffect(() => () => {
      if (pinnedRef.current !== null) pinnedRef.current.removeEventListener('scroll', onScroll)
    }, [onScroll])

    const refresh = React.useCallback((): void => {
      setTick(value => value + 1)
    }, [])

    React.useEffect(() => {
      if (typeof sessionId !== 'string' || sessionId === '') return
      let cancelled = false
      const load = async (): Promise<void> => {
        try {
          const page = await fetchCalls(sessionId, limit, 0)
          if (cancelled) return
          // The API pages newest-first; the ledger renders oldest-first so
          // the newest call sits at the bottom, like the Trajectory tab.
          setState({ kind: 'ready', calls: page.calls.slice().reverse(), total: page.total })
        } catch (error) {
          if (cancelled) return
          const message = error instanceof ApiError ? error.message : String(error)
          setState({ kind: 'error', message })
        }
      }
      void load()
      return () => { cancelled = true }
    }, [sessionId, tick, limit])

    React.useEffect(() => {
      if (!auto || selected !== null) return
      const timer = setInterval(() => { setTick(value => value + 1) }, 3000)
      return () => clearInterval(timer)
    }, [auto, selected])

    if (typeof sessionId !== 'string' || sessionId === '') {
      return h('div', { className: 'rl-root' },
        h('div', { className: 'rl-empty' }, dict.emptyHint))
    }

    if (selected !== null) {
      return h(CallDetail, {
        sessionId,
        callId: selected.id,
        ...selected.prevId === undefined ? {} : { prevId: selected.prevId },
        onBack: () => { stickToBottom.current = true; setSelected(null); refresh() },
      })
    }

    if (state.kind === 'loading') {
      return h('div', { className: 'rl-root' }, h('div', { className: 'rl-empty' }, '…'))
    }
    if (state.kind === 'error') {
      return h('div', { className: 'rl-root' },
        h('div', { className: 'rl-empty' },
          h('div', {}, dict.error + ': ' + state.message),
          h('button', { className: 'rl-btn', onClick: refresh }, dict.retry)))
    }
    if (state.calls.length === 0) {
      return h('div', { className: 'rl-root' },
        h('div', { className: 'rl-empty' },
          h('div', { className: 'rl-empty-title' }, dict.empty),
          h('div', { className: 'rl-empty-hint' }, dict.emptyHint)))
    }

    const sums = summarize(state.calls)
    const stat = (label: string, value: string, cls?: string, title?: string): React.ReactElement =>
      h('div', {
        className: 'rl-stat' + (cls === undefined ? '' : ' ' + cls),
        ...title === undefined ? {} : { title },
      },
        h('span', { className: 'rl-stat-label' }, label),
        h('span', { className: 'rl-stat-value' }, value))

    // The head and summary ride a sticky wrapper: the ledger pins to the
    // newest call at the bottom (and the real scroller may be an ancestor
    // pane), so without it the totals land off-screen exactly when the
    // reader arrives.
    return h('div', { className: 'rl-root', ref: scrollRef, onScroll },
      h('div', { className: 'rl-fixed-head' },
        h('div', { className: 'rl-head' },
          h('span', { className: 'rl-head-title' }, dict.calls + ' · ' + String(state.total)),
          h('span', { className: 'rl-head-actions' },
            h('button', {
              className: 'rl-btn' + (auto ? ' rl-btn-on' : ''),
              onClick: () => { setAuto(value => !value) },
            }, dict.auto),
            h('button', { className: 'rl-btn', onClick: refresh }, dict.refresh))),
        h('div', { className: 'rl-stats' },
          stat(dict.sumCalls, String(sums.count) + (sums.count < state.total ? '+' : '')),
          stat(dict.sumBilledInput, formatTokens(sums.billed), undefined, dict.sumBilledInputHint),
        stat(dict.sumInput, formatTokens(sums.input)),
        stat(dict.sumCacheRead, formatTokens(sums.cacheRead), 'rl-stat-hit'),
        stat(dict.sumHitRate, formatPct(sums.cacheRead, sums.billed), 'rl-stat-hit'),
          stat(dict.sumCacheWrite, formatTokens(sums.cacheWrite)),
          stat(dict.sumOutput, formatTokens(sums.output), 'rl-stat-out'))),
      state.calls.length < state.total
        ? h('div', { className: 'rl-loadmore' },
            h('button', {
              className: 'rl-btn',
              onClick: () => { setLimit(value => value + PAGE_SIZE) },
            }, interp(dict.loadMore, { count: state.total - state.calls.length })))
        : null,
      h('div', { className: 'rl-table' },
        h('div', { className: 'rl-row rl-row-head' },
          h('span', { className: 'rl-cell rl-c-time' }, dict.time),
          h('span', { className: 'rl-cell rl-c-model' }, dict.model),
          h('span', { className: 'rl-cell rl-c-num' }, dict.ttft),
          h('span', { className: 'rl-cell rl-c-num' }, dict.totalTime),
          h('span', { className: 'rl-cell rl-c-num' }, dict.colSpeed),
          h('span', { className: 'rl-cell rl-c-num' }, dict.colIn),
          h('span', { className: 'rl-cell rl-c-num rl-th-hit' }, dict.colCacheRead),
          h('span', { className: 'rl-cell rl-c-num rl-th-hit' }, dict.colHitRate),
          h('span', { className: 'rl-cell rl-c-num' }, dict.colCacheWrite),
          h('span', { className: 'rl-cell rl-c-num rl-th-out' }, dict.colOut),
          h('span', { className: 'rl-cell rl-c-size' }, dict.size)),
        state.calls.map((call, index) => {
          const prevId = prevIdOf(state.calls, index)
          return h(CallRow, {
            key: call.id,
            call,
            dict,
            onOpen: () => { setSelected({ id: call.id, ...prevId === undefined ? {} : { prevId } }) },
          })
        })))
  }

  return RequestLogView
}
