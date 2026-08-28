/**
 * Store specs: JSONL round-trip, newest-first paging, per-session cap trim,
 * and stale-file retention.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { assignSteps, CallStore, fileNameOf, packingOrder } from '../src/host/store.ts'
import { BlobStore, CODEC_DEFLATE_RAW, decodeFrame, encodeFrame, hashOfContent } from '../src/host/blob.ts'
import { PackStore } from '../src/host/pack.ts'
import { TREE_SCHEMA, encodeTree, resolveTree } from '../src/host/tree.ts'
import { resolveStoreConfig } from '../src/host/index.ts'
import { RECORD_SCHEMA, RECORD_SCHEMA_V3, toIndexEntry } from '../src/shared/types'
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

  it('writes v3 envelopes that round-trip the whole record', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    const original = richRecord()
    await store.append(original)

    const line = (await readFile(join(directory, 'sess-1.jsonl'), 'utf8')).trim()
    const env = JSON.parse(line) as { v: number; tree?: string; refs?: unknown; zn?: number }
    expect(env.v).toBe(RECORD_SCHEMA_V3)
    expect(typeof env.tree).toBe('string')
    expect(env.refs).toBeUndefined() // the piece list moved into the tree
    expect(env.zn).toBeGreaterThan(0)
    expect(await store.get('sess-1', original.id)).toEqual(original)
  })

  it('keeps the envelope line flat as the conversation grows', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 500, maxFileBytes: 64 * 1024 * 1024 })
    const messages: CallRecord['request']['messages'] = []
    for (let turn = 1; turn <= 40; turn += 1) {
      messages.push({ role: 'user', content: [{ type: 'text', text: 'ask ' + String(turn) }] })
      messages.push({ role: 'assistant', content: [{ type: 'text', text: 'answer ' + String(turn) }] })
      await store.append(recordOf({
        id: 'c-' + String(turn),
        requestHash: 'h' + String(turn),
        request: { system: 'sys', messages: [...messages] },
      }))
    }
    const lines = (await readFile(join(directory, 'sess-1.jsonl'), 'utf8')).split('\n').filter(l => l.length > 0)
    expect(lines).toHaveLength(40)
    // v2 re-listed every hash, so line 40 was ~40x line 1. A tree hash is one
    // hash whatever the history length, so the line must stay flat.
    expect(Buffer.byteLength(lines[39])).toBeLessThan(Buffer.byteLength(lines[0]) * 2)
    // The last call still resolves its full 80-message history.
    const last = await store.get('sess-1', 'c-40')
    expect(last?.request.messages).toHaveLength(80)
    expect(last?.request.messages[0].content[0].text).toBe('ask 1')
    expect(last?.request.system).toBe('sys')
  })

  it('round-trips a compaction that replaced the message list', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    const grown: CallRecord['request']['messages'] = [
      { role: 'user', content: [{ type: 'text', text: 'one' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
      { role: 'user', content: [{ type: 'text', text: 'three' }] },
    ]
    await store.append(recordOf({ id: 'grown', request: { messages: grown } }))
    // Compaction rewrites history wholesale: a delta cannot express it, so
    // the writer must cut a keyframe and the read must still be exact.
    const compacted: CallRecord['request']['messages'] = [
      { role: 'user', content: [{ type: 'text', text: 'summary so far' }] },
    ]
    await store.append(recordOf({ id: 'compacted', requestHash: 'h2', purpose: 'compaction', request: { messages: compacted } }))

    expect((await store.get('sess-1', 'compacted'))?.request.messages).toEqual(compacted)
    expect((await store.get('sess-1', 'grown'))?.request.messages).toEqual(grown)
  })

  it('bills a retry nothing: an identical request materializes no new object', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    const first = recordOf({ id: 'try-1', attempt: 1 })
    await store.append(first)
    await store.append({ ...first, id: 'try-2', attempt: 2 })
    const lines = (await readFile(join(directory, 'sess-1.jsonl'), 'utf8')).split('\n').filter(l => l.length > 0)
    const envs = lines.map(line => JSON.parse(line) as { tree: string; zn: number })
    expect(envs[0].zn).toBeGreaterThan(0)
    // Same pieces, same tree, nothing new on disk.
    expect(envs[1].tree).toBe(envs[0].tree)
    expect(envs[1].zn).toBe(0)
  })

  it('degrades one unresolvable tree without losing the record metadata', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    await store.append(recordOf({ id: 'orphan' }))
    const env = JSON.parse((await readFile(join(directory, 'sess-1.jsonl'), 'utf8')).trim()) as { tree: string }
    await rm(join(directory, 'objects', env.tree.slice(0, 2), env.tree + '.drl'))

    const record = await store.get('sess-1', 'orphan')
    expect(record?.id).toBe('orphan')
    expect(record?.provider).toBe('p')
    expect(record?.status).toBe('ok')
    // The gap is stated, never implied by an empty conversation.
    expect(JSON.stringify(record?.request.messages)).toContain('unavailable')
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
      if (line.startsWith('{"v":3')) {
        attributed += (JSON.parse(line) as { zn: number }).zn
      } else if (line.startsWith('{"v":2')) {
        for (const ref of JSON.parse(line).refs as { z: number }[]) attributed += ref.z
      }
      return total + attributed
    }, 0)
    // v3 bills materialized bytes (zn), not per-reference sizes: this run
    // settles at 866 logical for the two surviving lines (line bytes + Σ zn),
    // and 900 is the smallest round bound above it.
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
    if (line.startsWith('{"v":3')) {
      attributed += (JSON.parse(line) as { zn: number }).zn
    } else if (line.startsWith('{"v":2')) {
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
    const env = JSON.parse(text.trim()) as { resp?: string }
    const responseRef = env.resp === undefined ? undefined : { h: env.resp }
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
    expect(after.split('\n').filter(line => line.startsWith('{"v":2') || line.startsWith('{"v":3'))).toEqual([])
    expect(await readdir(directory)).toEqual(['frozen.jsonl'])
    // Legacy read paths serve the frozen session unchanged.
    expect((await store.listIndex('frozen', 50, 0)).total).toBe(2)
    expect((await store.get('frozen', 'new-1'))?.id).toBe('new-1')
  })

  it('marks tree chains transitively so a swept store keeps live pieces', async () => {
    const directory = await tempDir()
    const objects = join(directory, 'objects')
    await mkdir(directory, { recursive: true })

    // Bake one piece, one keyframe naming it, one delta naming a second piece.
    const bakeRaw = async (content: string): Promise<string> => {
      const hash = hashOfContent(content)
      await mkdir(join(objects, hash.slice(0, 2)), { recursive: true })
      await writeFile(
        join(objects, hash.slice(0, 2), hash + '.drl'),
        encodeFrame(CODEC_DEFLATE_RAW, deflateRawSync(Buffer.from(content, 'utf8'), { level: 6 })),
      )
      return hash
    }
    const older = await bakeRaw(JSON.stringify({ role: 'user', content: [] }))
    const newer = await bakeRaw(JSON.stringify({ role: 'assistant', content: [] }))
    const rootHash = await bakeRaw(encodeTree({ t: TREE_SCHEMA, e: [{ k: 'm', h: older }] }))
    const leafHash = await bakeRaw(encodeTree({ t: TREE_SCHEMA, p: rootHash, e: [{ k: 'm', h: newer }] }))

    // Only the LEAF appears in the line. Everything behind it is reachable
    // solely through the tree chain.
    await writeFile(
      join(directory, 'sess-1.jsonl'),
      JSON.stringify({ v: 3, id: 'c-1', tree: leafHash }) + '\n',
    )
    // Age every object past the GC grace floor so nothing is spared by mtime.
    const stale = new Date(Date.now() - 3 * 60 * 60 * 1000)
    for (const hash of [older, newer, rootHash, leafHash]) {
      await utimes(join(objects, hash.slice(0, 2), hash + '.drl'), stale, stale)
    }

    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    await store.sweep()

    // Every live piece survived the sweep — loose OR packed, never deleted.
    // The sweep may have packed these cold objects, so the judge is a
    // pack-aware reader over the same directory, not a loose-only stat.
    const reader = new BlobStore({ directory: objects, packs: new PackStore({ directory: join(objects, 'packs') }) })
    for (const hash of [older, newer, rootHash, leafHash]) {
      expect(await reader.has(hash)).toBe(true)
    }
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
    for (const line of lines) expect(JSON.parse(line).v).toBe(RECORD_SCHEMA_V3)
    // Round-trip through blobs preserves both records exactly.
    expect(await store.get('sess-1', 'rich-1')).toEqual(originalA)
    expect(await store.get('sess-1', 'plain-2')).toEqual(originalB)
    expect((await store.listIndex('sess-1', 50, 0)).calls.map(call => call))
      .toEqual([{ ...toIndexEntry(originalB), step: 2 }, { ...toIndexEntry(originalA), step: 1 }])

    // Idempotent: the second cycle leaves the file byte-stable.
    await store.sweep()
    expect(await readFile(join(directory, 'sess-1.jsonl'), 'utf8')).toBe(migrated)
  })

  it('converts a v2 file to v3 without reading a single blob body', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    const original = richRecord()
    await store.append(original)
    // Rewrite the line back into v2 shape to stand in for a file written by
    // the previous release.
    const v3 = JSON.parse((await readFile(join(directory, 'sess-1.jsonl'), 'utf8')).trim()) as Record<string, unknown>
    const entries = await resolveTree(v3.tree as string, async hash => {
      const bucket = (hash as string).slice(0, 2)
      return readFile(join(directory, 'objects', bucket, hash + '.drl'))
        .then(frame => inflateRawSync(decodeFrame(frame).payload))
    })
    const refs = [
      ...entries.map(item => ({ k: item.k, h: item.h, z: 1 })),
      ...(v3.resp === undefined ? [] : [{ k: 'r', h: v3.resp as string, z: 1 }]),
    ]
    delete v3.tree; delete v3.resp; delete v3.zn
    await writeFile(join(directory, 'sess-1.jsonl'), JSON.stringify({ ...v3, v: 2, refs }) + '\n')

    await store.sweep()

    const migrated = (await readFile(join(directory, 'sess-1.jsonl'), 'utf8')).trim()
    expect(JSON.parse(migrated).v).toBe(RECORD_SCHEMA_V3)
    expect(await store.get('sess-1', original.id)).toEqual(original)
  })

  it('compacts a migrated file with deltas, not a keyframe per line', async () => {
    const directory = await tempDir()
    await mkdir(directory, { recursive: true })
    const messages: CallRecord['request']['messages'] = []
    const lines: string[] = []
    for (let turn = 1; turn <= 20; turn += 1) {
      messages.push({ role: 'user', content: [{ type: 'text', text: 'ask ' + String(turn) }] })
      lines.push(JSON.stringify(recordOf({
        id: 'c-' + String(turn),
        requestHash: 'h' + String(turn),
        request: { messages: [...messages] },
      })))
    }
    await writeFile(join(directory, 'sess-1.jsonl'), lines.join('\n') + '\n')
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 64 * 1024 * 1024 })

    await store.sweep()

    const converted = (await readFile(join(directory, 'sess-1.jsonl'), 'utf8')).split('\n').filter(l => l.length > 0)
    expect(converted).toHaveLength(20)
    for (const line of converted) expect(JSON.parse(line).v).toBe(RECORD_SCHEMA_V3)
    // A keyframe per line would make every tree object as large as its
    // history; deltas keep all but the first tiny.
    const trees = converted.map(line => (JSON.parse(line) as { tree: string }).tree)
    expect(new Set(trees).size).toBe(20)
    expect(await store.get('sess-1', 'c-20')).toBeDefined()
    expect((await store.get('sess-1', 'c-20'))?.request.messages).toHaveLength(20)
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
      expect(JSON.parse(text.trim()).v).toBe(RECORD_SCHEMA_V3)
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
    expect(JSON.parse((await readFile(join(directory, 'new.jsonl'), 'utf8')).trim()).v).toBe(RECORD_SCHEMA_V3)
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

describe('CallStore v3 compatibility edges', () => {
  /** Fabricate a genuine v2 line (previous-release shape) out of a v3 append. */
  async function rewriteAsV2(directory: string, ids: string[]): Promise<void> {
    const path = join(directory, 'sess-1.jsonl')
    const text = await readFile(path, 'utf8')
    const out: string[] = []
    const byId = new Map(text.split('\n').filter(l => l.length > 0).map(l => [String((JSON.parse(l) as { id: string }).id), l]))
    for (const id of ids) {
      const v3 = JSON.parse(byId.get(id) as string) as Record<string, unknown>
      const entries = await resolveTree(v3.tree as string, async hash => {
        const bucket = (hash as string).slice(0, 2)
        return readFile(join(directory, 'objects', bucket, hash + '.drl'))
          .then(frame => inflateRawSync(decodeFrame(frame).payload))
      })
      const refs = [
        ...entries.map(item => ({ k: item.k, h: item.h, z: 1 })),
        ...(v3.resp === undefined ? [] : [{ k: 'r', h: v3.resp as string, z: 1 }]),
      ]
      delete v3.tree; delete v3.resp; delete v3.zn
      out.push(JSON.stringify({ ...v3, v: 2, refs }))
    }
    await writeFile(path, out.join('\n') + '\n')
  }

  it('serves v1, v2 and v3 lines side by side through every read arm', async () => {
    const directory = await tempDir()
    await mkdir(directory, { recursive: true })
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    const legacy = recordOf({ id: 'old-1', sessionId: 'sess-1', requestHash: 'h0' })
    const rich = richRecord()
    await store.append(rich)
    await rewriteAsV2(directory, ['rich-1'])
    await writeFile(join(directory, 'sess-1.jsonl'), JSON.stringify(legacy) + '\n' + (await readFile(join(directory, 'sess-1.jsonl'), 'utf8')), 'utf8')
    // A fresh v3 append lands after both (its accounting walks the v1/v2 lines).
    await store.append(recordOf({ id: 'new-3', requestHash: 'h3' }))

    const page = await store.listIndex('sess-1', 50, 0)
    expect(page.calls.map(call => call.id)).toEqual(['new-3', 'rich-1', 'old-1'])
    expect((await store.get('sess-1', 'old-1'))?.id).toBe('old-1')
    expect(await store.get('sess-1', 'rich-1')).toEqual(rich)
    expect((await store.get('sess-1', 'new-3'))?.id).toBe('new-3')
  })

  it('migrates a mixed file with v3, foreign, empty, identical and v2 lines', async () => {
    const directory = await tempDir()
    await mkdir(directory, { recursive: true })
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    const rich = richRecord()
    await store.append(rich) // a genuine v3 keyframe first
    const v3Line = (await readFile(join(directory, 'sess-1.jsonl'), 'utf8')).trim()
    const twin = recordOf({ id: 'twin-1', requestHash: 'h2' })
    const twinRetry = recordOf({ id: 'twin-2', requestHash: 'h2' })
    await writeFile(join(directory, 'sess-1.jsonl'), [
      v3Line,
      'not json',
      '',
      JSON.stringify(twin),
      JSON.stringify(twinRetry),
    ].join('\n') + '\n')

    await store.sweep()

    const migrated = await readFile(join(directory, 'sess-1.jsonl'), 'utf8')
    const lines = migrated.split('\n')
    expect(lines[1]).toBe('not json') // foreign lines pass through untouched
    const parsed = lines.filter(l => l.length > 0 && l !== 'not json').map(l => JSON.parse(l) as { v: number })
    for (const p of parsed) expect(p.v).toBe(RECORD_SCHEMA_V3)
    // The identical retry reuses the twin's tree instead of writing a new one.
    const [a, b] = lines
      .filter(l => l.startsWith('{"v":3'))
      .map(l => JSON.parse(l) as { id: string; tree: string })
      .filter(env => env.id.startsWith('twin'))
    expect(a.id).toBe('twin-1'); expect(b.id).toBe('twin-2')
    expect(b.tree).toBe(a.tree)
    expect(await store.get('sess-1', 'twin-1')).toEqual(twin)
    expect(await store.get('sess-1', 'twin-2')).toEqual(twinRetry)
    expect(await store.get('sess-1', 'rich-1')).toEqual(rich)
  })

  it('resets the chain when a migrated v3 line cannot resolve its tree', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    await store.append(recordOf({ id: 'gone', requestHash: 'h1' }))
    const rich = richRecord() // different shape: its tree is a fresh keyframe
    await store.append(rich)
    const lines = (await readFile(join(directory, 'sess-1.jsonl'), 'utf8')).split('\n').filter(l => l.length > 0)
    const deadTree = (JSON.parse(lines[0]) as { tree: string }).tree
    await rm(join(directory, 'objects', deadTree.slice(0, 2), deadTree + '.drl'))
    await rewriteAsV2(directory, ['rich-1'])
    await writeFile(join(directory, 'sess-1.jsonl'), lines[0] + '\n' + (await readFile(join(directory, 'sess-1.jsonl'), 'utf8')), 'utf8')

    await store.sweep()

    // The dead v3 line passes through unresolvable (chain state resets); the
    // v2 line after it converts on its own intact keyframe.
    const after = (await readFile(join(directory, 'sess-1.jsonl'), 'utf8')).split('\n').filter(l => l.length > 0)
    expect(after).toHaveLength(2)
    expect((JSON.parse(after[1]) as { v: number }).v).toBe(RECORD_SCHEMA_V3)
    expect(await store.get('sess-1', 'rich-1')).toEqual(rich)
    const degraded = await store.get('sess-1', 'gone')
    expect(JSON.stringify(degraded?.request.messages)).toContain('unavailable')
    expect(store.lastSweepStatus?.phase).toBe('done')
  })

  it('never chains a converted line onto a v3 line whose depth it cannot know', async () => {
    // A file where legacy lines FOLLOW v3 ones (format flipped back to auto,
    // or an earlier pass whose bakes failed for a stretch). The v3 line the
    // conversion lands behind may already sit at the keyframe interval, so
    // deltaing onto it would push the resolve walk past TREE_MAX_WALK and
    // make that one record unreadable with every object still on disk.
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 10_000, maxFileBytes: 512 * 1024 * 1024 })
    const growing = (n: number): CallRecord => recordOf({
      id: `id-${n}`,
      timing: { startedAt: 1_000 + n },
      request: { messages: Array.from({ length: n }, (_, i) => ({ role: 'user', content: [{ type: 'text', text: `m${i}` }] })) },
    })
    // TREE_KEYFRAME_INTERVAL is 32, so the 33rd append sits at depth 32.
    for (let n = 1; n <= 33; n += 1) await store.append(growing(n))
    const path = join(directory, 'sess-1.jsonl')
    let legacy = ''
    for (let n = 34; n <= 73; n += 1) legacy += JSON.stringify(growing(n)) + '\n'
    await writeFile(path, (await readFile(path, 'utf8')) + legacy, 'utf8')

    await store.sweep()

    for (let n = 1; n <= 73; n += 1) {
      const record = await store.get('sess-1', `id-${n}`)
      expect(record?.request.messages, `id-${n}`).toHaveLength(n)
    }
  })

  it('reports a failed tree bake or response bake and keeps the original line', async () => {
    const seed = async (): Promise<string> => {
      const directory = await tempDir()
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'legacy.jsonl'), JSON.stringify(recordOf({ id: 'l-1', sessionId: 'legacy' })) + '\n')
      return directory
    }
    const deny = (directory: string, when: (raw: string) => boolean): CallStore => {
      const blobs = new BlobStore({ directory: join(directory, 'objects') })
      const real = blobs.put.bind(blobs)
      blobs.put = async (hash: string, raw: string | Buffer) => {
        if (typeof raw === 'string' && when(raw)) throw new Error('EACCES: bake denied')
        return real(hash, raw)
      }
      return new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 }, blobs)
    }

    const treeDir = await seed()
    const treeDenied = deny(treeDir, raw => raw.startsWith('{"t":3'))
    await treeDenied.sweep()
    expect(treeDenied.lastSweepStatus?.error).toContain('EACCES')
    expect((await readFile(join(treeDir, 'legacy.jsonl'), 'utf8')).startsWith('{"schema":')).toBe(true)

    const responseDir = await seed()
    const responseDenied = deny(responseDir, raw => raw.includes('"chunkCount"'))
    await responseDenied.sweep()
    expect(responseDenied.lastSweepStatus?.error).toContain('EACCES')
    expect((await readFile(join(responseDir, 'legacy.jsonl'), 'utf8')).startsWith('{"schema":')).toBe(true)
  })

  it('evicts the least-recent tree state past 64 sessions', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    for (let i = 0; i < 66; i += 1) {
      await store.append(recordOf({ id: 'c-' + String(i), sessionId: 'sess-' + String(i), requestHash: 'h' + String(i) }))
    }
    // The bound never loses data: the first and last sessions both read back.
    expect((await store.get('sess-0', 'c-0'))?.id).toBe('c-0')
    expect((await store.get('sess-65', 'c-65'))?.id).toBe('c-65')
    expect((await readdir(directory)).filter(name => name.endsWith('.jsonl'))).toHaveLength(66)
  })

  it('trims under the byte cap in v1 mode without converting anything', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 1000, format: 'v1' })
    for (let i = 0; i < 6; i += 1) {
      await store.append(recordOf({ id: 'r' + String(i), requestHash: 'h' + String(i) }))
    }
    const lines = (await readFile(join(directory, 'sess-1.jsonl'), 'utf8')).split('\n').filter(l => l.length > 0)
    expect(lines.length).toBeLessThan(6) // the cap bit
    for (const line of lines) expect(line.startsWith('{"schema":1')).toBe(true)
    expect(await readdir(directory)).toEqual(['sess-1.jsonl']) // no object store in frozen mode
  })
})

