/**
 * Shared wire vocabulary between the Host half (capture + store + HTTP API)
 * and the Client half (tab UI). Plain JSON only: every field here crosses
 * the JSONL disk boundary and the browser fetch boundary unchanged.
 *
 * @module dsh-request-log/shared/types
 */

/** Recorded wire schema version; a reader refuses a mismatched record. */
export const RECORD_SCHEMA = 1

/** The neutral tool schema exactly as the request carried it. */
export interface RecordedToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/**
 * One content block exactly as the request/response carried it (after the
 * JSON disk projection). `type` discriminates: text | reasoning | image |
 * tool-call | tool-result for requests; the same vocabulary plus nothing
 * else for responses. Unknown block types pass through opaquely.
 */
export interface RecordedBlock {
  type: string
  [key: string]: unknown
}

/** One conversation message exactly as the provider-bound request carried it. */
export interface RecordedMessage {
  id?: string
  role: 'system' | 'user' | 'assistant'
  content: RecordedBlock[]
  /** Producer kind (user | plugin | model | tool), when the request carried it. */
  sourceKind?: string
}

/** Provider-reported token accounting; cache fields are optional. */
export interface RecordedUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** Terminal outcome of one attempt, as the stream's finish chunk stated it. */
export interface RecordedFinish {
  kind: 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error'
  failure?: {
    message: string
    code: string
    status?: number
    requestId?: string
  }
}

/** Wall-clock timing for one attempt (epoch milliseconds). */
export interface RecordedTiming {
  startedAt: number
  firstChunkAt?: number
  endedAt?: number
}

/** The exact provider-neutral request payload of one attempt. */
export interface RecordedRequest {
  system?: string
  messages: RecordedMessage[]
  tools?: RecordedToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
}

/** The assembled outcome of one attempt, built from the raw chunk stream. */
export interface RecordedResponse {
  blocks: RecordedBlock[]
  usage?: RecordedUsage
  finish: RecordedFinish
  /** Total raw chunks observed on the stream (deltas included). */
  chunkCount: number
}

/** Settlement state of one attempt. */
export type CallStatus = 'ok' | 'error' | 'aborted' | 'open'

/** One persisted provider-call attempt (one `llm/stream` waterfall pass). */
export interface CallRecord {
  schema: typeof RECORD_SCHEMA
  /** Unique attempt id (uuid v4). */
  id: string
  /** Session the call was routed to; `_` when the request carried none. */
  sessionId: string
  /** Auxiliary-call classification, when the request carried one. */
  purpose?: 'compaction' | 'session-title'
  provider: string
  model: string
  reasoningEffort?: string
  /**
   * Short sha1 over provider + model + the canonical request JSON: consecutive
   * attempts sharing a hash are retries of one logical call (each retry
   * re-enters the waterfall).
   */
  requestHash: string
  /** 1-based attempt ordinal among consecutive same-hash calls. */
  attempt: number
  timing: RecordedTiming
  request: RecordedRequest
  response?: RecordedResponse
  status: CallStatus
}

/**
 * List-row projection of a {@link CallRecord}: every field except the request
 * and response bodies, so an index page stays small for long sessions.
 */
export interface CallIndexEntry {
  id: string
  sessionId: string
  purpose?: 'compaction' | 'session-title'
  provider: string
  model: string
  reasoningEffort?: string
  requestHash: string
  attempt: number
  /**
   * 1-based ordinal of this LOGICAL call among the session's ordinary
   * (non-auxiliary) conversation turns: attempt 1 starts a new step, retries
   * (same hash, attempt > 1) share the step they retry. Auxiliary calls
   * (compaction / session-title) take no step and don't consume one. Derived
   * at projection time, so records written before the field existed get one
   * too. Undefined only for auxiliary rows.
   */
  step?: number
  startedAt: number
  durationMs?: number
  ttfbMs?: number
  status: CallStatus
  usage?: RecordedUsage
  finishKind?: RecordedFinish['kind']
  finishMessage?: string
  messageCount: number
  /**
   * Tool invocations this call's response made: every native tool-call block
   * counts once, except a `run_code` block, which counts its program's inner
   * `tools.x(...)` dispatch sites instead (a static site count — loops and
   * dynamic dispatches are approximated by their sites). Undefined only when
   * the response never settled (no blocks to count).
   */
  toolCalls?: number
  /** The dispatch breakdown behind {@link toolCalls}: native tool names, or
   * the inner tool names a run_code program calls, each with its count. */
  calledTools?: ToolDispatch[]
  /** Names of the tool definitions the request carried (tooltip fodder). */
  toolNames?: string[]
  /** Sum of request system+message text length (chars), a cheap size proxy. */
  requestChars: number
  responseBlockKinds: string[]
}

