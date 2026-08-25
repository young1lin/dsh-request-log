/**
 * The read API: one webServer prefix route serving the browser half over
 * same-origin fetch. Paths (all GET, JSON):
 *   GET /dsh-request-log/health
 *   GET /dsh-request-log/sessions/:sessionId/calls?limit=&offset=
 *   GET /dsh-request-log/sessions/:sessionId/calls/:callId
 *
 * The route prefix is deliberately NOT under /api — that prefix belongs to
 * the harness's own RPC carrier (`client-connection`). Reads only, no
 * credentials: the payloads are the user's own session content served to
 * the same origin that already renders them.
 *
 * @module dsh-request-log/host/api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { CallStore } from './store'

export const API_PREFIX = '/dsh-request-log'

/** Minimal typing of the `webServer` service face this plugin consumes. */
interface WebServerFace {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

const DEFAULT_LIMIT = 50
/** Matches the store's default per-session cap; a full ledger fits one page. */
const MAX_LIMIT = 2000

/**
 * Percent-decode one path segment. Malformed sequences (e.g. %FF, lone
 * surrogates) throw URIError from decodeURIComponent — a client bug must
 * surface as a 400, not as a rejected handler that hangs the response.
 */
function safeDecode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

function drain(req: IncomingMessage): void {
  // Keep-alive compatibility: consume any request bytes (none of the routes
  // accept a body) so the socket stays cleanly reusable.
  req.resume()
}

/**
 * Mount the API on `ctx.webServer` (optional: a headless composition without
 * the web server simply gets no read API — capture and storage still work).
 * @returns the disposer removing the route.
 */
export function installApi(ctx: Context, store: CallStore, version: string): () => void {
  const webServer = (ctx as Context & { webServer?: WebServerFace }).webServer
  if (webServer === undefined || typeof webServer.register !== 'function') return () => {}

  return webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      drain(req)
      const url = new URL(req.url ?? '/', 'http://localhost')
      const segments = url.pathname.slice(API_PREFIX.length).split('/').filter(part => part.length > 0)

      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      if (segments.length === 1 && segments[0] === 'health') {
        sendJson(res, 200, { ok: true, plugin: 'dsh-request-log', version })
        return
      }
      // /sessions/:sessionId/calls[/:callId]
      if (segments.length >= 3 && segments[0] === 'sessions' && segments[2] === 'calls') {
        const sessionId = safeDecode(segments[1])
        if (sessionId === undefined) {
          sendJson(res, 400, { error: 'malformed session id' })
          return
        }
        if (segments.length === 3) {
          const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
          const offsetRaw = Number(url.searchParams.get('offset') ?? 0)
          const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), MAX_LIMIT) : DEFAULT_LIMIT
          const offset = Number.isFinite(offsetRaw) ? Math.max(Math.trunc(offsetRaw), 0) : 0
          try {
            sendJson(res, 200, await store.listIndex(sessionId, limit, offset))
          } catch {
            sendJson(res, 500, { error: 'index read failed' })
          }
          return
        }
        if (segments.length === 4) {
          const callId = safeDecode(segments[3])
          if (callId === undefined) {
            sendJson(res, 400, { error: 'malformed call id' })
            return
          }
          try {
            const record = await store.get(sessionId, callId)
            if (record === undefined) {
              sendJson(res, 404, { error: 'call not found' })
            } else {
              sendJson(res, 200, record)
            }
          } catch {
            sendJson(res, 500, { error: 'record read failed' })
          }
          return
        }
      }
      sendJson(res, 404, { error: 'not found' })
    },
  })
}
