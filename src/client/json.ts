/**
 * Collapsible JSON tree — the body viewer for request/response payloads.
 *
 * Reading model for very large bodies:
 *   - containers fold (depth >= 2 by default), each row keeps its own state;
 *   - long strings clamp to a preview and open into a BLOCK with its own
 *     toolbar (collapse button at BOTH ends, char count, and — when the
 *     string is itself JSON, e.g. a tool-call's raw arguments — a "as JSON"
 *     toggle that renders it as a nested tree);
 *   - the toolbar's Expand / Collapse switch the whole view's default and
 *     clear per-node overrides;
 *   - strings beyond RENDER_CAP render truncated with a copy hint instead
 *     of flooding the DOM;
 *   - a whole-view node budget stops an Expand-all on a pathological body
 *     from building tens of thousands of DOM rows at once.
 *
 * Every human-readable string comes from {@link JsonLabels}, so the view
 * rides the plugin's locale dictionary like the rest of the UI.
 *
 * @module dsh-request-log/client/json
 */

import { React, h } from './react'

export type TreeMode = 'default' | 'expanded' | 'collapsed'

/** Localizable strings of the tree view; defaults are English. */
export interface JsonLabels {
  collapse: string
  expand: string
  /** Char count of an opened string; {count} = length. */
  charsCount: string
  viewAsJson: string
  viewAsText: string
  viewAsJsonTitle: string
  viewAsTextTitle: string
  collapseStringTitle: string
  /** Clamp chip of a folded string; {count} = hidden chars. */
  openString: string
  openStringTitle: string
  jsonChip: string
  /** Truncation notice of an over-cap string; {count} = the cap. */
  truncatedNote: string
  itemsCount: string
  keysCount: string
  nodeBudget: string
  /** Depth-cap hint of a too-deep container; {count} = the cap. */
  depthBudget: string
}

export const DEFAULT_JSON_LABELS: JsonLabels = {
  collapse: 'collapse',
  expand: 'expand',
  charsCount: '{count} chars',
  viewAsJson: 'view as JSON',
  viewAsText: 'view text',
  viewAsJsonTitle: 'Parse this string and show it as JSON',
  viewAsTextTitle: 'Show this string as plain text',
  collapseStringTitle: 'Collapse this string back to its preview',
  openString: '… +{count} chars',
  openStringTitle: 'Open this string in full',
  jsonChip: '{ } JSON',
  truncatedNote: '… truncated at {count} chars — use Copy JSON for the full body',
  itemsCount: '{count} items',
  keysCount: '{count} keys',
  nodeBudget: '… node budget exceeded, collapse other nodes or use Copy JSON ',
  depthBudget: '… depth limit ({count} levels) reached — use Copy JSON for the full body',
}

function interp(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? ''))
}

const DEFAULT_COLLAPSE_DEPTH = 2
const STRING_CLAMP_CHARS = 280
const STRING_PREVIEW_CHARS = 160
/** Above this an opened string renders truncated with a hint. */
const STRING_RENDER_CAP = 200_000
/** A clamped string that parses as JSON longer than this offers the JSON view. */
const JSON_STRING_MIN_CHARS = 40
/**
 * Whole-view rendered-node budget. Expand-all on a multi-thousand-message
 * body would otherwise build the entire DOM tree in one commit; past the
 * budget, containers render as a summary hint pointing at Copy JSON.
 */
const MAX_RENDER_NODES = 20_000
/**
 * Recursion depth cap. The node budget counts rendered LINES, so a single
 * deeply nested chain (a model echoing brackets, a hand-edited record)
 * could still recurse the renderer — and React's own recursive commit
 * walk — off the stack before the budget ever trips. Past the cap the
 * container degrades to a marked hint instead. Collapsed containers never
 * recurse, so only Expand-all or deep per-node overrides can reach it.
 * 96 is deliberately conservative: the dev-mode SSR renderer was measured
 * overflowing somewhere below 300 rendered levels, and real LLM payloads
 * (tool schemas, JSON-in-JSON arguments) barely leave the thirties.
 */
const MAX_RENDER_DEPTH = 96

interface TreeCtx {
  mode: TreeMode
  labels: JsonLabels
  overrides: Map<string, boolean>
  /** Store the inverse of the node's CURRENT effective state. */
  toggle: (path: string, currentEffective: boolean) => void
  /** Paths currently viewed as a parsed JSON sub-tree instead of text. */
  jsonView: Set<string>
  setJsonView: (path: string, on: boolean) => void
  /** Mutable count of rendered tree lines this pass (reset every render). */
  nodes: number
}

