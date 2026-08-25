/**
 * Browser-bundle ambient declarations. The client half ships as a CJS
 * closure inside the web boot handoff; node globals (require/module) come
 * from @types/node, which the host half needs anyway.
 */

// Stylesheet imports resolve through the bundle's CSS channels (see
// tsdown.config.ts): side-effect global sheets, ?inline text, and
// CSS Modules class maps.
declare module '*.css'
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
