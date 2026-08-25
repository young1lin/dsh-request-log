/**
 * Store specs: JSONL round-trip, newest-first paging, per-session cap trim,
 * and stale-file retention.
 */

import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CallStore } from '../src/host/store.ts'
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
})
