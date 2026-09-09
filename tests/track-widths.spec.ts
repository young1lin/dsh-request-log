/**
 * candidateRows: the widest-few values per column that the hidden measuring
 * grid lays out, so the table's track floor stays derived from content.
 */

import { describe, expect, it } from 'vitest'
import { LEDGER_COLUMNS, candidateRows } from '../src/client/track-widths.ts'

describe('candidateRows', () => {
  it("puts each column's widest value in row 0, independently per column", () => {
    const cells = [
      ['a', 'llllll'],
      ['bbbb', 'l'],
      ['cc', 'lll'],
    ]
    const rows = candidateRows(cells, 2)
    expect(rows[0]).toEqual(['bbbb', 'llllll'])
    // Later rows only ever add narrower candidates per column — a
    // max-content track takes the max, so they cannot move a track.
    for (const row of rows.slice(1)) {
      expect(row[0]!.length).toBeLessThanOrEqual(4)
      expect(['l', 'lll'].includes(row[1]!)).toBe(true)
    }
  })

  it('ranks by estimated rendered width, not raw length', () => {
    // '980ms' renders WIDER than '12.34s' in a proportional font — three
    // tabular digits plus a wide 'm' against four digits, a period and a
    // narrow 's' — which is exactly the case a length-ranked picker got
    // wrong on the live session (106 clipped cells).
    const rows = candidateRows([['12.34s'], ['1.234s'], ['980ms']], 1)
    expect(rows[0]![0]).toBe('980ms')
  })

  it('pads short columns rather than emitting holes', () => {
    // One row of data, three candidates asked for: the extra rows must not
    // introduce undefined cells that would render as the string 'undefined'
    // and measure wider than any real value.
    const rows = candidateRows([['x', 'y']], 3)
    expect(rows).toEqual([['x', 'y']])
    expect(rows.every(row => row.every(cell => typeof cell === 'string'))).toBe(true)
  })

  it('returns nothing for an empty ledger', () => {
    expect(candidateRows([], 3)).toEqual([])
  })

  it('names twelve ledger columns', () => {
    expect(LEDGER_COLUMNS).toBe(12)
  })
})
