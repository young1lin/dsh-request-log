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
 * @module dsh-request-log/client/json
 */

import { React, h } from './react'

export type TreeMode = 'default' | 'expanded' | 'collapsed'

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

interface TreeCtx {
  mode: TreeMode
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
 * while a 40KB+ system prompt pays a full JSON.parse each time. Keyed by the
 * string itself, capped and wholesale-evicted to stay tiny.
 */
const PARSE_CACHE_MAX = 256
const parseCache = new Map<string, unknown | undefined>()

/** Parse a string as JSON when it plausibly is one (object/array literal). */
function tryParseJsonString(text: string): unknown | undefined {
  if (text.length < JSON_STRING_MIN_CHARS) return undefined
  if (parseCache.has(text)) return parseCache.get(text)
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  let parsed: unknown | undefined = undefined
  try {
    const value = JSON.parse(trimmed) as unknown
    if (value !== null && typeof value === 'object') parsed = value
  } catch {
    // Not JSON — cached as undefined by falling through.
  }
  if (parseCache.size >= PARSE_CACHE_MAX) parseCache.clear()
  parseCache.set(text, parsed)
  return parsed
}

function Caret(props: { open: boolean; onClick: () => void }): React.ReactElement {
  return h('button', {
    className: 'rl-caret',
    onClick: (event: React.MouseEvent) => {
      event.stopPropagation()
      props.onClick()
    },
    'aria-label': props.open ? 'collapse' : 'expand',
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
  const asJson = ctx.jsonView.has(path)
  return h('span', { className: 'rl-str-tools' },
    h('span', { className: 'rl-str-count' }, String(text.length) + ' chars'),
    jsonCandidate
      ? h(Chip, {
          label: asJson ? 'view text' : 'view as JSON',
          title: asJson ? 'Show this string as plain text' : 'Parse this string and show it as JSON',
          on: asJson,
          onClick: () => { ctx.setJsonView(path, !asJson) },
        })
      : null,
    h(Chip, {
      label: 'collapse',
      title: 'Collapse this string back to its preview',
      onClick: () => { ctx.toggle(path, false) },
    }))
}

function StringValue(props: { text: string; path: string; ctx: TreeCtx }): React.ReactElement {
  const { text, path, ctx } = props
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
        label: '… +' + String(rest) + ' chars',
        title: 'Open this string in full',
        onClick: () => { ctx.toggle(path, true) },
      }),
      jsonCandidate ? h(Chip, {
        label: '{ } JSON',
        title: 'Parse this string and show it as JSON',
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
            '\n… truncated at ' + String(STRING_RENDER_CAP) + ' chars — use Copy JSON for the full body')
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
  const collapsed = containerCollapsed(ctx, path, depth)
  const open = isArray ? '[' : '{'
  const close = isArray ? ']' : '}'
  const count = String(entries.length) + (isArray ? ' items' : ' keys')
  const label = name === undefined ? null : h('span', { className: 'rl-j-key' }, JSON.stringify(name) + ': ')

  if (collapsed) {
    return h('div', { className: 'rl-tree-line' },
      h(Caret, { open: false, onClick: () => ctx.toggle(path, true) }),
      label,
      h('span', { className: 'rl-j-punc' }, open + ' '),
      h('span', { className: 'rl-tree-summary' }, '… ' + count + ' '),
      h('span', { className: 'rl-j-punc' }, close))
  }

  // Node budget: this container's open/close lines plus one line per entry
  // must fit, or the view degrades to a hint instead of flooding the DOM.
  // Nested containers re-check as the running count grows during recursion.
  if (ctx.nodes + entries.length + 2 > MAX_RENDER_NODES) {
    return h('div', { className: 'rl-tree-line' },
      h('span', { className: 'rl-j-punc' }, open + ' '),
      h('span', { className: 'rl-tree-summary' },
        '… ' + count + ' — node budget exceeded, collapse other nodes or use Copy JSON '),
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
      h(Caret, { open: true, onClick: () => ctx.toggle(path, false) }),
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
export function JsonTree(props: { value: unknown; mode: TreeMode }): React.ReactElement {
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
  const ctx: TreeCtx = { mode: props.mode, overrides, toggle, jsonView, setJsonView, nodes: 0 }
  return h('div', { className: 'rl-tree' }, h(JsonNode, { value: props.value, path: '', depth: 0, ctx }))
}