describe('sweep status observability', () => {
  it('publishes a completed cycle with migration counts for /health', async () => {
    const directory = await tempDir()
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'legacy.jsonl'), JSON.stringify(recordOf({ id: 'l-1', sessionId: 'legacy' })) + '\n')
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })

    await store.sweep()

    expect(store.lastSweepStatus).toMatchObject({
      running: false,
      phase: 'done',
      filesSeen: 1,
      deletedFiles: 0,
      trimmedFiles: 0,
      migrationCandidates: 1,
      migratedFiles: 1,
    })
    expect(store.lastSweepStatus?.error).toBeUndefined()
    expect(store.lastSweepStatus?.durationMs).toBeGreaterThanOrEqual(0)
    expect((await readFile(join(directory, 'legacy.jsonl'), 'utf8')).trim().startsWith('{"v":3')).toBe(true)

    // Idempotent re-sweep: no candidates left, no phantom migrations counted.
    await store.sweep()
    expect(store.lastSweepStatus).toMatchObject({ migrationCandidates: 0, migratedFiles: 0 })
  })

  it('counts retention deletions and keeps the cycle green', async () => {
    const directory = await tempDir()
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'stale.jsonl'), JSON.stringify(recordOf({ id: 's-1', sessionId: 'stale' })) + '\n')
    const now = Date.now()
    await utimes(join(directory, 'stale.jsonl'), new Date(now - 20 * 86_400_000), new Date(now - 20 * 86_400_000))
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })

    await store.sweep(now)

    expect(store.lastSweepStatus).toMatchObject({ phase: 'done', filesSeen: 1, deletedFiles: 1 })
  })

  it('reports a failed blob bake instead of a silent v1 no-op', async () => {
    // The exact live-incident shape: every fail-soft catch swallowed the bake
    // error, the file stayed v1, and nothing anywhere said why.
    const directory = await tempDir()
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'legacy.jsonl'), JSON.stringify(recordOf({ id: 'l-1', sessionId: 'legacy' })) + '\n')
    const blobs = new BlobStore({ directory: join(directory, 'objects') })
    blobs.put = async () => { throw new Error('EACCES: bake denied') }
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 }, blobs)

    await store.sweep()

    expect(store.lastSweepStatus).toMatchObject({ phase: 'done', migrationCandidates: 1, migratedFiles: 0 })
    expect(store.lastSweepStatus?.error).toContain('EACCES')
    // Fail-soft data preservation: the legacy line survives untouched.
    expect((await readFile(join(directory, 'legacy.jsonl'), 'utf8')).startsWith('{"schema":')).toBe(true)
  })
  it('reports a clean sweep on a store that has never been written', async () => {
    // The directory is created lazily by the first append, so a fresh install's
    // BOOT sweep runs before it exists. Publishing that as a sweep error hangs
    // a false failure on /health until the next daily cycle, 24 hours later.
    const directory = join(await tempDir(), 'never-written')
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })

    await store.sweep()

    expect(store.lastSweepStatus?.error).toBeUndefined()
    expect(store.lastSweepStatus?.phase).toBe('done')
    expect(store.lastSweepStatus?.filesSeen).toBe(0)
  })

  it('passes a v2 line with a malformed ref through instead of baking an invalid tree', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    await store.append(recordOf({ id: 'good' }))
    const path = join(directory, 'sess-1.jsonl')
    // A v2 envelope whose refs lost their hashes (external damage — the writer
    // never emits this). Converting it blindly writes `{"k":"m","h":undefined}`
    // into the immutable object store: unparsable, unreachable, permanent.
    const damaged = '{"v":2,"id":"bad","sessionId":"sess-1","provider":"p","model":"m","requestHash":"h",'
      + '"attempt":1,"timing":{"startedAt":2000},"status":"ok","refs":[{"k":"m"}]}'
    await writeFile(path, (await readFile(path, 'utf8')) + damaged + '\n', 'utf8')

    await store.sweep()

    const kept = (await readFile(path, 'utf8')).trim().split('\n')
    expect(kept.find(line => line.includes('"id":"bad"'))).toBe(damaged)
    // Nothing unparsable reached the object store.
    for (const bucket of await readdir(join(directory, 'objects'))) {
      if (!/^[0-9a-f]{2}$/.test(bucket)) continue
      for (const file of await readdir(join(directory, 'objects', bucket))) {
        const raw = await readFile(join(directory, 'objects', bucket, file))
        const { payload } = decodeFrame(raw)
        const text = inflateRawSync(payload).toString('utf8')
        if (text.startsWith('{"t":')) expect(() => JSON.parse(text)).not.toThrow()
      }
    }
  })

  it('surfaces a migration scan it could not read instead of silently skipping it', async () => {
    const directory = await tempDir()
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    await store.append(recordOf())
    // A directory wearing a session file's name: stat succeeds, so it reaches
    // the migration phase, and every read of it fails. Swallowing that inside
    // the scan makes the sweep's own error branch dead code and leaves /health
    // blind to a file that can never convert.
    await mkdir(join(directory, 'wedged.jsonl'), { recursive: true })

    await store.sweep()

    expect(store.lastSweepStatus?.error).toMatch(/^scan wedged/)
  })

  it('stops a file that never converts from monopolizing the migration budget', async () => {
    const directory = await tempDir()
    const store = new CallStore({
      directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024,
      migrationBudgetBytes: 1,
    })
    // A line from a schema this build does not understand counts as legacy
    // (it opens `{"schema":`) but converts to nothing — so it is "wanted"
    // forever. Newest-first ordering hands it the whole budget every cycle.
    const stubborn = join(directory, 'stuck.jsonl')
    const convertible = join(directory, 'plain.jsonl')
    await mkdir(directory, { recursive: true })
    await writeFile(convertible, JSON.stringify(recordOf({ id: 'v1', sessionId: 'plain' })) + '\n', 'utf8')
    await writeFile(stubborn, JSON.stringify({ ...recordOf({ id: 'x', sessionId: 'stuck' }), schema: 99 }) + '\n', 'utf8')
    const older = new Date(Date.now() - 60_000)
    await utimes(convertible, older, older)

    await store.sweep()
    expect((await readFile(stubborn, 'utf8')).startsWith('{"schema":99')).toBe(true) // never converts
    await store.sweep()

    // Second cycle: the file that failed last time yields its turn.
    expect((await readFile(convertible, 'utf8')).startsWith('{"v":3')).toBe(true)
  })
})

