/**
 * CSS contracts whose effect depends on two cooperating grid levels.
 * These assertions prevent the table gap from changing without also
 * reaching the independently gridded header and data rows.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(import.meta.dirname, '..', 'src', 'client', 'styles.css'), 'utf8')

function ruleBody(selector: string): string {
  const match = css.match(new RegExp('\\' + selector + '\\s*\\{([^}]*)\\}'))
  if (match?.[1] === undefined) throw new Error('missing CSS rule: ' + selector)
  return match[1]
}

describe('ledger column spacing', () => {
  it('carries the table gap into independently gridded rows', () => {
    expect(ruleBody('.rl-table')).toMatch(/column-gap:\s*16px;/)
    expect(ruleBody('.rl-row')).toMatch(/column-gap:\s*inherit;/)
  })
})
