/**
 * The read API: one webServer prefix route serving the browser half over
 * same-origin fetch. Paths (all GET, JSON):
 *   GET /dsh-request-log/health
 *   GET /dsh-request-log/sessions/:sessionId/calls?limit=&offset=
 *   GET /dsh-request-log/sessions/:sessionId/calls/:callId
 *
 * The route prefix is deliberately NOT under /api — that prefix belongs to
 * the harness's own RPC carrier (client-connection). Reads only, no
 * credentials: the payloads are the user's own session content served to
 * the same origin that already renders them.
 *
 * Because the payload IS the full conversation transcript, every request
 * passes a browser-trust fence first (mirroring the one client-connection
 * mounts on /api): the Host header must be a loopback or a configured
 * trusted authority — DNS rebinding cannot forge Host — and any attached
 * browser markers (Origin, Sec-Fetch-Site) must be same-origin. Anything
 * else 403s before a store read happens.
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

export interface ApiOptions {
  /**
   * Non-loopback authorities this deployment serves the web UI under
   * (LAN IP literals, hostnames): exact `host:port` or port-less `host`
   * matching any port. Requests carrying any other Host are refused.
   */
  trustedHosts?: readonly string[]
}

const DEFAULT_LIMIT = 50

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

function headerOf(headers: IncomingMessage['headers'], name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Loopback hostname: the literal localhost names or any 127.x.x.x quad. */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  if (!hostname.startsWith('127.')) return false
  const parts = hostname.split('.')
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether one configured trustedHosts entry (host or host:port) matches. */
function trustedAuthorityMatches(entry: string, hostUrl: URL): boolean {
  let entryUrl: URL
  try {
    entryUrl = new URL(`http://${entry}`)
  } catch {
    return false
  }
  if (entryUrl.hostname !== hostUrl.hostname) return false
  // Port-less entries grant the hostname on any port (OS-assigned ports);
  // explicit ports grant that exact authority only.
  return entryUrl.port === '' || entryUrl.port === hostUrl.port
}

/**
 * Browser-trust fence (same policy the harness's client-connection applies
 * to every /api route): Host must parse to a loopback or trusted authority,
 * `sec-fetch-site: cross-site` is refused, and an attached Origin must be
 * same-origin. Over plain HTTP a browser attaches neither Origin nor
 * Fetch-Metadata to reads, so the Host header is the one marker DNS
 * rebinding cannot forge — it binds every request, browser-looking or not.
 */
export function isTrustedReadRequest(req: IncomingMessage, trustedHosts: readonly string[]): boolean {
  const host = headerOf(req.headers, 'host')
  if (host === undefined) return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)
    && !trustedHosts.some(entry => trustedAuthorityMatches(entry, hostUrl))) return false
  if (headerOf(req.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = headerOf(req.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
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
export function installApi(ctx: Context, store: CallStore, version: string, options: ApiOptions = {}): () => void {
  const webServer = (ctx as Context & { webServer?: WebServerFace }).webServer
  if (webServer === undefined || typeof webServer.register !== 'function') return () => {}
  const trustedHosts = options.trustedHosts ?? []
  // Derived from the live store config (not a frozen constant) so a
  // deployment raising maxCallsPerSession above 2000 can still page its
  // whole ledger — a full session then fits a single page.
  const MAX_LIMIT = Math.max(store.maxCallsPerSession, DEFAULT_LIMIT)
  const logger = ctx.logger

  return webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      drain(req)
      if (!isTrustedReadRequest(req, trustedHosts)) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
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
          } catch (error) {
            logger?.warn('dsh-request-log: index read failed: %o', error)
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
          } catch (error) {
            logger?.warn('dsh-request-log: record read failed: %o', error)
            sendJson(res, 500, { error: 'record read failed' })
          }
          return
        }
      }
      sendJson(res, 404, { error: 'not found' })
    },
  })
}
