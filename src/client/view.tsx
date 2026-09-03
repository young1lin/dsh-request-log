/**
 * The Requests tab body: session call summary, the call list with timing and
 * token columns, and drill-down into the detail viewer.
 *
 * The host view ring renders only the ACTIVE conversation.view tab, so every
 * switch away unmounts this component and its useState with it. What the
 * reader was on — the open detail, its side/format, the loaded window, the
 * Auto toggle — therefore lives in per-session memory (./persist) and re-seeds
 * the ledger on remount.
 */

import { ErrorBoundary, React, h } from './react'
import type { CallIndexEntry, SessionStorageFootprint } from '../shared/types'
import { ApiError, fetchCalls, formatBytes, formatDateTime, formatDuration, formatPct, formatTime, formatToolDispatches, formatTokens, formatTps, speedReading, splitMeasure } from './data'
import { makeCallDetail } from './detail'
import { StatsPanel } from './chart'
import { interp, type ViewDict } from './dict'
import { PAGE_SIZE, loadViewMemory, updateViewMemory, type ChartsPrefs, type DetailPrefs, type SelectedCall } from './persist'

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

const NO_CALLS: CallIndexEntry[] = []

/** The element that actually scrolls for this ledger: .rl-root itself or a bounded ancestor pane. */
function findScroller(root: HTMLElement): HTMLElement {
  let node: HTMLElement | null = root
  while (node !== null) {
    if (node.scrollHeight > node.clientHeight + 1) return node
    node = node.parentElement
  }
  return root
}

/**
 * Reverse newest-first rows into the oldest-first ledger, REUSING the entry
 * objects of a previous load wherever the id matches: React.memo(CallRow)
 * then skips re-diffing unchanged rows across the 3s poll, because their
 * `call` prop keeps its object identity.
 */
export function reconcileCalls(next: CallIndexEntry[], prev: CallIndexEntry[] | undefined): CallIndexEntry[] {
  if (prev === undefined) return next.slice().reverse()
  const prevById = new Map(prev.map(call => [call.id, call]))
  const reversed = next.slice().reverse()
  for (let i = 0; i < reversed.length; i += 1) {
    const call = reversed[i]
    const old = call === undefined ? undefined : prevById.get(call.id)
    if (old !== undefined) reversed[i] = old
  }
  return reversed
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      calls: CallIndexEntry[]
      total: number
      /** Session disk footprint, absent against a server too old to report it. */
      storage?: SessionStorageFootprint
      /** Set when the LAST refresh failed and the data shown is stale. */
      warning?: string
    }

function StatusDot(props: { status: string }): React.ReactElement {
  const cls = props.status === 'ok' ? 'rl-dot-ok' : props.status === 'open' ? 'rl-dot-open' : 'rl-dot-bad'
  return h('span', { className: 'rl-dot ' + cls })
}

/**
 * Precompute, for every entry, the id of the prior call of the same logical
 * conversation: the nearest OLDER entry with a different request hash
 * (retries share one), the same purpose, and a successful finish — what the
 * Responses chained view reconstructs its delta against. One pass, O(n):
 * per purpose the stack of recent ok entries has strictly alternating
 * hashes (same-hash retries collapse into one slot), so a query consults at
 * most the top two slots.
 */
export function prevIdsOf(calls: CallIndexEntry[]): Map<string, string | undefined> {
  const result = new Map<string, string | undefined>()
  const chains = new Map<string, { hash: string; id: string }[]>()
  for (const call of calls) {
    const chain = chains.get(call.purpose ?? '') ?? []
    let prevId: string | undefined = undefined
    // Same hash as the stack top means "same logical call" — look one slot
    // deeper; adjacent slots always differ in hash by construction.
    for (let i = chain.length - 1; i >= 0 && prevId === undefined; i -= 1) {
      const slot = chain[i]
      if (slot.hash !== call.requestHash) prevId = slot.id
    }
    result.set(call.id, prevId)
    if (call.status === 'ok') {
      const top = chain[chain.length - 1]
      if (top === undefined || top.hash !== call.requestHash) chain.push({ hash: call.requestHash, id: call.id })
      else top.id = call.id
    }
    chains.set(call.purpose ?? '', chain)
  }
  return result
}

