/**
 * Anthropic Messages API rendering of one recorded call.
 *
 * Projects the neutral record into the documented POST /v1/messages shape
 * (request) and the final assembled response object (response). Reconstructed
 * view: built from the exact neutral capture, mirroring the mapping the
 * harness's pi-ai anthropic-messages adapter performs. Where the adapter's
 * output depends on state that never crossed the llm/stream boundary (the
 * thinking mode resolved per model, the thinking signature, adapter default
 * max_tokens), the rendering keeps a legal wire shape and marks the gap with
 * a namespaced `_note` instead of inventing values.
 *
 * @module dsh-request-log/wire/anthropic
 */

import type { CallRecord, RecordedBlock, RecordedMessage } from '../shared/types'
import type { WireExchange } from './common'
import { requestMessagesOf, responseIdOf, textOf } from './common'

type AnthropicContent = Record<string, unknown>

const SIGNATURE_NOTE = 'thinking signatures are adapter-private and not part of the neutral capture'

function imageSourceOf(block: RecordedBlock): Record<string, unknown> {
  const attachment = (block.attachment as Record<string, unknown> | undefined) ?? {}
  // The durable record holds the attachment reference, never bytes; the
  // rendered body keeps the reference so the shape stays honest.
  return {
    type: 'reference',
    _note: 'durable attachment reference; the real request carried normalized base64 bytes',
    attachmentId: attachment.attachmentId,
    ...typeof attachment.mediaType === 'string' ? { media_type: attachment.mediaType } : {},
  }
}

/**
 * A tool-call's `input`: the parsed argument object when it parses to one;
 * otherwise the raw string rides along under a namespaced note — a model
 * emitting broken JSON is exactly what a log reader needs to see, not a
 * silent `{}`.
 */
function toolInputOf(block: RecordedBlock): Record<string, unknown> {
  const raw = block.arguments
  if (typeof raw !== 'string') {
    // Already structured (an adapter that emitted an object): keep it as-is.
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : { _note: 'arguments were not a JSON object', raw: raw === undefined ? null : raw }
  }
  try {
    const value: unknown = JSON.parse(raw)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
    return { _note: 'arguments did not parse as a JSON object', raw }
  } catch {
    return { _note: 'arguments did not parse as JSON', raw }
  }
}

function requestBlocksOf(message: RecordedMessage): AnthropicContent[] {
  const blocks: AnthropicContent[] = []
  // Defense against a malformed record (hand-edited JSONL, an upstream
  // shape change): content must degrade to a MARKED block, never throw —
  // and a bare string must not be iterated into per-character junk.
  const content: unknown = message.content
  if (typeof content === 'string') {
    return [
      { type: 'opaque', blockType: 'content', _note: 'message.content was a string — rendered as one text block' },
      { type: 'text', text: content },
    ]
  }
  if (!Array.isArray(content)) {
    return [{
      type: 'opaque',
      blockType: 'content',
      _note: `message.content was ${content === null ? 'null' : typeof content} — nothing to render`,
    }]
  }
  for (const block of content as RecordedBlock[]) {
    switch (block.type) {
      case 'text':
        blocks.push({ type: 'text', text: textOf(block) })
        break
      case 'reasoning':
        blocks.push({ type: 'thinking', thinking: textOf(block), _note: SIGNATURE_NOTE })
        break
      case 'image':
        blocks.push({ type: 'image', source: imageSourceOf(block) })
        break
      case 'tool-call':
        blocks.push({ type: 'tool_use', id: String(block.id), name: String(block.name), input: toolInputOf(block) })
        break
      case 'tool-result': {
        const content: AnthropicContent[] = []
        for (const inner of Array.isArray(block.content) ? block.content as RecordedBlock[] : []) {
          if (inner.type === 'text') content.push({ type: 'text', text: textOf(inner) })
          else if (inner.type === 'image') content.push({ type: 'image', source: imageSourceOf(inner) })
        }
        // The real API rejects an empty content array (non-empty string or
        // non-empty array); an empty tool result renders a visible, MARKED
        // placeholder instead of a body a replay would be refused for.
        if (content.length === 0) {
          content.push({ type: 'text', text: '[empty tool result]', _note: 'placeholder — the API rejects an empty content array' })
        }
        blocks.push({ type: 'tool_result', tool_use_id: String(block.toolCallId), content })
        break
      }
      default:
        blocks.push({ type: 'opaque', blockType: block.type })
    }
  }
  return blocks
}

