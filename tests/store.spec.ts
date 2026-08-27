/**
 * Store specs: JSONL round-trip, newest-first paging, per-session cap trim,
 * and stale-file retention.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { assignSteps, CallStore, fileNameOf } from '../src/host/store.ts'
import { CODEC_DEFLATE_RAW, encodeFrame, hashOfContent } from '../src/host/blob.ts'
import { RECORD_SCHEMA, RECORD_SCHEMA_V2, toIndexEntry } from '../src/shared/types'
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
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    await store.append(recordOf({ id: 'a' }))
    await store.append(recordOf({ id: 'b' }))

    const fetched = await store.get('sess-1', 'b')
    expect(fetched?.id).toBe('b')
    expect(fetched?.request.messages[0].content).toEqual([{ type: 'text', text: 'hi' }])
    expect(await store.get('sess-1', 'missing')).toBeUndefined()
  })

  it('pages the index newest-first with totals', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
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
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 3, maxFileBytes: 8 * 1024 * 1024 })
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
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
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
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
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
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 2, maxFileBytes: 8 * 1024 * 1024 })
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
    const store = new CallStore({ directory, retentionDays: 1, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    await store.append(recordOf({ id: 'old', sessionId: 'old-sess' }))
    // Backdate the file past the retention window.
    const { utimes } = await import('node:fs/promises')
    const stale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    await utimes(join(directory, 'old-sess.jsonl'), stale, stale)

    const { deletedFiles } = await store.sweep()
    expect(deletedFiles).toBe(1)
    // Every session file is gone (v2 keeps an objects/ store alongside).
    const leftovers = (await readdir(directory)).filter(name => name.endsWith('.jsonl'))
    expect(leftovers).toEqual([])
  })

  it('skips corrupt and foreign-schema lines', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
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

  it('projects numeric timing and request-size fields', () => {
    const entry = toIndexEntry(recordOf({
      id: 'nums',
      timing: { startedAt: 1_000, firstChunkAt: 1_150, endedAt: 1_900 },
      request: {
        system: 'ab',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello world' }] }],
      },
    }))
    expect(entry.ttfbMs).toBe(150)
    expect(entry.durationMs).toBe(900)
    // system (2) + message text (11).
    expect(entry.requestChars).toBe(13)
  })

  it('sanitizes session ids into single safe path segments', async () => {
    expect(fileNameOf('normal-Id_1.2')).toBe('normal-Id_1.2.jsonl')
    expect(fileNameOf('a/b')).toBe('a_b.jsonl')
    expect(fileNameOf('..')).toBe('_.jsonl')
    // Percent-encoding is NOT decoded here: % leaves the whitelist and the
    // whole id stays one safe segment.
    expect(fileNameOf('..%2F..')).toBe('.._2F.jsonl')
    expect(fileNameOf('x y')).toBe('x_y.jsonl')
    // Win32 reserved device names get a prefix: NUL.jsonl would target the device.
    expect(fileNameOf('NUL')).toBe('_NUL.jsonl')
    expect(fileNameOf('com1')).toBe('_com1.jsonl')
    expect(fileNameOf('trailing.')).toBe('trailing.jsonl')

    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    await store.append(recordOf({ id: 'safe', sessionId: '../evil' }))
    const names = (await readdir(directory)).filter(name => name.endsWith('.jsonl'))
    // The slashes are gone — one safe segment (leading dots alone are harmless).
    expect(names).toEqual(['.._evil.jsonl'])
    // The sanitized id round-trips through the read path.
    expect(await store.get('../evil', 'safe')).toBeDefined()
  })

  it('creates its directory on the first append', async () => {
    const base = await tempDir()
    const directory = join(base, 'nested', 'deeper')
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    await store.append(recordOf({ id: 'first' }))
    // v2 keeps its object store beside the session file.
    expect((await readdir(directory)).filter(name => name.endsWith('.jsonl'))).toEqual(['sess-1.jsonl'])
    expect(await store.get('sess-1', 'first')).toBeDefined()
  })

  it('repairs a torn tail left by a failed append instead of fusing lines', async () => {
    const directory = await tempDir()
    let writes = 0
    class FlakyStore extends CallStore {
      protected async writeLine(path: string, line: string): Promise<void> {
        writes += 1
        if (writes === 2) {
          // Simulate a partial write followed by the error a full disk raises.
          await writeFile(path, '{"id":"tor', { flag: 'a' })
          throw new Error('ENOSPC')
        }
        await super.writeLine(path, line)
      }
    }
    const store = new FlakyStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    await store.append(recordOf({ id: 'good' }))
    await expect(store.append(recordOf({ id: 'torn' }))).rejects.toThrow('ENOSPC')

    // Without repair, the next append would fuse with the torn half-line and
    // BOTH records would be lost forever. With repair, only the torn one is.
    await store.append(recordOf({ id: 'next' }))
    const page = await store.listIndex('sess-1', 100, 0)
    expect(page.calls.map(call => call.id)).toEqual(['next', 'good'])
    const text = await readFile(join(directory, 'sess-1.jsonl'), 'utf8')
    expect(text.split('\n').every(line => line.length === 0 || line.endsWith('}'))).toBe(true)
  })

  it('bounds a session file in bytes, trimming the oldest records', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 1000, maxFileBytes: 900 })
    for (let i = 0; i < 8; i += 1) {
      await store.append(recordOf({ id: 'r' + String(i), timing: { startedAt: 1_000 + i } }))
    }
    const page = await store.listIndex('sess-1', 1000, 0)
    // The oldest records were trimmed to keep the file under the byte cap...
    expect(page.total).toBeLessThan(8)
    // ...and the NEWEST records all survived, in order.
    const ids = page.calls.map(call => call.id)
    expect(ids[0]).toBe('r7')
    // v2 keeps the cap on LOGICAL bytes: envelope lines + their referenced
    // compressed sizes. One envelope plus its blobs outweighs a tiny v1
    // line, so fewer raw records fit here — what matters is the bound.
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(join(directory, 'sess-1.jsonl'), 'utf8')
    const logical = text.split('\n').reduce((total, line) => {
      if (line.length === 0) return total
      let attributed = Buffer.byteLength(line, 'utf8')
      if (line.startsWith('{"v":2')) {
        for (const ref of JSON.parse(line).refs as { z: number }[]) attributed += ref.z
      }
      return total + attributed
    }, 0)
    expect(logical).toBeLessThanOrEqual(900)
  })
})
/** Total on-disk bytes under the objects root (recursive, fail-soft). */
async function objectBytesOf(root: string): Promise<number> {
  let total = 0
  let entries: string[] = []
  try { entries = await readdir(root) } catch { return 0 }
  for (const entry of entries) {
    const full = join(root, entry)
    const info = await stat(full).catch(() => null)
    if (info === null) continue
    if (info.isDirectory()) total += await objectBytesOf(full)
    else total += info.size
  }
  return total
}

