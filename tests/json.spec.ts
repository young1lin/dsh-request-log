/**
 * JSON tree specs: collapse defaults, mode switches, long-string clamping,
 * the render cap, and the whole-view node budget — rendered through
 * react-dom/server. react.ts calls the browser-injected `require`; under
 * vitest the same contract is satisfied with a Node require on globalThis.
 */

import { createRequire } from 'node:module'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'

;(globalThis as { require?: NodeRequire }).require = createRequire(import.meta.url)

const { renderToStaticMarkup } = await import('react-dom/server')
const { JsonTree } = await import('../src/client/json.ts')

function render(value: unknown, mode: 'default' | 'expanded' | 'collapsed' = 'default'): string {
  return renderToStaticMarkup(createElement(JsonTree, { value, mode }))
}

describe('JsonTree', () => {
  it('folds containers past depth 2 by default', () => {
    const markup = render({ a: { b: { c: 1 } } })
    expect(markup).toContain('rl-tree-summary')
    expect(markup).not.toContain('&quot;c&quot;')
  })

  it('expanded mode renders every leaf', () => {
    const markup = render({ a: { b: { c: 1 } } }, 'expanded')
    expect(markup).toContain('&quot;c&quot;')
    expect(markup).toContain('&quot;b&quot;')
    expect(markup).not.toContain('rl-tree-summary')
  })

  it('collapsed mode renders the root container as a summary', () => {
    const markup = render({ a: 1 }, 'collapsed')
    expect(markup).toContain('… 1 keys')
    expect(markup).not.toContain('>a<')
  })

  it('clamps long strings behind a +N chars toggle', () => {
    const long = 'x'.repeat(500)
    const markup = render(long)
    expect(markup).toContain('… +340 chars')
    // Only the 160-char preview travels to the DOM.
    expect(markup).not.toContain('x'.repeat(200))
  })

  it('offers the JSON view for long strings that parse as JSON', () => {
    const jsonish = JSON.stringify({ key: 'v'.repeat(300) })
    const markup = render(jsonish)
    expect(markup).toContain('{ } JSON')
  })

  it('renders opened strings truncated at the cap in expanded mode', () => {
    const huge = 'y'.repeat(200_001)
    const markup = render(huge, 'expanded')
    expect(markup).toContain('truncated at 200000 chars')
    expect(markup).not.toContain('y'.repeat(200_001))
  })

  it('stops rendering past the node budget instead of flooding the DOM', () => {
    const big = Array.from({ length: 25_000 }, (_, i) => i)
    const markup = render(big, 'expanded')
    expect(markup).toContain('node budget exceeded')
    // The tree refused before rendering all 25k leaf rows.
    expect(markup.length).toBeLessThan(500_000)
  })

  it('never applies the budget to ordinary bodies', () => {
    const markup = render({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, 'expanded')
    expect(markup).not.toContain('node budget exceeded')
    expect(markup).toContain('&quot;hi&quot;')
  })

  it('stops recursing past the depth cap instead of blowing the stack', () => {
    // ~600 nested levels: without the cap the recursive renderer (and
    // react-dom/server's own recursive walk, measured to overflow below
    // 300 rendered levels in dev mode) dies long before markup lands.
    let deep: unknown = { leaf: true }
    for (let i = 0; i < 300; i += 1) deep = { nested: [deep] }
    const markup = render(deep, 'expanded')
    expect(markup).toContain('depth limit')
    expect(markup.length).toBeLessThan(100_000)
  })
})
