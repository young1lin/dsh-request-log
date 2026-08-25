/**
 * OpenAI Chat Completion API rendering of one recorded call.
 *
 * Projects the neutral record into the documented POST /v1/chat/completions
 * shape. Reasoning travels in the `reasoning_content` field the
 * OpenAI-compatible ecosystem (DeepSeek included) uses, because the neutral
 * reasoning block has no chat.completions-native seat.
 *
 * @module dsh-request-log/wire/openai-chat
 */

import type { CallRecord, RecordedBlock, RecordedMessage } from '../shared/types'
import type { WireExchange } from './common'
import { blocksToPlainText, requestMessagesOf, responseIdOf, responseReasoningOf, responseTextOf, responseToolCallsOf, textOf } from './common'

type ChatMessage = Record<string, unknown>

function contentPartsOf(message: RecordedMessage): unknown[] {
  const parts: unknown[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        parts.push({ type: 'text', text: textOf(block) })
        break
      case 'reasoning':
        // No chat.completions content seat: keep it visible in the rendering
        // with its origin marked, instead of silently dropping it.
        parts.push({ type: 'text', text: textOf(block), _origin: 'reasoning' })
        break
      case 'image': {
        const attachment = (block.attachment as Record<string, unknown> | undefined) ?? {}
        parts.push({
          type: 'image_url',
          image_url: { url: `attachment:${String(attachment.attachmentId ?? '')}`, _note: 'durable reference; the real request carried a data URL' },
        })
        break
      }
      default:
        parts.push({ type: 'opaque', blockType: block.type })
    }
  }
  return parts
}

/** Chat messages with tool results lifted into dedicated `role: 'tool'` rows. */
function chatMessagesOf(record: CallRecord): ChatMessage[] {
  const rows: ChatMessage[] = []
  if (record.request.system !== undefined) {
    rows.push({ role: 'system', content: record.request.system })
  }
  for (const message of requestMessagesOf(record)) {
    const toolResults = message.content.filter(block => block.type === 'tool-result') as RecordedBlock[]
    const ordinary = message.content.filter(block => block.type !== 'tool-result')
    const toolCalls = (message.role === 'assistant')
      ? message.content.filter(block => block.type === 'tool-call') as RecordedBlock[]
      : []
    let assistantText = ''
    let assistantReasoning = ''
    if (message.role === 'assistant') {
      for (const block of ordinary) {
        if (block.type === 'text') assistantText += textOf(block)
        else if (block.type === 'reasoning') assistantReasoning += textOf(block)
      }
    }

    if (message.role === 'assistant') {
      rows.push({
        role: 'assistant',
        ...assistantText.length > 0 ? { content: assistantText } : { content: null },
        ...assistantReasoning.length > 0 ? { reasoning_content: assistantReasoning } : {},
        ...toolCalls.length > 0 ? {
          tool_calls: toolCalls.map(call => ({
            id: String(call.id),
            type: 'function',
            function: { name: String(call.name), arguments: String(call.arguments) },
          })),
        } : {},
      })
      continue
    }

    if (ordinary.length > 0) {
      rows.push({ role: 'user', content: contentPartsOf(message) })
    }
    for (const result of toolResults) {
      const inner = Array.isArray(result.content) ? result.content as RecordedBlock[] : []
      rows.push({
        role: 'tool',
        tool_call_id: String(result.toolCallId),
        content: blocksToPlainText(inner),
        ...result.isError === true ? { _isError: true } : {},
      })
    }
  }
  return rows
}

const FINISH_REASON: Record<string, string> = {
  'stop': 'stop',
  'tool-calls': 'tool_calls',
  'max-tokens': 'length',
  'aborted': 'aborted',
  'error': 'error',
}

/** Render the request exchange (method, path, body). */
export function renderOpenAiChatRequest(record: CallRecord): WireExchange {
  const body: Record<string, unknown> = {
    model: record.model,
    messages: chatMessagesOf(record),
    ...record.request.tools === undefined || record.request.tools.length === 0 ? {} : {
      tools: record.request.tools.map(tool => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
    },
    ...record.request.temperature === undefined ? {} : { temperature: record.request.temperature },
    ...record.request.maxTokens === undefined ? {} : { max_tokens: record.request.maxTokens },
    ...record.request.stop === undefined ? {} : { stop: record.request.stop },
    ...record.reasoningEffort === undefined || record.reasoningEffort === 'off' ? {} : {
      reasoning_effort: record.reasoningEffort,
    },
  }
  return { method: 'POST', path: '/v1/chat/completions', body }
}

/** Render the final assembled response in the chat.completion object shape. */
export function renderOpenAiChatResponse(record: CallRecord): Record<string, unknown> {
  const reasoning = responseReasoningOf(record).join('')
  const toolCalls = responseToolCallsOf(record).map((call, index) => ({
    id: String(call.id),
    type: 'function',
    function: { name: String(call.name), arguments: String(call.arguments) },
    index,
  }))
  const usage = record.response?.usage
  return {
    id: `chatcmpl-${responseIdOf(record)}`,
    object: 'chat.completion',
    created: Math.floor(record.timing.startedAt / 1000),
    model: record.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: responseTextOf(record),
        ...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
      },
      finish_reason: FINISH_REASON[record.response?.finish.kind ?? 'stop'] ?? 'stop',
    }],
    usage: {
      prompt_tokens: usage?.inputTokens ?? 0,
      completion_tokens: usage?.outputTokens ?? 0,
      total_tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
      ...usage?.cacheReadTokens === undefined ? {} : {
        prompt_tokens_details: { cached_tokens: usage.cacheReadTokens },
      },
    },
  }
}