describe('permanent retention', () => {
  it("keeps a session file forever when retention is 'never'", async () => {
    const directory = await tempDir()
    // Through the real config path: 'never' has to survive parsing, not just
    // the store's own field.
    const store = new CallStore(resolveStoreConfig({ directory, retentionDays: 'never' }))
    await store.append(recordOf({ id: 'ancient', sessionId: 'old-sess' }))
    // Older than the 3650-day ceiling a number could ever express.
    const stale = new Date(Date.now() - 4_000 * 24 * 60 * 60 * 1000)
    await utimes(join(directory, 'old-sess.jsonl'), stale, stale)

    const { deletedFiles } = await store.sweep()
    expect(deletedFiles).toBe(0)
    expect((await readdir(directory)).filter(name => name.endsWith('.jsonl'))).toEqual(['old-sess.jsonl'])
    // A kept file's objects must stay reachable: the GC marks from the files
    // retention spared, so sparing a file and reaping its bodies would be
    // worse than deleting it outright.
    expect((await store.get('old-sess', 'ancient'))?.id).toBe('ancient')
  })

  it('still deletes past a numeric window, so disabling is explicit', async () => {
    const directory = await tempDir()
    const store = new CallStore(resolveStoreConfig({ directory, retentionDays: 1 }))
    await store.append(recordOf({ id: 'old', sessionId: 'old-sess' }))
    const stale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    await utimes(join(directory, 'old-sess.jsonl'), stale, stale)

    expect((await store.sweep()).deletedFiles).toBe(1)
  })
})