/** Logical attributed bytes of one session file: line bytes + refs z sum. */
async function logicalBytesOfSessionFile(path: string): Promise<number> {
  const text = await readFile(path, 'utf8')
  let total = 0
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    let attributed = Buffer.byteLength(line, 'utf8')
    if (line.startsWith('{"v":2')) {
      for (const ref of JSON.parse(line).refs as { z: number }[]) attributed += ref.z
    }
    total += attributed
  }
  return total
}

/** A fuller record exercising every optional scalar and body shape. */
function richRecord(): CallRecord {
  return {
    schema: RECORD_SCHEMA,
    id: 'rich-1',
    sessionId: 'sess-1',
    provider: 'deepseek',
    model: 'test-model',
    reasoningEffort: 'high',
    requestHash: 'hash-rich',
    attempt: 1,
    timing: { startedAt: 5_000, firstChunkAt: 5_120, endedAt: 6_050 },
    request: {
      system: 'You are a helpful assistant.',
      messages: [
        { id: 'm0', role: 'user', content: [{ type: 'text', text: 'hi there' }], sourceKind: 'user' },
        { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'hello!' }] },
      ],
      tools: [{ name: 'lookup', description: 'looks things up', parameters: { type: 'object' } }],
      temperature: 0.7,
      maxTokens: 256,
      stop: ['END'],
    },
    status: 'ok',
    response: {
      blocks: [
        { type: 'text', text: 'thinking out loud' },
        { type: 'tool-call', id: 'c1', name: 'lookup', arguments: '{"q":42}' },
      ],
      usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 2 },
      finish: { kind: 'tool-calls' },
      chunkCount: 9,
    },
  }
}

