/**
 * Plugin entry specs: the config schema (defaults, strictness, bounds), the
 * resolved store config, and the version constant the /health route reports.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Config, DEFAULTS, VERSION, name, resolveStoreConfig } from '../src/host/index.ts'

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
