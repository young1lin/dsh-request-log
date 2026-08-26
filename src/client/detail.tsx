/**
 * The per-call detail viewer: summary cards (timing phases, full token
 * usage, call identity) plus the collapsible request/response JSON tree in
 * the neutral capture or one of the three wire renderings. The Responses
 * rendering reconstructs the chained incremental form when the prior call of
 * the same conversation is known (previous_response_id + delta input).
 */

import { React, h } from './react'
import type { CallRecord } from '../shared/types'
import { WIRE_PROTOCOLS, detectProtocol, renderWire, responsesChainOf } from '../wire'
import { ApiError, fetchCall, formatDateTime, formatDuration, formatPct, formatTokens, formatTokPerSec } from './data'
import { JsonTree, type TreeMode } from './json'
import { interp } from './dict'
import type { DetailFormat, DetailPrefs, DetailSide } from './persist'
import type { DictSource } from './view'

// DetailFormat (from ./persist): 'neutral' or a wire protocol; null = auto-detect.

function Row(props: { label: string; children?: React.ReactNode; title?: string }): React.ReactElement {
  return h('div', { className: 'rl-sum-row', ...props.title === undefined ? {} : { title: props.title } },
    h('span', { className: 'rl-sum-label' }, props.label),
    h('span', { className: 'rl-sum-value' }, props.children))
}

function CopyButton(props: { getText: () => string; label: string; copiedLabel: string }): React.ReactElement {
  const [copied, setCopied] = React.useState(false)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  React.useEffect(() => () => {
    if (timerRef.current !== undefined) clearTimeout(timerRef.current)
  }, [])
  const onClick = (): void => {
    // Stringify lazily: an MB-scale body is only paid for when the reader
    // actually copies, not on every side/format switch.
    const text = props.getText()
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      timerRef.current = setTimeout(() => { setCopied(false) }, 1500)
    }).catch(() => {})
  }
  return h('button', { className: 'rl-btn', onClick }, copied ? props.copiedLabel : props.label)
}

/** Timing phases: wait (start → first chunk) and stream (first chunk → end). */
function timingOf(record: CallRecord): { wait?: number; stream?: number; total?: number } {
  const { startedAt, firstChunkAt, endedAt } = record.timing
  return {
    ...firstChunkAt === undefined ? {} : { wait: firstChunkAt - startedAt },
    ...firstChunkAt !== undefined && endedAt !== undefined ? { stream: endedAt - firstChunkAt } : {},
    ...endedAt === undefined ? {} : { total: endedAt - startedAt },
  }
}