/** Session whose every call resends the whole prior history (dedup fodder). */
function growthRecord(callIndex: number): CallRecord {
  const filler = (messageIndex: number): string => `msg-${messageIndex}-${'lorem ipsum dolor sit amet '.repeat(24)}`
  return {
    schema: RECORD_SCHEMA,
    id: `grow-${callIndex}`,
    sessionId: 'grow',
    provider: 'p',
    model: 'm',
    requestHash: `gh${callIndex}`,
    attempt: 1,
    timing: { startedAt: 1_000 + callIndex },
    request: {
      messages: Array.from({ length: callIndex + 1 }, (_, j) => ({
        id: `m${j}`,
        role: 'user' as const,
        content: [{ type: 'text', text: filler(j) }],
      })),
    },
    status: 'ok',
    response: {
      blocks: [{ type: 'text', text: `answer ${callIndex} ${'pad '.repeat(20)}` }],
      usage: { inputTokens: callIndex + 1, outputTokens: 2 },
      finish: { kind: 'stop' },
      chunkCount: 3,
    },
  }
}

describe('CallStore v2 persistence', () => {
  it('projects an index identical to the v1 projection, field for field', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    const record = richRecord()
    await store.append(record)
    const page = await store.listIndex('sess-1', 50, 0)
    expect(page.total).toBe(1)
    // The envelope + precomputed sum project EXACTLY what toIndexEntry
    // derives from the embedded record; assignSteps stamps step 1.
    expect(page.calls[0]).toEqual({ ...toIndexEntry(record), step: 1 })
  })

  it('reassembles get() deep-equal to the original record', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    const record = richRecord()
    await store.append(record)
    const fetched = await store.get('sess-1', 'rich-1')
    // Modulo absent undefined fields only — the shim is a plain v1 record.
    expect(fetched).toEqual(record)
    expect(await store.get('sess-1', 'missing')).toBeUndefined()
  })

  it('lists mixed v1 and v2 lines side by side', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    const legacy: CallRecord = { ...recordOf({ id: 'legacy-1' }), timing: { startedAt: 900 } }
    // Seed a raw legacy line as an old binary would have left it.
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'sess-1.jsonl'), JSON.stringify(legacy) + '\n')
    await store.append(richRecord()) // fresh v2 envelope appended after it
    const page = await store.listIndex('sess-1', 50, 0)
    expect(page.calls.map(call => call.id)).toEqual(['rich-1', 'legacy-1'])
    // Detail reads work through BOTH arms.
    expect((await store.get('sess-1', 'legacy-1'))?.id).toBe('legacy-1')
    expect((await store.get('sess-1', 'rich-1'))?.id).toBe('rich-1')
  })

  it('degrades ONLY the detail slot when a blob is deleted', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    await store.append(richRecord())
    const text = await readFile(join(directory, 'sess-1.jsonl'), 'utf8')
    const env = JSON.parse(text.trim()) as { refs: { k: string; h: string }[] }
    const responseRef = env.refs.find(ref => ref.k === 'r')
    if (responseRef === undefined) throw new Error('missing response ref')
    const objectPath = join(directory, 'objects', responseRef.h.slice(0, 2), responseRef.h + '.drl')
    await rm(objectPath)

    // Index rows are untouched by the missing body.
    const page = await store.listIndex('sess-1', 50, 0)
    expect(page.calls[0]).toEqual({ ...toIndexEntry(richRecord()), step: 1 })
    // The detail view loses exactly that slot, to the placeholder.
    const degraded = await store.get('sess-1', 'rich-1')
    if (degraded === undefined) throw new Error('detail vanished')
    expect(degraded.response).toEqual({ $unavailable: responseRef.h })
    expect(degraded.request.messages).toHaveLength(2)
    expect(degraded.request.system).toBe('You are a helpful assistant.')
  })

  it('dedups growing histories into far fewer object bytes than v1', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 1000, maxFileBytes: 128 * 1024 * 1024 })
    let v1Equivalent = 0
    for (let i = 0; i < 10; i += 1) {
      const record = growthRecord(i)
      v1Equivalent += Buffer.byteLength(JSON.stringify(record), 'utf8')
      await store.append(record)
    }
    const objectTotal = await objectBytesOf(join(directory, 'objects'))
    // Each historical message persists ONCE (compressed); v1 re-persisted all
    // of them in full on every call.
    expect(objectTotal * 4).toBeLessThan(v1Equivalent)
  })

  it('trims by LOGICAL bytes and keeps newest envelopes under the cap', async () => {
    const directory = await tempDir()
    // Cap large enough that several envelopes coexist, small enough that
    // accumulations cross it mid-run (single-record measures still fit).
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 1000, maxFileBytes: 2400 })
    for (let i = 0; i < 6; i += 1) await store.append(growthRecord(i))
    const path = join(directory, 'grow.jsonl')
    const logical = await logicalBytesOfSessionFile(path)
    expect(logical).toBeLessThanOrEqual(2400)
    // Survivors are newest-first complete envelopes only.
    const ids = (await store.listIndex('grow', 100, 0)).calls.map(call => call.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(ids[0]).toBe('grow-5')
    const lastId = ids[ids.length - 1]
    if (lastId === undefined || !lastId.startsWith('grow-')) throw new Error('bad id')
  })

  it('sweep GC removes unreachable stale objects, spares referenced and fresh ones', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 1000, maxFileBytes: 128 * 1024 * 1024 })
    await store.append(growthRecord(2))
    const objectsRoot = join(directory, 'objects')
    // Fabricate two unreachable orphans via the documented frame format.
    const bake = async (content: string): Promise<string> => {
      const hash = hashOfContent(content)
      const bucket = join(objectsRoot, hash.slice(0, 2))
      await mkdir(bucket, { recursive: true })
      await writeFile(join(bucket, hash + '.drl'), encodeFrame(CODEC_DEFLATE_RAW, deflateRawSync(Buffer.from(content))))
      return hash
    }
    const staleHash = await bake('{"stale":true}')
    const freshHash = await bake('{"fresh":true}')
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(join(objectsRoot, staleHash.slice(0, 2), staleHash + '.drl'), past, past)

    await store.sweep()
    const stillThere = new Set<string>()
    for (const bucket of await readdir(objectsRoot)) {
      for (const name of await readdir(join(objectsRoot, bucket))) stillThere.add(name.replace(/\.drl$/, ''))
    }
    expect(stillThere.has(staleHash)).toBe(false) // unreachable + past grace
    expect(stillThere.has(freshHash)).toBe(true) // unreachable but FRESH
    // Referenced objects survive AND the session stays fully readable.
    expect(stillThere.size).toBeGreaterThanOrEqual(2)
    expect(await logicalBytesOfSessionFile(join(directory, 'grow.jsonl'))).toBeGreaterThan(0)
  })

  it("format 'v1' freezes legacy behavior byte-for-byte", async () => {
    const directory = await tempDir()
    await mkdir(directory, { recursive: true })
    const legacyLine = JSON.stringify(recordOf({ id: 'old-1', sessionId: 'frozen' })) + '\n'
    await writeFile(join(directory, 'frozen.jsonl'), legacyLine)
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024, format: 'v1' })
    await store.append(recordOf({ id: 'new-1', sessionId: 'frozen' }))

    const path = join(directory, 'frozen.jsonl')
    const text = await readFile(path, 'utf8')
    const lines = text.split('\n').filter(line => line.length > 0)
    expect(lines).toHaveLength(2)
    // Both lines are raw v1 records; NO object store ever materializes.
    for (const line of lines) expect(line.startsWith('{"schema":1')).toBe(true)
    expect(await readdir(directory)).toEqual(['frozen.jsonl'])

    // Sweeps neither migrate nor GC in frozen mode.
    await store.sweep()
    await store.sweep()
    const after = await readFile(path, 'utf8')
    expect(after.split('\n').filter(line => line.startsWith('{"v":2'))).toEqual([])
    expect(await readdir(directory)).toEqual(['frozen.jsonl'])
    // Legacy read paths serve the frozen session unchanged.
    expect((await store.listIndex('frozen', 50, 0)).total).toBe(2)
    expect((await store.get('frozen', 'new-1'))?.id).toBe('new-1')
  })

  it('migrates a legacy file losslessly and idempotently', async () => {
    const directory = await tempDir()
    const originalA = richRecord()
    const originalB = recordOf({ id: 'plain-2', sessionId: 'sess-1' })
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'sess-1.jsonl'), JSON.stringify(originalA) + '\n' + JSON.stringify(originalB) + '\n')
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })

    await store.sweep()
    const migrated = await readFile(join(directory, 'sess-1.jsonl'), 'utf8')
    const lines = migrated.split('\n').filter(line => line.length > 0)
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(JSON.parse(line).v).toBe(RECORD_SCHEMA_V2)
    // Round-trip through blobs preserves both records exactly.
    expect(await store.get('sess-1', 'rich-1')).toEqual(originalA)
    expect(await store.get('sess-1', 'plain-2')).toEqual(originalB)
    expect((await store.listIndex('sess-1', 50, 0)).calls.map(call => call))
      .toEqual([{ ...toIndexEntry(originalB), step: 2 }, { ...toIndexEntry(originalA), step: 1 }])

    // Idempotent: the second cycle leaves the file byte-stable.
    await store.sweep()
    expect(await readFile(join(directory, 'sess-1.jsonl'), 'utf8')).toBe(migrated)
  })

  it('migrates every legacy file that fits the cycle budget, not just one', async () => {
    const directory = await tempDir()
    await mkdir(directory, { recursive: true })
    for (const id of ['sess-a', 'sess-b', 'sess-c']) {
      await writeFile(join(directory, id + '.jsonl'), JSON.stringify(recordOf({ id: id + '-1', sessionId: id })) + '\n')
    }
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })

    await store.sweep()

    // A one-file-per-day budget never catches up with retention: a backlog of
    // legacy sessions would be deleted before it was ever converted.
    for (const id of ['sess-a', 'sess-b', 'sess-c']) {
      const text = await readFile(join(directory, id + '.jsonl'), 'utf8')
      expect(JSON.parse(text.trim()).v).toBe(RECORD_SCHEMA_V2)
    }
  })

  it('stops at the cycle byte budget and spends it on the newest legacy file first', async () => {
    const directory = await tempDir()
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'old.jsonl'), JSON.stringify(recordOf({ id: 'o-1', sessionId: 'old' })) + '\n')
    await writeFile(join(directory, 'new.jsonl'), JSON.stringify(recordOf({ id: 'n-1', sessionId: 'new' })) + '\n')
    const now = Date.now()
    await utimes(join(directory, 'old.jsonl'), new Date(now - 10 * 86_400_000), new Date(now - 10 * 86_400_000))
    await utimes(join(directory, 'new.jsonl'), new Date(now - 86_400_000), new Date(now - 86_400_000))
    const store = new CallStore({
      directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024,
      migrationBudgetBytes: 1,
    })

    await store.sweep(now)

    // The newest file has the most retention life left, so converting it buys
    // the most stored-byte-days; the oldest may not survive to the next cycle.
    expect(JSON.parse((await readFile(join(directory, 'new.jsonl'), 'utf8')).trim()).v).toBe(RECORD_SCHEMA_V2)
    expect((await readFile(join(directory, 'old.jsonl'), 'utf8')).startsWith('{"schema":')).toBe(true)
  })

  it('repairs torn tails around v2 envelopes (FlakyStore pattern)', async () => {
    const directory = await tempDir()
    let writes = 0
    class FlakyV2 extends CallStore {
      protected override async writeLine(path: string, line: string): Promise<void> {
        writes += 1
        if (writes === 2) {
          // Simulate a partial ENVELOPE write followed by ENOSPC.
          await writeFile(path, '{"id":"tor', { flag: 'a' })
          throw new Error('ENOSPC')
        }
        await super.writeLine(path, line)
      }
    }
    const store = new FlakyV2({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    await store.append(recordOf({ id: 'good' }))
    await expect(store.append(recordOf({ id: 'torn' }))).rejects.toThrow('ENOSPC')
    // Blobs may already exist for the dropped attempt — harmless orphans the
    // next GC pass collects; the INDEX never saw them.
    await store.append(recordOf({ id: 'next' }))
    const page = await store.listIndex('sess-1', 100, 0)
    expect(page.calls.map(call => call.id)).toEqual(['next', 'good'])
    const text = await readFile(join(directory, 'sess-1.jsonl'), 'utf8')
    expect(text.split('\n').every(line => line.length === 0 || line.endsWith('}'))).toBe(true)
  })
})
