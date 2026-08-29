/**
 * Capture specs: the waterfall recorder passes chunks through unchanged and
 * settles an exact record (blocks, usage, finish, timing, retry correlation).
 */

import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createAttemptTracker, installCapture } from '../src/host/capture.ts'
import type { CallRecord } from '../src/shared/types'

type Listener = (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>

async function* chunksOf(list: StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const chunk of list) yield chunk
}

function fakeStore(): { appended: CallRecord[]; append: (r: CallRecord) => Promise<void> } {
  const appended: CallRecord[] = []
  return { appended, append: async record => { appended.push(record) } }
}

/** Minimal Context double: captures the one listener installCapture registers. */
function contextDouble(): { ctx: unknown; listener: () => Listener } {
  let current: Listener | null = null
  const ctx = {
    on: (_event: string, listener: Listener) => {
      current = listener
      return () => { current = null }
    },
  }
  return { ctx, listener: () => current as Listener }
}

function optionsOf(overrides: Record<string, unknown> = {}): GenerateOptions {
  return {
    provider: 'test-provider',
    model: 'test-model',
    messages: [
      { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
    ],
    ...overrides,
  } as GenerateOptions
}

const okChunks: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'wor' },
  { type: 'text-delta', index: 0, text: 'ld' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'world' } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