/** Paged index response. */
export interface CallIndexResponse {
  calls: CallIndexEntry[]
  total: number
  offset: number
  limit: number
}

/** Health probe response. */
export interface HealthResponse {
  ok: true
  plugin: 'dsh-request-log'
  version: string
}

/** One called tool (or one of a run_code program's inner tools) with its count. */
export interface ToolDispatch {
  name: string
  count: number
}

/**
 * Dispatch sites inside a run_code program body: `tools.name(...)` and quoted
 * `tools['name'](...)` call sites. A static site count — a loop runs one site
 * many times, a dynamic `tools[key](...)` read exposes no site — so it
 * approximates the invocations without ever miscounting structure.
 */
const TOOL_DISPATCH_SITE = /\btools(?:\.([A-Za-z_$][\w$]*)|\[\s*(['"])([^'"\]]+)\2\s*\])\s*\(/g

/** Read a run_code tool-call's program body, whatever shape `arguments` took. */
function programCodeOf(block: RecordedBlock): string | undefined {
  const raw = block.arguments
  let args: unknown = raw
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (args !== null && typeof args === 'object' && typeof (args as { code?: unknown }).code === 'string') {
    return (args as { code: string }).code
  }
  return undefined
}

/**
 * Count the tool invocations a response's tool-call blocks stand for: native
 * blocks count once each; a `run_code` block counts its program's inner
 * dispatch sites, falling back to 1 (the transport call itself) when the
 * program is opaque — no parseable code or no static sites.
 */
export function countToolCalls(blocks: RecordedBlock[]): { total: number, dispatches: ToolDispatch[] } {
  const order: string[] = []
  const counts = new Map<string, number>()
  let total = 0
  const bump = (name: string, by: number): void => {
    const prev = counts.get(name)
    if (prev === undefined) order.push(name)
    counts.set(name, prev === undefined ? by : prev + by)
    total += by
  }
  for (const block of blocks) {
    if (block.type !== 'tool-call') continue
    const name = typeof block.name === 'string' && block.name !== '' ? block.name : 'tool'
    if (name === 'run_code') {
      const code = programCodeOf(block)
      if (code !== undefined) {
        let sites = 0
        for (const match of code.matchAll(TOOL_DISPATCH_SITE)) {
          bump(match[1] ?? match[3] ?? 'tool', 1)
          sites += 1
        }
        if (sites > 0) continue
      }
    }
    bump(name, 1)
  }
  return { total, dispatches: order.map(name => ({ name, count: counts.get(name) ?? 0 })) }
}

/** Project an index entry out of a full record (host-side, exported for tests). */
export function toIndexEntry(record: CallRecord): CallIndexEntry {
  let requestChars = record.request.system?.length ?? 0
  for (const message of record.request.messages) {
    for (const block of message.content) {
      if (block.type === 'text' && typeof block.text === 'string') requestChars += block.text.length
    }
  }
  const responseBlockKinds: string[] = []
  for (const block of record.response?.blocks ?? []) responseBlockKinds.push(block.type)
  const timing = record.timing
  return {
    id: record.id,
    sessionId: record.sessionId,
    ...record.purpose === undefined ? {} : { purpose: record.purpose },
    provider: record.provider,
    model: record.model,
    ...record.reasoningEffort === undefined ? {} : { reasoningEffort: record.reasoningEffort },
    requestHash: record.requestHash,
    attempt: record.attempt,
    startedAt: timing.startedAt,
    ...timing.firstChunkAt === undefined ? {} : { ttfbMs: timing.firstChunkAt - timing.startedAt },
    ...timing.endedAt === undefined ? {} : { durationMs: timing.endedAt - timing.startedAt },
    status: record.status,
    ...record.response?.usage === undefined ? {} : { usage: record.response.usage },
    ...record.response === undefined ? {} : { finishKind: record.response.finish.kind },
    ...record.response?.finish.failure === undefined ? {} : { finishMessage: record.response.finish.failure.message },
    messageCount: record.request.messages.length,
    ...(record.response === undefined ? {} : (() => {
      const { total, dispatches } = countToolCalls(record.response.blocks)
      return {
        toolCalls: total,
        ...(dispatches.length === 0 ? {} : { calledTools: dispatches }),
      }
    })()),
    ...(record.request.tools === undefined ? {} : { toolNames: record.request.tools.map(tool => tool.name) }),
    requestChars,
    responseBlockKinds,
  }
}
// ---- v2 envelope vocabulary (deduplicating persistence) -----------------------

/** Wire schema version of a v2 envelope line (`{"v":2,...}`). */
export const RECORD_SCHEMA_V2 = 2

/** What one blob reference stands for (system / tools / message / response). */
export type EnvelopeRefKind = 's' | 't' | 'm' | 'r'

/** One content-addressed reference inside an envelope line. */
export interface EnvelopeRef {
  /** Which recorded piece this hash names: s system, t tools, m message, r response. */
  k: EnvelopeRefKind
  /** Full lowercase hex sha256 over the exact JSON of the piece. */
  h: string
  /** Measured compressed byte size of the object payload (budget accounting). */
  z: number
}

/** Request scalars kept inline in the envelope (never blobbed). */
export interface EnvelopeOpts {
  temperature?: number
  maxTokens?: number
  stop?: string[]
}

/**
 * Precomputed projection of the blobbed request/response bodies, mirroring
 * {@link CallIndexEntry} exactly so the list path touches zero blobs.
 */
export interface EnvelopeSum {
  messageCount: number
  requestChars: number
  /** Response block kinds in order (may repeat); absent when no response settled. */
  blockKinds?: string[]
  toolCalls?: number
  calledTools?: ToolDispatch[]
  toolNames?: string[]
  usage?: RecordedUsage
  finishKind?: RecordedFinish['kind']
  finishMessage?: string
}

/** One persisted provider-call attempt in v2 form: scalars inline, bodies by hash. */
export interface CallEnvelope {
  v: typeof RECORD_SCHEMA_V2
  id: string
  sessionId: string
  purpose?: 'compaction' | 'session-title'
  provider: string
  model: string
  reasoningEffort?: string
  requestHash: string
  attempt: number
  timing: RecordedTiming
  status: CallStatus
  opts?: EnvelopeOpts
  refs: EnvelopeRef[]
  sum: EnvelopeSum
}

/** Fail-soft placeholder substituted for one unreadable blob slot in a detail read. */
export interface UnavailableSlot {
  $unavailable: string
}

/**
 * Precompute the {@link EnvelopeSum} for a record — the same traversal
 * {@link toIndexEntry} performs, frozen at append time so the index can be
 * projected from the envelope line alone.
 */
export function envelopeSumOf(record: CallRecord): EnvelopeSum {
  let requestChars = record.request.system?.length ?? 0
  for (const message of record.request.messages) {
    for (const block of message.content) {
      if (block.type === 'text' && typeof block.text === 'string') requestChars += block.text.length
    }
  }
  return {
    messageCount: record.request.messages.length,
    requestChars,
    ...record.response === undefined ? {} : (() => {
      const blockKinds = record.response.blocks.map(block => block.type)
      const { total, dispatches } = countToolCalls(record.response.blocks)
      const failure = record.response.finish.failure
      return {
        blockKinds,
        toolCalls: total,
        ...(dispatches.length === 0 ? {} : { calledTools: dispatches }),
        ...record.response.usage === undefined ? {} : { usage: record.response.usage },
        finishKind: record.response.finish.kind,
        ...failure === undefined ? {} : { finishMessage: failure.message },
      }
    })(),
    ...record.request.tools === undefined ? {} : { toolNames: record.request.tools.map(tool => tool.name) },
  }
}

/**
 * Project an index entry out of a v2 envelope — pure arithmetic over inline
 * scalars and the precomputed sum, identical field-for-field to what
 * {@link toIndexEntry} yields for the equivalent v1 record.
 */
export function entryFromEnvelope(env: CallEnvelope): CallIndexEntry {
  const timing = env.timing
  const sum = env.sum
  return {
    id: env.id,
    sessionId: env.sessionId,
    ...env.purpose === undefined ? {} : { purpose: env.purpose },
    provider: env.provider,
    model: env.model,
    ...env.reasoningEffort === undefined ? {} : { reasoningEffort: env.reasoningEffort },
    requestHash: env.requestHash,
    attempt: env.attempt,
    startedAt: timing.startedAt,
    ...timing.firstChunkAt === undefined ? {} : { ttfbMs: timing.firstChunkAt - timing.startedAt },
    ...timing.endedAt === undefined ? {} : { durationMs: timing.endedAt - timing.startedAt },
    status: env.status,
    ...sum.usage === undefined ? {} : { usage: sum.usage },
    ...sum.finishKind === undefined ? {} : { finishKind: sum.finishKind },
    ...sum.finishMessage === undefined ? {} : { finishMessage: sum.finishMessage },
    messageCount: sum.messageCount,
    ...sum.toolCalls === undefined ? {} : { toolCalls: sum.toolCalls },
    ...(sum.calledTools === undefined || sum.calledTools.length === 0 ? {} : { calledTools: sum.calledTools }),
    ...sum.toolNames === undefined ? {} : { toolNames: sum.toolNames },
    requestChars: sum.requestChars,
    responseBlockKinds: sum.blockKinds ?? [],
  }
}

