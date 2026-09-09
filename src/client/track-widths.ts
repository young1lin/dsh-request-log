/**
 * The ledger's column floor, derived from a handful of rows instead of all
 * of them.
 *
 * styles.css sizes twelve max-content tracks across EVERY row, which is
 * real table column semantics and the reason no header can clip in any
 * locale — but it also means one changed cell re-measures the whole table.
 * Measured on a 2000-row session: 3860 ms of layout on mount, 482 ms on
 * every 3 s poll.
 *
 * The floor stays derived, never declared. This module picks the few values
 * that can possibly be widest in each column; the view measures a hidden
 * grid holding only those, and publishes the resolved track list.
 *
 * Ranking is the hard part: string LENGTH is a poor proxy for rendered
 * width in a proportional font — on the live session '980ms' (5 chars)
 * rendered 35 px while '12.34s' (6 chars) rendered 27 px, and a
 * length-ranked picker put only the latter in the grid, clipping 106 cells.
 * So candidates are ranked by an estimated glyph width (digits are tabular
 * in this table, letters are not: 'm' is wide, '.' is nearly free) AND by
 * raw length, and the union of both rankings is kept: the widest value is
 * near the top of at least one ranking in every font observed, and several
 * candidates per column are kept besides, so the browser decides.
 *
 * No React, no DOM — tests run this under plain Node.
 *
 * @module dsh-request-log/client/track-widths
 */

/** Time, model, TTFT, total, speed, billed, in, hit, hit%, write, out, size. */
export const LEDGER_COLUMNS = 12

/** Rough advance widths in digit units — tabular digits are the table's unit. */
const WIDE = new Map([
  ['m', 1.8], ['M', 1.9], ['w', 1.5], ['W', 1.7],
  ['%', 1.4], ['#', 1.2], ['\u2248', 1.1], ['\u00d7', 1.1],
])
const NARROW = new Map([
  ['.', 0.3], [',', 0.3], [':', 0.3], [' ', 0.35], ['/', 0.55], ['\u00b7', 0.5], ['\u2013', 0.6],
  // The model cell's part separator; the parts render in their own boxes.
  ['\u0000', 0],
])

/** A digit-unit estimate of a cell's rendered width; only rankings use it. */
function estimateWidth(text: string): number {
  let total = 0
  for (const char of text) {
    total += WIDE.get(char) ?? NARROW.get(char) ?? (char >= '0' && char <= '9' ? 1 : char < 'a' ? 1.3 : 1)
  }
  return total
}

/**
 * Up to `keep` synthetic rows whose column i holds the i-th widest candidate
 * of column i, widest first under BOTH rankings (estimated width, then raw
 * length as the tiebreak). Columns are ranked independently, so row 0 is a
 * row no call ever produced — which is exactly the point: it is the widest
 * possible row, and the grid measured against it cannot clip a real one.
 */
export function candidateRows(cells: readonly (readonly string[])[], keep = 3): string[][] {
  if (cells.length === 0) return []
  const columns = cells[0]!.length
  const perColumn: string[][] = []
  for (let column = 0; column < columns; column += 1) {
    const values = new Set<string>()
    for (const row of cells) {
      const value = row[column]
      if (value !== undefined) values.add(value)
    }
    // The union of both rankings, widest-first. Extra candidates are free:
    // the hidden grid is max-content, so a row narrower than another never
    // moves a track — it only buys coverage when a ranking guesses wrong.
    const byEstimate = [...values].sort((a, b) =>
      estimateWidth(b) - estimateWidth(a) || b.length - a.length || (a < b ? -1 : 1))
    const byLength = [...values].sort((a, b) =>
      b.length - a.length || estimateWidth(b) - estimateWidth(a) || (a < b ? -1 : 1))
    const merged: string[] = []
    const seen = new Set<string>()
    for (let rank = 0; merged.length < keep * 2 && rank < values.size; rank += 1) {
      for (const list of [byEstimate, byLength]) {
        const value = list[rank]
        if (value !== undefined && !seen.has(value)) {
          seen.add(value)
          merged.push(value)
        }
      }
    }
    perColumn.push(merged)
  }
  const depth = Math.max(...perColumn.map(column => column.length))
  const rows: string[][] = []
  for (let index = 0; index < depth; index += 1) {
    // A column with fewer distinct values than `depth` repeats its widest,
    // so no cell is ever undefined — 'undefined' would measure wider than
    // any real value and inflate the track.
    rows.push(perColumn.map(column => column[index] ?? column[0] ?? ''))
  }
  return rows
}
