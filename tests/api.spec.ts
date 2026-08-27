/**
 * API specs: the webServer route parses the documented paths and serves the
 * store's index/detail/health responses with correct status codes — behind
 * the browser-trust fence (Host/Origin) every request must pass first.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installApi, isTrustedReadRequest } from '../src/host/api.ts'
import { CallStore } from '../src/host/store.ts'
import { RECORD_SCHEMA } from '../src/shared/types'
import type { CallIndexResponse, CallRecord } from '../src/shared/types'

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
  headers: Record<string, string> = { host: '127.0.0.1:3080' },
): Promise<FakeResponse> {
  const captured: FakeResponse = { status: 0, body: null }
  const req = {
    method,
    url,
    headers,
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

async function makeHandler(store: CallStore, trustedHosts: readonly string[] = []) {
  let route: { handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void } | null = null
  const webServer = {
    register: (candidate: typeof route) => {
      route = candidate
      return () => { route = null }
    },
  }
  const dispose = installApi({ webServer } as never, store, 'test-version', { trustedHosts })
  await Promise.resolve()
  expect(route).not.toBeNull()
  return { handler: (route as unknown as nonNull).handler, dispose }
}

type nonNull = { handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void }

async function seededStore(): Promise<CallStore> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-request-log-api-'))
  dirs.push(directory)
  const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
  await store.append(recordOf())
  return store
}

describe('browser-trust fence', () => {
  it('accepts a loopback host with no browser markers', async () => {
    const { handler, dispose } = await makeHandler(await seededStore())
    const health = await handle(handler, 'GET', '/dsh-request-log/health', { host: '127.0.0.1:3080' })
    expect(health.status).toBe(200)
    const local = await handle(handler, 'GET', '/dsh-request-log/health', { host: 'localhost:3080' })
    expect(local.status).toBe(200)
    dispose()
  })

  it('accepts a same-origin Origin and refuses a cross-origin one', async () => {
    const { handler, dispose } = await makeHandler(await seededStore())
    const same = await handle(handler, 'GET', '/dsh-request-log/health', {
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
    })
    expect(same.status).toBe(200)
    const cross = await handle(handler, 'GET', '/dsh-request-log/health', {
      host: '127.0.0.1:3080',
      origin: 'http://evil.example',
    })
    expect(cross.status).toBe(403)
    dispose()
  })

  it('refuses DNS-rebinding and cross-site browser requests', async () => {
    const { handler, dispose } = await makeHandler(await seededStore())
    // Rebinding: the Host names the attacker's domain while the socket is ours.
    const rebound = await handle(handler, 'GET', '/dsh-request-log/health', { host: 'evil.example:3080' })
    expect(rebound.status).toBe(403)
    const crossSite = await handle(handler, 'GET', '/dsh-request-log/health', {
      host: '127.0.0.1:3080',
      'sec-fetch-site': 'cross-site',
    })
    expect(crossSite.status).toBe(403)
    const noHost = await handle(handler, 'GET', '/dsh-request-log/health', {})
    expect(noHost.status).toBe(403)
    dispose()
  })

  it('serves configured trusted authorities (exact port and port-less)', async () => {
    const { handler, dispose } = await makeHandler(await seededStore(), ['192.168.1.10:3080', 'myhost.local'])
    const exact = await handle(handler, 'GET', '/dsh-request-log/health', { host: '192.168.1.10:3080' })
    expect(exact.status).toBe(200)
    const anyPort = await handle(handler, 'GET', '/dsh-request-log/health', { host: 'myhost.local:41234' })
    expect(anyPort.status).toBe(200)
    const wrongPort = await handle(handler, 'GET', '/dsh-request-log/health', { host: '192.168.1.10:9999' })
    expect(wrongPort.status).toBe(403)
    dispose()
  })

  it('isTrustedReadRequest refuses malformed authorities', () => {
    const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage
    expect(isTrustedReadRequest(req({ host: 'http://x' }), [])).toBe(false)
    expect(isTrustedReadRequest(req({ host: '' }), [])).toBe(false)
    expect(isTrustedReadRequest(req({ host: 'not loopback' }), ['not loopback'])).toBe(false)
    expect(isTrustedReadRequest(req({ host: '127.0.0.8:1' }), [])).toBe(true)
    expect(isTrustedReadRequest(req({ host: '[::1]:3080' }), [])).toBe(true)
  })
})

describe('read API', () => {
  it('serves health, index, and detail', async () => {
    const { handler, dispose } = await makeHandler(await seededStore())

    const health = await handle(handler, 'GET', '/dsh-request-log/health')
    expect(health.status).toBe(200)
    expect(health.body).toEqual({ ok: true, plugin: 'dsh-request-log', version: 'test-version' })

    const index = await handle(handler, 'GET', '/dsh-request-log/sessions/sess-1/calls?limit=10&offset=0')
    expect(index.status).toBe(200)
    expect((index.body as { total: number }).total).toBe(1)

    const detail = await handle(handler, 'GET', '/dsh-request-log/sessions/sess-1/calls/call-1')
    expect(detail.status).toBe(200)
    expect((detail.body as { id: string }).id).toBe('call-1')
    dispose()
  })

  it('404s unknown paths and calls; 405s POST; 400s malformed percent sequences', async () => {
    const { handler, dispose } = await makeHandler(await seededStore())
    expect((await handle(handler, 'GET', '/dsh-request-log/sessions/sess-1/calls/nope')).status).toBe(404)
    expect((await handle(handler, 'GET', '/dsh-request-log/other')).status).toBe(404)
    expect((await handle(handler, 'POST', '/dsh-request-log/health')).status).toBe(405)
    // Malformed percent sequences must 400, not reject the handler.
    expect((await handle(handler, 'GET', '/dsh-request-log/sessions/%FF/calls')).status).toBe(400)
    expect((await handle(handler, 'GET', '/dsh-request-log/sessions/sess-1/calls/%FF')).status).toBe(400)
    dispose()
  })

  it('sanitizes limit and offset', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-request-log-api-'))
    dirs.push(directory)
    // maxCallsPerSession 100 → MAX_LIMIT 100.
    const store = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    for (let i = 0; i < 150; i += 1) {
      await store.append(recordOf({ id: 'call-' + String(i), timing: { startedAt: 1_000 + i } }))
    }
    const { handler, dispose } = await makeHandler(store)

    const read = async (query: string): Promise<CallIndexResponse> => {
      const page = await handle(handler, 'GET', '/dsh-request-log/sessions/sess-1/calls?' + query)
      expect(page.status).toBe(200)
      return page.body as CallIndexResponse
    }
    // Zero / negative / NaN limits clamp to 1 / default 50; the ceiling is
    // the store's maxCallsPerSession; negative offsets clamp to 0.
    expect((await read('limit=0')).calls).toHaveLength(1)
    expect((await read('limit=-5')).calls).toHaveLength(1)
    expect((await read('limit=abc')).calls).toHaveLength(50)
    expect((await read('limit=99999')).calls).toHaveLength(100)
    expect((await read('offset=-5&limit=10')).calls[0].id).toBe('call-149')
    const huge = await read('offset=abc')
    expect(huge.offset).toBe(0)
    dispose()
  })

  it('maps store failures to 500', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-request-log-api-'))
    dirs.push(directory)
    const base = new CallStore({ directory, retentionDays: 14, maxCallsPerSession: 100, maxFileBytes: 8 * 1024 * 1024 })
    await base.append(recordOf())
    const exploding = {
      maxCallsPerSession: 100,
      listIndex: () => { throw new Error('disk on fire') },
      get: () => { throw new Error('disk on fire') },
    } as unknown as CallStore
    const { handler, dispose } = await makeHandler(exploding)
    const index = await handle(handler, 'GET', '/dsh-request-log/sessions/sess-1/calls')
    expect(index.status).toBe(500)
    const detail = await handle(handler, 'GET', '/dsh-request-log/sessions/sess-1/calls/call-1')
    expect(detail.status).toBe(500)
    void base
    dispose()
  })

  it('is a no-op without a webServer service', () => {
    const dispose = installApi({} as never, new CallStore({ directory: 'unused', retentionDays: 1, maxCallsPerSession: 1, maxFileBytes: 1024 * 1024 }), 'v')
    expect(typeof dispose).toBe('function')
  })
})
