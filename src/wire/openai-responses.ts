/**
 * OpenAI Responses API rendering of one recorded call.
 *
 * Projects the neutral record into the documented POST /v1/responses shape
 * the harness's pi-ai adapter actually sends: `store: false`, the FULL
 * conversation as typed `input` items (the system prompt as a leading
 * developer/system message item, not `instructions`), and — when the call
 * carried a reasoning effort — the native `reasoning: { effort, summary }`
 * parameter with `include: ["reasoning.encrypted_content"]`.
 *
 * The chained form (previous_response_id + delta input) is NOT what this
 * route's real requests look like, so it is never rendered as the body.
 * When the previous call of the same logical conversation is available, the
 * reconstruction rides a namespaced `_chain` annotation instead: what a
 * stateful client COULD have sent (previous_response_id, sent/skipped item
 * counts), clearly marked as a reconstruction.
 *
 * @module dsh-request-log/wire/openai-responses
 */

import type { CallRecord, RecordedBlock, RecordedMessage } from '../shared/types'
import type { WireExchange } from './common'
import { billedInputOf, requestMessagesOf, responseIdOf, textOf } from './common'

type ResponseItem = Record<string, unknown>

type ContentType = 'input_text' | 'output_text'

function contentBlockOf(block: RecordedBlock, kind: ContentType): Record<string, unknown> | undefined {
  switch (block.type) {
    case 'text':
      return { type: kind, text: textOf(block) }
    case 'reasoning':
      // The Responses API carries assistant reasoning in reasoning items;
      // within a message content list it is kept visible with origin marked.
      return { type: kind, text: textOf(block), _origin: 'reasoning' }
    case 'image': {
      const attachment = (block.attachment as Record<string, unknown> | undefined) ?? {}
      return {
        type: 'input_image',
        image_url: 'attachment:' + String(attachment.attachmentId ?? ''),
        _note: 'durable reference; the real request carried a data URL',
      }
    }
    default:
      return { type: 'opaque', blockType: block.type }
  }
}

/** One message → its typed input items (assistant history included). */
function messageToItems(message: RecordedMessage): ResponseItem[] {
  const items: ResponseItem[] = []
  if (message.role === 'assistant') {
    for (const block of message.content) {
      if (block.type === 'reasoning') {
        items.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: textOf(block) }] })
      } else if (block.type === 'tool-call') {
        items.push({ type: 'function_call', call_id: String(block.id), name: String(block.name), arguments: String(block.arguments) })
      } else if (block.type === 'text') {
        items.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: textOf(block) }],
        })
      }
    }
    return items
  }
  const ordinary: RecordedBlock[] = []
  for (const block of message.content) {
    if (block.type === 'tool-result') {
      const inner = Array.isArray(block.content) ? block.content as RecordedBlock[] : []
      let output = ''
      for (const part of inner) {
        if (part.type === 'text') output += textOf(part)
        // Non-text tool-result parts (images a tool returned) must stay
        // visible — a silent empty output would misreport the model's input.
        else if (part.type === 'image') {
          const attachment = (part.attachment as Record<string, unknown> | undefined) ?? {}
          output += `[image ${String(attachment.attachmentId ?? '')}]`
        }
      }
      items.push({ type: 'function_call_output', call_id: String(block.toolCallId), output })
      continue
    }
    ordinary.push(block)
  }
  if (ordinary.length > 0) {
    items.push({
      type: 'message',
      role: 'user',
      ...message.role === 'system' ? { _original_role: 'system' } : {},
      content: ordinary
        .map(block => contentBlockOf(block, 'input_text'))
        .filter((block): block is Record<string, unknown> => block !== undefined),
    })
  }
  return items
}

/** Longest prefix of messages sharing the same ids across two requests. */
function commonPrefixByMessageId(prev: RecordedMessage[], cur: RecordedMessage[]): number {
  let i = 0
  while (i < prev.length && i < cur.length) {
    const p = prev[i]?.id
    const c = cur[i]?.id
    if (p === undefined || c === undefined || p !== c) break
    i += 1
  }
  return i
}

/** Render options: the prior call of the same logical conversation, when known. */
export interface ResponsesRenderOptions {
  previous?: CallRecord
}

interface ChainState {
  chained: boolean
  /** Messages this request should carry on the wire under chaining. */
  sent: RecordedMessage[]
}

function chainStateOf(record: CallRecord, previous: CallRecord | undefined): ChainState {
  const all = requestMessagesOf(record)
  if (previous === undefined) return { chained: false, sent: all }
  const prior = previous.request.messages
  if (
    previous.sessionId !== record.sessionId
    || previous.purpose !== record.purpose
    || previous.status !== 'ok'
    // A same-hash "previous" is a concurrent identical sibling (subagent
    // fan-out), not the call this one chains after — degrade to full input.
    || previous.requestHash === record.requestHash
    // Self-reference (a record handed to itself as its own prior).
    || previous.id === record.id
  ) return { chained: false, sent: all }
  const prefix = commonPrefixByMessageId(prior, all)
  // Chaining is only valid when the prior request is a strict message-id
  // prefix of this one (a compaction or edit breaks it — degrade to full).
  if (prefix === 0 || prefix !== prior.length) return { chained: false, sent: all }
  // The server already holds the prefix AND the prior call's assistant reply
  // (the delta's leading assistant messages) — only new user/tool rows ship.
  const delta = all.slice(prefix).filter(message => message.role !== 'assistant')
  // A delta that filters down to nothing would render an `input: []` body a
  // real client never sends — degrade to the full-input form instead.
  if (delta.length === 0) return { chained: false, sent: all }
  return { chained: true, sent: delta }
}

