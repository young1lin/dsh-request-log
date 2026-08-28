/**
 * Plugin entry specs: the config schema (defaults, strictness, bounds), the
 * resolved store config, and the version constant the /health route reports.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { Config, DEFAULTS, VERSION, name, resolveStoreConfig, scheduleSweep } from '../src/host/index.ts'
import type { CallStore } from '../src/host/store.ts'

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { name: string; version: string }

describe('plugin identity', () => {
  it('reports the published version on /health', () => {
    // The route serves VERSION verbatim; drift from the manifest would make
    // every deployed instance misreport which build is running.
    expect(VERSION).toBe(pkg.version)
  })

  it('loads under the manifest name', () => {
    expect(name).toBe(pkg.name)
  })
})

describe('Config schema', () => {
  it('fills every retention default for an absent config', () => {
    expect(Config.parse(undefined)).toMatchObject({
      retentionDays: DEFAULTS.retentionDays,
      maxCallsPerSession: DEFAULTS.maxCallsPerSession,
      maxFileBytes: DEFAULTS.maxFileBytes,
      trustedHosts: [],
      format: 'auto',
    })
  })

  it('refuses unknown keys rather than silently ignoring a typo', () => {
    expect(() => Config.parse({ retentionDay: 3 })).toThrow()
  })

  it('bounds retention, call cap and byte cap', () => {
    expect(() => Config.parse({ retentionDays: 0 })).toThrow()
    expect(() => Config.parse({ retentionDays: 3651 })).toThrow()
    expect(() => Config.parse({ maxCallsPerSession: 0 })).toThrow()
    // A cap under 1 MiB would trim faster than a single call can be written.
    expect(() => Config.parse({ maxFileBytes: 1024 })).toThrow()
    expect(Config.parse({ retentionDays: 3650 }).retentionDays).toBe(3650)
  })

  it("takes 'never' as the way to say permanent, and only that word", () => {
    // dsh itself never deletes a session log; a store that follows it needs a
    // value that says so, not a 10-year number that quietly expires one day.
    expect(Config.parse({ retentionDays: 'never' }).retentionDays).toBe('never')
    expect(resolveStoreConfig({ retentionDays: 'never' }).retentionDays).toBe('never')
    // 0 stays a hard error: "keep nothing" and "keep everything" must not be
    // one keystroke apart.
    expect(() => Config.parse({ retentionDays: 0 })).toThrow()
    expect(() => Config.parse({ retentionDays: 'forever' })).toThrow()
  })

  it('accepts host and host:port authorities, refusing anything with a path or scheme', () => {
    expect(Config.parse({ trustedHosts: ['dev.box', '10.0.0.4:3080', '[::1]:80'] }).trustedHosts)
      .toEqual(['dev.box', '10.0.0.4:3080', '[::1]:80'])
    expect(() => Config.parse({ trustedHosts: ['http://dev.box'] })).toThrow()
    expect(() => Config.parse({ trustedHosts: ['dev.box/admin'] })).toThrow()
  })

  it('only knows the two persistence formats', () => {
    expect(Config.parse({ format: 'v1' }).format).toBe('v1')
    expect(() => Config.parse({ format: 'v3' })).toThrow()
  })

  it('takes the pack switch and nothing else', () => {
    // 'off' is the rollback door: it must also gradually unpack existing
    // packs, so the switch can never strand records a build cannot read.
    expect(Config.parse({ pack: 'off' }).pack).toBe('off')
    expect(Config.parse({}).pack).toBe('auto')
    expect(() => Config.parse({ pack: 'yes' })).toThrow()
    expect(resolveStoreConfig({ pack: 'off' }).pack).toBe('off')
  })
})

describe('resolveStoreConfig', () => {
  it('defaults the directory under DSH_HOME and passes the caps through', () => {
    const resolved = resolveStoreConfig(undefined)
    expect(resolved.directory).toMatch(/request-log$/)
    expect(resolved.retentionDays).toBe(DEFAULTS.retentionDays)
    expect(resolved.maxFileBytes).toBe(DEFAULTS.maxFileBytes)
    expect(resolved.format).toBe('auto')
  })

  it('honours an explicit directory', () => {
    expect(resolveStoreConfig({ directory: '/var/log/drl' }).directory).toBe('/var/log/drl')
  })
})

describe('scheduleSweep', () => {
  it('fires the boot sweep immediately and warns through the logger on rejection', async () => {
    const warn = vi.fn()
    const store = {
      sweep: vi.fn(() => Promise.reject(new Error('boom'))),
    } as unknown as CallStore

    scheduleSweep(store, { warn })
    await new Promise(resolve => setImmediate(resolve))

    // Boot sweep ran once; the rejection surfaced as a warn, not a swallow.
    expect(store.sweep).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('sweep failed')
  })

  it('returns the interval callback and does not crash it either', async () => {
    const warn = vi.fn()
    let sweeps = 0
    const store = {
      sweep: vi.fn(() => {
        sweeps += 1
        return sweeps === 1 ? Promise.resolve({ deletedFiles: 0, trimmedFiles: 0, migratedFiles: 0 }) : Promise.reject(new Error('later'))
      }),
    } as unknown as CallStore

    const interval = scheduleSweep(store, { warn })
    interval()
    await new Promise(resolve => setImmediate(resolve))
    expect(sweeps).toBe(2)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
