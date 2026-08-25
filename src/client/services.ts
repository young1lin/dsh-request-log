/**
 * Client-side service contracts — the exact API surface this plugin consumes
 * from the harness web half. TYPE-ONLY: the runtime services come from the
 * user's harness installation.
 */

export interface LocaleService {
  register(ns: string, dicts: Record<string, unknown>): () => void
  bind(ns: string): (key: string, params?: Record<string, string | number>) => string
  subscribe(fn: () => void): () => void
  getLocale?(): { active: string }
}

export interface SlotRegistration {
  name: string
  id?: string
  order?: number
  locale?: string
  label?: () => string
  inject?: (sessionId: string) => unknown
}

export interface SlotsService {
  inject(name: string, callback: () => unknown): unknown
  register(
    registration: SlotRegistration,
    component: (props: { sessionId?: string }) => unknown,
  ): unknown
}

/** The framework session kit reaches slot components as standard props. */
export interface SessionStandardProps {
  sessionId?: string
}

export type ClientCtx = {
  effect: (setup: () => unknown, label?: string) => () => void
  get: (name: string) => unknown
  on: (event: string, listener: (...args: unknown[]) => unknown) => () => void
  slots: SlotsService
  locale: LocaleService
}
