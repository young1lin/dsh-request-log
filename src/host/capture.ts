/**
 * The capture unit: one `llm/stream` waterfall listener that transparently
 * records every provider-call attempt — the exact provider-neutral request
 * plus the assembled response, usage, finish, and timing.
 *
 * The harness re-enters this waterfall for every real attempt: llm-retry
 * decides at the `agent/request-error` layer (outside the runtime), so each
 * retry attempt is its own `llm/stream` pass with the same request payload.
 * Consecutive attempts are correlated through the request hash.
 *
 * The listener is a pure pass-through: every chunk observed is yielded
 * through unchanged, and RECORDING failures never break the call. Every
 * snapshot this module takes of the request or the stream is fenced — a
 * payload the JSON projection cannot serialize (circular references,
 * BigInt, throwing getters from a foreign plugin's hand-built call)
 * degrades that record's fidelity (a placeholder, a warn) instead of
 * throwing into the consumer's `for await`. Only errors raised by the
 * source stream itself propagate, as the waterfall contract requires.
 *
 * @module dsh-request-log/host/capture
 */

import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { CallRecord, RecordedFinish, RecordedResponse } from '../shared/types'
import { RECORD_SCHEMA } from '../shared/types'
import { errorTextOf } from './errtext'

/** Two same-hash calls within this window count as retries of each other. */
const RETRY_WINDOW_MS = 120_000
/** Upper bound on tracked (session, provider) keys — a long-lived process sees many sessions. */
const TRACKER_MAX_KEYS = 1024

/** Per-key retry correlation state (recent hash → last attempt). */
interface AttemptState {
  hash: string
  attempt: number
  startedAt: number
  /** Whether the tracked attempt already settled, and how. */
  settled: boolean
  ok: boolean
}

/** Begin/settle face the recorder drives retry correlation through. */
export interface AttemptTracker {
  begin(key: string, hash: string, startedAt: number): number
  settle(key: string, ok: boolean): void
}

/**
 * Retry correlation: an attempt counts as a retry only when the PRIOR
 * same-hash attempt settled non-ok first — a completed call, or one still
 * in flight (concurrent identical requests, e.g. subagent fan-out sharing a
 * session), starts a fresh logical call instead of being mislabeled ×N.
 * Entries past the retry window (or beyond the key bound) are pruned.
 */
export function createAttemptTracker(): AttemptTracker {
  const recent = new Map<string, AttemptState>()

  const prune = (now: number): void => {
    for (const [key, state] of recent) {
      if (now - state.startedAt > RETRY_WINDOW_MS) recent.delete(key)
    }
    while (recent.size > TRACKER_MAX_KEYS) {
      let oldestKey: string | undefined
      let oldestAt = Infinity
      for (const [key, state] of recent) {
        if (state.startedAt < oldestAt) { oldestAt = state.startedAt; oldestKey = key }
      }
      if (oldestKey === undefined) break
      recent.delete(oldestKey)
    }
  }

  return {
    begin(key, hash, startedAt) {
      prune(startedAt)
      const prior = recent.get(key)
      const attempt = prior !== undefined
        && prior.hash === hash
        && prior.settled
        && !prior.ok
        && startedAt - prior.startedAt <= RETRY_WINDOW_MS
        ? prior.attempt + 1
        : 1
      recent.set(key, { hash, attempt, startedAt, settled: false, ok: false })
      return attempt
    },
    settle(key, ok) {
      const state = recent.get(key)
      if (state !== undefined) {
        state.settled = true
        state.ok = ok
      }
    },
  }
}

/** The persistence face capture needs — satisfied by {@link CallStore}. */
export interface CaptureStore {
  append(record: CallRecord): Promise<void>
}

export interface CaptureOptions {
  store: CaptureStore
  logger?: { warn: (message: string, ...args: unknown[]) => void }
}

type Warn = ((message: string, ...args: unknown[]) => void) | undefined

/** The logger face capture needs (satisfied by cordis ctx.logger). */
interface WarnLogger {
  warn: (message: string, ...args: unknown[]) => void
}

/**
 * Install the waterfall listener. Registered `global` so attempts from every
 * session scope (subagents included) are recorded.
 * @returns the disposer removing the listener.
 */
