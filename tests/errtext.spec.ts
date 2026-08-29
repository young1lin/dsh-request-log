/**
 * errtext specs: the sanitizer keeps an error's name/errno/shape while
 * stripping the absolute paths (and the usernames inside them) that fs
 * errors carry — /health and the host log must not leak the disk layout.
 */

import { describe, expect, it } from 'vitest'
import { errorTextOf } from '../src/host/errtext.ts'

describe('errorTextOf', () => {
  it('keeps the name and errno while redacting windows paths', () => {
    const error: Error & { code?: string } = new Error(
      "ENOENT: no such file or directory, open 'C:\\Users\\alice\\secret\\s.jsonl'",
    )
    error.code = 'ENOENT'
    const text = errorTextOf(error)
    expect(text).toContain('Error (ENOENT)')
    expect(text).toContain('<path>')
    expect(text).not.toContain('alice')
  })

  it('redacts unix paths', () => {
    const text = errorTextOf(new Error("EACCES: permission denied, open '/home/bob/data/x.drl'"))
    expect(text).toContain('<path>')
    expect(text).not.toContain('/home/bob')
  })

  it('passes plain strings through', () => {
    expect(errorTextOf('boom')).toBe('boom')
  })
})