function containerCollapsed(ctx: TreeCtx, path: string, depth: number): boolean {
  const override = ctx.overrides.get(path)
  if (override !== undefined) return override
  if (ctx.mode === 'expanded') return false
  if (ctx.mode === 'collapsed') return true
  return depth >= DEFAULT_COLLAPSE_DEPTH
}

function stringClamped(ctx: TreeCtx, path: string, length: number): boolean {
  // A short string can never clamp: even a stale override (e.g. a path whose
  // value changed between formats) must not push it into the preview branch,
  // whose rest-count math assumes a long string.
  if (length <= STRING_CLAMP_CHARS) return false
  const override = ctx.overrides.get(path)
  if (override !== undefined) return override
  if (ctx.mode === 'expanded') return false
  return true
}

/** Child path: array indexes bracketed, object keys dotted. */
function childPathOf(path: string, key: string, isArray: boolean): string {
  return isArray ? path + '[' + key + ']' : path + '.' + key
}

/**
 * Parse cache: one long string can be probed several times per render and
 * re-probed on every re-render (poll tick, locale switch, sibling toggle),
 * while a 40KB+ system prompt pays a full JSON.parse each time. Keyed by
 * the string itself and bounded by a BYTE budget (UTF-16 code units, the
 * cheap upper bound): hits refresh recency, misses insert and evict the
 * least-recently-used entries until the budget holds. A string larger than
 * the whole budget is never cached — it could only evict everything else
 * and still not stay.
 */
const PARSE_CACHE_MAX_BYTES = 4 * 1024 * 1024
const parseCache = new Map<string, unknown | undefined>()
let parseCacheBytes = 0

const cacheBytesOf = (text: string): number => text.length * 2

function cacheRefresh(text: string): void {
  if (!parseCache.has(text)) return
  const value = parseCache.get(text)
  parseCache.delete(text)
  parseCache.set(text, value)
}

function cachePut(text: string, parsed: unknown | undefined): void {
  const bytes = cacheBytesOf(text)
  if (bytes > PARSE_CACHE_MAX_BYTES) return
  if (parseCache.has(text)) parseCache.delete(text)
  parseCache.set(text, parsed)
  parseCacheBytes += bytes
  while (parseCacheBytes > PARSE_CACHE_MAX_BYTES && parseCache.size > 1) {
    const oldest = parseCache.keys().next().value
    if (oldest === undefined) break
    parseCacheBytes -= cacheBytesOf(oldest)
    parseCache.delete(oldest)
  }
}

/** Parse a string as JSON when it plausibly is one (object/array literal). */
function tryParseJsonString(text: string): unknown | undefined {
  if (text.length < JSON_STRING_MIN_CHARS) return undefined
  if (parseCache.has(text)) {
    cacheRefresh(text)
    return parseCache.get(text)
  }
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  let parsed: unknown | undefined = undefined
  try {
    const value = JSON.parse(trimmed) as unknown
    if (value !== null && typeof value === 'object') parsed = value
  } catch {
    // Not JSON — cached as undefined by falling through.
  }
  cachePut(text, parsed)
  return parsed
}

function Caret(props: { open: boolean; label: string; onClick: () => void }): React.ReactElement {
  return h('button', {
    className: 'rl-caret',
    onClick: (event: React.MouseEvent) => {
      event.stopPropagation()
      props.onClick()
    },
    'aria-label': props.label,
  }, props.open ? '▾' : '▸')
}

/** Small in-tree action chip (collapse / as-JSON toggles). */
function Chip(props: { label: string; title?: string; onClick: () => void; on?: boolean }): React.ReactElement {
  return h('button', {
    className: 'rl-string-toggle' + (props.on === true ? ' rl-string-toggle-on' : ''),
    ...props.title === undefined ? {} : { title: props.title },
    onClick: (event: React.MouseEvent) => {
      event.stopPropagation()
      props.onClick()
    },
  }, props.label)
}

/** Toolbar of an opened string block: char count + collapse + optional JSON view. */
function StringToolbar(props: {
  text: string
  path: string
  ctx: TreeCtx
  jsonCandidate: boolean
  top: boolean
}): React.ReactElement {
  const { text, path, ctx, jsonCandidate } = props
  const labels = ctx.labels
  const asJson = ctx.jsonView.has(path)
  return h('span', { className: 'rl-str-tools' },
    h('span', { className: 'rl-str-count' }, interp(labels.charsCount, { count: text.length })),
    jsonCandidate
      ? h(Chip, {
          label: asJson ? labels.viewAsText : labels.viewAsJson,
          title: asJson ? labels.viewAsTextTitle : labels.viewAsJsonTitle,
          on: asJson,
          onClick: () => { ctx.setJsonView(path, !asJson) },
        })
      : null,
    h(Chip, {
      label: labels.collapse,
      title: labels.collapseStringTitle,
      onClick: () => { ctx.toggle(path, false) },
    }))
}

