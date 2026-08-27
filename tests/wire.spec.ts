/**
 * Wire renderer specs: golden-shape assertions for the three protocol
 * renderings of one fixture record (text + tool traffic + reasoning + image)
 * — including every usage field the neutral record can carry, and the
 * degraded shapes (unsettled records, failures, missing usage).
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
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 25, reasoningTokens: 8 },
    finish: { kind: 'tool-calls' },
    chunkCount: 9,
  },
}

describe('anthropic rendering', () => {
  it('renders the Messages request shape the adapter can legally send', () => {
    const exchange = renderAnthropicRequest(record)
    expect(exchange.method).toBe('POST')
    expect(exchange.path).toBe('/v1/messages')
    const body = exchange.body
    expect(body.model).toBe('some-model')
    expect(body.stream).toBe(true)
    expect(body.system).toEqual([{ type: 'text', text: 'be brief' }])
    expect(body.max_tokens).toBe(512)
    expect(body.stop_sequences).toEqual(['END'])
    // Thinking renders the LEGAL adaptive shape + output_config (the real
    // adapter sends adaptive+output_config or enabled+budget_tokens — only
    // the effort crossed the llm/stream boundary).
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config).toEqual({ effort: 'high' })
    // Temperature is incompatible with thinking: omitted, and noted.
    expect(body.temperature).toBeUndefined()
    expect(body._note).toEqual(expect.any(Array))
    expect((body._note as string[]).join(' ')).toContain('temperature omitted')
    expect(body.tools).toEqual([{
      name: 'lookup',
      description: 'look things up',
      input_schema: { type: 'object', properties: { q: { type: 'string' } } },
    }])
    const messages = body.messages as Record<string, unknown>[]
    expect(messages).toHaveLength(3)
    expect(messages[1].role).toBe('assistant')
    const assistantContent = messages[1].content as Record<string, unknown>[]
    expect(assistantContent[0]).toEqual({ type: 'thinking', thinking: 'thinking about it', _note: expect.any(String) })
    expect(assistantContent[2]).toEqual({ type: 'tool_use', id: 'call-9', name: 'lookup', input: { q: 'wire' } })
    const toolResultContent = (messages[2].content as Record<string, unknown>[])[0]
    expect(toolResultContent.type).toBe('tool_result')
    expect(toolResultContent.tool_use_id).toBe('call-9')
  })

  it('keeps temperature when thinking is off', () => {
    const plain = { ...record, reasoningEffort: 'off' } as CallRecord
    const body = renderAnthropicRequest(plain).body
    expect(body.temperature).toBe(0.2)
    expect(body.thinking).toBeUndefined()
  })

  it('marks a missing maxTokens with a note (the API requires it)', () => {
    const body = renderAnthropicRequest({
      ...record,
      request: { ...record.request, maxTokens: undefined },
    } as CallRecord).body
    expect(body.max_tokens).toBeUndefined()
    expect((body._note as string[]).join(' ')).toContain('max_tokens')
  })

  it('renders the final response with cache usage, preserving block order', () => {
    const response = renderAnthropicResponse(record)
    expect(response.stop_reason).toBe('tool_use')
    expect(response.usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 25,
    })
    const content = response.content as Record<string, unknown>[]
    expect(content.map(block => block.type)).toEqual(['thinking', 'text', 'tool_use'])
  })

  it('preserves interleaved thinking/text order instead of regrouping', () => {
    const interleaved: CallRecord = {
      ...record,
      response: {
        ...record.response!,
        blocks: [
          { type: 'text', text: 'first' },
          { type: 'reasoning', text: 'mid think' },
          { type: 'text', text: 'last' },
        ],
      },
    }
    const content = renderAnthropicResponse(interleaved).content as Record<string, unknown>[]
    expect(content.map(block => block.type)).toEqual(['text', 'thinking', 'text'])
  })

  it('renders failures with a null stop_reason and namespaced _error', () => {
    const failed: CallRecord = {
      ...record,
      status: 'error',
      response: {
        blocks: [],
        finish: { kind: 'error', failure: { message: 'boom', code: 'RATE_LIMIT', status: 429 } },
        chunkCount: 1,
      },
    }
    const response = renderAnthropicResponse(failed)
    expect(response.stop_reason).toBeNull()
    expect(response._error).toEqual({ message: 'boom', code: 'RATE_LIMIT', status: 429 })
  })

  it('renders zeroed usage when none was reported', () => {
    const bare: CallRecord = {
      ...record,
      response: { blocks: [], finish: { kind: 'stop' }, chunkCount: 1 },
    }
    expect(renderAnthropicResponse(bare).usage).toEqual({ input_tokens: 0, output_tokens: 0 })
  })

  it('keeps unparsable tool arguments visible instead of a silent {}', () => {
    const broken: CallRecord = {
      ...record,
      response: {
        ...record.response!,
        blocks: [{ type: 'tool-call', id: 'c', name: 'lookup', arguments: '{oops' }],
      },
    }
    const content = renderAnthropicResponse(broken).content as Record<string, unknown>[]
    const input = content[0].input as Record<string, unknown>
    expect(input._note).toContain('did not parse')
    expect(input.raw).toBe('{oops')
  })
})

describe('openai chat rendering', () => {
  it('renders the chat.completions request shape with streaming fields', () => {
    const exchange = renderOpenAiChatRequest(record)
    expect(exchange.path).toBe('/v1/chat/completions')
    const body = exchange.body
    expect(body.model).toBe('some-model')
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
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

  it('maps system-role history messages to system rows', () => {
    const withSystemMsg: CallRecord = {
      ...record,
      request: {
        ...record.request,
        messages: [{ role: 'system', content: [{ type: 'text', text: 'inline rule' }] }],
      },
    }
    const rows = renderOpenAiChatRequest(withSystemMsg).body.messages as Record<string, unknown>[]
    expect(rows[0]).toEqual({ role: 'system', content: 'be brief' })
    expect(rows[1]).toEqual({ role: 'system', content: 'inline rule' })
  })

  it('uses max_completion_tokens for the reasoning-first model families', () => {
    const gpt5 = renderOpenAiChatRequest({ ...record, model: 'gpt-5.2' } as CallRecord).body
    expect(gpt5.max_completion_tokens).toBe(512)
    expect(gpt5.max_tokens).toBeUndefined()
    const o4 = renderOpenAiChatRequest({ ...record, model: 'o4-mini' } as CallRecord).body
    expect(o4.max_completion_tokens).toBe(512)
    // Everything else (DeepSeek et al.) keeps max_tokens.
    const ds = renderOpenAiChatRequest({ ...record, model: 'deepseek-v4' } as CallRecord).body
    expect(ds.max_tokens).toBe(512)
  })

  it('renders the final response with cached and reasoning token details', () => {
    const response = renderOpenAiChatResponse(record)
    expect(response.object).toBe('chat.completion')
    const choice = (response.choices as Record<string, unknown>[])[0]
    expect(choice.finish_reason).toBe('tool_calls')
    const message = choice.message as Record<string, unknown>
    expect(message.content).toBe('all done')
    expect(message.reasoning_content).toBe('short think')
    // OpenAI reports the TOTAL input (cached_tokens is a subset of it):
    // 100 uncached + 40 cached + 25 written = 165 in, 185 total.
    expect(response.usage).toEqual({
      prompt_tokens: 165,
      completion_tokens: 20,
      total_tokens: 185,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 8 },
    })
  })

  it('renders failures with a null finish_reason and namespaced _error', () => {
    const failed: CallRecord = {
      ...record,
      status: 'aborted',
      response: {
        blocks: [],
        finish: { kind: 'aborted', failure: { message: 'stream closed before finish', code: 'ABORTED' } },
        chunkCount: 2,
      },
    }
    const response = renderOpenAiChatResponse(failed)
    const choice = (response.choices as Record<string, unknown>[])[0]
    expect(choice.finish_reason).toBeNull()
    expect(response._error).toEqual({ message: 'stream closed before finish', code: 'ABORTED' })
    expect(response.usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    })
  })
})

describe('openai responses rendering', () => {
  it('renders the adapter\'s real request form: full input, store disabled', () => {
    const exchange = renderOpenAiResponsesRequest(record)
    expect(exchange.path).toBe('/v1/responses')
    const body = exchange.body
    expect(body.store).toBe(false)
    expect(body.previous_response_id).toBeUndefined()
    expect(body.stream).toBe(true)
    expect(body.prompt_cache_key).toBe('s1')
    // The system prompt rides a leading developer message item (reasoning
    // call), not instructions.
    expect(body.instructions).toBeUndefined()
    const items = body.input as Record<string, unknown>[]
    expect(items[0]).toEqual({
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'be brief' }],
    })
    const kinds = items.slice(1).map(item => item.type)
    expect(kinds).toEqual(['message', 'reasoning', 'message', 'function_call', 'function_call_output'])
    expect(items[5]).toEqual({ type: 'function_call_output', call_id: 'call-9', output: 'found it' })
    // Effort lands in the native reasoning parameter.
    expect(body.reasoning).toEqual({ effort: 'high', summary: 'auto' })
    expect(body.include).toEqual(['reasoning.encrypted_content'])
    expect(body.max_output_tokens).toBe(512)
    expect(body.tools).toEqual([{
      type: 'function',
      name: 'lookup',
      description: 'look things up',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
    }])
    expect(body._chain).toBeUndefined()
  })

  it('seats the system prompt as a system item when the call had no effort', () => {
    const plain = renderOpenAiResponsesRequest({ ...record, reasoningEffort: 'off' } as CallRecord).body
    const items = plain.input as Record<string, unknown>[]
    expect(items[0].role).toBe('system')
    expect(plain.reasoning).toBeUndefined()
  })

  it('keeps tool-result images visible in function_call_output', () => {
    const withImage: CallRecord = {
      ...record,
      request: {
        ...record.request,
        messages: [
          { id: 'm3', role: 'user', content: [
            { type: 'tool-result', toolCallId: 'call-9', content: [
              { type: 'text', text: 'shot: ' },
              { type: 'image', attachment: { attachmentId: 'att-2', mediaType: 'image/png' } },
            ] },
          ] },
        ],
      },
    }
    const items = renderOpenAiResponsesRequest(withImage).body.input as Record<string, unknown>[]
    const output = items[1] as { output?: string }
    expect(output.output).toBe('shot: [image att-2]')
  })

  it('renders the final response with reasoning token details', () => {
    const response = renderOpenAiResponsesResponse(record)
    expect(response.object).toBe('response')
    expect(response.status).toBe('completed')
    const output = response.output as Record<string, unknown>[]
    expect(output.map(item => item.type)).toEqual(['reasoning', 'message', 'function_call'])
    // Total input semantics: 100 uncached + 40 cached + 25 written = 165.
    expect(response.usage).toEqual({
      input_tokens: 165,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens_details: { reasoning_tokens: 8 },
      total_tokens: 185,
    })
  })

  it('maps abort and error finishes to legal statuses', () => {
    const aborted: CallRecord = {
      ...record,
      response: { ...record.response!, finish: { kind: 'aborted', failure: { message: 'gone', code: 'ABORTED' } } },
    }
    expect(renderOpenAiResponsesResponse(aborted).status).toBe('cancelled')
    const errored: CallRecord = {
      ...record,
      response: { ...record.response!, finish: { kind: 'error', failure: { message: 'boom', code: 'X' } } },
    }
    expect(renderOpenAiResponsesResponse(errored).status).toBe('failed')
    expect((renderOpenAiResponsesResponse(errored).error as Record<string, unknown>).message).toBe('boom')
  })

  it('renders zeroed usage when none was reported', () => {
    const bare: CallRecord = {
      ...record,
      response: { blocks: [], finish: { kind: 'stop' }, chunkCount: 1 },
    }
    expect(renderOpenAiResponsesResponse(bare).usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
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

  it('annotates the chain against a prior call; the body stays the real full-input form', () => {
    const info = responsesChainOf(chainedRecord, prior)
    expect(info.chained).toBe(true)
    // Item counts (what `input:` holds): the delta is 2 items, the full
    // history would be 5 (one message expands into several items).
    expect(info.sentItems).toBe(2)
    expect(info.skippedItems).toBe(3)
    expect(info.previousResponseId).toBeDefined()

    const exchange = renderOpenAiResponsesRequest(chainedRecord, { previous: prior })
    const body = exchange.body
    // The reconstruction never masquerades as the real request: full input
    // rides the body, the chain rides a namespaced annotation.
    expect(body.store).toBe(false)
    expect(body.previous_response_id).toBeUndefined()
    const items = body.input as Record<string, unknown>[]
    expect(items).toHaveLength(6) // developer system item + the 5 history items
    expect(body._chain).toEqual({
      chained: true,
      previous_response_id: info.previousResponseId,
      sent_items: 2,
      skipped_items: 3,
      _note: expect.stringContaining('hypothetical'),
    })
  })

  it('marks the annotation degraded when ids do not line up (compaction/edit)', () => {
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
    const body = renderOpenAiResponsesRequest(broken, { previous: prior }).body
    expect(body._chain).toEqual({
      chained: false,
      previous_response_id: undefined,
      sent_items: 1,
      skipped_items: 0,
      _note: expect.any(String),
    })
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
