/**
 * The 统计 panel: switchable SVG charts over the loaded ledger window —
 * per-call cache-hit rate, token volumes, latency phases, output speed. A
 * group whose series are additive (the token bands) draws as STACKED COLUMNS,
 * one per call, floor-up; the rest are plain lines.
 *
 * Pure geometry lives in ./chart-scale, pure shaping in ./chart-stats; this
 * module is the only React-touching piece. One metric-group tab strip drives
 * what plots; the choice rides the per-session view memory (./persist) like
 * every other reading position.
 *
 * Rendering rules pinned by the design review:
 *  - null ys DRAW GAPS (the path breaks), never skipped x slots;
 *  - the hit-rate axis stays fixed [0,100] with 25% ticks while every other
 *    axis anchors at 0 with one niceCeil tick of headroom;
 *  - pointer events land on ONE transparent overlay rect, never on paths;
 *  - >200-point series decimate for DRAWING only (LTTB for lines, one column
 *    per ~pixel for columns; tooltips read full-resolution values either way);
 *  - a lone non-null value renders as its own dot (lines) or its own column.
 *
 * @module dsh-request-log/client/chart
 */

import { React, h } from './react'
import type { CallIndexEntry } from '../shared/types'
import { formatAxisTime, formatDuration, formatLedgerTime, formatTokens } from './data'
import {
  BUCKET_MAX_MINUTES,
  BUCKET_MIN_MINUTES,
  BUCKET_PRESETS,
  bucketTokens,
} from './chart-buckets'
import {
  buildChartModel,
  stackSerieses,
  type ChartModel,
  type MetricGroup,
  type MetricGroupKey,
  type MetricSeries,
  type XMode,
} from './chart-stats'
import {
  extentOf,
  intTicks,
  timeTicks,
  linear,
  lttbDecimate,
  nearestIndex,
  niceCeil,
  niceTicks,
  padDomain,
  splitRuns,
} from './chart-scale'
import type { ChartsPrefs } from './persist'
import type { ViewDict } from './dict'

/** Plot height; matches the .rl-chart-body CSS height. */
const CHART_HEIGHT = 220

/** Width until the first real measurement lands (one frame, usually). */
const FALLBACK_WIDTH = 720

/** Gap between the snapped point and the tooltip card, in px. */
const TIP_MARGIN = 16

const GROUP_ORDER: readonly MetricGroupKey[] = ['hitrate', 'tokens', 'latency', 'speed']

/** Axis segments, left to right: the clock first — it is the default reading. */
const X_MODE_ORDER: readonly XMode[] = ['time', 'step']

const EN_DASH = String.fromCharCode(8211)

/** '{count}' interpolation for the panel's own hint strings. */
function interpCount(template: string, count: number): string {
  return template.replace('{count}', String(count))
}

function groupLabel(charts: ViewDict['charts'], key: MetricGroupKey): string {
  switch (key) {
    case 'hitrate': return charts.groupHitRate
    case 'tokens': return charts.groupTokens
    case 'latency': return charts.groupLatency
    case 'speed': return charts.groupSpeed
    default: return key
  }
}

function seriesLabel(dict: ViewDict, key: string): string {
  switch (key) {
    case 'hitRate': return dict.sumHitRate
    case 'in': return dict.colIn
    case 'cacheRead': return dict.colCacheRead
    case 'cacheWrite': return dict.colCacheWrite
    case 'out': return dict.colOut
    case 'duration': return dict.totalTime
    case 'ttfb': return dict.ttft
    case 'speed': return dict.colSpeed
    default: return key
  }
}

/** Exact-value formatting for tooltips/ticks (everything numeric elsewhere). */
function formatValue(group: MetricGroup, v: number | null, precise: boolean): string {
  if (v === null || !Number.isFinite(v)) return EN_DASH
  switch (group.unit) {
    case 'percent':
      return precise ? ((Math.round(v * 10) / 10).toFixed(1) + '%') : String(Math.round(v)) + '%'
    case 'tokens':
      return formatTokens(v)
    case 'ms':
      return formatDuration(v)
    case 'tokps':
      // Ticks stay compact (4k), tooltips precise (57.2 t/s).
      return precise ? v.toFixed(1) + ' t/s'
        : v >= 1000 ? ((v / 1000).toFixed(v >= 10_000 ? 0 : 1)) + 'k'
          : String(Math.round(v))
    default:
      return String(Math.round(v))
  }
}

