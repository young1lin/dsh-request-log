/**
 * Store specs: JSONL round-trip, newest-first paging, per-session cap trim,
 * and stale-file retention.
 */

import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assignSteps, CallStore } from '../src/host/store.ts'
import { RECORD_SCHEMA, toIndexEntry } from '../src/shared/types'
import type { CallRecord } from '../src/shared/types'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-request-log-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function recordOf(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    schema: RECORD_SCHEMA,
    id: overrides.id ?? 'id-1',
    sessionId: overrides.sessionId ?? 'sess-1',
    provider: 'p',
    model: 'm',
    requestHash: 'h',
    attempt: 1,
    timing: { startedAt: 1_000 },
    request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
    status: 'ok',
    response: {
      blocks: [{ type: 'text', text: 'hey' }],
      usage: { inputTokens: 3, outputTokens: 4 },
      finish: { kind: 'stop' },
      chunkCount: 2,
    },
    ...overrides,
  }
}

describe('CallStore', () => {
  it('appends and reads back records losslessly', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100 })
    await store.append(recordOf({ id: 'a' }))
    await store.append(recordOf({ id: 'b' }))

    const fetched = await store.get('sess-1', 'b')
    expect(fetched?.id).toBe('b')
    expect(fetched?.request.messages[0].content).toEqual([{ type: 'text', text: 'hi' }])
    expect(await store.get('sess-1', 'missing')).toBeUndefined()
  })

  it('pages the index newest-first with totals', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100 })
    for (let i = 0; i < 5; i += 1) {
      await store.append(recordOf({ id: 'r' + String(i), timing: { startedAt: 1_000 + i } }))
    }

    const first = await store.listIndex('sess-1', 2, 0)
    expect(first.total).toBe(5)
    expect(first.calls.map(call => call.id)).toEqual(['r4', 'r3'])
    const second = await store.listIndex('sess-1', 2, 2)
    expect(second.calls.map(call => call.id)).toEqual(['r2', 'r1'])

    const entry = first.calls[0]
    expect(entry.startedAt).toBe(1_004)
    expect(entry.messageCount).toBe(1)
    expect(entry.usage).toEqual({ inputTokens: 3, outputTokens: 4 })
    expect(entry.finishKind).toBe('stop')
    expect(entry.responseBlockKinds).toEqual(['text'])
    expect(entry.durationMs).toBeUndefined()
  })

  it('trims a session file to the newest maxCallsPerSession records', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 3 })
    for (let i = 0; i < 5; i += 1) {
      await store.append(recordOf({ id: 'r' + String(i), timing: { startedAt: 1_000 + i } }))
    }
    const { trimmedFiles } = await store.sweep()
    expect(trimmedFiles).toBe(1)

    const page = await store.listIndex('sess-1', 100, 0)
    expect(page.calls.map(call => call.id)).toEqual(['r4', 'r3', 'r2'])
    const text = await readFile(join(directory, 'sess-1.jsonl'), 'utf8')
    expect(text.split('\n').filter(line => line.length > 0).length).toBe(3)
  })

  it('stamps conversation-loop steps on the projected index', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100 })
    await store.append(recordOf({ id: 's1', requestHash: 'h1' }))
    await store.append(recordOf({ id: 's1-retry', requestHash: 'h1', attempt: 2 }))
    await store.append(recordOf({ id: 'title', purpose: 'session-title' }))
    await store.append(recordOf({ id: 's2', requestHash: 'h2' }))

    const page = await store.listIndex('sess-1', 50, 0)
    // Newest-first rows; step is gap-free across ordinary calls, retries
    // share their step, and the auxiliary title call carries none.
    const byId = new Map(page.calls.map(call => [call.id, call]))
    expect(byId.get('s1')?.step).toBe(1)
    expect(byId.get('s1-retry')?.step).toBe(1)
    expect(byId.get('title')?.step).toBeUndefined()
    expect(byId.get('s2')?.step).toBe(2)
  })

  it('assignSteps tolerates a trimmed retry chain head', () => {
    const entries = [
      { ...toIndexEntry(recordOf({ id: 'r2', requestHash: 'h1', attempt: 2 })), attempt: 2 },
      { ...toIndexEntry(recordOf({ id: 'next', requestHash: 'h2', attempt: 1 })), attempt: 1 },
    ]
    assignSteps(entries)
    // The orphaned retry opens the window's first step instead of stalling at 0.
    expect(entries[0]?.step).toBe(1)
    expect(entries[1]?.step).toBe(2)
  })

  it('serves appends incrementally and tolerates torn tails', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100 })
    await store.append(recordOf({ id: 'a' }))
    await store.append(recordOf({ id: 'b' }))
    expect((await store.listIndex('sess-1', 50, 0)).total).toBe(2)

    // A torn write: half a line with no trailing newline must be ignored,
    // then picked up once the appending record completes it.
    await writeFile(join(directory, 'sess-1.jsonl'), '{"id":"tor', { flag: 'a' })
    let page = await store.listIndex('sess-1', 50, 0)
    expect(page.total).toBe(2)

    await store.append(recordOf({ id: 'c' }))
    page = await store.listIndex('sess-1', 50, 0)
    // The torn prefix physically fuses with the next appended record into
    // one unparsable line: that fused record is lost (fail-soft skip), the
    // earlier complete records survive, and nothing crashes.
    expect(page.calls.map(call => call.id)).toEqual(['b', 'a'])

    // After the fused line, a fresh append lands on its own line and the
    // incremental path picks it up again.
    await store.append(recordOf({ id: 'd' }))
    page = await store.listIndex('sess-1', 50, 0)
    expect(page.calls.map(call => call.id)).toContain('d')
  })

  it('re-reads fully after a trim shrinks the file', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 2 })
    await store.append(recordOf({ id: 'a', requestHash: 'h1' }))
    await store.append(recordOf({ id: 'b', requestHash: 'h2' }))
    await store.listIndex('sess-1', 50, 0) // warm the incremental cache
    await store.append(recordOf({ id: 'c', requestHash: 'h3' }))
    await store.sweep() // trims to the newest 2 lines and rewrites the file
    const page = await store.listIndex('sess-1', 50, 0)
    expect(page.total).toBe(2)
    expect(page.calls.map(call => call.id)).toEqual(['c', 'b'])
  })

  it('deletes stale session files on sweep', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 1, maxCallsPerSession: 100 })
    await store.append(recordOf({ id: 'old', sessionId: 'old-sess' }))
    // Backdate the file past the retention window.
    const { utimes } = await import('node:fs/promises')
    const stale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    await utimes(join(directory, 'old-sess.jsonl'), stale, stale)

    const { deletedFiles } = await store.sweep()
    expect(deletedFiles).toBe(1)
    expect(await readdir(directory)).toEqual([])
  })

  it('skips corrupt and foreign-schema lines', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100 })
    await store.append(recordOf({ id: 'good' }))
    await writeFile(join(directory, 'sess-1.jsonl'), 'not json\n', { flag: 'a' })
    await writeFile(
      join(directory, 'sess-1.jsonl'),
      JSON.stringify({ ...recordOf({ id: 'bad' }), schema: 999 }) + '\n',
      { flag: 'a' },
    )
    const page = await store.listIndex('sess-1', 100, 0)
    expect(page.total).toBe(1)
    expect(page.calls[0].id).toBe('good')
  })

  it('toIndexEntry projects retry and purpose metadata', () => {
    const entry = toIndexEntry(recordOf({ id: 'x', attempt: 3, purpose: 'compaction' }))
    expect(entry.attempt).toBe(3)
    expect(entry.purpose).toBe('compaction')
  })

  it('toIndexEntry counts native tool-call blocks as invocations', () => {
    const entry = toIndexEntry(recordOf({
      id: 'native',
      response: {
        blocks: [
          { type: 'text', text: 'thinking' },
          { type: 'tool-call', id: 'c1', name: 'lookup', arguments: '{"q":1}' },
          { type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' },
          { type: 'tool-call', id: 'c3', name: 'lookup', arguments: '{}' },
        ],
        usage: { inputTokens: 1, outputTokens: 2 },
        finish: { kind: 'tool-calls' },
        chunkCount: 4,
      },
    }))
    expect(entry.toolCalls).toBe(3)
    expect(entry.calledTools).toEqual([
      { name: 'lookup', count: 2 },
      { name: 'read', count: 1 },
    ])
  })

  it('counts a run_code program by its inner dispatch sites', () => {
    const code = 'const a = await tools.read({})\nawait tools[\'grep\']({})\nfor (const x of [1, 2]) await tools.pwsh({})'
    const entry = toIndexEntry(recordOf({
      id: 'code',
      request: {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [{ name: 'run_code', description: '', parameters: {} }],
      },
      response: {
        blocks: [{ type: 'tool-call', id: 'c9', name: 'run_code', arguments: JSON.stringify({ code, description: 'd' }) }],
        usage: { inputTokens: 1, outputTokens: 2 },
        finish: { kind: 'tool-calls' },
        chunkCount: 2,
      },
    }))
    // Static SITE count: the loop body's tools.pwsh site counts once,
    // however many times it runs at runtime.
    expect(entry.toolCalls).toBe(3)
    expect(entry.calledTools).toEqual([
      { name: 'read', count: 1 },
      { name: 'grep', count: 1 },
      { name: 'pwsh', count: 1 },
    ])
    expect(entry.toolNames).toEqual(['run_code'])
  })

  it('falls back to the transport call when the program is opaque', () => {
    const entry = toIndexEntry(recordOf({
      id: 'dyn',
      response: {
        blocks: [{ type: 'tool-call', id: 'c9', name: 'run_code', arguments: JSON.stringify({ code: 'await tools[k]({})' }) }],
        usage: { inputTokens: 1, outputTokens: 2 },
        finish: { kind: 'tool-calls' },
        chunkCount: 2,
      },
    }))
    expect(entry.toolCalls).toBe(1)
    expect(entry.calledTools).toEqual([{ name: 'run_code', count: 1 }])
  })

  it('omits toolCalls for unsettled responses and zeroes text-only ones', () => {
    expect(toIndexEntry(recordOf({ id: 'open', response: undefined })).toolCalls).toBeUndefined()
    const text = toIndexEntry(recordOf({ id: 'text' }))
    expect(text.toolCalls).toBe(0)
    expect(text.calledTools).toBeUndefined()
  })
})
