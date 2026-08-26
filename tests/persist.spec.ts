/**
 * Per-session view memory: fresh defaults, update/load round-trips, the
 * sessionStorage write-through (page refresh), narrow coercion of untrusted
 * stored JSON, fail-soft storage failures, and the in-page session cap.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PAGE_SIZE,
  clearViewMemory,
  freshViewMemory,
  loadViewMemory,
  updateViewMemory,
} from '../src/client/persist.ts'

/** Map-backed Storage stub for the sessionStorage lane. */
function fakeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => { map.clear() },
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => { map.delete(key) },
    setItem: (key: string, value: string) => { map.set(key, value) },
  } as Storage
}

const KEY = 'dsh-request-log:view:s1'

beforeEach(() => {
  clearViewMemory()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fresh defaults', () => {
  it('returns the empty ledger defaults', () => {
    expect(loadViewMemory('s1')).toEqual({
      selected: null,
      limit: PAGE_SIZE,
      auto: true,
      detail: { side: 'request', format: null },
    })
  })
})

describe('in-page round-trip', () => {
  it('keeps an updated selection and prefs per session', () => {
    updateViewMemory('s1', { selected: { id: 'call-7', prevId: 'call-6' } })
    updateViewMemory('s1', { detail: { side: 'response', format: 'openai-responses' } })
    updateViewMemory('s1', { limit: PAGE_SIZE * 2, auto: false })
    expect(loadViewMemory('s1')).toEqual({
      selected: { id: 'call-7', prevId: 'call-6' },
      limit: PAGE_SIZE * 2,
      auto: false,
      detail: { side: 'response', format: 'openai-responses' },
    })
    expect(loadViewMemory('s2')).toEqual(freshViewMemory())
  })

  it('clears a selection back to the list', () => {
    updateViewMemory('s1', { selected: { id: 'call-7' } })
    updateViewMemory('s1', { selected: null })
    expect(loadViewMemory('s1').selected).toBeNull()
  })

  it('returns copies — mutating a load must not poison the store', () => {
    updateViewMemory('s1', { detail: { side: 'response', format: 'neutral' } })
    const loaded = loadViewMemory('s1')
    loaded.detail.side = 'request'
    loaded.selected = { id: 'poison' }
    const again = loadViewMemory('s1')
    expect(again.detail.side).toBe('response')
    expect(again.selected).toBeNull()
  })

  it('keeps only the most recent sessions in-page', () => {
    for (let i = 1; i <= 9; i += 1) updateViewMemory('s' + String(i), { auto: false })
    // s1 fell off the cap with no storage to fall back on (node has none).
    expect(loadViewMemory('s1')).toEqual(freshViewMemory())
    expect(loadViewMemory('s9').auto).toBe(false)
  })
})

describe('sessionStorage write-through', () => {
  it('seeds a fresh page from what the previous page wrote', () => {
    const store = fakeStorage()
    vi.stubGlobal('sessionStorage', store)
    // A previous page wrote this; this page starts with an empty in-page map
    // (exactly the state after a refresh).
    store.setItem(KEY, JSON.stringify({
      selected: { id: 'call-1' },
      limit: 300,
      auto: false,
      detail: { side: 'response', format: 'neutral' },
    }))
    const loaded = loadViewMemory('s1')
    expect(loaded.selected).toEqual({ id: 'call-1' })
    expect(loaded.limit).toBe(300)
    expect(loaded.auto).toBe(false)
    expect(loaded.detail).toEqual({ side: 'response', format: 'neutral' })
  })

  it('degrades corrupted JSON to defaults', () => {
    const store = fakeStorage()
    vi.stubGlobal('sessionStorage', store)
    store.setItem(KEY, '{not json')
    expect(loadViewMemory('s1')).toEqual(freshViewMemory())
  })

  it('coerces untrusted stored fields narrowly', () => {
    const store = fakeStorage()
    vi.stubGlobal('sessionStorage', store)
    store.setItem(KEY, JSON.stringify({
      selected: { id: 'ok', prevId: 42 },
      limit: -5,
      auto: 'yes',
      detail: { side: 'diagonal', format: 'smtp' },
    }))
    expect(loadViewMemory('s1')).toEqual({
      selected: { id: 'ok' },
      limit: PAGE_SIZE,
      auto: true,
      detail: { side: 'request', format: null },
    })
  })

  it('drops a selection whose id is not a string', () => {
    const store = fakeStorage()
    vi.stubGlobal('sessionStorage', store)
    store.setItem(KEY, JSON.stringify({ selected: { id: 7 } }))
    expect(loadViewMemory('s1').selected).toBeNull()
  })

  it('survives a storage that throws on write (quota)', () => {
    const store = fakeStorage()
    vi.stubGlobal('sessionStorage', store)
    vi.spyOn(store, 'setItem').mockImplementation(() => { throw new Error('quota exceeded') })
    expect(() => updateViewMemory('s1', { auto: false })).not.toThrow()
    expect(loadViewMemory('s1').auto).toBe(false)
  })

  it('survives a storage that throws on read', () => {
    const store = fakeStorage()
    vi.stubGlobal('sessionStorage', store)
    vi.spyOn(store, 'getItem').mockImplementation(() => { throw new Error('denied') })
    expect(loadViewMemory('s1')).toEqual(freshViewMemory())
  })
})

describe('clearViewMemory', () => {
  it('forgets the in-page map and the storage keys', () => {
    const store = fakeStorage()
    vi.stubGlobal('sessionStorage', store)
    updateViewMemory('s1', { auto: false })
    updateViewMemory('s2', { auto: false })
    clearViewMemory()
    expect(store.getItem(KEY)).toBeNull()
    expect(store.getItem('dsh-request-log:view:s2')).toBeNull()
    expect(loadViewMemory('s1')).toEqual(freshViewMemory())
  })

  it('clearing ONE session leaves other sessions intact', () => {
    const store = fakeStorage()
    vi.stubGlobal('sessionStorage', store)
    updateViewMemory('s1', { auto: true })
    updateViewMemory('s2', { auto: false, limit: 300 })
    clearViewMemory('s1')
    expect(store.getItem(KEY)).toBeNull()
    expect(store.getItem('dsh-request-log:view:s2')).not.toBeNull()
    expect(loadViewMemory('s1')).toEqual(freshViewMemory())
    expect(loadViewMemory('s2').limit).toBe(300)
  })
})