interface HoverState {
  /** Slot index into the active series arrays (decimation-aligned). */
  index: number
}

export function StatsPanel(props: {
  calls: CallIndexEntry[]
  dict: ViewDict
  prefs: ChartsPrefs
  onPrefs: (patch: Partial<ChartsPrefs>) => void
  /** Select the concrete ledger row represented by a clicked chart slot. */
  onSelectCall?: (callId: string) => void
}): React.ReactElement {
  const dict = props.dict
  const charts = dict.charts
  // Auxiliary calls carry no step, so the numbered axis can never hold them;
  // the time axis can, and a compaction is usually what explains a hit-rate
  // cliff. buildChartModel ignores the option in step mode.
  const base: ChartModel = React.useMemo(
    () => buildChartModel(props.calls, props.prefs.xMode, { auxCalls: 'include' }),
    [props.calls, props.prefs.xMode],
  )
  // On the CLOCK axis the token columns are per-window sums — "how much was
  // burned between 14:00 and 14:05". That is the reading a column form makes
  // available and a line cannot: one column per call positioned at its real
  // timestamp would take its width from neighbour spacing, drawing 1px
  // slivers inside a burst and a fat slab around an isolated call, which is
  // the same data the numbered axis already shows properly. So the clock axis
  // buckets and the step axis stays per-call — two axes, two genuine
  // readings, no third mode to learn. Only the token group buckets; the rest
  // are sampled signals drawn as lines, where the slope between two calls is
  // the whole point.
  const bucketed = React.useMemo(
    () => bucketTokens(props.calls, props.prefs.bucketMinutes),
    [props.calls, props.prefs.bucketMinutes],
  )
  const buckets = props.prefs.xMode === 'time' && props.prefs.group === 'tokens'
  const model: ChartModel = buckets
    ? {
        ...base,
        slots: bucketed.slots,
        groups: base.groups.map(entry => entry.key === 'tokens' ? bucketed.group : entry),
        hasData: base.hasData,
      }
    : base
  const timeMode = model.xMode === 'time'
  const group: MetricGroup =
    model.groups.find(entry => entry.key === props.prefs.group) ?? model.groups[0]!

  // Legend-hidden series set (local, momentary lens — not persisted).
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(new Set())
  const toggleHidden = React.useCallback((key: string): void => {
    setHidden(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // --- width measurement ladder -------------------------------------------
  const bodyRef = React.useRef<HTMLDivElement | null>(null)
  const svgRef = React.useRef<SVGSVGElement | null>(null)
  const [width, setWidth] = React.useState(FALLBACK_WIDTH)
  React.useLayoutEffect(() => {
    const el = bodyRef.current
    if (el === null) return
    const measure = (): void => {
      const next = el.getBoundingClientRect().width
      if (next > 0) setWidth(prev => (Math.abs(prev - next) < 1 ? prev : Math.floor(next)))
    }
    measure()
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(measure)
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => measure())
      observer.observe(el)
      return () => observer.disconnect()
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('resize', measure, { passive: true })
      return () => window.removeEventListener('resize', measure)
    }
    return undefined
  }, [])

  const [hover, setHover] = React.useState<HoverState | null>(null)
  const clearHover = React.useCallback((): void => setHover(null), [])

  // --- resolved series ------------------------------------------------------
  // A group carrying a stackOrder draws as STACKED COLUMNS: its series are
  // per-call quantities that add up, so one column per call, segmented by
  // where the tokens went, is the reading — and it is a reading no line can
  // give. A line between two calls interpolates tokens that were never spent,
  // and four stacked lines over a 98%-cache-hit session collapse into one
  // indistinguishable bundle. Every other group is a sampled signal (a rate, a
  // latency, a speed) where the slope between two calls is the point, and
  // those stay lines.
  // Hiding a chip drops the band from the stack outright — the segments above
  // close the gap — which is why the source is filtered BEFORE stacking, and
  // why the legend has to survive stacking (it is the only way back).
  const stackRank = group.stackOrder
  const bars = stackRank !== undefined
  const source: MetricSeries[] = stackRank === undefined
    ? group.series.filter(series => !hidden.has(series.key))
    : stackRank
      .map(key => group.series.find(series => series.key === key && !hidden.has(series.key)))
      .filter((series): series is MetricSeries => series !== undefined)
  const visible: MetricSeries[] = stackRank === undefined
    ? source
    : stackSerieses({ ...group, series: source })
  // Tooltip rows read each series' OWN value, never its stacked segment top:
  // the reader wants what this call spent on cache hits, not where the green
  // band happens to end.
  const tipSource = source

  // --- layout ---------------------------------------------------------------
  const plotW = Math.max(width - 74, 120)
  const PAD_TOP = 10
  const PAD_RIGHT = 14
  const PAD_BOTTOM = 24

  let yDomain: [number, number] = [0, 1]
  const yTicks: number[] = []
  if (group.percentAxis) {
    yDomain = [0, 100]
    yTicks.push(0, 25, 50, 75, 100)
  } else {
    const extent = extentOf(visible.map(series => series.points))
    if (extent !== null) {
      const top = niceCeil(extent[1] * 1.08)
      yDomain = [0, top]
      yTicks.push(...niceTicks(0, top, 4))
    }
  }
  const longestY = yTicks.reduce((len, v) => Math.max(len, formatValue(group, v, false).length), 3)
  const padLeft = Math.min(64, Math.max(34, Math.floor(6.2 * longestY) + 14))

  const reference = visible[0]?.points ?? []
  const xsAll = reference.map(p => p.x)
  // Loop, not spread: a long session legitimately holds six figures of
  // slots, and Math.min(...xs) over that many arguments blows the stack.
  const xMinRaw = xMinOf(xsAll)
  const xSpanRaw = xsAll.length > 1 ? xMaxOf(xsAll) - xMinRaw : 1
  const xDomain = padDomain(xMinRaw - xSpanRaw * 0.04, xMinRaw + xSpanRaw * 1.04, 'span')
  const height = CHART_HEIGHT
  const x0 = padLeft
  const x1 = width - PAD_RIGHT
  const y0 = PAD_TOP
  const y1 = height - PAD_BOTTOM
  const sx = linear(xDomain, [x0, x1])
  const sy = linear(yDomain, [y1, y0])

  // Drawing-only decimation; tooltips keep reading the full-resolution arrays.
  // Lines LTTB past ~200 points. COLUMNS cannot: LTTB samples each series
  // independently, and segments stacked on mismatched xs would be nonsense —
  // so columns bucket to at most one per ~pixel on ONE shared stride, keeping
  // each bucket's last slot that any layer reaches. That slot is a real call,
  // so a hover snap still reads exact values.
  const decimateTo = Math.max(80, Math.round(plotW / 2))
  const rendered = bars ? [] : visible.map(series => ({
    series,
    points: series.points.length > 200 ? lttbDecimate(series.points, decimateTo) : series.points,
  }))
  const barDrawn: { x: number; idx: number }[] = []
  if (bars) {
    const maxBars = Math.max(40, Math.floor(plotW))
    const step = Math.max(1, Math.ceil(reference.length / maxBars))
    for (let i = 0; i < reference.length; i += step) {
      const end = Math.min(i + step, reference.length)
      let pick = -1
      for (let j = i; j < end; j += 1) {
        if (visible.some(series => {
          const y = series.points[j]?.y
          return y !== null && y !== undefined
        })) pick = j
      }
      if (pick >= 0) barDrawn.push({ x: reference[pick]!.x, idx: pick })
    }
  }
  // Snapping runs in PIXEL space: nearestIndex compares the pointer's px
  // position, so the candidates must be drawn px positions — data-unit xs
  // here once made every hover land on the last slot (a pointer px of ~300
  // beats every step number below it). Lines snap against the
  // FULL-resolution first visible series so the returned ordinal indexes
  // the same arrays the tooltip/crosshair reads — decimation stays
  // drawing-only, as the module header promises. Columns snap against the
  // columns actually drawn, then hand back the slot each one stands for.
  const hoverXs: number[] = bars
    ? barDrawn.map(column => sx(column.x))
    : visible[0]?.points.map(p => sx(p.x)) ?? []

  const snapIndex = React.useCallback((event: { clientX?: number; clientY?: number }): number => {
    if (hoverXs.length === 0 || typeof event.clientX !== 'number') return -1
    const svg = svgRef.current
    if (svg === null) return -1
    const rect = svg.getBoundingClientRect()
    const nearest = nearestIndex(hoverXs, event.clientX - rect.left)
    if (nearest < 0) return -1
    let ordinal = nearest
    // Concurrent calls can share an x pixel (and even the exact timestamp).
    // When they do, vertical proximity chooses the visible point the reader
    // actually clicked instead of making the first call permanently win.
    if (typeof event.clientY === 'number') {
      const tied: number[] = []
      const targetX = hoverXs[nearest]!
      for (let i = 0; i < hoverXs.length; i += 1) {
        if (Math.abs(hoverXs[i]! - targetX) < 0.5) tied.push(i)
      }
      if (tied.length > 1) {
        const pointerY = event.clientY - rect.top
        let bestDistance = Number.POSITIVE_INFINITY
        for (const candidate of tied) {
          const slot = bars ? barDrawn[candidate]!.idx : candidate
          for (const series of visible) {
            const y = series.points[slot]?.y
            if (y === null || y === undefined || !Number.isFinite(y)) continue
            const distance = Math.abs(sy(y) - pointerY)
            if (distance < bestDistance) {
              bestDistance = distance
              ordinal = candidate
            }
          }
        }
      }
    }
    // A column carries the full-resolution slot index it was picked from;
    // a line's ordinal already indexes the full-resolution arrays.
    return bars ? barDrawn[ordinal]?.idx ?? -1 : ordinal
  }, [hoverXs, bars, barDrawn, visible, sy])
  const onMove = React.useCallback((event: { clientX?: number; clientY?: number }): void => {
    const index = snapIndex(event)
    setHover(index < 0 ? null : { index })
  }, [snapIndex])
  const onSelect = React.useCallback((event: { clientX?: number; clientY?: number }): void => {
    const index = snapIndex(event)
    if (index < 0) return
    setHover({ index })
    const slot = model.slots[index]
    if (slot !== undefined) props.onSelectCall?.(slot.callId)
  }, [snapIndex, model.slots, props.onSelectCall])

  // Elements -----------------------------------------------------------------
  const gridlines = yTicks.map(v =>
    h('line', {
      key: 'gy' + String(v),
      className: 'rl-grid-line',
      x1: x0, x2: x1, y1: sy(v), y2: sy(v),
    }))
  const yLabels = yTicks.map(v =>
    h('text', {
      key: 'ty' + String(v),
      className: 'rl-axis-text',
      x: x0 - 6, y: sy(v) + 3.5, textAnchor: 'end',
    }, formatValue(group, v, false)))
  // Steps are 1-based; never label the phantom '#0' the padded domain admits.
  const xTickValues = timeMode
    ? timeTicks(xMinRaw, xMinRaw + xSpanRaw)
    : intTicks(
        Math.ceil(xMinRaw),
        Math.ceil(xMinRaw + xSpanRaw),
        Math.min(12, Math.max(2, Math.floor(plotW / 56))),
      ).filter(v => v >= 1)
  // A bare HH:MM repeated down a week-long axis names nothing, so the date
  // leads as soon as the plotted span leaves the day it started in. Decided
  // by the span alone, not the axis mode — the step-axis tooltip title has
  // the same ambiguity to answer.
  const spansDays = new Date(xMinRaw).toDateString() !== new Date(xMinRaw + xSpanRaw).toDateString()
  const xLabels = xTickValues.map(v =>
    h('text', {
      key: 'tx' + String(v),
      className: 'rl-axis-text',
      x: sx(v), y: height - 7, textAnchor: 'middle',
    }, timeMode ? formatAxisTime(v, spansDays) : '#' + String(v)))
  const vGrids = xTickValues.map(v =>
    h('line', {
      key: 'gx' + String(v),
      className: 'rl-grid-line rl-grid-x',
      x1: sx(v), x2: sx(v), y1: y0, y2: y1,
    }))
  const baseline = h('line', {
    className: 'rl-baseline',
    x1: x0, x2: x1, y1: sy(0), y2: sy(0),
  })

  const shapes: React.ReactElement[] = []
  // Column geometry: width from the drawn-column spacing, clamped to [1, 22],
  // so a dense session packs slivers and a two-call one never draws a slab.
  // A call with no usage at all simply has no column — the gap is the reading.
  if (bars) {
    const spacing = barDrawn.length > 1
      ? (sx(barDrawn[barDrawn.length - 1]!.x) - sx(barDrawn[0]!.x)) / (barDrawn.length - 1)
      : 0
    const barW = barDrawn.length === 1
      ? 22
      : Math.max(1, Math.min(22, Math.floor(spacing * 0.7)))
    for (const column of barDrawn) {
      const cx = sx(column.x)
      const bx = Math.max(x0, Math.min(cx - barW / 2, x1 - barW))
      let prev = 0
      for (const layer of visible) {
        const y = layer.points[column.idx]?.y
        if (y === null || y === undefined || !Number.isFinite(y)) continue
        const topPx = sy(y)
        const basePx = sy(prev)
        // A sub-half-pixel segment draws nothing — a 20-token cache write in a
        // 9k column is a smudge, not a band — but it still advances `prev`, so
        // every segment above keeps its true height.
        if (basePx - topPx >= 0.5) {
          shapes.push(h('rect', {
            key: layer.key + '-bar-' + String(column.idx),
            className: 'rl-bar rl-ls-' + layer.colorRole,
            x: bx, y: topPx, width: barW, height: basePx - topPx,
          }))
        }
        prev = y
      }
    }
  }
  for (const { series, points } of rendered) {
    const runs = splitRuns(points)
    const markers = points.length <= 40
    runs.forEach((run, runIdx) => {
      const runKey = series.key + '-' + String(runIdx)
      if (run.length === 1) {
        const p = run[0]!
        shapes.push(h('circle', {
          key: series.key + '-iso-' + String(runIdx),
          className: 'rl-dot rl-ls-' + series.colorRole,
          cx: sx(p.x), cy: sy(p.y ?? 0), r: 2.5,
        }))
        return
      }
      const d = run.map((p, i) => (i === 0 ? 'M' : 'L') + String(sx(p.x)) + ',' + String(sy(p.y ?? 0))).join('')
      shapes.push(h('path', {
        key: runKey,
        className: 'rl-line rl-ls-' + series.colorRole,
        d, fill: 'none',
      }))
      // Dense series skip exact markers, but an APPROXIMATE sample must stay
      // visible (hollow) — so a run carrying any plots its approx points.
      const approxSeen = run.some(sample => sample.approx === true)
      if (!markers && !approxSeen) return
      for (const p of run) {
        if (!markers && p.approx !== true) continue
        shapes.push(h('circle', {
          key: runKey + '-' + String(p.x),
          // Approximate points draw HOLLOW — visibly estimated, still in-trend.
          className: 'rl-mark rl-ls-' + series.colorRole + (p.approx === true ? ' rl-mark-approx' : ''),
          cx: sx(p.x), cy: sy(p.y ?? 0), r: 2,
        }))
      }
    })
  }

  // Crosshair, focus dots, tooltip -------------------------------------------
  const tipRows: { label: string; cls: string; text: string; approx?: boolean }[] = []
  const focusDots: React.ReactElement[] = []
  if (hover !== null) {
    for (const series of tipSource) {
      const p = series.points[hover.index]
      if (p === undefined || p.y === null || !Number.isFinite(p.y)) continue
      // Columns take a wash over the whole hovered column instead (pushed
      // below): a dot at the series' OWN value would float clear of the
      // segment it names, since the segment sits at its stacked height.
      if (!bars) {
        focusDots.push(h('circle', {
          key: 'fd-' + series.key,
          className: 'rl-focus rl-ls-' + series.colorRole,
          cx: sx(p.x), cy: sy(p.y), r: 3.5,
        }))
      }
      tipRows.push({
        label: seriesLabel(dict, series.key),
        cls: 'rl-ls-' + series.colorRole,
        text: formatValue(group, p.y, true),
        approx: p.approx === true,
      })
    }
  }

  let tooltip: React.ReactElement | null = null
  if (hover !== null && xsAll.length > 0) {
    const idx = Math.min(hover.index, xsAll.length - 1)
    const slot = xsAll[idx]!
    const meta = model.slots[idx]
    const snapPx = sx(slot)
    const flip = snapPx > width / 2
    tooltip = h('div', {
      key: 'tip',
      className: 'rl-chart-tip' + (flip ? ' rl-chart-tip-flip' : ''),
      style: flip
        ? { right: String(width - snapPx + TIP_MARGIN) + 'px' }
        : { left: String(snapPx + TIP_MARGIN) + 'px' },
    },
      h('div', { className: 'rl-tip-title' },
        // The clock axis leads with the time — it is the question being
        // asked — and names the turn behind it, or the auxiliary call's
        // purpose for the rows that have no step at all. spansDays keeps the
        // title honest on a multi-day axis, seconds included (the axis ticks
        // drop them for space; a tooltip can afford them).
        buckets
          // A bucket column stands for a WINDOW, never for one call, so its
          // title names the window it totals.
          ? formatLedgerTime(slot, spansDays) + ' · ' + bucketLabel(props.prefs.bucketMinutes)
          : timeMode
            ? formatLedgerTime(slot, spansDays) + (meta?.step !== undefined
                ? ' · #' + String(meta.step)
                : meta?.purpose === undefined ? '' : ' · ' + meta.purpose)
            : '#' + String(slot) + (meta === undefined ? '' : ' · ' + formatLedgerTime(meta.startedAt, spansDays))),
      ...(tipRows.length === 0
        ? [h('div', { key: 'none', className: 'rl-tip-row' }, EN_DASH)]
        : [
            ...tipRows.map(row =>
              h('div', { key: row.label, className: 'rl-tip-row' },
                h('span', { className: 'rl-tip-swatch ' + row.cls }),
                h('span', { className: 'rl-tip-label' }, row.label),
                h('span', { className: 'rl-tip-value' },
                  (row.approx === true ? '\u2248 ' : '') + row.text))),
            ...tipRows.some(row => row.approx === true)
              ? [h('div', { key: 'approx-hint', className: 'rl-tip-note' }, charts.speedApproxHint)]
              : [],
          ]))
  }

  // --- chrome ---------------------------------------------------------------
  const tabs = GROUP_ORDER.map(key =>
    h('button', {
      key,
      className: 'rl-btn' + (group.key === key ? ' rl-btn-on' : ''),
      onClick: () => props.onPrefs({ group: key }),
      role: 'tab',
    }, groupLabel(charts, key)))
  const legend = group.series.length > 1 && model.hasData
    ? h('span', { className: 'rl-chart-legend' },
        group.series.map(series =>
          h('button', {
            key: series.key,
            className: 'rl-chip' + (!hidden.has(series.key) ? ' rl-chip-on' : ''),
            onClick: () => toggleHidden(series.key),
          },
            h('span', { className: 'rl-tip-swatch rl-ls-' + series.colorRole }),
            seriesLabel(dict, series.key))))
    : null
  // Both axes on screen, the drawn one lit — the same segmented shape as the
  // metric-group tabs opposite. Its predecessor was a cycler labelled with the
  // axis it would switch TO, so the panel never said which axis you were
  // reading and the third position had to be memorised.
  const xAxisControl = h('span', { key: 'xaxis', className: 'rl-chart-tabs-group' },
    ...X_MODE_ORDER.map(mode => h('button', {
      key: mode,
      className: 'rl-btn' + (model.xMode === mode ? ' rl-btn-on' : ''),
      title: charts.xAxisHint,
      onClick: () => props.onPrefs({ xMode: mode }),
      role: 'tab',
    }, mode === 'time' ? charts.xAxisTime : charts.xAxisStep)))
  // Only rendered where a column IS a window: the whole surface of the
  // by-window reading is this one control, and it is meaningless anywhere
  // else. Presets cover the ordinary questions; the field takes anything
  // between a minute and a day for the ones they miss.
  const bucketControl = !buckets ? null : h('span', { key: 'bucket', className: 'rl-bucket-ctrl' },
    h('span', { className: 'rl-bucket-label' }, charts.bucketSize),
    ...BUCKET_PRESETS.map(minutes => h('button', {
      key: 'bucket-' + String(minutes),
      className: 'rl-chip' + (props.prefs.bucketMinutes === minutes ? ' rl-chip-on' : ''),
      title: charts.bucketHint,
      onClick: () => props.onPrefs({ bucketMinutes: minutes }),
    }, bucketLabel(minutes))),
    h('input', {
      className: 'rl-bucket-input',
      type: 'number',
      min: BUCKET_MIN_MINUTES,
      max: BUCKET_MAX_MINUTES,
      title: charts.bucketCustom,
      'aria-label': charts.bucketCustom,
      placeholder: charts.bucketCustom,
      value: BUCKET_PRESETS.includes(props.prefs.bucketMinutes) ? '' : String(props.prefs.bucketMinutes),
      onChange: (event: { target: { value: string } }) => {
        const next = Number(event.target.value)
        if (Number.isInteger(next) && next >= BUCKET_MIN_MINUTES && next <= BUCKET_MAX_MINUTES) {
          props.onPrefs({ bucketMinutes: next })
        }
      },
    }))
  const note = model.excludedAux > 0
    ? h('span', {
        className: 'rl-chart-note',
        title: interpCount(charts.excludedHint, model.excludedAux),
      }, String.fromCharCode(9432) + ' ' + interpCount(charts.excludedShort, model.excludedAux))
    : null

  const bodyChildren: React.ReactElement[] = [
    h('g', { key: 'grid' }, ...gridlines, ...vGrids, baseline),
    h('g', { key: 'labels' }, ...yLabels, ...xLabels),
    h('g', { key: 'shapes' }, ...shapes),
  ]
  bodyChildren.push(h('line', {
    key: 'cross',
    className: 'rl-crosshair',
    x1: hover === null ? -99 : sx(xsAll[Math.min(hover.index, xsAll.length - 1)]!),
    x2: hover === null ? -99 : sx(xsAll[Math.min(hover.index, xsAll.length - 1)]!),
    y1: y0, y2: y1,
  }))
  if (focusDots.length > 0) bodyChildren.push(h('g', { key: 'focus' }, ...focusDots))
  if (bars && hover !== null && xsAll.length > 0 && barDrawn.length > 0) {
    // Wide translucent wash over the hovered column — wider than the column
    // itself so a 1px sliver in a packed session is still visibly the one
    // being read.
    const spacing = barDrawn.length > 1
      ? (sx(barDrawn[barDrawn.length - 1]!.x) - sx(barDrawn[0]!.x)) / (barDrawn.length - 1)
      : 0
    const washW = Math.min(Math.max(spacing * 1.6, 8), 34)
    const cx = sx(xsAll[Math.min(hover.index, xsAll.length - 1)]!)
    bodyChildren.push(h('rect', {
      key: 'barhi',
      className: 'rl-bar-hover',
      x: cx - washW / 2, y: y0, width: washW, height: Math.max(y1 - y0, 1),
    }))
  }
  bodyChildren.push(h('rect', {
    key: 'overlay',
    className: 'rl-overlay',
    x: x0, y: y0, width: Math.max(x1 - x0, 1), height: Math.max(y1 - y0, 1),
    fill: 'transparent',
    onMouseMove: onMove,
    // A click/tap without a prior move (touch) snaps the same way.
    onClick: onSelect,
    onMouseLeave: clearHover,
  }))

  const axisFrame = h('svg', {
    ref: svgRef,
    className: 'rl-chart-svg',
    width, height,
    viewBox: '0 0 ' + String(width) + ' ' + String(height),
    role: 'img',
  }, ...bodyChildren)

  return h('div', { className: 'rl-chart' },
    h('div', { className: 'rl-chart-tabs' },
      h('span', { className: 'rl-chart-tabs-group' }, ...tabs),
      h('span', { className: 'rl-chart-tabs-space' }),
      legend,
      xAxisControl,
      bucketControl,
      note),
    h('div', { className: 'rl-chart-body', ref: bodyRef },
      model.hasData ? axisFrame : null,
      !model.hasData
        ? h('div', { className: 'rl-empty rl-empty-overlay' },
            h('div', { className: 'rl-empty-title' }, charts.emptyTitle),
            h('div', { className: 'rl-empty-hint' }, charts.emptyHint))
        : extentOf(visible.map(series => series.points)) === null
          ? h('div', { className: 'rl-chart-hint' }, charts.allNull)
          : null,
      tooltip))
}

/** Chip/tooltip label for a window width in minutes (60 → "1h"). */
function bucketLabel(minutes: number): string {
  return minutes >= 60 && minutes % 60 === 0 ? String(minutes / 60) + 'h' : String(minutes) + 'm'
}

function xMinOf(values: number[]): number {
  let min = values[0] ?? 0
  for (const v of values) if (v < min) min = v
  return min
}

function xMaxOf(values: number[]): number {
  let max = values[0] ?? 0
  for (const v of values) if (v > max) max = v
  return max
}