export function installCapture(ctx: Context, { store, logger }: CaptureOptions): () => void {
  const tracker = createAttemptTracker()

  return ctx.on('llm/stream', (request: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    const source = next()
    return recordAttempt(request, source, store, tracker, logger)
  }, { global: true })
}

/**
 * Canonical call fingerprint: stable key order over provider, model, and
 * payload. The optional salt (the session id) scopes the fingerprint to one
 * session: identical requests in DIFFERENT sessions then hash differently,
 * so logs from two machines cannot be correlated by hash — while retry
 * correlation, which only ever compares hashes within a session, is intact.
 */
export function requestHashOf(identity: { provider: string; model: string; request: unknown }, salt?: string): string {
  const hash = createHash('sha1')
  if (salt !== undefined) hash.update(salt).update('|')
  hash.update(JSON.stringify(identity))
  return hash.digest('hex').slice(0, 12)
}

/**
 * JSON-safe clone of a snapshot value. A non-serializable input (cycles,
 * BigInt, throwing getters) yields the fallback instead of throwing — the
 * recording degrades, the call never does.
 */
function safeSnapshot<T>(value: unknown, fallback: T, warn: Warn, what: string): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch (error) {
    warn?.(`dsh-request-log: ${what} was not JSON-serializable; a placeholder was recorded: %s`, errorTextOf(error))
    return fallback
  }
}

/** Credential-shaped substrings a provider failure text must never persist verbatim. */
const SECRET_LIKE = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{7,}\b/g,
  /\b(?:api[-_]?key|token|secret|password|authorization)\s*[:=]\s*["']?[^\s"'`,;]{4,}/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
]

/** Upper bound on a recorded failure text: errors are evidence, not payload. */
const FAILURE_TEXT_CAP = 500

/** Redact credential-shaped substrings and cap the length of a provider failure text. */
function redactFailureText(text: string): string {
  let out = text
  for (const pattern of SECRET_LIKE) out = out.replace(pattern, '<redacted>')
  return out.length > FAILURE_TEXT_CAP ? out.slice(0, FAILURE_TEXT_CAP) + `… (+${out.length - FAILURE_TEXT_CAP} chars)` : out
}

/**
 * JSON-safe projection of one request payload (drops non-serializable fields like `signal`).
 * A wholly unprojectable request records as an empty message list — metadata
 * (provider, model, timing, outcome) still lands, and the call still runs.
 */
function toRecordedRequest(options: GenerateOptions, logger?: WarnLogger): CallRecord['request'] {
  try {
    const projection = {
      system: options.system,
      // Messages project through a whitelist: the runtime shape also carries
      // adapter-private fields (message.source — provider/model and the
      // replay state: response ids, native stop reasons, thinking signatures)
      // that were never part of the prompt and must not land in the log.
      // Block CONTENT stays open (unknown block types pass through opaquely
      // by design).
      messages: (Array.isArray(options.messages)
        ? options.messages.map(message => ({
            ...message.id === undefined ? {} : { id: message.id },
            role: message.role,
            content: message.content,
          }))
        : options.messages) as unknown as CallRecord['request']['messages'],
      tools: options.tools,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      stop: options.stop,
    }
    return safeSnapshot<CallRecord['request']>(projection, { messages: [] }, logger?.warn, 'the request payload')
  } catch (error) {
    logger?.warn('dsh-request-log: the request payload could not be read; an empty record was kept: %s', errorTextOf(error))
    return { messages: [] }
  }
}

