/**
 * Per-session view memory: fresh defaults, update/load round-trips, the
 * sessionStorage write-through (page refresh), narrow coercion of untrusted
 * stored JSON, fail-soft storage failures, and the in-page session cap.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
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
      auto: true,
      model: null,
      detail: { side: 'request', format: null },
      charts: { open: true, group: 'hitrate', xMode: 'time', bucketMinutes: 5 },
    })
  })
})

describe('in-page round-trip', () => {
  it('keeps an updated selection and prefs per session', () => {
    updateViewMemory('s1', { selected: { id: 'call-7', prevId: 'call-6' } })
    updateViewMemory('s1', { detail: { side: 'response', format: 'openai-responses' } })
    updateViewMemory('s1', { auto: false })
    expect(loadViewMemory('s1')).toEqual({
      selected: { id: 'call-7', prevId: 'call-6' },
      auto: false,
      model: null,
      detail: { side: 'response', format: 'openai-responses' },
      charts: { open: true, group: 'hitrate', xMode: 'time', bucketMinutes: 5 },
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
      selected: { id: 'call-1', prevId: 'call-0', step: 4 },
      auto: false,
      detail: { side: 'response', format: 'neutral' },
    }))
    const loaded = loadViewMemory('s1')
    expect(loaded.selected).toEqual({ id: 'call-1', prevId: 'call-0', step: 4 })
    expect(loaded.auto).toBe(false)
    expect(loaded.detail).toEqual({ side: 'response', format: 'neutral' })
  })

  it('restores the selected step only when it is a positive integer', () => {
    const store = fakeStorage()
    vi.stubGlobal('sessionStorage', store)
    const seed = (sessionId: string, selected: unknown): void => {
      store.setItem('dsh-request-log:view:' + sessionId, JSON.stringify({
        selected,
        detail: { side: 'request', format: null },
      }))
    }
    seed('zero', { id: 'call-1', step: 0 })
    expect(loadViewMemory('zero').selected).toEqual({ id: 'call-1' })
    seed('text', { id: 'call-2', step: '3' })
    expect(loadViewMemory('text').selected).toEqual({ id: 'call-2' })
    seed('frac', { id: 'call-3', step: 1.5 })
    expect(loadViewMemory('frac').selected).toEqual({ id: 'call-3' })
    seed('ok', { id: 'call-4', step: 7 })
    expect(loadViewMemory('ok').selected).toEqual({ id: 'call-4', step: 7 })
  })

  it('degrades corrupted JSON to defaults', () => {
    const store = fakeStorage()
    vi.stubGlobal('sessionStorage', store)
    store.setItem(KEY, '{not json')
    expect(loadViewMemory('s1')).toEqual(freshViewMemory())
  })

  it('remembers the model filter and rejects a non-string or empty one', () => {
    const store = fakeStorage()
    vi.stubGlobal('sessionStorage', store)
    updateViewMemory('s1', { model: 'glm-5.3' })
    expect(loadViewMemory('s1').model).toBe('glm-5.3')
    updateViewMemory('s1', { model: null })
    expect(loadViewMemory('s1').model).toBeNull()
    // A freshly seeded page per id: 42 is not a model name, and '' is what
    // a cleared chip serializes to — both must read back as "all models".
    store.setItem('dsh-request-log:view:s42', JSON.stringify({ model: 42 }))
    expect(loadViewMemory('s42').model).toBeNull()
    store.setItem('dsh-request-log:view:sempty', JSON.stringify({ model: '' }))
    expect(loadViewMemory('sempty').model).toBeNull()
  })

  it('coerces untrusted stored fields narrowly', () => {
    const store = fakeStorage()
    vi.stubGlobal('sessionStorage', store)
    store.setItem(KEY, JSON.stringify({
      selected: { id: 'ok', prevId: 42 },
      auto: 'yes',
      detail: { side: 'diagonal', format: 'smtp' },
    }))
    expect(loadViewMemory('s1')).toEqual({
      selected: { id: 'ok' },
      auto: true,
      model: null,
      detail: { side: 'request', format: null },
      charts: { open: true, group: 'hitrate', xMode: 'time', bucketMinutes: 5 },
    })
  })

  it('degrades a memory left behind by the three-axis charts', () => {
    const store = fakeStorage()
    vi.stubGlobal('sessionStorage', store)
    // Written by <=0.1.4: a bucket axis plus the stacking and cumulative
    // toggles. The axis name is retired — the by-window reading is what the
    // clock axis now draws — so it falls back to the default rather than
    // leaving the panel on a mode it cannot name. The window width it stored
    // is still a window width and survives; the retired toggles are not read.
    store.setItem('dsh-request-log:view:old', JSON.stringify({
      charts: { open: true, group: 'tokens', xMode: 'bucket', bucketMinutes: 10, stacks: true, cumulative: true },
    }))
    expect(loadViewMemory('old').charts)
      .toEqual({ open: true, group: 'tokens', xMode: 'time', bucketMinutes: 10 })
  })

  it('coerces chart prefs narrowly and keeps valid ones', () => {
    const store = fakeStorage()
    vi.stubGlobal('sessionStorage', store)
    store.setItem(KEY, JSON.stringify({
      charts: { open: false, group: 'tokens', xMode: 'sideways' },
    }))
    const loaded = loadViewMemory('s1')
    expect(loaded.charts).toEqual({ open: false, group: 'tokens', xMode: 'time', bucketMinutes: 5 })
    store.setItem('dsh-request-log:view:s2', JSON.stringify({
      charts: { open: true, group: 'galaxy' },
    }))
    // An uncached session id reads through to storage; s1 stays in-page.
    expect(loadViewMemory('s2').charts).toEqual({ open: true, group: 'hitrate', xMode: 'time', bucketMinutes: 5 })
    // A partial patch rides the merge without dropping untouched fields.
    updateViewMemory('s1', { charts: { group: 'latency', open: false, xMode: 'step', bucketMinutes: 5 } })
    expect(loadViewMemory('s1').charts).toEqual({ open: false, group: 'latency', xMode: 'step', bucketMinutes: 5 })
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
    updateViewMemory('s2', { auto: false })
    clearViewMemory('s1')
    expect(store.getItem(KEY)).toBeNull()
    expect(store.getItem('dsh-request-log:view:s2')).not.toBeNull()
    expect(loadViewMemory('s1')).toEqual(freshViewMemory())
    expect(loadViewMemory('s2').auto).toBe(false)
  })
})

describe('charts window memory', () => {
  it('rejects a stored window that is not a whole number of minutes in range', () => {
    const store = fakeStorage()
    vi.stubGlobal('sessionStorage', store)
    const seed = (id: string, bucketMinutes: unknown): void => {
      store.setItem('dsh-request-log:view:' + id, JSON.stringify({
        charts: { open: true, group: 'tokens', xMode: 'time', bucketMinutes },
      }))
    }
    // A window is a count of minutes: zero and negative name no window, a
    // fraction is not a wall-clock boundary, a day is the ceiling, and a
    // string is not a number however numeric it looks.
    seed('zero', 0)
    expect(loadViewMemory('zero').charts.bucketMinutes).toBe(5)
    seed('neg', -10)
    expect(loadViewMemory('neg').charts.bucketMinutes).toBe(5)
    seed('frac', 2.5)
    expect(loadViewMemory('frac').charts.bucketMinutes).toBe(5)
    seed('huge', 10_000)
    expect(loadViewMemory('huge').charts.bucketMinutes).toBe(5)
    seed('text', '10')
    expect(loadViewMemory('text').charts.bucketMinutes).toBe(5)
    seed('ok', 30)
    expect(loadViewMemory('ok').charts.bucketMinutes).toBe(30)
    seed('day', 1440)
    expect(loadViewMemory('day').charts.bucketMinutes).toBe(1440)
  })
})

describe('charts xMode memory', () => {
  it('defaults to the time axis and round-trips a switch to steps', () => {
    expect(freshViewMemory().charts.xMode).toBe('time')
    updateViewMemory('s-x', { charts: { ...freshViewMemory().charts, xMode: 'step' } })
    expect(loadViewMemory('s-x').charts.xMode).toBe('step')
  })
})
