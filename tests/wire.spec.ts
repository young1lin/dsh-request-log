/**
 * Wire renderer specs: golden-shape assertions for the three protocol
 * renderings of one fixture record (text + tool traffic + reasoning + image).
 */

import { describe, expect, it } from 'vitest'
import type { CallRecord } from '../src/shared/types'
import { RECORD_SCHEMA } from '../src/shared/types'
import { renderAnthropicRequest, renderAnthropicResponse } from '../src/wire/anthropic.ts'
import { renderOpenAiChatRequest, renderOpenAiChatResponse } from '../src/wire/openai-chat.ts'
import { renderOpenAiResponsesRequest, renderOpenAiResponsesResponse, responsesChainOf } from '../src/wire/openai-responses.ts'
import { detectProtocol } from '../src/wire/index.ts'

const record: CallRecord = {
  schema: RECORD_SCHEMA,
  id: 'id-1',
  sessionId: 's1',
  provider: 'openrouter',
  model: 'some-model',
  reasoningEffort: 'high',
  requestHash: 'abc123',
  attempt: 1,
  timing: { startedAt: 1_700_000_000_000, firstChunkAt: 1_700_000_000_120, endedAt: 1_700_000_000_900 },
  request: {
    system: 'be brief',
    temperature: 0.2,
    maxTokens: 512,
    stop: ['END'],
    tools: [{ name: 'lookup', description: 'look things up', parameters: { type: 'object', properties: { q: { type: 'string' } } } }],
    messages: [
      {
        id: 'm1',
        role: 'user',
        sourceKind: 'user',
        content: [
          { type: 'text', text: 'check this' },
          { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png' } },
        ],
      },
      {
        id: 'm2',
        role: 'assistant',
        sourceKind: 'model',
        content: [
          { type: 'reasoning', text: 'thinking about it' },
          { type: 'text', text: 'let me look' },
          { type: 'tool-call', id: 'call-9', name: 'lookup', arguments: '{"q":"wire"}' },
        ],
      },
      {
        id: 'm3',
        role: 'user',
        sourceKind: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'call-9', content: [{ type: 'text', text: 'found it' }] },
        ],
      },
    ],
  },
  status: 'ok',
  response: {
    blocks: [
      { type: 'reasoning', text: 'short think' },
      { type: 'text', text: 'all done' },
      { type: 'tool-call', id: 'call-10', name: 'lookup', arguments: '{"q":"again"}' },
    ],
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40 },
    finish: { kind: 'tool-calls' },
    chunkCount: 9,
  },
}

describe('anthropic rendering', () => {
  it('renders the Messages request shape', () => {
    const exchange = renderAnthropicRequest(record)
    expect(exchange.method).toBe('POST')
    expect(exchange.path).toBe('/v1/messages')
    const body = exchange.body
    expect(body.model).toBe('some-model')
    expect(body.system).toEqual([{ type: 'text', text: 'be brief' }])
    expect(body.max_tokens).toBe(512)
    expect(body.stop_sequences).toEqual(['END'])
    expect(body.thinking).toEqual({ type: 'enabled', effort: 'high' })
    expect(body.tools).toEqual([{
      name: 'lookup',
      description: 'look things up',
      input_schema: { type: 'object', properties: { q: { type: 'string' } } },
    }])
    const messages = body.messages as Record<string, unknown>[]
    expect(messages).toHaveLength(3)
    expect(messages[1].role).toBe('assistant')
    const assistantContent = messages[1].content as Record<string, unknown>[]
    expect(assistantContent[0]).toEqual({ type: 'thinking', thinking: 'thinking about it' })
    expect(assistantContent[2]).toEqual({ type: 'tool_use', id: 'call-9', name: 'lookup', input: { q: 'wire' } })
    const toolResultContent = (messages[2].content as Record<string, unknown>[])[0]
    expect(toolResultContent.type).toBe('tool_result')
    expect(toolResultContent.tool_use_id).toBe('call-9')
  })

  it('renders the final response object with cache usage', () => {
    const response = renderAnthropicResponse(record)
    expect(response.stop_reason).toBe('tool_use')
    expect(response.usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 40,
    })
    const content = response.content as Record<string, unknown>[]
    expect(content.map(block => block.type)).toEqual(['thinking', 'text', 'tool_use'])
  })
})