/** Legal stop_reason values only; error/abort are not part of the enum. */
const STOP_REASON: Record<string, string> = {
  'stop': 'end_turn',
  'tool-calls': 'tool_use',
  'max-tokens': 'max_tokens',
}

/** Render the request exchange (method, path, body). */
export function renderAnthropicRequest(record: CallRecord): WireExchange {
  const notes: string[] = []
  const thinkingOn = record.reasoningEffort !== undefined && record.reasoningEffort !== 'off'
  const messages = requestMessagesOf(record).map(message => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    ...message.role === 'system' ? { _original_role: 'system' } : {},
    content: requestBlocksOf(message),
  }))
  const body: Record<string, unknown> = {
    model: record.model,
    stream: true,
    ...record.request.system === undefined ? {} : {
      system: [{ type: 'text', text: record.request.system }],
    },
    messages,
    ...record.request.tools === undefined || record.request.tools.length === 0 ? {} : {
      tools: record.request.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      })),
    },
    // Temperature is incompatible with extended thinking — the adapter drops
    // it when thinking is on, and so does this rendering.
    ...record.request.temperature !== undefined && !thinkingOn ? { temperature: record.request.temperature } : {},
    ...thinkingOn && record.request.temperature !== undefined
      ? (notes.push('temperature omitted — incompatible with thinking (the adapter drops it)'), {})
      : {},
    ...record.request.maxTokens === undefined
      ? (notes.push('max_tokens is required by the API — the adapter applied a model default not visible at the llm/stream boundary'), {})
      : { max_tokens: record.request.maxTokens },
    ...record.request.stop === undefined ? {} : { stop_sequences: record.request.stop },
  }
  if (thinkingOn) {
    // The adapter resolves the thinking mode per model (adaptive vs
    // enabled+budget_tokens); only the effort crossed the boundary, so the
    // legal shape that carries exactly that — adaptive + output_config — is
    // rendered, with the resolution gap marked.
    body.thinking = { type: 'adaptive', display: 'summarized' }
    body.output_config = { effort: record.reasoningEffort }
    notes.push('thinking mode is model-resolved (adaptive vs enabled+budget_tokens) — rendered in the adaptive shape the effort maps to')
  }
  if (notes.length > 0) body._note = notes
  return { method: 'POST', path: '/v1/messages', body }
}

/** Render the final assembled response in the Messages API object shape. */
export function renderAnthropicResponse(record: CallRecord): Record<string, unknown> {
  // Single pass in the recorded block order: thinking / text / tool_use can
  // interleave on the real wire, and the record preserves that order.
  const content: AnthropicContent[] = []
  // Same malformed-record defense as the request side: only a real array
  // of blocks renders; anything else degrades to an empty content array.
  const blocks: unknown = record.response?.blocks
  for (const block of Array.isArray(blocks) ? blocks as RecordedBlock[] : []) {
    if (block.type === 'reasoning') {
      content.push({ type: 'thinking', thinking: textOf(block), _note: SIGNATURE_NOTE })
    } else if (block.type === 'text') {
      content.push({ type: 'text', text: textOf(block) })
    } else if (block.type === 'tool-call') {
      content.push({ type: 'tool_use', id: String(block.id), name: String(block.name), input: toolInputOf(block) })
    } else {
      content.push({ type: 'opaque', blockType: block.type })
    }
  }
  const usage = record.response?.usage
  const finish = record.response?.finish
  const failure = finish?.failure
  const kind = finish?.kind ?? 'stop'
  return {
    id: `msg_${responseIdOf(record)}`,
    type: 'message',
    role: 'assistant',
    model: record.model,
    content,
    // Only enum members render; an aborted/error finish has no legal
    // stop_reason and reports null, the failure details under _error.
    stop_reason: STOP_REASON[kind] ?? null,
    ...failure === undefined ? {} : { _error: { message: failure.message, code: failure.code, ...failure.status === undefined ? {} : { status: failure.status } } },
    usage: {
      input_tokens: usage?.inputTokens ?? 0,
      output_tokens: usage?.outputTokens ?? 0,
      ...usage?.cacheReadTokens === undefined ? {} : { cache_read_input_tokens: usage.cacheReadTokens },
      ...usage?.cacheWriteTokens === undefined ? {} : { cache_creation_input_tokens: usage.cacheWriteTokens },
    },
  }
}