/** Chain summary for UI annotation (item counts of the rendered request). */
export interface ResponsesChainInfo {
  chained: boolean
  sentItems: number
  skippedItems: number
  previousResponseId?: string
}

/** Compute the chain annotation of one request against its prior call. */
export function responsesChainOf(record: CallRecord, previous: CallRecord | undefined): ResponsesChainInfo {
  const state = chainStateOf(record, previous)
  // The badge counts WIRE ITEMS (what `input:` actually holds), matching the
  // rendered body — one message can expand into several items.
  const totalItems = requestMessagesOf(record).flatMap(messageToItems).length
  if (!state.chained || previous === undefined) {
    return { chained: false, sentItems: totalItems, skippedItems: 0 }
  }
  return {
    chained: true,
    sentItems: state.sent.flatMap(messageToItems).length,
    skippedItems: totalItems - state.sent.flatMap(messageToItems).length,
    previousResponseId: responseIdOf(previous),
  }
}

const CHAIN_NOTE = 'hypothetical reconstruction: a stateful client chaining on this prior call could send only the delta with previous_response_id — the actual requests on this route always carry full input with store: false'

const STATUS: Record<string, string> = {
  'stop': 'completed',
  'tool-calls': 'completed',
  'max-tokens': 'incomplete',
  // A user abort is a cancellation, not truncation (`incomplete` is
  // reserved for max_output_tokens-style short stops).
  'aborted': 'cancelled',
  'error': 'failed',
}

/** Render the request exchange (method, path, body) in the adapter's real form. */
export function renderOpenAiResponsesRequest(record: CallRecord, options?: ResponsesRenderOptions): WireExchange {
  const chain = responsesChainOf(record, options?.previous)
  const items = requestMessagesOf(record).flatMap(messageToItems)
  // The adapter seats the system prompt as a leading developer (reasoning
  // models) or system message item in the input — not as instructions.
  const systemItems: ResponseItem[] = record.request.system === undefined ? [] : [{
    type: 'message',
    role: record.reasoningEffort !== undefined && record.reasoningEffort !== 'off' ? 'developer' : 'system',
    content: [{ type: 'input_text', text: record.request.system }],
  }]
  const effort = record.reasoningEffort
  const body: Record<string, unknown> = {
    model: record.model,
    input: [...systemItems, ...items],
    stream: true,
    // The adapter never stores responses on this route (and the codex
    // transport outright rejects store: true).
    store: false,
    ...record.sessionId !== '' && record.sessionId !== '_'
      ? { prompt_cache_key: record.sessionId }
      : {},
    ...effort !== undefined && effort !== 'off' ? {
      reasoning: { effort, summary: 'auto' },
      include: ['reasoning.encrypted_content'],
    } : {},
    ...record.request.tools === undefined || record.request.tools.length === 0 ? {} : {
      tools: record.request.tools.map(tool => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    },
    ...record.request.temperature === undefined ? {} : { temperature: record.request.temperature },
    ...record.request.maxTokens === undefined ? {} : { max_output_tokens: record.request.maxTokens },
  }
  if (options?.previous !== undefined) {
    body._chain = {
      chained: chain.chained,
      previous_response_id: chain.chained ? chain.previousResponseId : undefined,
      sent_items: chain.sentItems,
      skipped_items: chain.skippedItems,
      _note: CHAIN_NOTE,
    }
  }
  return { method: 'POST', path: '/v1/responses', body }
}

/** Render the final assembled response in the response object shape. */
export function renderOpenAiResponsesResponse(record: CallRecord): Record<string, unknown> {
  // Single pass in the recorded block order: reasoning / message /
  // function_call interleave on the real wire, and the record keeps it.
  const output: ResponseItem[] = []
  for (const block of record.response?.blocks ?? []) {
    if (block.type === 'reasoning') {
      output.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: textOf(block) }] })
    } else if (block.type === 'text') {
      output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: textOf(block) }] })
    } else if (block.type === 'tool-call') {
      output.push({
        type: 'function_call',
        call_id: String(block.id),
        name: String(block.name),
        arguments: String(block.arguments),
      })
    } else {
      output.push({ type: 'opaque', blockType: block.type })
    }
  }
  const usage = record.response?.usage
  const failure = record.response?.finish.failure
  const kind = record.response?.finish.kind ?? 'stop'
  return {
    id: 'resp_' + responseIdOf(record),
    object: 'response',
    created_at: Math.floor(record.timing.startedAt / 1000),
    model: record.model,
    status: STATUS[kind] ?? 'completed',
    output,
    ...failure === undefined ? {} : { error: { message: failure.message, code: failure.code } },
    usage: {
      // The Responses API reports the TOTAL input (cached_tokens is a
      // subset breakdown), so the disjoint neutral counts fold back together.
      input_tokens: billedInputOf(usage),
      output_tokens: usage?.outputTokens ?? 0,
      ...usage?.cacheReadTokens === undefined ? {} : {
        input_tokens_details: { cached_tokens: usage.cacheReadTokens },
      },
      ...usage?.reasoningTokens === undefined ? {} : {
        output_tokens_details: { reasoning_tokens: usage.reasoningTokens },
      },
      total_tokens: billedInputOf(usage) + (usage?.outputTokens ?? 0),
    },
  }
}
