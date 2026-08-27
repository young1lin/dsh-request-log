/**
 * The 统计 panel: switchable SVG line charts over the loaded ledger window —
 * per-call cache-hit rate, token volumes, latency phases, output speed.
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
 *  - >200-point series decimate for DRAWING only (LTTB keeps endpoints and
 *    original extremes; tooltips read full-resolution values);
 *  - a lone non-null value renders as its own dot.
 *
 * @module dsh-request-log/client/chart
 */

import { React, h } from './react'
import type { CallIndexEntry } from '../shared/types'
import { formatDuration, formatTime, formatTokens } from './data'
import {
  buildChartModel,
  stackSerieses,
  type MetricGroup,
  type MetricGroupKey,
  type MetricSeries,
} from './chart-stats'
import {
  extentOf,
  intTicks,
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
}): React.ReactElement {
  const dict = props.dict
  const charts = dict.charts
  const model = React.useMemo(() => buildChartModel(props.calls, 'step'), [props.calls])
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

  // Step → startedAt for the tooltip title (#N · HH:MM:SS).
  const startsAt = React.useMemo(() => {
    const map = new Map<number, number>()
    for (const call of props.calls) {
      if (call.step !== undefined && !map.has(call.step)) map.set(call.step, call.startedAt)
    }
    return map
  }, [props.calls])

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

  // --- resolved series (stacking honored) ----------------------------------
  const stacking = props.prefs.stacks && group.stackOrder !== undefined
  const stacked = stacking ? stackSerieses(group) : group.series
  const visible: MetricSeries[] =
    stacked.length <= 1 ? stacked : stacked.filter(series => !hidden.has(series.key))

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
  const xMinRaw = xsAll.length > 0 ? Math.min(...xsAll) : 0
  const xSpanRaw = xsAll.length > 1 ? xMaxOf(xsAll) - xMinRaw : 1
  const xDomain = padDomain(xMinRaw - xSpanRaw * 0.04, xMinRaw + xSpanRaw * 1.04, 'span')
  const height = CHART_HEIGHT
  const x0 = padLeft
  const x1 = width - PAD_RIGHT
  const y0 = PAD_TOP
  const y1 = height - PAD_BOTTOM
  const sx = linear(xDomain, [x0, x1])
  const sy = linear(yDomain, [y1, y0])

  // Drawing-only decimation past ~200 points per series.
  const decimateTo = Math.max(80, Math.round(plotW / 2))
  const rendered = visible.map(series => ({
    series,
    points: series.points.length > 200 ? lttbDecimate(series.points, decimateTo) : series.points,
  }))
  const hoverXs = rendered[0]?.points.map(p => p.x) ?? []

  const onMove = React.useCallback((event: { clientX?: number }): void => {
    if (hoverXs.length === 0 || typeof event.clientX !== 'number') return
    const svg = svgRef.current
    if (svg === null) return
    const rect = svg.getBoundingClientRect()
    const index = nearestIndex(hoverXs, event.clientX - rect.left)
    setHover(index < 0 ? null : { index })
  }, [hoverXs])

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
  const xTickValues = intTicks(
    Math.ceil(xMinRaw),
    Math.ceil(xMinRaw + xSpanRaw),
    Math.min(12, Math.max(2, Math.floor(plotW / 56))),
  ).filter(v => v >= 1)
  const xLabels = xTickValues.map(v =>
    h('text', {
      key: 'tx' + String(v),
      className: 'rl-axis-text',
      x: sx(v), y: height - 7, textAnchor: 'middle',
    }, '#' + String(v)))
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
    for (const series of visible) {
      const p = series.points[hover.index]
      if (p === undefined || p.y === null || !Number.isFinite(p.y)) continue
      focusDots.push(h('circle', {
        key: 'fd-' + series.key,
        className: 'rl-focus rl-ls-' + series.colorRole,
        cx: sx(p.x), cy: sy(p.y), r: 3.5,
      }))
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
    const startedAt = startsAt.get(slot)
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
        '#' + String(slot) + (startedAt === undefined ? '' : ' · ' + formatTime(startedAt))),
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
  const legend = group.series.length > 1 && !stacking && model.hasData
    ? h('span', { className: 'rl-chart-legend' },
        group.series.map(series =>
          h('button', {
            key: series.key,
            className: 'rl-chip' + (visible.includes(series) ? ' rl-chip-on' : ''),
            onClick: () => toggleHidden(series.key),
          },
            h('span', { className: 'rl-tip-swatch rl-ls-' + series.colorRole }),
            seriesLabel(dict, series.key))))
    : null
  const stacksToggle = group.stackOrder === undefined ? null : h('button', {
    className: 'rl-btn' + (stacking ? ' rl-btn-on' : ''),
    title: charts.stacksHint,
    onClick: () => props.onPrefs({ stacks: !props.prefs.stacks }),
  }, charts.stacks)
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
  bodyChildren.push(h('rect', {
    key: 'overlay',
    className: 'rl-overlay',
    x: x0, y: y0, width: Math.max(x1 - x0, 1), height: Math.max(y1 - y0, 1),
    fill: 'transparent',
    onMouseMove: onMove,
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
      stacksToggle,
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

function xMaxOf(values: number[]): number {
  let max = values[0] ?? 0
  for (const v of values) if (v > max) max = v
  return max
}