async function* recordAttempt(
  options: GenerateOptions,
  source: AsyncIterable<StreamChunk>,
  store: CaptureStore,
  tracker: AttemptTracker,
  logger?: { warn: (message: string, ...args: unknown[]) => void },
): AsyncIterable<StreamChunk> {
  let record: CallRecord
  try {
    const request = toRecordedRequest(options, logger)
    const sessionId = typeof options.sessionId === 'string' && options.sessionId.length > 0 ? options.sessionId : '_'
    // Salted with the session: same logical call in one session hashes equal
    // (retry correlation), the same payload in another session does not
    // (no cross-machine correlation by hash).
    const hash = requestHashOf({ provider: options.provider, model: options.model, request }, sessionId)
    const key = `${sessionId}:${options.provider}`
    record = {
      schema: RECORD_SCHEMA,
      id: randomUUID(),
      sessionId,
      ...options.purpose === undefined ? {} : { purpose: options.purpose },
      provider: options.provider,
      model: options.model,
      ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
      requestHash: hash,
      attempt: tracker.begin(key, hash, Date.now()),
      timing: { startedAt: Date.now() },
      request,
      status: 'open',
    }
  } catch (error) {
    // Red line: a recording failure must never break the model call. Without
    // a record there is nothing to persist — pass the stream through as-is.
    logger?.warn('dsh-request-log: failed to open a call record; this attempt is not recorded: %s', errorTextOf(error))
    yield* source
    return
  }

  const blocks: RecordedResponse['blocks'] = []
  let usage: RecordedResponse['usage'] | undefined
  let chunkCount = 0

  try {
    for await (const chunk of source) {
      try {
        if (record.timing.firstChunkAt === undefined) record.timing.firstChunkAt = Date.now()
        chunkCount += 1
        switch (chunk.type) {
          case 'block-end':
            blocks.push(safeSnapshot<RecordedResponse['blocks'][number]>(
              chunk.block,
              { type: 'opaque', unserializable: true },
              logger?.warn,
              'a response block',
            ))
            break
          case 'usage':
            usage = safeSnapshot<RecordedResponse['usage'] | undefined>(chunk.usage, undefined, logger?.warn, 'a usage report')
            break
          case 'finish': {
            const reason = chunk.reason
            const failure = 'failure' in reason ? reason.failure : undefined
            const finish: RecordedFinish = {
              kind: reason.kind,
              ...failure === undefined ? {} : {
                failure: {
                  // Provider error text can quote endpoints and key fragments
                  // ("Incorrect API key provided: sk-…") — redact the common
                  // credential shapes before it lands in the log.
                  message: redactFailureText(failure.message),
                  code: failure.code,
                  ...failure.status === undefined ? {} : { status: failure.status },
                  ...failure.requestId === undefined ? {} : { requestId: failure.requestId },
                },
              },
            }
            record.response = { blocks, usage, finish, chunkCount }
            record.status = reason.kind === 'error' ? 'error' : reason.kind === 'aborted' ? 'aborted' : 'ok'
            record.timing.endedAt = Date.now()
            break
          }
          default:
            break
        }
      } catch (error) {
        // Observing one chunk failed — the record loses that chunk's
        // fidelity, not the consumer its stream.
        logger?.warn('dsh-request-log: failed to observe a stream chunk: %s', errorTextOf(error))
      }
      yield chunk
    }
    // A stream that ends without a finish chunk (clean return) still settles ok
    // with whatever was assembled — adapters always emit finish, so this only
    // covers exotic middleware short-circuits.
    if (record.response === undefined) {
      record.response = { blocks, usage, finish: { kind: 'stop' }, chunkCount }
      record.status = 'ok'
      record.timing.endedAt = Date.now()
    }
  } finally {
    // Consumer failure or generator teardown: settle as open when no finish
    // arrived, then persist whatever was observed.
    if (record.response === undefined) {
      record.response = {
        blocks,
        usage,
        finish: { kind: 'aborted', failure: { message: 'stream closed before finish', code: 'ABORTED' } },
        chunkCount,
      }
      record.status = 'aborted'
      record.timing.endedAt = Date.now()
    }
    tracker.settle(key(record), record.status === 'ok')
    // Fire-and-forget: this finally runs inside the consumer's `for await`
    // teardown, so persistence latency (disk flush, antivirus scan) must not
    // extend the stream's tail. Append order across concurrent calls was
    // never guaranteed; failures only log.
    store.append(record).catch(error => {
      logger?.warn('dsh-request-log: failed to persist call record: %s', errorTextOf(error))
    })
  }
}

/** The tracker key of a settled record — recompute rather than close over (kept lean). */
function key(record: CallRecord): string {
  return `${record.sessionId}:${record.provider}`
}
