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
  /**
   * Delete session files untouched for this many days, or `'never'` to keep
   * them forever — what dsh's own session logs do.
   */
  retentionDays?: number | 'never'
  /** Per-session cap on kept call records (newest kept). */
  maxCallsPerSession?: number
  /** Per-session byte cap on each JSONL file (oldest records trimmed first). */
  maxFileBytes?: number
  /**
   * Non-loopback authorities the read API may serve (LAN IP literals,
   * hostnames): exact `host:port`, or port-less `host` matching any port.
   * Every other Host — DNS-rebinding domains included — is refused.
   */
  trustedHosts?: string[]
  /**
   * Persistence format. `auto` (default) writes deduplicating v2 envelopes
   * into a content-addressed object store and lazily converts old files;
   * `v1` freezes the legacy behavior byte-for-byte (kill switch).
   */
  format?: 'v1' | 'auto'
  /**
   * Whether the sweep packs cold objects into solid blocks. `off` stops
   * writing new packs; existing packs stay readable and are gradually
   * unpacked again, so records already packed are never hidden.
   */
  pack?: 'auto' | 'off'
}

export const DEFAULTS: Required<Pick<Config, 'retentionDays' | 'maxCallsPerSession' | 'maxFileBytes'>> = {
  retentionDays: 14,
  maxCallsPerSession: 2000,
  maxFileBytes: 128 * 1024 * 1024,
}

const TRUSTED_AUTHORITY = /^[\w.\-:[\]]+$/

export const Config = z.preprocess(
  v => v ?? {},
  z.object({
    directory: z.string().min(1).optional(),
    // 'never' is a word, not 0: "keep nothing" and "keep everything" must not
    // be one keystroke apart, and a 3650-day stand-in would quietly expire.
    retentionDays: z.union([z.literal('never'), z.number().int().min(1).max(3650)])
      .default(DEFAULTS.retentionDays),
    maxCallsPerSession: z.number().int().min(1).default(DEFAULTS.maxCallsPerSession),
    maxFileBytes: z.number().int().min(1024 * 1024).default(DEFAULTS.maxFileBytes),
    trustedHosts: z.array(z.string().regex(TRUSTED_AUTHORITY)).default([]),
    format: z.enum(['v1', 'auto']).default('auto'),
    pack: z.enum(['auto', 'off']).default('auto'),
  }).strict(),
)

export function resolveStoreConfig(config: Config | undefined): StoreConfig {
  const parsed = Config.parse(config ?? {})
  return {
    directory: parsed.directory ?? dshHomePath('request-log'),
    retentionDays: parsed.retentionDays,
    maxCallsPerSession: parsed.maxCallsPerSession,
    maxFileBytes: parsed.maxFileBytes,
    format: parsed.format,
    pack: parsed.pack,
  }
}

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * Wire the boot sweep and its daily re-run: fires one cycle immediately and
 * returns the callback the interval rides. A whole-cycle rejection must never
 * break a model call — but it logs a warn and lands in /health's sweep status
 * instead of vanishing into a no-op catch.
 */
export function scheduleSweep(store: CallStore, logger: { warn: (...args: unknown[]) => void }): () => void {
  const sweep = (): void => {
    store.sweep().catch(error => {
      logger.warn('dsh-request-log: sweep failed: %o', error)
    })
  }
  sweep()
  return sweep
}

export function apply(ctx: Context, config: Config = {}): void {
  const store = new CallStore(resolveStoreConfig(config))

  // The waterfall is an event, not a service: capture needs no inject and
  // records in every composition (web, headless, tests).
  ctx.effect(() => installCapture(ctx, { store, logger: ctx.logger }), 'dsh-request-log: capture')

  // The read API rides the webServer service: runtime inject keeps it
  // OPTIONAL — a headless composition without the web server leaves the
  // callback pending forever, and capture/storage keep working. The browser
  // trust fence serves loopback plus the configured trusted authorities.
  ctx.inject(['webServer'], webCtx => {
    const parsed = Config.parse(config ?? {})
    webCtx.effect(
      () => installApi(webCtx, store, VERSION, { trustedHosts: parsed.trustedHosts }),
      'dsh-request-log: read api',
    )
  })

  // Boot sweep + daily sweep. Fire-and-forget: stage failures are contained
  // inside the store and published via /health's sweep status, and a
  // whole-cycle rejection warns through the logger. The timer is unref'd so
  // a headless/CLI composition can still exit naturally.
  const sweep = scheduleSweep(store, ctx.logger)
  ctx.effect(() => {
    const timer = setInterval(sweep, SWEEP_INTERVAL_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'dsh-request-log: retention sweep')
}

// ---- public type surface -----------------------------------------------------

export type { CallRecord } from '../shared/types'
export { toIndexEntry, RECORD_SCHEMA } from '../shared/types'
export { CallStore } from './store'
export { installCapture, requestHashOf, createAttemptTracker } from './capture'
export { installApi, API_PREFIX } from './api'
