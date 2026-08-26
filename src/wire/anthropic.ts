/**
 * Anthropic Messages API rendering of one recorded call.
 *
 * Projects the neutral record into the documented POST /v1/messages shape
 * (request) and the final assembled response object (response). Reconstructed
 * view: built from the exact neutral capture, mirroring the mapping the
 * harness's pi-ai anthropic-messages adapter performs.
 *
 * @module dsh-request-log/wire/anthropic
 */

import type { CallRecord, RecordedBlock, RecordedMessage } from '../shared/types'
import type { WireExchange } from './common'
import { requestMessagesOf, responseIdOf, responseReasoningOf, responseTextOf, responseToolCallsOf, textOf, toolArgumentsOf } from './common'

type AnthropicContent = Record<string, unknown>

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

function requestBlocksOf(message: RecordedMessage): AnthropicContent[] {
  const blocks: AnthropicContent[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        blocks.push({ type: 'text', text: textOf(block) })
        break
      case 'reasoning':
        blocks.push({ type: 'thinking', thinking: textOf(block) })
        break
      case 'image':
        blocks.push({ type: 'image', source: imageSourceOf(block) })
        break
      case 'tool-call':
        blocks.push({ type: 'tool_use', id: String(block.id), name: String(block.name), input: toolArgumentsOf(block) })
        break
      case 'tool-result': {
        const content: AnthropicContent[] = []
        for (const inner of Array.isArray(block.content) ? block.content as RecordedBlock[] : []) {
          if (inner.type === 'text') content.push({ type: 'text', text: textOf(inner) })
          else if (inner.type === 'image') content.push({ type: 'image', source: imageSourceOf(inner) })
        }
        // The real API rejects an empty content array (non-empty string or
        // non-empty array); an empty tool result renders a visible placeholder
        // instead of a body a replay would be refused for.
        if (content.length === 0) content.push({ type: 'text', text: '[empty tool result]' })
        blocks.push({ type: 'tool_result', tool_use_id: String(block.toolCallId), content })
        break
      }
      default:
        blocks.push({ type: 'opaque', blockType: block.type })
    }
  }
  return blocks
}

const STOP_REASON: Record<string, string> = {
  'stop': 'end_turn',
  'tool-calls': 'tool_use',
  'max-tokens': 'max_tokens',
  'aborted': 'aborted',
  'error': 'error',
}

/** Render the request exchange (method, path, body). */
export function renderAnthropicRequest(record: CallRecord): WireExchange {
  const messages = requestMessagesOf(record).map(message => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: requestBlocksOf(message),
  }))
  const body: Record<string, unknown> = {
    model: record.model,
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
    ...record.request.temperature === undefined ? {} : { temperature: record.request.temperature },
    ...record.request.maxTokens === undefined ? {} : { max_tokens: record.request.maxTokens },
    ...record.request.stop === undefined ? {} : { stop_sequences: record.request.stop },
    ...record.reasoningEffort === undefined || record.reasoningEffort === 'off' ? {} : {
      thinking: { type: 'enabled', effort: record.reasoningEffort },
    },
  }
  return { method: 'POST', path: '/v1/messages', body }
}

/** Render the final assembled response in the Messages API object shape. */
export function renderAnthropicResponse(record: CallRecord): Record<string, unknown> {
  const content: AnthropicContent[] = []
  for (const text of responseReasoningOf(record)) content.push({ type: 'thinking', thinking: text })
  const body = responseTextOf(record)
  if (body.length > 0) content.push({ type: 'text', text: body })
  for (const call of responseToolCallsOf(record)) {
    content.push({ type: 'tool_use', id: String(call.id), name: String(call.name), input: toolArgumentsOf(call) })
  }
  const usage = record.response?.usage
  const failure = record.response?.finish.failure
  return {
    id: `msg_${responseIdOf(record)}`,
    type: 'message',
    role: 'assistant',
    model: record.model,
    content,
    stop_reason: STOP_REASON[record.response?.finish.kind ?? 'stop'] ?? 'end_turn',
    ...failure === undefined ? {} : { stop_reason_error: { message: failure.message, type: failure.code } },
    usage: {
      input_tokens: usage?.inputTokens ?? 0,
      output_tokens: usage?.outputTokens ?? 0,
      ...usage?.cacheReadTokens === undefined ? {} : { cache_read_input_tokens: usage.cacheReadTokens },
      ...usage?.cacheWriteTokens === undefined ? {} : { cache_creation_input_tokens: usage.cacheWriteTokens },
    },
  }
}