describe('packingOrder', () => {
  it('orders objects by the call that first referenced them', () => {
    const order = packingOrder([
      { at: 200, hashes: ['c', 'd'] },
      { at: 100, hashes: ['a', 'b'] },
      { at: 300, hashes: ['b', 'e'] },
    ])
    // Sorted by time first: a,b (t=100), then c,d (t=200), then e (t=300).
    expect(order).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('keeps a re-referenced object at its FIRST position, not its last', () => {
    // Retries and unchanged history re-name the same pieces every call; moving
    // them would scatter a conversation across blocks and cost compression.
    expect(packingOrder([
      { at: 1, hashes: ['x', 'y'] },
      { at: 2, hashes: ['x', 'z'] },
    ])).toEqual(['x', 'y', 'z'])
  })

  it('is stable for calls sharing a timestamp', () => {
    expect(packingOrder([
      { at: 5, hashes: ['p'] },
      { at: 5, hashes: ['q'] },
    ])).toEqual(['p', 'q'])
  })
})

describe('sweep packing', () => {
  const oldEnough = (directory: string, hashes: string[]) => Promise.all(hashes.map(hash => {
    const past = new Date(Date.now() - 3 * 60 * 60 * 1000)
    return utimes(join(directory, 'objects', hash.slice(0, 2), `${hash}.drl`), past, past)
  }))

  it('moves cold reachable objects into a pack and drops the loose copies', async () => {
    const directory = await tempDir()
    const store = new CallStore(resolveStoreConfig({ directory }))
    await store.append(recordOf({ id: 'a' }))
    await store.append(recordOf({ id: 'b', request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'second' }] }] } }))

    const objectsDir = join(directory, 'objects')
    const loose = (await store.objectCensusForTest()).map(row => row.hash)
    await oldEnough(directory, loose)

    await store.sweep()

    const packs = (await readdir(join(objectsDir, 'packs'))).filter(n => n.endsWith('.pack'))
    expect(packs).toHaveLength(1)
    // Loose copies are gone...
    const remaining = await store.objectCensusForTest()
    expect(remaining).toHaveLength(0)
    // ...and every record still reads back byte for byte.
    expect((await store.get('sess-1', 'a'))?.request.messages).toEqual(recordOf({ id: 'a' }).request.messages)
    expect((await store.get('sess-1', 'b'))?.id).toBe('b')
  })

  it('leaves a fresh object loose, so a pending append cannot lose its body', async () => {
    const directory = await tempDir()
    const store = new CallStore(resolveStoreConfig({ directory }))
    await store.append(recordOf({ id: 'fresh' }))

    await store.sweep()

    // Nothing packed: every object is younger than the grace floor.
    expect(await store.objectCensusForTest()).not.toHaveLength(0)
    const packDir = join(directory, 'objects', 'packs')
    const packs = await readdir(packDir).catch(() => [])
    expect(packs.filter(n => n.endsWith('.pack'))).toHaveLength(0)
  })

  it('bounds one cycle by the packing budget', async () => {
    const directory = await tempDir()
    const store = new CallStore({ ...resolveStoreConfig({ directory }), packBudgetBytes: 1 })
    for (let i = 0; i < 4; i += 1) {
      await store.append(recordOf({ id: `r${i}`, request: { messages: [{ role: 'user', content: [{ type: 'text', text: `body ${i} ${'z'.repeat(500)}` }] }] } }))
    }
    await oldEnough(directory, (await store.objectCensusForTest()).map(row => row.hash))

    await store.sweep()
    const status = store.lastSweepStatus
    expect(status?.packedObjects).toBeGreaterThan(0)
    // A 1-byte budget still makes progress, but does not drain the store.
    expect(await store.objectCensusForTest()).not.toHaveLength(0)
  })

  it('packs nothing when pack is off', async () => {
    const directory = await tempDir()
    const store = new CallStore(resolveStoreConfig({ directory, pack: 'off' }))
    await store.append(recordOf({ id: 'a' }))
    await oldEnough(directory, (await store.objectCensusForTest()).map(row => row.hash))

    await store.sweep()
    expect(await readdir(join(directory, 'objects', 'packs')).catch(() => [])).toEqual([])
  })
})
