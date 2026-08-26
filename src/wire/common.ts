/**
 * Wire-rendering helpers shared by the three protocol renderers.
 *
 * The renderers are pure display projections of an exact recorded
 * request/response pair into each provider's documented wire shape. They run
 * in the browser bundle over the stored neutral record — the same record for
 * every format, so differences between the three views are exactly the
 * differences between the protocols, never between captures.
 *
 * @module dsh-request-log/wire/common
 */

import type { CallRecord, RecordedBlock, RecordedMessage, RecordedUsage } from '../shared/types'

/** One rendered HTTP exchange: the method, path, and JSON body. */
export interface WireExchange {
  method: 'POST'
  path: string
  body: Record<string, unknown>
}

/** The neutral record's block/text accessors the renderers share. */

export function textOf(block: RecordedBlock): string {
  return typeof block.text === 'string' ? block.text : ''
}

/** Parse a tool-call block's raw argument string into an object (fallback {}). */
export function toolArgumentsOf(block: RecordedBlock): Record<string, unknown> {
  try {
    const value = JSON.parse(typeof block.arguments === 'string' ? block.arguments : '{}')
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** Flatten one message's blocks into a plain text string (tool blocks render their identity). */
export function blocksToPlainText(blocks: RecordedBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' || block.type === 'reasoning') {
      parts.push(textOf(block))
    } else if (block.type === 'tool-call') {
      parts.push(`[tool-call ${String(block.name)}(${String(block.id)})]`)
    } else if (block.type === 'tool-result') {
      parts.push(`[tool-result ${String(block.toolCallId)}]`)
    } else if (block.type === 'image') {
      parts.push(`[image ${String((block.attachment as Record<string, unknown> | undefined)?.attachmentId ?? '')}]`)
    }
  }
  return parts.join('')
}

/** Recorded response text (all text blocks joined). */
export function responseTextOf(record: CallRecord): string {
  const parts: string[] = []
  for (const block of record.response?.blocks ?? []) {
    if (block.type === 'text') parts.push(textOf(block))
  }
  return parts.join('')
}

/** Reasoning blocks of the recorded response, in order. */
export function responseReasoningOf(record: CallRecord): string[] {
  const parts: string[] = []
  for (const block of record.response?.blocks ?? []) {
    if (block.type === 'reasoning') parts.push(textOf(block))
  }
  return parts
}

/** Tool-call blocks of the recorded response, in order. */
export function responseToolCallsOf(record: CallRecord): RecordedBlock[] {
  return (record.response?.blocks ?? []).filter(block => block.type === 'tool-call')
}

/** Stable pseudo ids so repeated renders (React keys, JSON diffs) stay stable. */
export function responseIdOf(record: CallRecord): string {
  return `reqlog_${record.requestHash}_${record.attempt}`
}

/** The request messages with the system prompt carried separately. */
export function requestMessagesOf(record: CallRecord): RecordedMessage[] {
  return record.request.messages
}

/**
 * Billed input tokens: the neutral usage counts are DISJOINT (inputTokens is
 * uncached input only), while the OpenAI wire shapes report the TOTAL input
 * (their `cached_tokens`/`prompt_tokens_details` is a subset breakdown of
 * that total, not an extra). Both OpenAI renderers therefore add the cache
 * read/write parts back in — the Anthropic renderer keeps the disjoint
 * split because that API reports it natively.
 */
export function billedInputOf(usage: RecordedUsage | undefined): number {
  if (usage === undefined) return 0
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}
