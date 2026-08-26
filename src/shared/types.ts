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
  toolCount: number
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

/** Project an index entry out of a full record (host-side, exported for tests). */
export function toIndexEntry(record: CallRecord): CallIndexEntry {
  let requestChars = record.request.system?.length ?? 0
  const blockKinds = new Set<string>()
  for (const message of record.request.messages) {
    for (const block of message.content) {
      if (block.type === 'text' && typeof block.text === 'string') requestChars += block.text.length
      blockKinds.add(`req:${block.type}`)
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
    toolCount: record.request.tools?.length ?? 0,
    ...(record.request.tools === undefined ? {} : { toolNames: record.request.tools.map(tool => tool.name) }),
    requestChars,
    responseBlockKinds,
  }
}
