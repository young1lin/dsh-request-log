/**
 * The browser module table supplies React through the injected require —
 * every component imports it from here instead of repeating the require.
 */

import type * as ReactNS from 'react'

// The loader contract: a closure-factory bundle has no ESM imports; the
// browser module table answers this injected require.
// oxlint-disable-next-line typescript/no-require-imports
export const React: typeof ReactNS = require('react') as typeof ReactNS
export const h = React.createElement

/**
 * Render-time crash net: a subtree whose render throws (a malformed record
 * reaching a renderer, an unexpected shape) degrades to `fallback` instead
 * of blanking the whole tab — React only honours error boundaries, never a
 * try/catch around render. `reset` re-mounts the children.
 */
export class ErrorBoundary extends React.Component<{
  fallback: (error: unknown, reset: () => void) => ReactNS.ReactElement
  children?: ReactNS.ReactNode
}, { error?: unknown }> {
  override state: { error?: unknown } = {}

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error }
  }

  override render(): ReactNS.ReactNode {
    if (this.state.error !== undefined) {
      return this.props.fallback(this.state.error, () => { this.setState({ error: undefined }) })
    }
    return this.props.children
  }
}