describe('openai chat rendering', () => {
  it('renders the chat.completions request shape', () => {
    const exchange = renderOpenAiChatRequest(record)
    expect(exchange.path).toBe('/v1/chat/completions')
    const body = exchange.body
    expect(body.model).toBe('some-model')
    expect(body.reasoning_effort).toBe('high')
    expect(body.max_tokens).toBe(512)
    expect(body.stop).toEqual(['END'])
    const rows = body.messages as Record<string, unknown>[]
    expect(rows[0]).toEqual({ role: 'system', content: 'be brief' })
    expect(rows[1].role).toBe('user')
    const parts = rows[1].content as Record<string, unknown>[]
    expect(parts[1].type).toBe('image_url')
    const assistant = rows[2]
    expect(assistant.role).toBe('assistant')
    expect(assistant.content).toBe('let me look')
    expect(assistant.reasoning_content).toBe('thinking about it')
    const calls = assistant.tool_calls as Record<string, unknown>[]
    expect(calls[0].function).toEqual({ name: 'lookup', arguments: '{"q":"wire"}' })
    const toolRow = rows[3]
    expect(toolRow.role).toBe('tool')
    expect(toolRow.tool_call_id).toBe('call-9')
    expect(toolRow.content).toBe('found it')
  })

  it('renders the final response object with cached token details', () => {
    const response = renderOpenAiChatResponse(record)
    expect(response.object).toBe('chat.completion')
    const choice = (response.choices as Record<string, unknown>[])[0]
    expect(choice.finish_reason).toBe('tool_calls')
    const message = choice.message as Record<string, unknown>
    expect(message.content).toBe('all done')
    expect(message.reasoning_content).toBe('short think')
    // OpenAI reports the TOTAL input (cached_tokens is a subset of it):
    // 100 uncached + 40 cached = 140 in, 160 total.
    expect(response.usage).toEqual({
      prompt_tokens: 140,
      completion_tokens: 20,
      total_tokens: 160,
      prompt_tokens_details: { cached_tokens: 40 },
    })
  })
})

describe('openai responses rendering', () => {
  it('renders the /v1/responses request shape with store enabled', () => {
    const exchange = renderOpenAiResponsesRequest(record)
    expect(exchange.path).toBe('/v1/responses')
    const body = exchange.body
    expect(body.store).toBe(true)
    expect(body.previous_response_id).toBeUndefined()
    expect(body.instructions).toBe('be brief')
    expect(body.max_output_tokens).toBe(512)
    const items = body.input as Record<string, unknown>[]
    const kinds = items.map(item => item.type)
    expect(kinds).toEqual(['message', 'reasoning', 'message', 'function_call', 'function_call_output'])
    expect(items[4]).toEqual({ type: 'function_call_output', call_id: 'call-9', output: 'found it' })
    expect(body.tools).toEqual([{
      type: 'function',
      name: 'lookup',
      description: 'look things up',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
    }])
  })

  it('renders the final response object', () => {
    const response = renderOpenAiResponsesResponse(record)
    expect(response.object).toBe('response')
    expect(response.status).toBe('completed')
    const output = response.output as Record<string, unknown>[]
    expect(output.map(item => item.type)).toEqual(['reasoning', 'message', 'function_call'])
    // Total input semantics: 100 uncached + 40 cached = 140 in, 160 total.
    expect(response.usage).toEqual({
      input_tokens: 140,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 40 },
      total_tokens: 160,
    })
  })
})

