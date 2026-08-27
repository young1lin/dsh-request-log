/**
 * Ledger pure-function specs: chain-source resolution (prevIdsOf), poll
 * identity reuse (reconcileCalls), and the overview sums (summarize).
 * view.tsx pulls the browser-injected React through ./react; under vitest
 * the same contract is satisfied with a Node require on globalThis.
 */

import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

;(globalThis as { require?: NodeRequire }).require = createRequire(import.meta.url)

const { prevIdsOf, reconcileCalls, summarize } = await import('../src/client/view.tsx')
type Entry = import('../src/shared/types').CallIndexEntry

function entryOf(overrides: Partial<Entry> & { id: string }): Entry {
  return {
    sessionId: 's1',
    provider: 'p',
    model: 'm',
    requestHash: 'h',
    attempt: 1,
    startedAt: 1_000,
    status: 'ok',
    messageCount: 1,
    requestChars: 10,
    ...overrides,
  }
}

describe('prevIdsOf', () => {
  it('resolves the prior different-hash ok call per purpose chain', () => {
    const calls = [
      entryOf({ id: 'c1', requestHash: 'A' }),
      entryOf({ id: 'c1-retry', requestHash: 'A', attempt: 2 }),
      entryOf({ id: 'c2', requestHash: 'B' }),
      entryOf({ id: 'c3', requestHash: 'C', status: 'error' }),
      entryOf({ id: 'c4', requestHash: 'D' }),
      entryOf({ id: 'aux', requestHash: 'E', purpose: 'session-title' }),
    ]
    const prevIds = prevIdsOf(calls)
    // A retry's chain source: none (its own logical call is the head).
    expect(prevIds.get('c1')).toBeUndefined()
    expect(prevIds.get('c1-retry')).toBeUndefined()
    // c2 chains after the (settled) logical call A — its newest attempt.
    expect(prevIds.get('c2')).toBe('c1-retry')
    // An error call is never a chain source but still queries the chain.
    expect(prevIds.get('c3')).toBe('c2')
    // c4 chains after c2 — the error c3 holds no server-side state.
    expect(prevIds.get('c4')).toBe('c2')
    // Auxiliary calls run in their own purpose chain.
    expect(prevIds.get('aux')).toBeUndefined()
  })
})

describe('reconcileCalls', () => {
  it('reverses newest-first pages and reuses previous entry identities', () => {
    const nextA = entryOf({ id: 'a' }) // oldest
    const nextB = entryOf({ id: 'b' })
    const nextC = entryOf({ id: 'c' }) // newest

    // The API pages newest-first: [c, b, a].
    const first = reconcileCalls([nextC, nextB, nextA], undefined)
    expect(first.map(call => call.id)).toEqual(['a', 'b', 'c'])
    expect(first[0]).toBe(nextA)

    // A later poll reuses the object identities the previous load produced:
    // a REFRESHED wire object for the same id is swapped for the identity
    // already on screen — React.memo rows keep skipping unchanged subtrees.
    const refreshedC = entryOf({ id: 'c' })
    const second = reconcileCalls([refreshedC, nextB, nextA], first)
    expect(second.map(call => call.id)).toEqual(['a', 'b', 'c'])
    expect(second[0]).toBe(nextA)
    expect(second[1]).toBe(nextB)
    expect(second[2]).toBe(nextC)
  })
})

describe('summarize', () => {
  it('sums billed input (uncached + hits + writes) and skips usage-less rows for token sums', () => {
    const sums = summarize([
      entryOf({
        id: 'a',
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 25 },
      }),
      entryOf({ id: 'b' }), // no usage reported
      entryOf({
        id: 'c',
        usage: { inputTokens: 1, outputTokens: 2 },
      }),
    ])
    expect(sums.count).toBe(3)
    expect(sums.billed).toBe(100 + 40 + 25 + 1)
    expect(sums.input).toBe(101)
    expect(sums.cacheRead).toBe(40)
    expect(sums.cacheWrite).toBe(25)
    expect(sums.output).toBe(22)
  })
})
