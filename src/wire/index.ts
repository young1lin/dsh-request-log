/**
 * Protocol detection + the one-stop rendering surface.
 *
 * Detection is a display default only — the harness resolves the real wire
 * protocol inside the pi-ai adapter (catalog route or the `api` field of a
 * user-configured route), which does not cross the `llm/stream` boundary.
 * The UI lets the reader switch formats freely; this just pre-selects the
 * most plausible one.
 *
 * @module dsh-request-log/wire
 */

import type { CallRecord } from '../shared/types'
import type { WireExchange } from './common'
import { renderAnthropicRequest, renderAnthropicResponse } from './anthropic'
import { renderOpenAiChatRequest, renderOpenAiChatResponse } from './openai-chat'
import { renderOpenAiResponsesRequest, renderOpenAiResponsesResponse } from './openai-responses'

export type WireProtocol = 'anthropic-messages' | 'openai-completions' | 'openai-responses'

export const WIRE_PROTOCOLS: readonly { id: WireProtocol; label: string }[] = [
  { id: 'openai-completions', label: 'OpenAI ChatCompletion' },
  { id: 'anthropic-messages', label: 'Anthropic Messages' },
  { id: 'openai-responses', label: 'OpenAI Responses' },
]

/**
 * Best-effort protocol guess for the provider/model pair of one record.
 * Provider-route keys and catalog ids follow the harness conventions
 * (`anthropic`, `openai`, `*-codex`, `azure-openai-responses`, …).
 */
export function detectProtocol(record: CallRecord): WireProtocol {
  const provider = record.provider.toLowerCase()
  const model = record.model.toLowerCase()
  if (provider.includes('anthropic') || provider.includes('claude') || model.startsWith('claude')) {
    return 'anthropic-messages'
  }
  if (provider.includes('codex') || provider.includes('responses') || model.includes('gpt-5-codex')) {
    return 'openai-responses'
  }
  return 'openai-completions'
}

/** Render one exchange (request or response) in the chosen protocol. */
export function renderWire(
  record: CallRecord,
  protocol: WireProtocol,
  side: 'request' | 'response',
  options?: { previous?: CallRecord },
): WireExchange | Record<string, unknown> {
  if (protocol === 'anthropic-messages') {
    return side === 'request' ? renderAnthropicRequest(record) : renderAnthropicResponse(record)
  }
  if (protocol === 'openai-responses') {
    return side === 'request'
      ? renderOpenAiResponsesRequest(record, options)
      : renderOpenAiResponsesResponse(record)
  }
  return side === 'request' ? renderOpenAiChatRequest(record) : renderOpenAiChatResponse(record)
}

export { renderAnthropicRequest, renderAnthropicResponse } from './anthropic'
export { renderOpenAiChatRequest, renderOpenAiChatResponse } from './openai-chat'
export { renderOpenAiResponsesRequest, renderOpenAiResponsesResponse, responsesChainOf } from './openai-responses'
