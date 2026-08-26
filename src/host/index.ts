/**
 * dsh-request-log — Host half (installed package entry).
 *
 * A plain Cordis plugin loaded as the `dsh-request-log` loader row. Three
 * effects, each independently disposable:
 *   - `llm/stream` waterfall capture (every provider attempt, every scope),
 *   - JSONL persistence under `$DSH_HOME/request-log/` with retention,
 *   - a same-origin read API on `ctx.webServer` for the browser half.
 *
 * There is no required service: the plugin loads in any composition. The
 * webServer seat is optional — without it, capture and storage still run.
 */

import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { installApi } from './api'
import { installCapture } from './capture'
import { CallStore, type StoreConfig } from './store'

export const name = 'dsh-request-log'

export const VERSION = '0.1.0'

export interface Config {
  /** Root directory for the per-session JSONL files. */
  directory?: string
  /** Delete session files untouched for this many days. */
  retentionDays?: number
  /** Per-session cap on kept call records (newest kept). */
  maxCallsPerSession?: number
}

export const DEFAULTS: Required<Pick<Config, 'retentionDays' | 'maxCallsPerSession'>> = {
  retentionDays: 14,
  maxCallsPerSession: 2000,
}

export const Config = z.preprocess(
  v => v ?? {},
  z.object({
    directory: z.string().min(1).optional(),
    retentionDays: z.number().int().min(1).max(3650).default(DEFAULTS.retentionDays),
    maxCallsPerSession: z.number().int().min(1).default(DEFAULTS.maxCallsPerSession),
  }).strict(),
)

export function resolveStoreConfig(config: Config | undefined): StoreConfig {
  const parsed = Config.parse(config ?? {})
  return {
    directory: parsed.directory ?? dshHomePath('request-log'),
    retentionDays: parsed.retentionDays,
    maxCallsPerSession: parsed.maxCallsPerSession,
  }
}

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

export function apply(ctx: Context, config: Config = {}): void {
  const store = new CallStore(resolveStoreConfig(config))

  // The waterfall is an event, not a service: capture needs no inject and
  // records in every composition (web, headless, tests).
  ctx.effect(() => installCapture(ctx, { store, logger: ctx.logger }), 'dsh-request-log: capture')

  // The read API rides the webServer service: runtime inject keeps it
  // OPTIONAL — a headless composition without the web server leaves the
  // callback pending forever, and capture/storage keep working.
  ctx.inject(['webServer'], webCtx => {
    webCtx.effect(() => installApi(webCtx, store, VERSION), 'dsh-request-log: read api')
  })

  // Boot sweep + daily sweep. Fire-and-forget: sweep failures are contained
  // inside the store and never surface as plugin errors.
  const sweep = (): void => { store.sweep().catch(() => {}) }
  sweep()
  ctx.effect(() => {
    const timer = setInterval(sweep, SWEEP_INTERVAL_MS)
    return () => clearInterval(timer)
  }, 'dsh-request-log: retention sweep')
}

// ---- public type surface -----------------------------------------------------

export type { CallRecord } from '../shared/types'
export { toIndexEntry, RECORD_SCHEMA } from '../shared/types'
export { CallStore } from './store'
export { installCapture, requestHashOf, createAttemptTracker } from './capture'
export { installApi, API_PREFIX } from './api'