export function makeCallDetail(source: DictSource): (props: {
  sessionId: string
  callId: string
  prevId?: string
  /** Conversation-loop step of this call, when known from the index. */
  step?: number
  onBack: () => void
  /** Reading position restored from the per-session memory (see ./persist). */
  initialPrefs?: DetailPrefs
  /** Reports side/format changes back to the per-session memory. */
  onPrefsChange?: (prefs: DetailPrefs) => void
}) => React.ReactElement {
  function CallDetail(props: {
    sessionId: string
    callId: string
    prevId?: string
    step?: number
    onBack: () => void
    initialPrefs?: DetailPrefs
    onPrefsChange?: (prefs: DetailPrefs) => void
  }): React.ReactElement {
    const [, force] = React.useState(0)
    React.useEffect(() => source.subscribe(() => { force(value => value + 1) }), [source])
    const dict = source.dictOf()
    const d = dict.detail
    const [record, setRecord] = React.useState<CallRecord | null>(null)
    const [error, setError] = React.useState<string | null>(null)
    const [side, setSide] = React.useState<DetailSide>(props.initialPrefs?.side ?? 'request')
    const [format, setFormat] = React.useState<DetailFormat | null>(props.initialPrefs?.format ?? null)
    const [treeMode, setTreeMode] = React.useState<TreeMode>('default')
    const [previous, setPrevious] = React.useState<CallRecord | undefined>(undefined)

    // Reading-position memory: side/format changes ride out to the per-session
    // store so a remount (tab switch, refresh) reopens where the reader left
    // off. Fires once on mount too — an idempotent write of the same prefs.
    React.useEffect(() => {
      props.onPrefsChange?.({ side, format })
    }, [side, format, props.onPrefsChange])

    React.useEffect(() => {
      let cancelled = false
      const abort = new AbortController()
      setRecord(null)
      setError(null)
      const load = async (): Promise<void> => {
        try {
          const value = await fetchCall(props.sessionId, props.callId, abort.signal)
          if (cancelled) return
          setRecord(value)
        } catch (cause) {
          if (cancelled || abort.signal.aborted) return
          setError(cause instanceof ApiError ? cause.message : String(cause))
        }
      }
      void load()
      return () => {
        cancelled = true
        abort.abort()
      }
    }, [props.sessionId, props.callId])

    // The prior call is only needed for the chained Responses view; fetch it
    // lazily on first switch to that format, once per prevId.
    React.useEffect(() => {
      if (format !== 'openai-responses' || props.prevId === undefined) return
      let cancelled = false
      const abort = new AbortController()
      const load = async (): Promise<void> => {
        try {
          const value = await fetchCall(props.sessionId, props.prevId as string, abort.signal)
          if (cancelled) return
          setPrevious(value)
        } catch {
          // Unavailable prior call degrades the view to full input — not an error.
        }
      }
      void load()
      return () => {
        cancelled = true
        abort.abort()
      }
    }, [props.sessionId, props.prevId, format])

    // Hooks must run before the early returns below; both memos tolerate a
    // null record. Rendering the wire projection and its copy-text are the
    // expensive steps here (MB-scale bodies) — memoize them per inputs so a
    // locale force-render or tree toggle never re-stringifies the payload.
    const effectiveFormat: DetailFormat = format ?? (record === null ? 'neutral' : detectProtocol(record))
    const payload = React.useMemo<unknown>(() => {
      if (record === null) return null
      if (effectiveFormat === 'neutral') {
        return side === 'request'
          ? record.request
          : { status: record.status, timing: record.timing, response: record.response }
      }
      return renderWire(record, effectiveFormat, side, { previous })
    }, [record, side, effectiveFormat, previous])
    const textRef = React.useRef(payload)
    textRef.current = payload

    if (error !== null) {
      return h('div', { className: 'rl-root' },
        h('div', { className: 'rl-empty' },
          h('div', {}, d.loadError + ': ' + error),
          h('button', { className: 'rl-btn', onClick: props.onBack }, d.back)))
    }
    if (record === null) {
      return h('div', { className: 'rl-root' }, h('div', { className: 'rl-empty' }, '…'))
    }

    const chain = effectiveFormat === 'openai-responses' && side === 'request'
      ? responsesChainOf(record, previous)
      : undefined
    const usage = record.response?.usage
    const timing = timingOf(record)
    const billed = usage === undefined
      ? undefined
      : usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)

    return h('div', { className: 'rl-root' },
      h('div', { className: 'rl-head' },
        h('button', { className: 'rl-btn', onClick: props.onBack }, '← ' + d.back),
        h('span', { className: 'rl-head-title' }, record.model
          + (record.reasoningEffort !== undefined ? ' · ' + record.reasoningEffort : '')),
        h('span', { className: 'rl-head-actions' },
          h(CopyButton, {
            getText: () => textRef.current === null ? '' : JSON.stringify(textRef.current, null, 2),
            label: d.copy,
            copiedLabel: d.copied,
          }))),
      h('div', { className: 'rl-cards' },
        h('div', { className: 'rl-card' },
          h('div', { className: 'rl-card-title' }, d.timingCard),
          h(Row, { label: d.startedAt }, formatDateTime(record.timing.startedAt)),
          timing.wait === undefined ? null : h(Row, {
            label: d.waitPhase,
            title: d.waitHint,
          }, formatDuration(timing.wait)),
          timing.stream === undefined ? null : h(Row, {
            label: d.streamPhase,
            title: d.streamHint,
          }, formatDuration(timing.stream)),
          timing.total === undefined ? null : h(Row, { label: d.totalPhase }, formatDuration(timing.total)),
          h(Row, {
            label: d.outSpeed,
            title: d.outSpeedHint,
          }, formatTokPerSec(usage?.outputTokens, timing.stream))),
        usage === undefined
          ? h('div', { className: 'rl-card' },
              h('div', { className: 'rl-card-title' }, d.usageCard),
              h('div', { className: 'rl-empty-hint' }, d.usageNone))
          : h('div', { className: 'rl-card' },
              h('div', { className: 'rl-card-title' }, d.usageCard),
              h('div', { className: 'rl-tokens' },
                h('div', { className: 'rl-token' },
                  h('span', { className: 'rl-token-label' }, d.input),
                  h('span', { className: 'rl-token-value' }, formatTokens(usage.inputTokens))),
                h('div', { className: 'rl-token rl-token-hit' },
                  h('span', { className: 'rl-token-label' }, d.cacheRead),
                  h('span', { className: 'rl-token-value' }, formatTokens(usage.cacheReadTokens))),
                h('div', { className: 'rl-token' },
                  h('span', { className: 'rl-token-label' }, d.cacheWrite),
                  h('span', { className: 'rl-token-value' }, formatTokens(usage.cacheWriteTokens))),
                h('div', { className: 'rl-token rl-token-out' },
                  h('span', { className: 'rl-token-label' }, d.output),
                  h('span', { className: 'rl-token-value' }, formatTokens(usage.outputTokens))),
                usage.reasoningTokens === undefined ? null : h('div', { className: 'rl-token' },
                  h('span', { className: 'rl-token-label' }, d.reasoning),
                  h('span', { className: 'rl-token-value' }, formatTokens(usage.reasoningTokens))),
                h('div', { className: 'rl-token rl-token-hit' },
                  h('span', { className: 'rl-token-label' }, d.hitRate),
                  h('span', { className: 'rl-token-value' }, formatPct(usage.cacheReadTokens, billed))),
                h('div', { className: 'rl-token rl-token-total' },
                  h('span', { className: 'rl-token-label' }, d.billedInput),
                  h('span', { className: 'rl-token-value' }, billed === undefined ? '–' : formatTokens(billed))))),
        h('div', { className: 'rl-card' },
          h('div', { className: 'rl-card-title' }, d.callCard),
          props.step === undefined ? null : h(Row, { label: d.step }, '#' + String(props.step)),
          h(Row, { label: d.provider }, record.provider
            + (record.purpose !== undefined ? ' · ' + record.purpose : '')),
          h(Row, { label: d.model }, record.model),
          record.reasoningEffort === undefined ? null
            : h(Row, { label: d.effort }, record.reasoningEffort),
          h(Row, {
            label: d.attempt,
            title: d.retryOf,
          }, String(record.attempt) + ' · ' + record.requestHash),
          h(Row, { label: d.finish }, (record.response?.finish.kind ?? record.status)
            + (record.response?.finish.failure !== undefined
              ? ' · ' + record.response.finish.failure.message
              : '')),
          h(Row, { label: d.size }, String(record.request.messages.length) + ' ' + d.msgs
            + ' · ' + String(record.request.tools?.length ?? 0) + ' ' + d.toolsLabel))),
      h('div', { className: 'rl-head rl-head-tabs' },
        h('span', { className: 'rl-tabs' },
          h('button', {
            className: 'rl-btn' + (side === 'request' ? ' rl-btn-on' : ''),
            onClick: () => { setSide('request') },
          }, d.request),
          h('button', {
            className: 'rl-btn' + (side === 'response' ? ' rl-btn-on' : ''),
            onClick: () => { setSide('response') },
          }, d.response)),
        h('span', { className: 'rl-tabs' },
          [{ id: 'neutral' as const, label: d.neutral },
            ...WIRE_PROTOCOLS.map(entry => ({ id: entry.id, label: entry.label }))].map(entry =>
            h('button', {
              key: entry.id,
              className: 'rl-btn' + (effectiveFormat === entry.id ? ' rl-btn-on' : ''),
              title: entry.id === 'neutral' ? undefined : d.reconstructed,
              onClick: () => { setFormat(entry.id) },
            }, entry.label)),
          h('button', {
            className: 'rl-btn',
            title: d.expandHint,
            onClick: () => { setTreeMode('expanded') },
          }, d.expandAll),
          h('button', {
            className: 'rl-btn',
            title: d.collapseHint,
            onClick: () => { setTreeMode('collapsed') },
          }, d.collapseAll))),
      chain === undefined ? null : h('div', {
        className: 'rl-chain' + (chain.chained ? ' rl-chain-on' : ''),
        title: chain.chained ? chain.previousResponseId : undefined,
      }, chain.chained
        ? interp(d.chainOn, { sent: chain.sentItems, skipped: chain.skippedItems })
        : interp(d.chainOff, { items: chain.sentItems })),
      h('div', { className: 'rl-json' },
        // Keyed per call+side+format: a format switch rebuilds the tree so
        // per-node overrides can never leak onto a different node that
        // happens to sit at the same path in another rendering.
        h(JsonTree, {
          key: record.id + ':' + side + ':' + String(format) + ':' + String(previous?.id),
          value: payload,
          mode: treeMode,
        })))
  }

  return CallDetail
}