describe('capture', () => {
  it('passes every chunk through unchanged and records the assembled attempt', async () => {
    const store = fakeStore()
    const { ctx, listener } = contextDouble()
    const dispose = installCapture(ctx as never, { store })
    expect(typeof dispose).toBe('function')

    const seen = await collect(listener()(optionsOf({ sessionId: 's1' }), () => chunksOf(okChunks)))
    expect(seen).toEqual(okChunks)

    expect(store.appended.length).toBe(1)
    const record = store.appended[0]
    expect(record.status).toBe('ok')
    expect(record.sessionId).toBe('s1')
    expect(record.provider).toBe('test-provider')
    expect(record.model).toBe('test-model')
    expect(record.request.messages.length).toBe(1)
    expect(record.request.messages[0].content[0]).toEqual({ type: 'text', text: 'hello' })
    expect(record.response?.blocks).toEqual([{ type: 'text', text: 'world' }])
    expect(record.response?.usage).toEqual({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 5 })
    expect(record.response?.finish).toEqual({ kind: 'stop' })
    expect(record.response?.chunkCount).toBe(6)
    expect(record.timing.firstChunkAt).toBeGreaterThanOrEqual(record.timing.startedAt)
    expect(record.timing.endedAt).toBeGreaterThanOrEqual(record.timing.firstChunkAt ?? 0)
    expect(record.attempt).toBe(1)
    dispose()
  })

  it('marks error finishes with their failure and keeps the status error', async () => {
    const store = fakeStore()
    const { ctx, listener } = contextDouble()
    installCapture(ctx as never, { store })

    const errorChunks: StreamChunk[] = [
      { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'RATE_LIMIT', status: 429 } } },
    ]
    await collect(listener()(optionsOf(), () => chunksOf(errorChunks)))

    const record = store.appended[0]
    expect(record.status).toBe('error')
    expect(record.response?.finish).toEqual({
      kind: 'error',
      failure: { message: 'boom', code: 'RATE_LIMIT', status: 429 },
    })
  })

  it('counts a same-hash call after a FAILED attempt as a retry', async () => {
    const store = fakeStore()
    const { ctx, listener } = contextDouble()
    installCapture(ctx as never, { store })

    const options = optionsOf({ sessionId: 's1' })
    const errorFinish: StreamChunk[] = [
      { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'RATE_LIMIT' } } },
    ]
    await collect(listener()(options, () => chunksOf(errorFinish)))
    await collect(listener()(options, () => chunksOf(okChunks)))
    await collect(listener()(optionsOf({ sessionId: 's1', model: 'other' }), () => chunksOf(okChunks)))

    expect(store.appended.map(record => record.attempt)).toEqual([1, 2, 1])
    expect(store.appended[1].requestHash).toBe(store.appended[0].requestHash)
  })

  it('does not mark an identical call after a SUCCESSFUL one as a retry', async () => {
    const store = fakeStore()
    const { ctx, listener } = contextDouble()
    installCapture(ctx as never, { store })

    const options = optionsOf({ sessionId: 's1' })
    await collect(listener()(options, () => chunksOf(okChunks)))
    await collect(listener()(options, () => chunksOf(okChunks)))

    expect(store.appended.map(record => record.attempt)).toEqual([1, 1])
  })

  it('does not mark CONCURRENT identical calls as retries of each other', async () => {
    const store = fakeStore()
    const { ctx, listener } = contextDouble()
    installCapture(ctx as never, { store })

    const options = optionsOf({ sessionId: 's1' })
    // Both streams are in flight when the second begins (subagent fan-out
    // shape): neither has settled, so both are attempt 1.
    const first = listener()(options, () => chunksOf(okChunks))
    const second = listener()(options, () => chunksOf(okChunks))
    await collect(first)
    await collect(second)

    expect(store.appended.map(record => record.attempt)).toEqual([1, 1])
  })

  it('settles an aborted record when the consumer breaks the stream early', async () => {
    const store = fakeStore()
    const { ctx, listener } = contextDouble()
    installCapture(ctx as never, { store })

    const stream = listener()(optionsOf(), () => chunksOf(okChunks))
    const iterator = stream[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.return?.()

    const record = store.appended[0]
    expect(record.status).toBe('aborted')
    expect(record.response?.finish.kind).toBe('aborted')
  })

  it('groups unattributed calls under the underscore session', async () => {
    const store = fakeStore()
    const { ctx, listener } = contextDouble()
    installCapture(ctx as never, { store })
    await collect(listener()(optionsOf(), () => chunksOf(okChunks)))
    expect(store.appended[0].sessionId).toBe('_')
    // An EMPTY string is unattributed too, not a session id.
    await collect(listener()(optionsOf({ sessionId: '' }), () => chunksOf(okChunks)))
    expect(store.appended[1].sessionId).toBe('_')
  })

  it('passes purpose and reasoningEffort through to the record', async () => {
    const store = fakeStore()
    const { ctx, listener } = contextDouble()
    installCapture(ctx as never, { store })
    await collect(listener()(optionsOf({ purpose: 'compaction', reasoningEffort: 'high' }), () => chunksOf(okChunks)))
    expect(store.appended[0].purpose).toBe('compaction')
    expect(store.appended[0].reasoningEffort).toBe('high')
  })

  it('settles ok when the stream ends cleanly without a finish chunk', async () => {
    const store = fakeStore()
    const { ctx, listener } = contextDouble()
    installCapture(ctx as never, { store })
    const noFinish = okChunks.filter(chunk => chunk.type !== 'finish')
    await collect(listener()(optionsOf(), () => chunksOf(noFinish)))
    const record = store.appended[0]
    expect(record.status).toBe('ok')
    expect(record.response?.finish).toEqual({ kind: 'stop' })
    expect(record.response?.blocks).toEqual([{ type: 'text', text: 'world' }])
  })

  it('never breaks the call when persisting fails (fail-soft core promise)', async () => {
    const appended: CallRecord[] = []
    let failFirst = true
    const store = {
      append: async (record: CallRecord): Promise<void> => {
        if (failFirst) {
          failFirst = false
          throw new Error('ENOSPC')
        }
        appended.push(record)
      },
    }
    const warnings: string[] = []
    const logger = { warn: (message: string) => { warnings.push(message) } }
    const { ctx, listener } = contextDouble()
    installCapture(ctx as never, { store, logger })

    // The stream completes intact despite the persistence failure...
    const seen = await collect(listener()(optionsOf(), () => chunksOf(okChunks)))
    expect(seen).toEqual(okChunks)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('failed to persist call record')
    // ...and the NEXT call records normally.
    await collect(listener()(optionsOf(), () => chunksOf(okChunks)))
    expect(appended).toHaveLength(1)
  })

  it('degrades to an empty request record when the payload is unserializable', async () => {
    const store = fakeStore()
    const warnings: string[] = []
    const logger = { warn: (message: string) => { warnings.push(message) } }
    const { ctx, listener } = contextDouble()
    installCapture(ctx as never, { store, logger })

    // BigInt breaks JSON serialization: the record degrades, the call does not.
    const options = optionsOf({
      messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'x', n: 10n }] }],
    })
    const seen = await collect(listener()(options as GenerateOptions, () => chunksOf(okChunks)))
    expect(seen).toEqual(okChunks)
    const record = store.appended[0]
    expect(record.status).toBe('ok')
    expect(record.request.messages).toEqual([])
    expect(record.provider).toBe('test-provider')
    expect(warnings.length).toBeGreaterThanOrEqual(1)
  })

  it('stops recording after dispose', async () => {
    const store = fakeStore()
    const { ctx, listener } = contextDouble()
    const dispose = installCapture(ctx as never, { store })
    await collect(listener()(optionsOf(), () => chunksOf(okChunks)))
    expect(store.appended).toHaveLength(1)
    dispose()
    expect(listener()).toBeNull()
  })
})