function StringValue(props: { text: string; path: string; ctx: TreeCtx }): React.ReactElement {
  const { text, path, ctx } = props
  const labels = ctx.labels
  // The ordinary case: a short string renders INLINE as a quoted token —
  // no toolbar, no block. Only long strings get the clamp/open machinery.
  if (text.length <= STRING_CLAMP_CHARS) {
    return h('span', { className: 'rl-j-str' }, JSON.stringify(text))
  }
  if (stringClamped(ctx, path, text.length)) {
    const preview = text.slice(0, STRING_PREVIEW_CHARS)
    const rest = text.length - STRING_PREVIEW_CHARS
    const jsonCandidate = text.length >= JSON_STRING_MIN_CHARS && tryParseJsonString(text) !== undefined
    return h('span', { className: 'rl-tree-string-clamp' },
      h('span', { className: 'rl-j-str' }, JSON.stringify(preview).slice(0, -1)),
      h(Chip, {
        label: interp(labels.openString, { count: rest }),
        title: labels.openStringTitle,
        onClick: () => { ctx.toggle(path, true) },
      }),
      jsonCandidate ? h(Chip, {
        label: labels.jsonChip,
        title: labels.viewAsJsonTitle,
        on: true,
        onClick: () => { ctx.setJsonView(path, true); ctx.toggle(path, false) },
      }) : null,
      h('span', { className: 'rl-j-str' }, '"'))
  }

  // Opened: a JSON sub-tree when that view is on, else the text block.
  if (ctx.jsonView.has(path)) {
    const parsed = tryParseJsonString(text)
    if (parsed !== undefined) {
      return h('span', { className: 'rl-str-open' },
        h('span', { className: 'rl-str-tools' },
          h(StringToolbar, { text, path, ctx, jsonCandidate: true, top: true })),
        h('span', { className: 'rl-tree-inline' },
          h(JsonNode, { value: parsed, path: path + '#json', depth: 0, ctx })),
        h('span', { className: 'rl-str-tools' },
          h(StringToolbar, { text, path, ctx, jsonCandidate: true, top: false })))
    }
  }

  const truncated = text.length > STRING_RENDER_CAP
  const shown = truncated ? text.slice(0, STRING_RENDER_CAP) : text
  return h('span', { className: 'rl-str-open' },
    h('span', { className: 'rl-str-tools' },
      h(StringToolbar, { text, path, ctx, jsonCandidate: tryParseJsonString(text) !== undefined, top: true })),
    h('span', { className: 'rl-tree-string-block' }, shown,
      truncated
        ? h('span', { className: 'rl-str-truncated' },
            interp(labels.truncatedNote, { count: STRING_RENDER_CAP }))
        : null),
    h('span', { className: 'rl-str-tools' },
      h(StringToolbar, { text, path, ctx, jsonCandidate: false, top: false })))
}

