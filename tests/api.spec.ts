/**
 * API specs: the webServer route parses the documented paths and serves the
 * store's index/detail/health responses with correct status codes.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installApi } from '../src/host/api.ts'
import { CallStore } from '../src/host/store.ts'
import { RECORD_SCHEMA } from '../src/shared/types'
import type { CallRecord } from '../src/shared/types'

const dirs: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function recordOf(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    schema: RECORD_SCHEMA,
    id: 'call-1',
    sessionId: 'sess-1',
    provider: 'p',
    model: 'm',
    requestHash: 'h',
    attempt: 1,
    timing: { startedAt: 1_000 },
    request: { messages: [] },
    status: 'ok',
    ...overrides,
  } as CallRecord
}

interface FakeResponse {
  status: number
  body: unknown
}

async function handle(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
  method: string,
  url: string,
): Promise<FakeResponse> {
  const captured: FakeResponse = { status: 0, body: null }
  const req = {
    method,
    url,
    resume: () => {},
    on: () => {},
  } as unknown as IncomingMessage
  const res = {
    writeHead: (status: number) => { captured.status = status },
    end: (payload?: string) => {
      captured.body = payload === undefined ? null : JSON.parse(payload)
    },
  } as unknown as ServerResponse
  await handler(req, res)
  return captured
}

describe('read API', () => {
  it('serves health, index, and detail; 404s unknown paths; 405s POST', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-request-log-api-'))
    dirs.push(directory)
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100 })
    await store.append(recordOf())

    let route: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void } | null = null
    const webServer = {
      register: (candidate: typeof route) => {
        route = candidate
        return () => { route = null }
      },
    }
    const dispose = installApi({ webServer } as never, store, 'test-version')
    expect(route).not.toBeNull()
    const handler = (route as unknown as nonNull).handler

    const health = await handle(handler, 'GET', '/dsh-request-log/health')
    expect(health.status).toBe(200)
    expect(health.body).toEqual({ ok: true, plugin: 'dsh-request-log', version: 'test-version' })

    const index = await handle(handler, 'GET', '/dsh-request-log/sessions/sess-1/calls?limit=10&offset=0')
    expect(index.status).toBe(200)
    expect((index.body as { total: number }).total).toBe(1)

    const detail = await handle(handler, 'GET', '/dsh-request-log/sessions/sess-1/calls/call-1')
    expect(detail.status).toBe(200)
    expect((detail.body as { id: string }).id).toBe('call-1')

    const missing = await handle(handler, 'GET', '/dsh-request-log/sessions/sess-1/calls/nope')
    expect(missing.status).toBe(404)

    const unknown = await handle(handler, 'GET', '/dsh-request-log/other')
    expect(unknown.status).toBe(404)

    const post = await handle(handler, 'POST', '/dsh-request-log/health')
    expect(post.status).toBe(405)

    // Malformed percent sequences must 400, not reject the handler.
    const badSession = await handle(handler, 'GET', '/dsh-request-log/sessions/%FF/calls')
    expect(badSession.status).toBe(400)
    const badCall = await handle(handler, 'GET', '/dsh-request-log/sessions/sess-1/calls/%FF')
    expect(badCall.status).toBe(400)

    dispose()
  })

  it('is a no-op without a webServer service', () => {
    const dispose = installApi({} as never, new CallStore({ directory: 'unused', retentionDays: 1, maxCallsPerSession: 1 }), 'v')
    expect(typeof dispose).toBe('function')
  })
})

type nonNull = { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void }