describe('capture privacy hardening', () => {
  it('redacts credential-shaped substrings from the failure text', async () => {
    const store = fakeStore()
    const { ctx, listener } = contextDouble()
    installCapture(ctx as never, { store })

    const errorChunks: StreamChunk[] = [
      { type: 'finish', reason: { kind: 'error', failure: { message: 'Incorrect API key provided: sk-abc123def456ghi789xyz', code: 'AUTH' } } },
    ]
    await collect(listener()(optionsOf(), () => chunksOf(errorChunks)))

    expect(store.appended[0].response?.finish.failure?.message).toBe('Incorrect API key provided: <redacted>')
  })

  it('drops adapter-private message fields (source/replayState) from the persisted request', async () => {
    const store = fakeStore()
    const { ctx, listener } = contextDouble()
    installCapture(ctx as never, { store })

    await collect(listener()(optionsOf(), () => chunksOf(okChunks)))
    const message = store.appended[0].request.messages[0]
    expect(message).not.toHaveProperty('source')
    expect(message).toEqual({ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }] })
  })

  it('scopes the request hash to the session: identical payloads hash differently across sessions', async () => {
    const store = fakeStore()
    const { ctx, listener } = contextDouble()
    installCapture(ctx as never, { store })

    await collect(listener()(optionsOf({ sessionId: 's1' }), () => chunksOf(okChunks)))
    await collect(listener()(optionsOf({ sessionId: 's2' }), () => chunksOf(okChunks)))
    expect(store.appended[0].requestHash).not.toBe(store.appended[1].requestHash)
  })
})

describe('createAttemptTracker', () => {
  it('expires retry correlation past the window', () => {
    const tracker = createAttemptTracker()
    const key = 's:p'
    expect(tracker.begin(key, 'h', 1_000)).toBe(1)
    tracker.settle(key, false)
    // Inside the window: a retry.
    expect(tracker.begin(key, 'h', 60_000)).toBe(2)
    tracker.settle(key, false)
    // Outside the window (2 minutes later): a fresh logical call.
    expect(tracker.begin(key, 'h', 61_000 + 120_000)).toBe(1)
  })

  it('keeps a same-hash failure after a window-expired success as fresh', () => {
    const tracker = createAttemptTracker()
    const key = 's:p'
    expect(tracker.begin(key, 'h', 1_000)).toBe(1)
    tracker.settle(key, true)
    // A successful call never makes the next identical one a retry.
    expect(tracker.begin(key, 'h', 2_000)).toBe(1)
  })
})