describe('responses chaining', () => {
  // A prior conversation call: user asks, assistant replies with a tool call.
  const priorMessages = [
    { id: 'm1', role: 'user' as const, content: [{ type: 'text', text: 'check this' }] },
    { id: 'm2', role: 'assistant' as const, content: [
      { type: 'text', text: 'let me look' },
      { type: 'tool-call', id: 'call-9', name: 'lookup', arguments: '{"q":"wire"}' },
    ] },
  ]
  const prior: CallRecord = {
    ...record,
    id: 'prior-1',
    requestHash: 'priorhash',
    attempt: 1,
    request: { ...record.request, messages: priorMessages },
  }
  // This call: same prefix, plus the tool result and a new user message.
  const chainedRecord: CallRecord = {
    ...record,
    id: 'cur-1',
    request: {
      ...record.request,
      messages: [
        ...priorMessages,
        { id: 'm3', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-9', content: [{ type: 'text', text: 'found it' }] }] },
        { id: 'm4', role: 'user', content: [{ type: 'text', text: 'and now?' }] },
      ],
    },
  }

  it('chains against a prior call: delta input only, previous_response_id set', () => {
    const info = responsesChainOf(chainedRecord, prior)
    expect(info.chained).toBe(true)
    // Item counts (what `input:` holds): the delta is 2 items, the full
    // history would be 5 (one message expands into several items).
    expect(info.sentItems).toBe(2)
    expect(info.skippedItems).toBe(3)
    expect(info.previousResponseId).toBeDefined()

    const exchange = renderOpenAiResponsesRequest(chainedRecord, { previous: prior })
    const body = exchange.body
    expect(body.previous_response_id).toBe(info.previousResponseId)
    expect(body.store).toBe(true)
    const items = body.input as Record<string, unknown>[]
    // Only the new rows: the tool result and the new user message — the
    // prefix and the prior assistant reply stay server-side.
    expect(items).toEqual([
      { type: 'function_call_output', call_id: 'call-9', output: 'found it' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'and now?' }] },
    ])
  })

  it('degrades to full input when ids do not line up (compaction/edit)', () => {
    const broken: CallRecord = {
      ...chainedRecord,
      request: {
        ...chainedRecord.request,
        messages: [
          { id: 'm9', role: 'user', content: [{ type: 'text', text: 'different history' }] },
        ],
      },
    }
    const info = responsesChainOf(broken, prior)
    expect(info.chained).toBe(false)
    expect(info.sentItems).toBe(1)
    const exchange = renderOpenAiResponsesRequest(broken, { previous: prior })
    expect(exchange.body.previous_response_id).toBeUndefined()
  })

  it('degrades to full input for a failed prior call', () => {
    const failed: CallRecord = { ...prior, status: 'error' }
    expect(responsesChainOf(chainedRecord, failed).chained).toBe(false)
  })

  it('degrades for a same-hash prior (concurrent identical sibling)', () => {
    const sibling: CallRecord = { ...prior, id: chainedRecord.id + '-x', requestHash: chainedRecord.requestHash }
    expect(responsesChainOf(chainedRecord, sibling).chained).toBe(false)
  })

  it('degrades when the record is handed to itself as prior', () => {
    expect(responsesChainOf(chainedRecord, chainedRecord).chained).toBe(false)
  })

  it('degrades when the delta would be empty (all rows assistant)', () => {
    const onlyAssistant: CallRecord = {
      ...chainedRecord,
      request: {
        ...chainedRecord.request,
        messages: [
          ...prior.request.messages,
          { id: 'm5', role: 'assistant', content: [{ type: 'text', text: 'local prefill' }] },
        ],
      },
    }
    const info = responsesChainOf(onlyAssistant, prior)
    expect(info.chained).toBe(false)
    // Full input then: every message ships, none held server-side.
    expect(info.skippedItems).toBe(0)
    const exchange = renderOpenAiResponsesRequest(onlyAssistant, { previous: prior })
    expect(exchange.body.previous_response_id).toBeUndefined()
  })

  it('reports full input without a prior call', () => {
    const info = responsesChainOf(chainedRecord, undefined)
    expect(info.chained).toBe(false)
    // 4 messages expand to 5 wire items (assistant rows fan out).
    expect(info.sentItems).toBe(5)
    expect(info.skippedItems).toBe(0)
  })
})

describe('protocol detection', () => {
  it('guesses from provider and model identities', () => {
    expect(detectProtocol({ ...record, provider: 'anthropic', model: 'claude-sonnet-5' })).toBe('anthropic-messages')
    expect(detectProtocol({ ...record, provider: 'openai', model: 'gpt-5.2' })).toBe('openai-responses')
    expect(detectProtocol({ ...record, provider: 'openai-codex', model: 'gpt-5-codex' })).toBe('openai-responses')
    expect(detectProtocol({ ...record, provider: 'deepseek', model: 'deepseek-v4' })).toBe('openai-completions')
    expect(detectProtocol({ ...record, provider: 'openrouter', model: 'some-model' })).toBe('openai-completions')
  })
})
