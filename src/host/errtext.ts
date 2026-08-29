/**
 * Error text safe for logs and /health: filesystem errors carry absolute
 * paths — and with them the username and the machine's directory layout —
 * which must not leak into the host session log or the health endpoint.
 *
 * @module dsh-request-log/host/errtext
 */

const PATH_LIKE = [
  // Windows absolute paths (drive letter), up to the next delimiter.
  /[A-Za-z]:\\[^\s'"`,;)]*/g,
  // Unix absolute paths of two or more segments (a leading slash alone stays).
  /(?<![\w.])\/(?:[\w.-]+\/)+[\w.-]*/g,
]

/**
 * Redact path-like substrings from an error's text. Keeps the error name,
 * the errno, and the message shape (debuggability) while stripping the
 * local filesystem layout (privacy).
 */
export function errorTextOf(error: unknown): string {
  const errno = (error as NodeJS.ErrnoException | null)?.code
  const base = error instanceof Error
    ? `${error.name}${typeof errno === 'string' ? ` (${errno})` : ''}: ${error.message}`
    : String(error)
  let text = base
  for (const pattern of PATH_LIKE) text = text.replace(pattern, '<path>')
  return text
}