/** Sum the loaded window's usage into the overview card. */
export function summarize(calls: CallIndexEntry[]): {
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

// Memoized: a 3s poll re-renders the whole ledger, but an unchanged row
// (same call object reference, same dict) skips its subtree diff entirely.
const CallRow = React.memo(function CallRow(props: {
  call: CallIndexEntry
  dict: ViewDict
  onOpen: () => void
}): React.ReactElement {
  const call = props.call
  const dict = props.dict
  const usage = call.usage
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
  // Same reading the chart plots (chart-stats): exact over the stream phase,
  // ≈ over the whole call when that phase is unmeasurable — one number, one
  // meaning, instead of the ledger's old '–' where the chart showed ≈.
  const speedRead = speedReading(usage?.outputTokens, call.durationMs, call.ttfbMs)
  const speed = speedRead === null ? DASH
    : (speedRead.approx ? '\u2248 ' : '') + formatTps(speedRead.tokensPerSecond)
  const input = formatTokens(usage?.inputTokens)
  const hit = formatTokens(usage?.cacheReadTokens)
  const write = formatTokens(usage?.cacheWriteTokens)
  const out = formatTokens(usage?.outputTokens)
  const called = formatToolDispatches(call.calledTools)
  return h('button', { className: 'rl-row', onClick: props.onOpen },
    h('span', {
      className: 'rl-cell rl-c-time',
      // HH:MM:SS alone is ambiguous across midnight; hover shows the date.
      title: formatDateTime(call.startedAt),
    }, formatTime(call.startedAt)),
    h('span', { className: 'rl-cell rl-c-model' },
      h(StatusDot, { status: call.status }),
      h('span', { className: 'rl-model-name', title: call.provider + ' · ' + call.model }, call.model),
      call.step !== undefined
        ? h('span', {
            className: 'rl-badge rl-badge-step',
            title: dict.stepHint,
          }, '#' + String(call.step))
        : null,
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
    h('span', {
      className: numCls(speed),
      title: speedRead !== null && speedRead.approx ? dict.charts.speedApproxHint : dict.speedHint,
    }, speed),
    // Billed input first: the total context the provider counted for this
    // call (uncached + cache hits + cache writes) — the number the In /
    // Cache-hit columns decompose.
    h('span', {
      className: numCls(billed === undefined ? DASH : formatTokens(billed)),
      title: dict.sumBilledInputHint,
    }, billed === undefined ? DASH : formatTokens(billed)),
    h('span', { className: numCls(input) }, input),
    h('span', { className: numCls(hit, 'rl-td-hit') }, hit),
    h('span', {
      className: numCls(formatPct(usage?.cacheReadTokens, billed), 'rl-td-hit'),
      title: dict.hitRateHint,
    }, formatPct(usage?.cacheReadTokens, billed)),
    h('span', { className: numCls(write) }, write),
    h('span', { className: numCls(out, 'rl-td-out') }, out),
    h('span', {
      className: 'rl-cell rl-c-size',
      title: dict.sizeHint
        + (called === '' ? '' : ' · ' + called)
        + (call.toolNames === undefined || call.toolNames.length === 0
          ? ''
          : ' · ' + call.toolNames.join(', ')),
    },
      String(call.messageCount) + '/' + String(call.toolCalls ?? '\u2013')))
})

export function makeRequestLogView(source: DictSource): (props: { sessionId?: string }) => React.ReactElement {
  // Built once per source: a stable component identity, so the remounts that
  // matter are the session-keyed ones below, not a re-created factory.
  const CallDetail = makeCallDetail(source)

  function RequestLogView(props: { sessionId?: string }): React.ReactElement {
    const dict = useDict(source)
    const sessionId = props.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      return h('div', { className: 'rl-root' },
        h('div', { className: 'rl-empty' }, dict.emptyHint))
    }
    // Keyed per session: switching sessions remounts the ledger, so nothing
    // (open detail, loaded window, Auto) can leak from one session into
    // another — and the remount re-seeds from that session's memory, bringing
    // back what the reader left on when the tab was last closed.
    return h(SessionLedger, { key: sessionId, sessionId, dict })
  }

  function SessionLedger(props: { sessionId: string; dict: ViewDict }): React.ReactElement {
    const dict = props.dict
    const sessionId = props.sessionId
    const [initial] = React.useState(() => loadViewMemory(sessionId))
    const [state, setState] = React.useState<LoadState>({ kind: 'loading' })
    const [auto, setAuto] = React.useState(initial.auto)
    const [charts, setCharts] = React.useState<ChartsPrefs>(initial.charts)
    const [selected, setSelected] = React.useState<SelectedCall | null>(initial.selected)
    const [tick, setTick] = React.useState(0)
    // Auto-refresh drives this probe counter (see the probe effect below);
    // manual refresh drives `tick` and reloads the whole window.
    const [probeTick, setProbeTick] = React.useState(0)
    // How many of the newest calls the ledger shows; "Load older" grows it.
    // One fetch of `limit` newest entries keeps refresh simple and the whole
    // loaded window consistent (the server caps it at its own MAX_LIMIT).
    // Restored from memory so a paged-in window survives a tab switch.
    const [limit, setLimit] = React.useState(initial.limit)
    // Latest detail reading position, mirroring the per-session memory: a
    // newly opened call mounts with the side/format the reader last used.
    const prefsRef = React.useRef<DetailPrefs>(initial.detail)
    // Chronological ledger like the Trajectory tab: oldest first, the view
    // pinned to the newest call at the bottom until the user scrolls away.
    // The real scroller may be .rl-root itself OR a bounded ancestor pane
    // (the host slot decides), so pin whichever actually overflows.
    const scrollRef = React.useRef<HTMLDivElement | null>(null)
    const stickToBottom = React.useRef(true)
    const pinnedRef = React.useRef<HTMLElement | null>(null)
    // Set right before "Load older" prepends rows: after the update lands,
    // the layout effect grows scrollTop by the added height so the viewport
    // stays anchored on the row the reader was looking at.
    const prependAnchor = React.useRef<{ scroller: HTMLElement; height: number } | null>(null)
    const onScroll = React.useCallback((event?: { target?: EventTarget | null }): void => {
      const el = (event?.target ?? scrollRef.current) as HTMLElement | null
      if (el === null || el === undefined) return
      stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    }, [])
    React.useLayoutEffect(() => {
      if (state.kind !== 'ready') return
      const root = scrollRef.current
      if (root === null) return
      const target = findScroller(root)
      if (pinnedRef.current !== target) {
        if (pinnedRef.current !== null) pinnedRef.current.removeEventListener('scroll', onScroll)
        target.addEventListener('scroll', onScroll, { passive: true })
        pinnedRef.current = target
      }
      const anchor = prependAnchor.current
      if (anchor !== null && anchor.scroller === target) {
        target.scrollTop += target.scrollHeight - anchor.height
        prependAnchor.current = null
        return
      }
      if (stickToBottom.current) target.scrollTop = target.scrollHeight
    }, [state, onScroll])
    React.useEffect(() => () => {
      if (pinnedRef.current !== null) pinnedRef.current.removeEventListener('scroll', onScroll)
    }, [onScroll])

    const refresh = React.useCallback((): void => {
      setTick(value => value + 1)
    }, [])

    // Every state that shapes what the reader sees writes through to the
    // per-session memory, so an unmount (tab switch) and even a page refresh
    // reopen on the same view.
    const openCall = React.useCallback((call: SelectedCall): void => {
      setSelected(call)
      updateViewMemory(sessionId, { selected: call })
    }, [sessionId])
    const backToList = React.useCallback((): void => {
      stickToBottom.current = true
      setSelected(null)
      updateViewMemory(sessionId, { selected: null })
      setTick(value => value + 1)
    }, [sessionId])
    const onPrefsChange = React.useCallback((prefs: DetailPrefs): void => {
      prefsRef.current = prefs
      updateViewMemory(sessionId, { detail: prefs })
    }, [sessionId])
    const onChartsPrefs = React.useCallback((patch: Partial<ChartsPrefs>): void => {
      setCharts(prev => {
        const next = { ...prev, ...patch }
        updateViewMemory(sessionId, { charts: next })
        return next
      })
    }, [sessionId])

    // Full load: the whole loaded window (initial load, manual refresh,
    // "Load older" growing the limit). Records settle once and never
    // change, so identity reuse below keeps React.memo rows inert.
    React.useEffect(() => {
      let cancelled = false
      // Aborting on cleanup also cancels the in-flight fetch itself (session
      // switch, tab unmount) instead of letting it run to a discarded setState.
      const abort = new AbortController()
      const load = async (): Promise<void> => {
        try {
          const page = await fetchCalls(sessionId, limit, 0, abort.signal)
          if (cancelled) return
          // The API pages newest-first; the ledger renders oldest-first so
          // the newest call sits at the bottom, like the Trajectory tab.
          setState(previous => previous.kind === 'ready'
            ? { kind: 'ready', calls: reconcileCalls(page.calls, previous.calls), total: page.total, storage: page.storage }
            : { kind: 'ready', calls: reconcileCalls(page.calls, undefined), total: page.total, storage: page.storage })
        } catch (error) {
          if (cancelled || abort.signal.aborted) return
          const message = error instanceof ApiError ? error.message : String(error)
          // Fail-soft: one transient poll failure never throws away the
          // loaded ledger — the data stays and a banner marks it stale. Only
          // a session with nothing loaded yet degrades to the error screen.
          setState(prev => prev.kind === 'ready'
            ? { kind: 'ready', calls: prev.calls, total: prev.total, storage: prev.storage, warning: message }
            : { kind: 'error', message })
        }
      }
      void load()
      return () => {
        cancelled = true
        abort.abort()
      }
    }, [sessionId, tick, limit])

    // Auto-refresh probe: fetch only the newest PAGE and splice it into the
    // loaded window — a 3s poll on a session paged in 2000-deep costs one
    // page, not the whole window re-fetched and re-parsed every tick. A full
    // refresh (manual, limit change) re-syncs whatever this splice misses.
    const firstProbe = React.useRef(true)
    React.useEffect(() => {
      if (firstProbe.current) {
        firstProbe.current = false
        return
      }
      let cancelled = false
      const abort = new AbortController()
      const probe = async (): Promise<void> => {
        try {
          const page = await fetchCalls(sessionId, Math.min(PAGE_SIZE, limit), 0, abort.signal)
          if (cancelled) return
          setState(prev => {
            if (prev.kind !== 'ready') {
              return { kind: 'ready', calls: reconcileCalls(page.calls, undefined), total: page.total, storage: page.storage }
            }
            const probeIds = new Set(page.calls.map(call => call.id))
            const prevById = new Map(prev.calls.map(call => [call.id, call]))
            // Keep the older loaded rows the probe window does not cover,
            // reuse entry objects for the rows it does (memo identity).
            const older = prev.calls.filter(call => !probeIds.has(call.id))
            const spliced = page.calls.slice().reverse().map(call => prevById.get(call.id) ?? call)
            return { kind: 'ready', calls: [...older, ...spliced], total: page.total, storage: page.storage }
          })
        } catch (error) {
          if (cancelled || abort.signal.aborted) return
          const message = error instanceof ApiError ? error.message : String(error)
          setState(prev => prev.kind === 'ready'
            ? { kind: 'ready', calls: prev.calls, total: prev.total, storage: prev.storage, warning: message }
            : prev)
        }
      }
      void probe()
      return () => {
        cancelled = true
        abort.abort()
      }
    }, [sessionId, probeTick, limit])

    React.useEffect(() => {
      if (!auto || selected !== null) return
      const timer = setInterval(() => {
        // A hidden tab cannot be read; skip the tick so the poll costs
        // nothing while the conversation is in the background.
        if (typeof document === 'object' && document.visibilityState === 'hidden') return
        setProbeTick(value => value + 1)
      }, 3000)
      return () => clearInterval(timer)
    }, [auto, selected])

    // One O(n) pass per loaded-window change instead of a per-row scan. Must
    // sit above the conditional returns: it is a hook like the rest.
    const readyCalls = state.kind === 'ready' ? state.calls : NO_CALLS
    const prevIds = React.useMemo(() => prevIdsOf(readyCalls), [readyCalls])
    // Openers must resolve predecessors through the LATEST map: prevIds is
    // rebuilt whenever the loaded window grows (Load older), and an opener
    // cached before that growth would otherwise keep reading the stale map
    // it closed over — a row whose predecessor just paged in would open as
    // "full input" instead of chained.
    const prevIdsRef = React.useRef(prevIds)
    prevIdsRef.current = prevIds
    // Memoized row openers keyed by call id: React.memo(CallRow) only pays
    // off when the onOpen prop is ALSO stable across the 3s poll re-renders.
    const openersRef = React.useRef(new Map<string, () => void>())
    const openers = openersRef.current
    React.useEffect(() => {
      const alive = new Set(readyCalls.map(call => call.id))
      for (const id of openers.keys()) {
        if (!alive.has(id)) openers.delete(id)
      }
    }, [readyCalls])
    const openerOf = (call: CallIndexEntry): (() => void) => {
      const existing = openers.get(call.id)
      if (existing !== undefined) return existing
      const opener = (): void => {
        // Read through the ref, NOT a captured memo value: see prevIdsRef.
        const prevId = prevIdsRef.current.get(call.id)
        openCall({
          id: call.id,
          ...prevId === undefined ? {} : { prevId },
          ...call.step === undefined ? {} : { step: call.step },
        })
      }
      openers.set(call.id, opener)
      return opener
    }

    if (selected !== null) {
      // Keyed per call: switching calls REMOUNTS the detail, so no state
      // (the chained-previous fetch above all) can leak from one call into
      // the next. Reading position survives via initialPrefs / memory.
      // The boundary keys with the call too, so a poison record's crash
      // never sticks to the next call the reader opens.
      return h(ErrorBoundary, {
        key: selected.id,
        fallback: (error: unknown, reset: () => void): React.ReactElement => h('div', { className: 'rl-root' },
          h('div', { className: 'rl-empty' },
            h('div', {}, dict.error + ': ' + String(error)),
            h('button', { className: 'rl-btn', onClick: reset }, dict.retry))),
      },
        h(CallDetail, {
          key: selected.id,
          sessionId,
          callId: selected.id,
          ...selected.prevId === undefined ? {} : { prevId: selected.prevId },
          ...selected.step === undefined ? {} : { step: selected.step },
          initialPrefs: prefsRef.current,
          onPrefsChange,
          onBack: backToList,
        }))
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
    // A headline figure: the number leads, its name sits under it. A trailing
    // unit ('2.86 MB') is set smaller so the digits stay the thing you read.
    const metric = (label: string, text: string, cls?: string, title?: string): React.ReactElement => {
      const { value, unit } = splitMeasure(text)
      return h('div', {
        className: 'rl-metric' + (cls === undefined ? '' : ' ' + cls),
        ...title === undefined ? {} : { title },
      },
        h('span', { className: 'rl-metric-value' },
          value,
          unit === undefined ? null : h('span', { className: 'rl-metric-unit' }, unit)),
        h('span', { className: 'rl-metric-label' }, label))
    }
    // One part of the breakdown line under the headlines.
    const part = (value: string, label: string): React.ReactElement =>
      h('span', { className: 'rl-sub-part', key: label },
        h('span', { className: 'rl-sub-value' }, value), ' ', label)

    // The head and summary ride a sticky wrapper: the ledger pins to the
    // newest call at the bottom (and the real scroller may be an ancestor
    // pane), so without it the totals land off-screen exactly when the
    // reader arrives.
    return h('div', { className: 'rl-root', ref: scrollRef, onScroll },
      h('div', { className: 'rl-fixed-head' },
        state.warning === undefined ? null : h('div', { className: 'rl-warn', title: state.warning },
          dict.stale),
        h('div', { className: 'rl-head' },
          h('span', { className: 'rl-head-title' }, dict.calls + ' · ' + String(state.total)),
          h('span', { className: 'rl-head-actions' },
            h('button', {
              className: 'rl-btn' + (charts.open ? ' rl-btn-on' : ''),
              title: dict.charts.toggleHint,
              onClick: () => onChartsPrefs({ open: !charts.open }),
            }, dict.charts.toggle),
            h('button', {
              className: 'rl-btn' + (auto ? ' rl-btn-on' : ''),
              onClick: () => {
                const next = !auto
                setAuto(next)
                updateViewMemory(sessionId, { auto: next })
              },
            }, dict.auto),
            h('button', { className: 'rl-btn', onClick: refresh }, dict.refresh))),
        h('div', { className: 'rl-stats' },
          h('div', { className: 'rl-stats-row' },
            metric(dict.sumCalls, String(sums.count) + (sums.count < state.total ? '+' : '')),
            metric(dict.sumBilledInput, formatTokens(sums.billed), undefined, dict.sumBilledInputHint),
            // The hit rate is the figure people actually scan, and the only
            // one carrying colour — which is what makes it findable.
            metric(dict.sumHitRate, formatPct(sums.cacheRead, sums.billed), 'rl-metric-hit'),
            metric(dict.sumOutput, formatTokens(sums.output)),
            // Marginal, not the transcript's weight — the tooltip carries the
            // whole caveat, so the label says ADDED and never "total".
            state.storage === undefined
              ? null
              : metric(dict.sumStorage, formatBytes(state.storage.logicalBytes), undefined, interp(dict.sumStorageHint, {
                  envelope: formatBytes(state.storage.envelopeBytes),
                  objects: formatBytes(state.storage.objectBytes),
                  cap: formatBytes(state.storage.maxFileBytes),
                  pct: formatPct(state.storage.logicalBytes, state.storage.maxFileBytes),
                }))),
          // Billed input IS these three summed; naming the line says so.
          h('div', { className: 'rl-stats-sub' },
            h('span', { className: 'rl-sub-key' }, dict.sumInput),
            part(formatTokens(sums.input), dict.sumUncached),
            part(formatTokens(sums.cacheRead), dict.sumCached),
            part(formatTokens(sums.cacheWrite), dict.sumWritten)))),
        charts.open
          ? h(StatsPanel, { calls: state.calls, dict, prefs: charts, onPrefs: onChartsPrefs })
          : null,
      state.calls.length < state.total
        ? h('div', { className: 'rl-loadmore' },
            h('button', {
              className: 'rl-btn',
              onClick: () => {
                const root = scrollRef.current
                if (root !== null) {
                  const scroller = findScroller(root)
                  prependAnchor.current = { scroller, height: scroller.scrollHeight }
                }
                const next = limit + PAGE_SIZE
                setLimit(next)
                updateViewMemory(sessionId, { limit: next })
              },
            }, interp(dict.loadMore, { count: state.total - state.calls.length })))
        : null,
      h('div', { className: 'rl-table' },
        h('div', { className: 'rl-row rl-row-head' },
          h('span', { className: 'rl-cell rl-c-time' }, dict.time),
          h('span', { className: 'rl-cell rl-c-model' }, dict.model),
          h('span', { className: 'rl-cell rl-c-num' }, dict.ttft),
          h('span', { className: 'rl-cell rl-c-num' }, dict.totalTime),
          h('span', { className: 'rl-cell rl-c-num' }, dict.colSpeed),
          h('span', { className: 'rl-cell rl-c-num' }, dict.colBilledInput),
          h('span', { className: 'rl-cell rl-c-num' }, dict.colIn),
          h('span', { className: 'rl-cell rl-c-num rl-th-hit' }, dict.colCacheRead),
          h('span', { className: 'rl-cell rl-c-num rl-th-hit' }, dict.colHitRate),
          h('span', { className: 'rl-cell rl-c-num' }, dict.colCacheWrite),
          h('span', { className: 'rl-cell rl-c-num rl-th-out' }, dict.colOut),
          h('span', { className: 'rl-cell rl-c-size' }, dict.size)),
        state.calls.map(call => h(CallRow, {
          key: call.id,
          call,
          dict,
          onOpen: openerOf(call),
        }))))
  }

  return RequestLogView
}