function Container(props: {
  name?: string
  entries: [key: string, value: unknown][]
  isArray: boolean
  path: string
  depth: number
  ctx: TreeCtx
}): React.ReactElement {
  const { name, entries, isArray, path, depth, ctx } = props
  const labels = ctx.labels
  const collapsed = containerCollapsed(ctx, path, depth)
  const open = isArray ? '[' : '{'
  const close = isArray ? ']' : '}'
  const count = interp(isArray ? labels.itemsCount : labels.keysCount, { count: entries.length })
  const label = name === undefined ? null : h('span', { className: 'rl-j-key' }, JSON.stringify(name) + ': ')

  if (collapsed) {
    return h('div', { className: 'rl-tree-line' },
      h(Caret, { open: false, label: labels.expand, onClick: () => ctx.toggle(path, true) }),
      label,
      h('span', { className: 'rl-j-punc' }, open + ' '),
      h('span', { className: 'rl-tree-summary' }, '… ' + count + ' '),
      h('span', { className: 'rl-j-punc' }, close))
  }

  // Depth cap first: the budget below counts rendered lines, so one deep
  // chain could blow the stack before it ever trips (MAX_RENDER_DEPTH).
  if (depth >= MAX_RENDER_DEPTH) {
    return h('div', { className: 'rl-tree-line' },
      h('span', { className: 'rl-j-punc' }, open + ' '),
      h('span', { className: 'rl-tree-summary' }, interp(labels.depthBudget, { count: MAX_RENDER_DEPTH })),
      h('span', { className: 'rl-j-punc' }, close))
  }

  // Node budget: this container's open/close lines plus one line per entry
  // must fit, or the view degrades to a hint instead of flooding the DOM.
  // Nested containers re-check as the running count grows during recursion.
  if (ctx.nodes + entries.length + 2 > MAX_RENDER_NODES) {
    return h('div', { className: 'rl-tree-line' },
      h('span', { className: 'rl-j-punc' }, open + ' '),
      h('span', { className: 'rl-tree-summary' }, '… ' + count + ' — ' + labels.nodeBudget),
      h('span', { className: 'rl-j-punc' }, close))
  }
  ctx.nodes += entries.length + 2

  const children = entries.map(([key, child]) =>
    h(JsonNode, {
      key,
      ...isArray ? {} : { name: key },
      value: child,
      path: childPathOf(path, key, isArray),
      depth: depth + 1,
      ctx,
    }))

  return h('div', { className: 'rl-tree-node' },
    h('div', { className: 'rl-tree-line' },
      h(Caret, { open: true, label: labels.collapse, onClick: () => ctx.toggle(path, false) }),
      label,
      h('span', { className: 'rl-j-punc' }, open)),
    h('div', { className: 'rl-tree-children' }, children),
    h('div', { className: 'rl-tree-line' }, h('span', { className: 'rl-j-punc' }, close)))
}

function JsonNode(props: {
  name?: string
  value: unknown
  path: string
  depth: number
  ctx: TreeCtx
}): React.ReactElement {
  const { value, ctx } = props
  const label = props.name === undefined ? null : h('span', { className: 'rl-j-key' }, JSON.stringify(props.name) + ': ')
  if (value === null) {
    return h('div', { className: 'rl-tree-line' }, label, h('span', { className: 'rl-j-bool' }, 'null'))
  }
  if (typeof value === 'string') {
    return h('div', { className: 'rl-tree-line' }, label, h(StringValue, { text: value, path: props.path, ctx }))
  }
  if (typeof value === 'number') {
    return h('div', { className: 'rl-tree-line' }, label, h('span', { className: 'rl-j-num' }, String(value)))
  }
  if (typeof value === 'boolean') {
    return h('div', { className: 'rl-tree-line' }, label, h('span', { className: 'rl-j-bool' }, String(value)))
  }
  if (Array.isArray(value)) {
    return h(Container, {
      ...props.name === undefined ? {} : { name: props.name },
      entries: value.map((child, index) => [String(index), child] as [string, unknown]),
      isArray: true,
      path: props.path,
      depth: props.depth,
      ctx,
    })
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return h(Container, {
      ...props.name === undefined ? {} : { name: props.name },
      entries: Object.keys(record).map(key => [key, record[key]] as [string, unknown]),
      isArray: false,
      path: props.path,
      depth: props.depth,
      ctx,
    })
  }
  return h('div', { className: 'rl-tree-line' }, label, h('span', { className: 'rl-j-bool' }, String(value)))
}

/** The tree view: owns per-node overrides; `mode` sets the defaults. */
export function JsonTree(props: { value: unknown; mode: TreeMode; labels?: JsonLabels }): React.ReactElement {
  const [overrides, setOverrides] = React.useState<Map<string, boolean>>(new Map())
  const [jsonView, setJsonViewState] = React.useState<Set<string>>(new Set())
  const toggle = React.useCallback((path: string, currentEffective: boolean): void => {
    setOverrides(current => {
      const next = new Map(current)
      next.set(path, !currentEffective)
      return next
    })
  }, [])
  const setJsonView = React.useCallback((path: string, on: boolean): void => {
    setJsonViewState(current => {
      const next = new Set(current)
      if (on) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])
  // A mode switch is a whole-view intent: drop per-node overrides so the
  // toolbar buttons apply everywhere immediately.
  React.useEffect(() => {
    setOverrides(new Map())
    setJsonViewState(new Set())
  }, [props.mode])
  const labels = props.labels === undefined ? DEFAULT_JSON_LABELS : { ...DEFAULT_JSON_LABELS, ...props.labels }
  const ctx: TreeCtx = { mode: props.mode, labels, overrides, toggle, jsonView, setJsonView, nodes: 0 }
  return h('div', { className: 'rl-tree' }, h(JsonNode, { value: props.value, path: '', depth: 0, ctx }))
}
